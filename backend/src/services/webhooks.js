// ================================================================
// Webhook Routes — PayFast ITN, Ozow, Smile ID, Purple Owl
// No auth required — validated by signature
// ================================================================
const express = require('express');
const router = express.Router();
const { Queue } = require('bullmq');
const { verifyPayFastITN } = require('../services/payfast');
const { verifyWebhookSignature } = require('../services/purple-owl');
const { processCallback } = require('../services/smile-id');
const { db, withTransaction } = require('../config/database');

const depositQueue = new Queue('deposit-split', {
  connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' }
});

// POST /webhooks/payfast — PayFast ITN (Instant Transaction Notification)
router.post('/payfast', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const data = req.body;
    global.logger?.info('PayFast ITN received:', { payment_id: data.m_payment_id });

    // 1. Verify PayFast signature
    if (!verifyPayFastITN(data)) {
      global.logger?.warn('PayFast ITN signature verification failed');
      return res.status(400).send('Invalid signature');
    }

    // 2. Always respond 200 first (PayFast requires immediate response)
    res.status(200).send('OK');

    if (data.payment_status !== 'COMPLETE') return;

    const paymentId = data.m_payment_id;
    const product = data.custom_str1;
    const userId = data.custom_str2;
    const amountCents = Math.round(parseFloat(data.amount_gross) * 100);

    await withTransaction(async (client) => {
      if (product === 'easyfuel') {
        // Activate fuel voucher
        await client.query(
          "UPDATE fuel_vouchers SET status = 'active' WHERE id = $1",
          [paymentId]
        );
        // Credit wallet record
        await client.query(`
          INSERT INTO ledger_entries (wallet_id, entry_type, amount_cents, balance_after, description, reference, product, payment_method, external_ref, status)
          SELECT w.id, 'credit', $1,
            w.balance_cents + $1,
            'EasyFuel voucher purchase', $2, 'easyfuel', 'payfast', $3, 'completed'
          FROM wallets w WHERE w.user_id = $4
        `, [amountCents, paymentId, data.pf_payment_id, userId]);

      } else if (product === 'safebet' || product === 'fuelflex') {
        // Queue async processing — NEVER split funds in HTTP request
        await depositQueue.add('process-payment', {
          payment_id: paymentId,
          product,
          user_id: userId,
          amount_cents: amountCents,
          payfast_ref: data.pf_payment_id
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 }
        });

      } else if (product === 'greenwallet') {
        await client.query(`
          UPDATE green_projects 
          SET current_funding_cents = current_funding_cents + $1
          WHERE id = $2
        `, [amountCents, paymentId]);
      }
    });

    global.logger?.info('PayFast ITN processed:', { paymentId, product });
  } catch (err) {
    global.logger?.error('PayFast ITN error:', err);
  }
});

// POST /webhooks/ozow — Ozow Instant EFT (SafeBet deposits)
router.post('/ozow', async (req, res) => {
  try {
    const { Status, TransactionReference, Amount, HashCheck } = req.body;
    res.status(200).send('OK');

    if (Status !== 'Complete') return;

    const batchId = TransactionReference;
    const amountCents = Math.round(parseFloat(Amount) * 100);

    // Queue VALR conversion job (Step 3 of SafeBet payment rail)
    await depositQueue.add('deposit-split', {
      batch_id: batchId,
      amount_cents: amountCents,
      source: 'ozow'
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });

    // Update batch status
    await db.query(
      "UPDATE contribution_batches SET status = 'active', ozow_payment_ref = $1 WHERE id = $2",
      [req.body.TransactionId, batchId]
    );

    global.logger?.info('Ozow payment confirmed, VALR conversion queued:', batchId);
  } catch (err) {
    global.logger?.error('Ozow webhook error:', err);
  }
});

// POST /webhooks/kyc — Smile ID KYC callback
router.post('/kyc', async (req, res) => {
  try {
    res.status(200).send('OK');

    const result = processCallback(req.body);
    global.logger?.info('Smile ID KYC callback:', result);

    if (!result.userId) return;

    const kycStatus = result.verified ? 'verified' : 'rejected';
    const kycTier = result.verified ? 1 : 0;

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE users 
        SET kyc_status = $1, kyc_tier = $2, kyc_reference = $3, kyc_verified_at = $4
        WHERE id = $5
      `, [kycStatus, kycTier, result.jobId,
          result.verified ? new Date() : null, result.userId]);

      await client.query(`
        INSERT INTO kyc_checks (user_id, provider, check_type, status, provider_ref, result_data, completed_at)
        VALUES ($1, 'smile_id', 'identity', $2, $3, $4, NOW())
      `, [result.userId, kycStatus, result.jobId, JSON.stringify(result)]);
    });

    global.logger?.info(`KYC ${kycStatus} for user ${result.userId}`);
  } catch (err) {
    global.logger?.error('KYC webhook error:', err);
  }
});

// POST /webhooks/purple-owl — Purple Owl card payment notifications
router.post('/purple-owl', async (req, res) => {
  try {
    const signature = req.headers['x-pop-signature'];
    if (!verifyWebhookSignature(req.body, signature)) {
      return res.status(400).send('Invalid signature');
    }

    res.status(200).send('OK');

    const { event_type, transaction_id, status, amount, reference } = req.body;
    global.logger?.info('Purple Owl webhook:', { event_type, transaction_id, status });

    if (event_type === 'transaction.success') {
      await db.query(`
        UPDATE ledger_entries SET status = 'completed'
        WHERE external_ref = $1
      `, [transaction_id]);
    } else if (event_type === 'transaction.reversed') {
      await db.query(`
        UPDATE ledger_entries SET status = 'reversed'
        WHERE external_ref = $1
      `, [transaction_id]);
    }
  } catch (err) {
    global.logger?.error('Purple Owl webhook error:', err);
  }
});

module.exports = router;
