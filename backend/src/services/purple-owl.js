// ================================================================
// Purple Owl Payments Service (Softy Comp)
// Agreement signed: 20 August 2025
// PASA Reg: SO001024 / SP001060
// Supports: Visa, Mastercard, Amex, Maestro, Diners
// Modes: E-commerce, EBPP, 3D Secure, MOTO, Cross-border
// ================================================================
const axios = require('axios');

const POP_BASE = process.env.PURPLE_OWL_BASE_URL || 'https://eft.softycomp.co.za/api';

const popClient = axios.create({
  baseURL: POP_BASE,
  headers: {
    'Authorization': `Bearer ${process.env.PURPLE_OWL_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Merchant-ID': process.env.PURPLE_OWL_MERCHANT_ID
  },
  timeout: 30000
});

// Process card payment (3D Secure enabled per agreement)
async function processCardPayment(params) {
  const {
    amount,
    currency = 'ZAR',
    cardToken,
    reference,
    description,
    customerEmail,
    use3DS = process.env.PURPLE_OWL_3DS_ENABLED === 'true',
    isMOTO = false
  } = params;

  const payload = {
    merchant_id: process.env.PURPLE_OWL_MERCHANT_ID,
    amount: parseFloat(amount).toFixed(2),
    currency,
    reference,
    description,
    customer_email: customerEmail,
    card_token: cardToken,
    three_d_secure: use3DS,
    moto: isMOTO,
    transaction_type: isMOTO ? 'non_3d_secured' : '3d_secured'
  };

  try {
    const response = await popClient.post('/transactions/process', payload);
    return {
      success: true,
      transactionId: response.data.transaction_id,
      authCode: response.data.auth_code,
      status: response.data.status,
      raw: response.data
    };
  } catch (err) {
    global.logger?.error('Purple Owl card processing error:', err.response?.data);
    throw new Error(err.response?.data?.message || 'Card processing failed');
  }
}

// Tokenize card for recurring billing
async function tokenizeCard(cardDetails) {
  try {
    const response = await popClient.post('/cards/tokenize', {
      card_number: cardDetails.cardNumber,
      expiry_month: cardDetails.expiryMonth,
      expiry_year: cardDetails.expiryYear,
      cvv: cardDetails.cvv,
      card_holder: cardDetails.cardHolder
    });
    return { token: response.data.card_token, last4: response.data.last_four };
  } catch (err) {
    throw new Error('Card tokenization failed');
  }
}

// EBPP — Electronic Bill Payment Presentment
// Used for automated billing (per Softy Comp agreement)
async function sendEBPP(params) {
  const { customerEmail, customerPhone, amount, reference, dueDate } = params;

  try {
    const response = await popClient.post('/ebpp/send', {
      merchant_id: process.env.PURPLE_OWL_MERCHANT_ID,
      customer_email: customerEmail,
      customer_phone: customerPhone,
      amount: parseFloat(amount).toFixed(2),
      currency: 'ZAR',
      reference,
      due_date: dueDate,
      merchant_name: 'Moveeasy',
      contact_email: 'yangaskaal2@gmail.com',
      contact_phone: '071 173 6340'
    });
    return { success: true, presentment_id: response.data.presentment_id };
  } catch (err) {
    throw new Error('EBPP delivery failed');
  }
}

// Process refund / cashback
async function refundTransaction(transactionId, amountCents) {
  try {
    const response = await popClient.post(`/transactions/${transactionId}/refund`, {
      amount: (amountCents / 100).toFixed(2)
    });
    return { success: true, refund_id: response.data.refund_id };
  } catch (err) {
    global.logger?.error('Purple Owl refund error:', err.response?.data);
    throw new Error('Refund processing failed');
  }
}

// Verify webhook signature from Purple Owl
function verifyWebhookSignature(payload, signature) {
  const crypto = require('crypto');
  const expected = crypto
    .createHmac('sha256', process.env.PURPLE_OWL_API_KEY)
    .update(JSON.stringify(payload))
    .digest('hex');
  return expected === signature;
}

module.exports = {
  processCardPayment,
  tokenizeCard,
  sendEBPP,
  refundTransaction,
  verifyWebhookSignature
};
