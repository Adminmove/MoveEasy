// ================================================================
// EasyFuel Routes — Fuel Pre-purchase & FuelFlex BNPL
// ================================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { authenticate, requireKYC } = require('../middleware/auth');
const { db, withTransaction } = require('../config/database');
const { generatePaymentURL, createSubscription } = require('../services/payfast');
const { runFuelOptimizer } = require('../services/ai-orchestrator');

// Haversine distance (metres) for geo-lock validation
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Generate HMAC-signed QR payload (4-hour TTL)
function generateQRPayload(voucher) {
  const payload = {
    voucher_code: voucher.voucher_code,
    station_id: voucher.station_id,
    amount_cents: voucher.amount_cents,
    expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
  };
  const hmac = crypto
    .createHmac('sha256', process.env.VOUCHER_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
  return Buffer.from(JSON.stringify({ ...payload, hmac })).toString('base64');
}

// GET /api/v1/easyfuel/stations/nearby
router.get('/stations/nearby', authenticate, async (req, res) => {
  try {
    const { lat, lng, radius = 5000 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    // PostgreSQL earth_distance or manual haversine filter
    const result = await db.query(`
      SELECT id, name, brand, address, latitude, longitude,
        (6371000 * acos(
          cos(radians($1)) * cos(radians(latitude)) *
          cos(radians(longitude) - radians($2)) +
          sin(radians($1)) * sin(radians(latitude))
        )) AS distance_m
      FROM fuel_stations
      WHERE is_active = TRUE
      HAVING (6371000 * acos(
        cos(radians($1)) * cos(radians(latitude)) *
        cos(radians(longitude) - radians($2)) +
        sin(radians($1)) * sin(radians(latitude))
      )) < $3
      ORDER BY distance_m
      LIMIT 20
    `, [lat, lng, radius]);

    res.json({ stations: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/easyfuel/vouchers/purchase
router.post('/vouchers/purchase', authenticate, requireKYC(1), [
  body('station_id').isUUID(),
  body('amount_cents').isInt({ min: 5000 }),
  body('fuel_type').isIn(['unleaded', 'diesel', 'premium'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { station_id, amount_cents, fuel_type } = req.body;

    const driverResult = await db.query(
      'SELECT id FROM easyfuel_drivers WHERE user_id = $1',
      [req.user.id]
    );
    if (!driverResult.rows.length) {
      return res.status(404).json({ error: 'Driver profile not found. Please register your vehicle.' });
    }

    const stationResult = await db.query(
      'SELECT * FROM fuel_stations WHERE id = $1 AND is_active = TRUE',
      [station_id]
    );
    if (!stationResult.rows.length) {
      return res.status(404).json({ error: 'Station not found or inactive' });
    }

    const station = stationResult.rows[0];
    const driver = driverResult.rows[0];

    // Create voucher
    const voucherCode = crypto.randomBytes(8).toString('hex').toUpperCase();
    const voucherHash = crypto.createHmac('sha256', process.env.VOUCHER_SECRET)
      .update(voucherCode).digest('hex');

    const voucherResult = await db.query(`
      INSERT INTO fuel_vouchers (
        driver_id, station_id, voucher_code, voucher_hash,
        amount_cents, fuel_type, unlock_radius_m,
        station_lat, station_lng, expires_at, voucher_type
      ) VALUES ($1,$2,$3,$4,$5,$6,500,$7,$8,NOW()+INTERVAL '30 days','standard')
      RETURNING *
    `, [driver.id, station_id, voucherCode, voucherHash,
        amount_cents, fuel_type, station.latitude, station.longitude]);

    const voucher = voucherResult.rows[0];

    // Generate PayFast payment URL
    const paymentUrl = generatePaymentURL({
      firstName: req.user.first_name || '',
      lastName: req.user.last_name || '',
      email: req.user.email,
      paymentId: voucher.id,
      amountZAR: amount_cents / 100,
      itemName: `EasyFuel Voucher — ${station.brand} ${station.name}`,
      product: 'easyfuel',
      userId: req.user.id,
      returnUrl: `${process.env.CORS_ORIGIN}/easyfuel/success`,
      cancelUrl: `${process.env.CORS_ORIGIN}/easyfuel/cancel`
    });

    res.json({
      voucher_id: voucher.id,
      voucher_code: voucherCode,
      payment_url: paymentUrl,
      amount_zar: amount_cents / 100,
      station: { name: station.name, brand: station.brand, address: station.address }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/easyfuel/vouchers/:id/unlock
// Geo-lock validation + biometric gate (called by mobile app)
router.post('/vouchers/:id/unlock', authenticate, async (req, res) => {
  try {
    const { user_lat, user_lng } = req.body;
    const voucherId = req.params.id;

    const result = await db.query(
      'SELECT * FROM fuel_vouchers WHERE id = $1',
      [voucherId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Voucher not found' });

    const voucher = result.rows[0];

    if (voucher.is_unlocked) return res.status(400).json({ error: 'Voucher already used' });
    if (voucher.status !== 'active') return res.status(400).json({ error: `Voucher status: ${voucher.status}` });
    if (new Date(voucher.expires_at) < new Date()) {
      await db.query("UPDATE fuel_vouchers SET status='expired' WHERE id=$1", [voucherId]);
      return res.status(400).json({ error: 'Voucher has expired' });
    }

    // GEO-LOCK VALIDATION (500m radius)
    const distance = haversineDistance(
      parseFloat(user_lat), parseFloat(user_lng),
      parseFloat(voucher.station_lat), parseFloat(voucher.station_lng)
    );

    if (distance > voucher.unlock_radius_m) {
      return res.status(403).json({
        error: `GEO_LOCK_FAIL: ${Math.round(distance)}m from station. Must be within ${voucher.unlock_radius_m}m.`,
        code: 'GEO_LOCK_FAIL',
        distance_m: Math.round(distance),
        max_radius_m: voucher.unlock_radius_m
      });
    }

    // Generate signed QR payload with 4-hour TTL
    const qrPayload = generateQRPayload(voucher);

    await db.query(`
      UPDATE fuel_vouchers 
      SET is_unlocked = TRUE, unlocked_at = NOW(), qr_payload = $1
      WHERE id = $2
    `, [qrPayload, voucherId]);

    // Trigger Fuel Optimizer AI check
    runFuelOptimizer(voucher.driver_id).catch(err =>
      global.logger?.warn('Fuel optimizer async error:', err.message)
    );

    res.json({
      success: true,
      qr_payload: qrPayload,
      expires_in_seconds: 4 * 60 * 60,
      message: 'Voucher unlocked. Show QR code at pump.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/easyfuel/fuelflex/apply
router.post('/fuelflex/apply', authenticate, requireKYC(2), [
  body('station_id').isUUID(),
  body('fuel_type').isIn(['unleaded', 'diesel', 'premium'])
], async (req, res) => {
  try {
    const { station_id, fuel_type } = req.body;

    const driverResult = await db.query(
      'SELECT * FROM easyfuel_drivers WHERE user_id = $1',
      [req.user.id]
    );
    if (!driverResult.rows.length) return res.status(404).json({ error: 'Driver profile required' });

    const driver = driverResult.rows[0];
    if (!driver.bnpl_approved) {
      return res.status(403).json({
        error: 'FuelFlex BNPL approval required',
        code: 'FUELFLEX_NOT_APPROVED',
        message: 'Please complete TransUnion credit check to activate FuelFlex'
      });
    }

    // For demo: use R1,200 as full tank example
    // In production: use current fuel price API
    const totalTankValueCents = 120000; // R1,200
    const depositCents = Math.round(totalTankValueCents / 3); // R400
    const serviceFeeCents = Math.round(totalTankValueCents * 0.035); // R42 total / R14 per token

    const contract = await db.query(`
      INSERT INTO fuelflex_contracts (
        driver_id, total_tank_value_cents, deposit_amount_cents, 
        token_1_unlock_cents, service_fee_cents, repayment_due_date,
        fuel_price_at_signup
      ) VALUES ($1,$2,$3,$4,$5,CURRENT_DATE + INTERVAL '30 days',22.50)
      RETURNING *
    `, [driver.id, totalTankValueCents, depositCents,
        Math.round(totalTankValueCents / 3), Math.round(serviceFeeCents / 3)]);

    const subscriptionUrl = await createSubscription({
      firstName: req.user.first_name || '',
      lastName: req.user.last_name || '',
      email: req.user.email,
      amountCents: depositCents,
      itemName: 'FuelFlex BNPL Deposit',
      product: 'fuelflex',
      userId: req.user.id,
      returnUrl: `${process.env.CORS_ORIGIN}/easyfuel/fuelflex/success`,
      cancelUrl: `${process.env.CORS_ORIGIN}/easyfuel/fuelflex/cancel`,
      startDate: new Date().toISOString().split('T')[0],
      frequency: 3
    });

    res.json({
      contract_id: contract.rows[0].id,
      deposit_zar: depositCents / 100,
      total_value_zar: totalTankValueCents / 100,
      service_fee_zar: serviceFeeCents / 100,
      repayment_per_tank_zar: (depositCents + Math.round(serviceFeeCents / 3)) / 100,
      payment_url: subscriptionUrl,
      mechanic: 'Deposit R400. Receive 3x full tank vouchers. Pay R266 + R14 fee per tank used.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/easyfuel/dashboard
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const driver = await db.query(`
      SELECT ed.*, 
        COUNT(fv.id) FILTER (WHERE fv.status = 'active') as active_vouchers,
        COUNT(fv.id) FILTER (WHERE fv.status = 'used') as used_vouchers,
        SUM(fv.amount_cents) FILTER (WHERE fv.status = 'used') as total_spend_cents,
        fc.contract_status as fuelflex_status,
        fc.token_1_status, fc.token_2_status, fc.token_3_status
      FROM easyfuel_drivers ed
      LEFT JOIN fuel_vouchers fv ON fv.driver_id = ed.id
      LEFT JOIN fuelflex_contracts fc ON fc.driver_id = ed.id AND fc.contract_status = 'ACTIVE'
      WHERE ed.user_id = $1
      GROUP BY ed.id, fc.contract_status, fc.token_1_status, fc.token_2_status, fc.token_3_status
    `, [req.user.id]);

    res.json(driver.rows[0] || { message: 'No driver profile. Register your vehicle to get started.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
