// ================================================================
// VALR Service — ZAR → USDC Conversion for SafeBet
// Async trading via BullMQ worker
// ================================================================
const axios = require('axios');
const crypto = require('crypto');

const VALR_BASE = process.env.VALR_BASE_URL || 'https://api.valr.com';

function signRequest(apiKey, apiSecret, timestamp, verb, path, body = '') {
  const payload = `${timestamp}${verb.toUpperCase()}${path}${body}`;
  return crypto.createHmac('sha512', apiSecret).update(payload).digest('hex');
}

function getHeaders(verb, path, body = '') {
  const timestamp = Date.now().toString();
  const signature = signRequest(
    process.env.VALR_API_KEY,
    process.env.VALR_API_SECRET,
    timestamp,
    verb,
    path,
    body
  );

  return {
    'X-VALR-API-KEY': process.env.VALR_API_KEY,
    'X-VALR-SIGNATURE': signature,
    'X-VALR-TIMESTAMP': timestamp,
    'Content-Type': 'application/json'
  };
}

async function valrRequest(method, path, data = null) {
  const body = data ? JSON.stringify(data) : '';
  const headers = getHeaders(method, path, body);

  try {
    const response = await axios({
      method,
      url: `${VALR_BASE}${path}`,
      headers,
      data: data || undefined,
      timeout: 10000
    });
    return response.data;
  } catch (err) {
    global.logger?.error('VALR API error:', { path, error: err.response?.data });
    throw new Error(`VALR API error: ${err.response?.data?.message || err.message}`);
  }
}

// Get current ZAR/USDC rate
async function getZARUSDCRate() {
  const ticker = await valrRequest('GET', '/v1/public/ZARUSDC/marketsummary');
  return {
    bid: parseFloat(ticker.bidPrice),
    ask: parseFloat(ticker.askPrice),
    last: parseFloat(ticker.lastTradedPrice),
    timestamp: ticker.created
  };
}

// Convert ZAR to USDC (market order)
async function convertZARtoUSDC(zarAmount) {
  const rate = await getZARUSDCRate();
  const usdcExpected = zarAmount / rate.ask;

  const order = await valrRequest('POST', '/v1/orders/market', {
    side: 'BUY',
    pair: 'ZARUSDC',
    quoteOrderQuantity: zarAmount.toFixed(2)  // spend exactly this ZAR
  });

  return {
    orderId: order.id,
    zarSpent: zarAmount,
    usdcAcquired: parseFloat(order.quantity || usdcExpected),
    rate: rate.ask,
    status: order.orderStatusType
  };
}

// Get USDC balance
async function getUSDCBalance() {
  const balances = await valrRequest('GET', '/v1/account/balances');
  const usdc = balances.find(b => b.currency === 'USDC');
  return usdc ? parseFloat(usdc.available) : 0;
}

// Get portfolio summary for SafeBet admin pool
async function getPoolSummary() {
  const balances = await valrRequest('GET', '/v1/account/balances');
  const rate = await getZARUSDCRate();

  const usdc = balances.find(b => b.currency === 'USDC');
  const usdcBalance = usdc ? parseFloat(usdc.available) : 0;

  return {
    usdc_balance: usdcBalance,
    zar_equivalent: usdcBalance * rate.bid,
    rate_bid: rate.bid,
    rate_ask: rate.ask,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  getZARUSDCRate,
  convertZARtoUSDC,
  getUSDCBalance,
  getPoolSummary
};
