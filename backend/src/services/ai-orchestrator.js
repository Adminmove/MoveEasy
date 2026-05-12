// ================================================================
// MoveEasy AI Orchestrator — The Central Brain
// Cross-platform intelligence layer using Claude API
// Agents: Fuel Optimizer, Intel Mapper, Sustainability Auditor
// Features: Predictive RAG Status, Cross-platform telemetry
// ================================================================
const axios = require('axios');
const { db } = require('../config/database');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You are MoveEasy's Central AI Orchestrator — the brain of an African fintech ecosystem.
You monitor cross-platform telemetry from EasyFuel (fuel vouchers/BNPL), EasyTransect (mobile money bridge), 
SafeBet (ZAR/USDC savings), GreenWallet (ESG marketplace), and MMP.ai (B2B sourcing).

Your specialist agents:
1. FUEL_OPTIMIZER: Analyze driver movement vs fuel consumption. Flag drivers >15% above route average as ALERT_SUPERVISOR.
2. INTEL_MAPPER: Cross-reference merchant GPS with survey boundaries. Correct coordinates via CORRECT_COORDINATES.
3. SUSTAINABILITY_AUDITOR: Convert eco-certified merchant activations to GreenPoints via DEPOSIT_REWARD (500 GreenPoints).

Your RAG forecasting:
- GREEN: All metrics healthy, 7-10 day outlook clear
- AMBER: Warning indicators detected, monitoring required  
- RED: Immediate intervention needed

