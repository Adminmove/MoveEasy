// ================================================================
// PayFast Payment Service
// MoveEasy merchant account — per Nedbank/PayFast agreements
// ================================================================
const crypto = require('crypto');
const axios = require('axios');

const PAYFAST_BASE = process.env.PAYFAST_SANDBOX === 'true'
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

const PAYFAST_API = process.env.PAYFAST_SANDBOX === 'true'
  ? 'https://api.sandbox.payfast.co.za/merchant'
  : 'https://api.payfast.co.za/merchant';

// Build PayFast MD5 signature
function buildSignature(data, passPhrase = null) {
  let str = Object.keys(data)
    .filter(k => data[k] !== '' && data[k] !== null && data[k] !== undefined)
    .sort()
    .map(k => `${k}=${encodeURIComponent(String(data[k])).replace(/%20/g, '+')}`)
    .join('&');

  if (passPhrase) {
    str += `&passphrase=${encodeURIComponent(passPhrase).replace(/%20/g, '+')}`;
  }

  return crypto.createHash('md5').update(str).digest('hex');
}

// Build query string for signature verification
function buildQueryString(data) {
  return Object.keys(data)
    .filter(k => k !== 'signature')
    .map(k => `${k}=${encodeURIComponent(String(data[k])).replace(/%20/g, '+')}`)
    .join('&');
}

// Verify PayFast ITN (webhook) signature
function verifyPayFastITN(data) {
  const receivedSignature = data.signature;
  const expectedSignature = buildSignature(data, process.env.PAYFAST_PASSPHRASE);
  return receivedSignature === expectedSignature;
}

// Generate payment URL for standard EFT payment
function generatePaymentURL(params) {
  const data = {
    merchant_id: process.env.PAYFAST_MERCHANT_ID,
    merchant_key: process.env.PAYFAST_MERCHANT_KEY,
    return_url: params.returnUrl,
    cancel_url: params.cancelUrl,
    notify_url: process.env.PAYFAST_NOTIFY_URL,
    name_first: params.firstName,
    name_last: params.lastName,
    email_address: params.email,
    m_payment_id: params.paymentId,
    amount: params.amountZAR.toFixed(2),
    item_name: params.itemName,
    item_description: params.description || '',
    custom_str1: params.product || '',
    custom_str2: params.userId || '',
    ...params.extra
  };

  data.signature = buildSignature(data, process.env.PAYFAST_PASSPHRASE);

  const queryString = Object.keys(data)
    .map(k => `${k}=${encodeURIComponent(String(data[k]))}`)
    .join('&');

  return `${PAYFAST_BASE}?${queryString}`;
}

// Atomic EFT disbursement (EasyTransect payout to SA bank)
// This is the core of the EasyTransect liquidity bridge
async function disburseFunds(params) {
  const { walletId, bankDetails, amountCents, idempotencyKey } = params;

  // Idempotency check handled by caller

  const disbursementData = {
    merchant_id: process.env.PAYFAST_MERCHANT_ID,
    merchant_key: process.env.PAYFAST_MERCHANT_KEY,
    amount: (amountCents / 100).toFixed(2),
    bank_name: bankDetails.bankName,
    account_number: bankDetails.accountNumber,
    account_holder_name: bankDetails.accountHolder,
    branch_code: bankDetails.branchCode,
    reference: idempotencyKey,
  };

  const signature = buildSignature(disbursementData, process.env.PAYFAST_PASSPHRASE);

  try {
    const response = await axios.post(`${PAYFAST_API}/disbursements`, {
      ...disbursementData,
      signature
    }, {
      headers: {
        'Merchant-Id': process.env.PAYFAST_MERCHANT_ID,
        'version': 'v1',
        'timestamp': new Date().toISOString()
      },
      timeout: 15000
    });

    return {
      success: true,
      reference: response.data.reference || idempotencyKey,
      status: response.data.status
    };
  } catch (err) {
    global.logger?.error('PayFast disbursement error:', {
      error: err.message,
      idempotencyKey
    });
    throw new Error(`Disbursement failed: ${err.response?.data?.message || err.message}`);
  }
}

// Recurring billing setup (FuelFlex repayments)
async function createSubscription(params) {
  const { userId, email, amountCents, frequency, startDate, itemName } = params;

  return generatePaymentURL({
    ...params,
    amountZAR: amountCents / 100,
    extra: {
      subscription_type: 1,
      billing_date: startDate,
      recurring_amount: (amountCents / 100).toFixed(2),
      frequency: frequency || 3, // 3 = monthly
      cycles: 0 // indefinite
    }
  });
}

module.exports = {
  generatePaymentURL,
  disburseFunds,
  createSubscription,
  verifyPayFastITN,
  buildSignature,
  buildQueryString
};
