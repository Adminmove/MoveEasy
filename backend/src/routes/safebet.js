// ================================================================
// SafeBet Routes — ZAR→USDC Yield Savings
// Architecture: Async BullMQ pipeline → Ozow → VALR → Supabase
// ================================================================
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { Queue } = require('bullmq');
const { authenticate, requireKYC } = require('../middleware/auth');
const { db, withTransaction } = require('../config/database');
const { getZARUSDCRate, getPoolSummary } = require('../services/valr');

// BullMQ deposit queue (payments MUST be async per architecture doctrine)
const depositQueue = new Queue('deposit-split', {
  connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' }
});

// POST /api/v1/safebet/deposit
// Step 1: User initiates deposit → Ozow EFT
router.post('/deposit', authenticate, requireKYC(1), [
  body('amount_cents').isInt({ min: 5000, max: 100000000 }),
  body('bet_savings_pct').optional().isFloat({ min: 7, max: 10 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  // Idempotency check
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (idempotencyKey) {
    const existing = await db.query(
      'SELECT id FROM contribution_batches WHERE ozow_payment_ref = $1',
      [idempotencyKey]
    );
    if (existing.rows.length) {
      return res.json({ message: 'Duplicate request', batch_id: existing.rows[0].id });
    }
  }

  try {
    const { amount_cents, bet_savings_pct = 7 } = req.body;
    const clipped_cents = Math.round(amount_cents * (bet_savings_pct / 100));
    const deposit_date = new Date().toISOString().split('T')[0];

    // Get profile
    let profile = await db.query(
      'SELECT id FROM safebet_profiles WHERE user_id = $1',
      [req.user.id]
    );

    if (!profile.rows.length) {
      profile = await db.query(
        'INSERT INTO safebet_profiles (user_id) VALUES ($1) RETURNING *',
        [req.user.id]
      );
    }

    const unlock3m = new Date();
    unlock3m.setMonth(unlock3m.getMonth() + 3);
    const unlock12m = new Date();
    unlock12m.setFullYear(unlock12m.getFullYear() + 1);

    // Create batch in 'converting' state
    const batch = await db.query(`
      INSERT INTO contribution_batches (
        profile_id, zar_amount_cents, clipped_zar_cents,
        bet_savings_pct, deposit_date, unlock_3m_date, unlock_12m_date,
        status, ozow_payment_ref
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'converting',$8)
      RETURNING *
    `, [profile.rows[0].id, amount_cents, clipped_cents,
        bet_savings_pct, deposit_date,
        unlock3m.toISOString().split('T')[0],
        unlock12m.toISOString().split('T')[0],
        idempotencyKey || null]);

    // Build Ozow payment URL
    // In production: use Ozow SDK to generate payment URL
    const ozowParams = new URLSearchParams({
      SiteCode: process.env.OZOW_SITE_CODE,
      CountryCode: 'ZA',
      CurrencyCode: 'ZAR',
      Amount: (clipped_cents / 100).toFixed(2),
      TransactionReference: batch.rows[0].id,
      BankReference: `SAFEBET-${batch.rows[0].id.slice(0, 8).toUpperCase()}`,
      SuccessUrl: `${process.env.CORS_ORIGIN}/safebet/success`,
      CancelUrl: `${process.env.CORS_ORIGIN}/safebet/cancel`,
      ErrorUrl: `${process.env.CORS_ORIGIN}/safebet/error`,
      NotifyUrl: `${process.env.BACKEND_URL || 'https://api.moveeasy.co.za'}/webhooks/ozow`
    });

    res.json({
      batch_id: batch.rows[0].id,
      amount_zar: amount_cents / 100,
      savings_clipped_zar: clipped_cents / 100,
      savings_pct: bet_savings_pct,
      unlock_3m: unlock3m.toISOString().split('T')[0],
      unlock_12m: unlock12m.toISOString().split('T')[0],
      payment_url: `https://pay.ozow.com/?${ozowParams.toString()}`,
      message: `R${(clipped_cents/100).toFixed(2)} (${bet_savings_pct}%) will be converted to USDC and locked for 3 months.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/safebet/portfolio
router.get('/portfolio', authenticate, async (req, res) => {
  try {
    const rate = await getZARUSDCRate().catch(() => ({ bid: 18.50, ask: 18.60 }));

    const result = await db.query(`
      SELECT 
        sp.*,
        COUNT(cb.id) as total_batches,
        COUNT(cb.id) FILTER (WHERE cb.status = 'active') as active_batches,
        COUNT(cb.id) FILTER (WHERE cb.status = 'unlocked_3m') as unlocked_3m,
        COUNT(cb.id) FILTER (WHERE cb.status = 'unlocked_12m') as unlocked_12m,
        SUM(cb.zar_amount_cents) as total_deposited_cents,
        SUM(cb.usdc_acquired) as total_usdc,
        SUM(cb.gain_zar_cents) as total_gains_cents
      FROM safebet_profiles sp
      LEFT JOIN contribution_batches cb ON cb.profile_id = sp.id
      WHERE sp.user_id = $1
      GROUP BY sp.id
    `, [req.user.id]);

    if (!result.rows.length) {
      return res.json({ message: 'No SafeBet profile. Make your first deposit to start.', usdc_rate: rate.bid });
    }

    const portfolio = result.rows[0];
    const usdcValue = parseFloat(portfolio.total_usdc || 0) * rate.bid;

    res.json({
      ...portfolio,
      usdc_zar_rate: rate.bid,
      portfolio_value_zar: usdcValue.toFixed(2),
      gain_pct: portfolio.total_deposited_cents > 0
        ? ((portfolio.total_gains_cents || 0) / portfolio.total_deposited_cents * 100).toFixed(2)
        : '0.00'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/safebet/batches
router.get('/batches', authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT cb.*,
        EXTRACT(DAYS FROM (cb.unlock_3m_date - CURRENT_DATE)) as days_to_3m_unlock,
        EXTRACT(DAYS FROM (cb.unlock_12m_date - CURRENT_DATE)) as days_to_12m_unlock
      FROM contribution_batches cb
      JOIN safebet_profiles sp ON sp.id = cb.profile_id
      WHERE sp.user_id = $1
      ORDER BY cb.created_at DESC
    `, [req.user.id]);

    res.json({ batches: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/safebet/withdraw
router.post('/withdraw', authenticate, requireKYC(1), [
  body('batch_id').isUUID(),
  body('withdraw_type').isIn(['principal', 'gains', 'full'])
], async (req, res) => {
  try {
    const { batch_id, withdraw_type } = req.body;

    const batch = await db.query(`
      SELECT cb.* FROM contribution_batches cb
      JOIN safebet_profiles sp ON sp.id = cb.profile_id
      WHERE cb.id = $1 AND sp.user_id = $2
    `, [batch_id, req.user.id]);

    if (!batch.rows.length) return res.status(404).json({ error: 'Batch not found' });
    const b = batch.rows[0];

    if (withdraw_type === 'principal' && b.status !== 'unlocked_3m' && b.status !== 'unlocked_12m') {
      return res.status(400).json({
        error: 'Principal locked until 3-month unlock date',
        unlock_date: b.unlock_3m_date
      });
    }

    if (withdraw_type === 'gains' && b.status !== 'unlocked_12m') {
      return res.status(400).json({
        error: 'Trading gains locked until 12-month unlock date',
        unlock_date: b.unlock_12m_date
      });
    }

    // Queue withdrawal job (async — never process in HTTP request)
    await depositQueue.add('withdrawal', {
      batch_id, withdraw_type,
      user_id: req.user.id,
      zar_amount_cents: b.zar_amount_cents,
      gains_cents: b.gain_zar_cents
    }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });

    await db.query(
      "UPDATE contribution_batches SET status = 'withdrawn' WHERE id = $1",
      [batch_id]
    );

    res.json({
      message: 'Withdrawal queued. Funds will be transferred within 2-3 business days.',
      batch_id,
      amount_zar: b.zar_amount_cents / 100
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
