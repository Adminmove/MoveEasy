// ================================================================
// Auth Middleware — JWT Verification + KYC Gate
// ================================================================
const jwt = require('jsonwebtoken');
const { db } = require('../config/database');

// Verify JWT and attach user to request
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch fresh user from DB (catches suspensions)
    const result = await db.query(
      `SELECT u.id, u.email, u.kyc_status, u.kyc_tier, u.is_active, u.is_suspended,
              es.rag_status, es.ecosystem_score
       FROM users u
       LEFT JOIN ecosystem_sync es ON es.user_id = u.id
       WHERE u.id = $1`,
      [payload.userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    if (!user.is_active || user.is_suspended) {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// KYC requirement gate
function requireKYC(minTier = 1) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.kyc_status !== 'verified') {
      return res.status(403).json({
        error: 'KYC verification required',
        code: 'KYC_REQUIRED',
        kyc_status: req.user.kyc_status,
        redirect: '/kyc/start'
      });
    }
    if (req.user.kyc_tier < minTier) {
      return res.status(403).json({
        error: `KYC Tier ${minTier} required for this action`,
        code: 'KYC_TIER_INSUFFICIENT',
        current_tier: req.user.kyc_tier,
        required_tier: minTier
      });
    }
    next();
  };
}

// Admin role guard
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { authenticate, requireKYC, requireAdmin };