Respond in JSON only. Never include markdown, explanations, or extra text.
Format: { "rag_status": "green|amber|red", "action": "ACTION_NAME|none", "target_id": "uuid|null", "reasoning": "brief", "data": {} }`;

// Core orchestrator call
async function orchestrate(context) {
  try {
    const response = await axios.post(CLAUDE_API, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(context) }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const text = response.data.content[0].text;
    return JSON.parse(text.trim());
  } catch (err) {
    global.logger?.error('AI Orchestrator error:', err.message);
    return { rag_status: 'amber', action: 'none', reasoning: 'Orchestrator unavailable', data: {} };
  }
}

// ================================================================
// Agent 1: Fuel Optimizer
// Trigger: Driver movement vs fuel consumption
// ================================================================
async function runFuelOptimizer(driverId) {
  const result = await db.query(`
    SELECT 
      ed.id, ed.avg_fuel_efficiency, ed.tank_size_litres, ed.vehicle_reg,
      COUNT(fv.id) as vouchers_used,
      SUM(fv.amount_cents) as total_fuel_spend,
      u.first_name, u.email
    FROM easyfuel_drivers ed
    JOIN users u ON u.id = ed.user_id
    LEFT JOIN fuel_vouchers fv ON fv.driver_id = ed.id AND fv.status = 'used'
      AND fv.unlocked_at > NOW() - INTERVAL '30 days'
    WHERE ed.id = $1
    GROUP BY ed.id, u.first_name, u.email
  `, [driverId]);

  if (!result.rows.length) return null;
  const driver = result.rows[0];

  const decision = await orchestrate({
    agent: 'FUEL_OPTIMIZER',
    driver,
    threshold: 0.15 // 15% above route average
  });

  await logAIEvent('fuel_optimizer', driverId, { driver }, decision);
  return decision;
}

// ================================================================
// Agent 2: Intel Mapper
// Trigger: Merchant GPS cross-reference with survey boundaries
// ================================================================
async function runIntelMapper(merchantId) {
  const result = await db.query(`
    SELECT id, business_name, latitude, longitude, survey_zone, address
    FROM merchants WHERE id = $1
  `, [merchantId]);

  if (!result.rows.length) return null;
  const merchant = result.rows[0];

  const decision = await orchestrate({
    agent: 'INTEL_MAPPER',
    merchant,
    task: 'cross_reference_gps_with_survey_boundary'
  });

  if (decision.action === 'CORRECT_COORDINATES' && decision.data?.new_lat) {
    await db.query(
      'UPDATE merchants SET latitude = $1, longitude = $2, updated_at = NOW() WHERE id = $3',
      [decision.data.new_lat, decision.data.new_lng, merchantId]
    );
  }

  await logAIEvent('intel_mapper', merchantId, { merchant }, decision);
  return decision;
}

// ================================================================
// Agent 3: Sustainability Auditor
// Trigger: Eco-certified merchant activation → GreenPoints
// ================================================================
async function runSustainabilityAuditor(merchantId, agentUserId) {
  const result = await db.query(`
    SELECT m.*, gp.id as greenwallet_id, gp.greenpoints_balance
    FROM merchants m
    LEFT JOIN greenwallet_profiles gp ON gp.user_id = $2
    WHERE m.id = $1
  `, [merchantId, agentUserId]);

  if (!result.rows.length) return null;
  const merchant = result.rows[0];

  const decision = await orchestrate({
    agent: 'SUSTAINABILITY_AUDITOR',
    merchant,
    trigger: 'eco_certified_merchant_activation',
    reward_amount: 500
  });

  if (decision.action === 'DEPOSIT_REWARD' && merchant.greenwallet_id) {
    await db.query(`
      UPDATE greenwallet_profiles 
      SET greenpoints_balance = greenpoints_balance + 500
      WHERE id = $1
    `, [merchant.greenwallet_id]);

    await db.query(`
      INSERT INTO greenpoints_ledger (profile_id, amount, balance_after, reason, reference_id)
      SELECT id, 500, greenpoints_balance, 'eco_merchant_onboard', $1
      FROM greenwallet_profiles WHERE id = $2
    `, [merchantId, merchant.greenwallet_id]);
  }

  await logAIEvent('sustainability_auditor', merchantId, { merchant }, decision);
  return decision;
}

// ================================================================
// Predictive RAG Status Update (runs every 6 hours via cron)
// 7-10 day forecasting window
// ================================================================
async function updateSystemRAGStatus() {
  const [voucherStats, depositStats, contractStats, batchStats] = await Promise.all([
    db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'expired') as expired_today,
        COUNT(*) FILTER (WHERE status = 'frozen') as frozen
      FROM fuel_vouchers 
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `),
    db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
      FROM voucher_deposits 
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `),
    db.query(`
      SELECT COUNT(*) as defaulted 
      FROM fuelflex_contracts 
      WHERE is_defaulted = TRUE AND defaulted_at > NOW() - INTERVAL '7 days'
    `),
    db.query(`
      SELECT COUNT(*) as unlocking_soon
      FROM contribution_batches
      WHERE status = 'active' AND unlock_3m_date <= NOW() + INTERVAL '10 days'
    `)
  ]);

  const systemContext = {
    agent: 'RAG_FORECASTER',
    window: '7_10_day_forecast',
    metrics: {
      easyfuel: voucherStats.rows[0],
      easytransect: depositStats.rows[0],
      fuelflex_defaults: contractStats.rows[0],
      safebet_unlocking: batchStats.rows[0]
    }
  };

  const decision = await orchestrate(systemContext);
  
  await logAIEvent('rag_update', null, systemContext.metrics, decision);
  
  return decision;
}

// ================================================================
// ARIA — MMP.ai Sourcing Agent
// ================================================================
const ARIA_PROMPT = `You are ARIA — the AI Sourcing Agent for MMP.ai.
Connect African merchants to verified Chinese manufacturers.
Calculate total landed cost using:
* Sea Freight: base $120 + $0.8/kg | ETA 21-35 days
* Air Freight: base $280 + $4.5/kg | ETA 5-10 days
Always factor MOQ, Lead Days, and location (e.g., Guangzhou).
Respond in JSON only: { "suppliers": [], "recommended_freight": "sea|air", "total_landed_cost_usd": 0, "eta_days": 0, "notes": "" }`;

async function runARIA(context) {
  try {
    const response = await axios.post(CLAUDE_API, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: ARIA_PROMPT,
      messages: [{
        role: 'user',
        content: `Product: ${context.product}, Quantity: ${context.quantity} ${context.unit}, ` +
                 `Budget: $${context.targetPrice}, Freight preference: ${context.freightMethod || 'any'}`
      }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    return JSON.parse(response.data.content[0].text.trim());
  } catch (err) {
    global.logger?.error('ARIA error:', err.message);
    throw new Error('ARIA sourcing agent unavailable');
  }
}

// ================================================================
// Event Logger
// ================================================================
async function logAIEvent(eventType, triggeredBy, inputData, outputData) {
  try {
    await db.query(`
      INSERT INTO ai_events (event_type, triggered_by, input_data, output_action, output_data, rag_prediction, processed, processed_at)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
    `, [
      eventType,
      triggeredBy,
      JSON.stringify(inputData),
      outputData.action || 'none',
      JSON.stringify(outputData),
      outputData.rag_status || 'green'
    ]);
  } catch (err) {
    global.logger?.warn('AI event log failed:', err.message);
  }
}

module.exports = {
  orchestrate,
  runFuelOptimizer,
  runIntelMapper,
  runSustainabilityAuditor,
  updateSystemRAGStatus,
  runARIA
};
