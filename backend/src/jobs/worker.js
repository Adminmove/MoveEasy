// ================================================================
// BullMQ Async Worker — Deposit Processing Pipeline
// Architecture Doctrine: Payments MUST be async
// Failed jobs preserved for investigation — zero financial data loss
// ================================================================
require('dotenv').config();
const { Worker, Queue } = require('bullmq');
const { db, withTransaction } = require('../config/database');
const { convertZARtoUSDC } = require('../services/valr');
const { disburseFunds } = require('../services/payfast');

const redis = { url: process.env.REDIS_URL || 'redis://localhost:6379' };

// ================================================================
// Worker: deposit-split
// SafeBet: Ozow confirmed → VALR conversion → Supabase ledger
// ================================================================
const depositWorker = new Worker('deposit-split', async (job) => {
  const { batch_id, amount_cents, source } = job.data;
  global.logger?.info(`Processing deposit job: ${job.id}`, { batch_id, amount_cents });

  await withTransaction(async (client) => {
    // Fetch batch
    const batchResult = await client.query(
      'SELECT * FROM contribution_batches WHERE id = $1 FOR UPDATE',
      [batch_id]
    );
    if (!batchResult.rows.length) throw new Error(`Batch ${batch_id} not found`);
    const batch = batchResult.rows[0];

    if (batch.status === 'active') {
      global.logger?.info(`Batch ${batch_id} already processed, skipping`);
      return; // Idempotent
    }

    // Step 4: VALR — convert ZAR to USDC
    const zarToConvert = batch.clipped_zar_cents / 100;
    const conversion = await convertZARtoUSDC(zarToConvert);

    // Step 5: Supabase double-entry ledger update
    await client.query(`
      UPDATE contribution_batches
      SET 
        usdc_acquired = $1,
        zar_to_usdc_rate = $2,
        valr_trade_ref = $3,
        status = 'active'
      WHERE id = $4
    `, [conversion.usdcAcquired, conversion.rate, conversion.orderId, batch_id]);

    // Update profile totals
    await client.query(`
      UPDATE safebet_profiles
      SET 
        total_zar_deposited_cents = total_zar_deposited_cents + $1,
        total_usdc_acquired = total_usdc_acquired + $2
      WHERE id = $3
    `, [batch.clipped_zar_cents, conversion.usdcAcquired, batch.profile_id]);

    global.logger?.info(`Deposit processed: ${batch_id}, USDC: ${conversion.usdcAcquired}`);
  });
}, {
  connection: redis,
  concurrency: 3,
  // Exponential backoff on failure
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  }
});

// ================================================================
// Worker: eft-disbursement
// EasyTransect: process EFT payouts to SA bank accounts
// ================================================================
const eftWorker = new Worker('eft-disbursement', async (job) => {
  const { disbursement_id, wallet_id, bank_details, amount_cents, idempotency_key } = job.data;

  await withTransaction(async (client) => {
    // Lock wallet for update
    const wallet = await client.query(
      'SELECT * FROM wallets WHERE id = $1 FOR UPDATE',
      [wallet_id]
    );

    if (!wallet.rows.length) throw new Error('Wallet not found');
    const w = wallet.rows[0];

    const feeCents = Math.round(amount_cents * 0.01); // 1% ecosystem fee
    const netCents = amount_cents - feeCents;

    if (w.balance_cents - amount_cents - feeCents < 0) {
      throw new Error('Insufficient funds');
    }

    // Debit wallet
    await client.query(`
      UPDATE wallets SET balance_cents = balance_cents - $1, updated_at = NOW()
      WHERE id = $2
    `, [amount_cents + feeCents, wallet_id]);

    // Ledger entry
    await client.query(`
      INSERT INTO ledger_entries (wallet_id, entry_type, amount_cents, balance_after, description, reference, product, payment_method, status)
      VALUES ($1, 'debit', $2, $3, 'EasyTransect EFT disbursement', $4, 'easytransect', 'payfast', 'processing')
    `, [wallet_id, amount_cents + feeCents, w.balance_cents - amount_cents - feeCents, idempotency_key]);

    // Disburse via PayFast
    const result = await disburseFunds({
      walletId: wallet_id,
      bankDetails: bank_details,
      amountCents: netCents,
      idempotencyKey: idempotency_key
    });

    // Update disbursement status
    await client.query(`
      UPDATE eft_disbursements 
      SET status = 'completed', payfast_ref = $1, processed_at = NOW()
      WHERE id = $2
    `, [result.reference, disbursement_id]);
  });

  global.logger?.info(`EFT disbursement processed: ${disbursement_id}`);
}, { connection: redis, concurrency: 2 });

// ================================================================
// Worker: fuelflex-repayment
// Process FuelFlex token repayments
// ================================================================
const fuelflexWorker = new Worker('fuelflex-repayment', async (job) => {
  const { contract_id, token_index, amount_cents } = job.data;

  await withTransaction(async (client) => {
    const contract = await client.query(
      'SELECT * FROM fuelflex_contracts WHERE id = $1 FOR UPDATE',
      [contract_id]
    );
    if (!contract.rows.length) throw new Error('Contract not found');

    const tokenField = `token_${token_index}_status`;
    const nextTokenField = token_index < 3 ? `token_${token_index + 1}_status` : null;

    // Settle current token
    await client.query(`
      UPDATE fuelflex_contracts 
      SET ${tokenField} = 'settled' ${nextTokenField ? `, ${nextTokenField} = 'active'` : ''}
      WHERE id = $1
    `, [contract_id]);

    global.logger?.info(`FuelFlex token ${token_index} settled for contract ${contract_id}`);
  });
}, { connection: redis, concurrency: 5 });

// Error handlers
depositWorker.on('failed', (job, err) => {
  global.logger?.error(`Deposit job ${job?.id} failed:`, { error: err.message, data: job?.data });
});

eftWorker.on('failed', (job, err) => {
  global.logger?.error(`EFT job ${job?.id} failed:`, { error: err.message });
});

fuelflexWorker.on('failed', (job, err) => {
  global.logger?.error(`FuelFlex job ${job?.id} failed:`, err.message);
});

global.logger?.info('🔧 MoveEasy BullMQ Workers started');
global.logger?.info('   → deposit-split worker (SafeBet VALR conversion)');
global.logger?.info('   → eft-disbursement worker (EasyTransect payouts)');
global.logger?.info('   → fuelflex-repayment worker (BNPL settlement)');

module.exports = { depositWorker, eftWorker, fuelflexWorker };
