// ================================================================
// Smile ID — KYC Service (FICA-compliant biometric verification)
// Once-only KYC: verified once, usable across all MoveEasy products
// ================================================================
const axios = require('axios');
const crypto = require('crypto');

const SMILE_BASE = process.env.SMILE_ID_BASE_URL || 'https://api.smileidentity.com/v1';

function generateSmileSignature() {
  const timestamp = new Date().toISOString();
  const hashPayload = `${timestamp}${process.env.SMILE_ID_PARTNER_ID}${process.env.SMILE_ID_API_KEY}`;
  const hash = crypto.createHash('sha256').update(hashPayload).digest('base64');
  return { timestamp, signature: hash };
}

// Submit KYC identity verification
async function submitIdentityVerification(params) {
  const { userId, idNumber, firstName, lastName, dob, idType = 'NATIONAL_ID' } = params;
  const { timestamp, signature } = generateSmileSignature();

  try {
    const response = await axios.post(`${SMILE_BASE}/id_verification`, {
      partner_id: process.env.SMILE_ID_PARTNER_ID,
      timestamp,
      signature,
      partner_params: {
        user_id: userId,
        job_id: `kyc_${userId}_${Date.now()}`,
        job_type: 5 // Enhanced KYC
      },
      id_info: {
        first_name: firstName,
        last_name: lastName,
        dob,
        country: 'ZA',
        id_type: idType,
        id_number: idNumber
      },
      callback_url: process.env.SMILE_ID_CALLBACK_URL,
      options: {
        return_job_status: true
      }
    }, { timeout: 30000 });

    return {
      success: true,
      jobId: response.data.job_id || response.data.partner_params?.job_id,
      result: response.data.result,
      status: response.data.job_success ? 'verified' : 'pending'
    };
  } catch (err) {
    global.logger?.error('Smile ID verification error:', err.response?.data);
    throw new Error('KYC verification submission failed');
  }
}

// Submit liveness check (biometric)
async function submitLivenessCheck(params) {
  const { userId, selfieBase64 } = params;
  const { timestamp, signature } = generateSmileSignature();

  try {
    const response = await axios.post(`${SMILE_BASE}/smile_links`, {
      partner_id: process.env.SMILE_ID_PARTNER_ID,
      timestamp,
      signature,
      partner_params: {
        user_id: userId,
        job_id: `liveness_${userId}_${Date.now()}`,
        job_type: 4 // Liveness check
      },
      image_list: [{
        image_type_id: 0,
        image: selfieBase64
      }],
      callback_url: process.env.SMILE_ID_CALLBACK_URL
    }, { timeout: 30000 });

    return {
      success: true,
      jobId: response.data.partner_params?.job_id
    };
  } catch (err) {
    throw new Error('Liveness check failed');
  }
}

// Process Smile ID callback webhook
function processCallback(webhookData) {
  const { job_success, result, partner_params } = webhookData;
  
  return {
    userId: partner_params?.user_id,
    jobId: partner_params?.job_id,
    success: job_success === 'true' || job_success === true,
    resultCode: result?.ResultCode,
    resultText: result?.ResultText,
    confidence: result?.Confidence,
    verified: result?.ResultCode === '1012' || result?.ResultCode === '1021'
  };
}

// Send OTP for phone verification (Clickatell)
async function sendOTP(phone) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = crypto.createHash('sha256').update(otp + process.env.APP_SECRET).digest('hex');

  try {
    await axios.post('https://platform.clickatell.com/messages', {
      to: [phone],
      content: `MoveEasy verification code: ${otp}. Valid for 5 minutes. Do not share.`
    }, {
      headers: {
        'Authorization': process.env.CLICKATELL_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    return { otpHash, expiresAt: new Date(Date.now() + 5 * 60 * 1000) };
  } catch (err) {
    global.logger?.error('OTP send failed:', err.response?.data);
    throw new Error('Failed to send verification code');
  }
}

module.exports = {
  submitIdentityVerification,
  submitLivenessCheck,
  processCallback,
  sendOTP
};
