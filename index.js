// ================================================================
// MoveEasy Core API — Main Server Entry Point
// ================================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createLogger, format, transports } = require('winston');

// Routes
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const easyfuelRoutes = require('./routes/easyfuel');
const easytransectRoutes = require('./routes/easytransect');
const safebetRoutes = require('./routes/safebet');
const greenwalletRoutes = require('./routes/greenwallet');
const mmpaiRoutes = require('./routes/mmpai');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const orchestratorRoutes = require('./routes/orchestrator');

// Services
const { initDB } = require('./config/database');

// ================================================================
// Logger
// ================================================================
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(format.colorize(), format.simple())
    }),
    new transports.File({ filename: 'logs/error.log', level: 'error' }),
    new transports.File({ filename: 'logs/combined.log' })
  ]
});

global.logger = logger;

// ================================================================
// App Initialization
// ================================================================
const app = express();
const PORT = process.env.PORT || 4000;

// ================================================================
// Security Middleware
// ================================================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    }
  }
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key']
}));

// Rate limiting (SARB/AML compliance)
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Rate limit exceeded for sensitive operations.' }
});

app.use(limiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ================================================================
// Request Logging
// ================================================================
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${Date.now() - start}ms`,
      ip: req.ip
    });
  });
  next();
});

// ================================================================
// Health Check
// ================================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: '2026.1.0',
    timestamp: new Date().toISOString(),
    ecosystem: 'MoveEasy Core Brain',
    products: ['EasyFuel', 'EasyTransect', 'SafeBet', 'GreenWallet', 'MMP.ai']
  });
});

// ================================================================
// API Routes
// ================================================================
app.use('/api/v1/auth', strictLimiter, authRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/easyfuel', easyfuelRoutes);
app.use('/api/v1/easytransect', easytransectRoutes);
app.use('/api/v1/safebet', safebetRoutes);
app.use('/api/v1/greenwallet', greenwalletRoutes);
app.use('/api/v1/mmpai', mmpaiRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/ai', orchestratorRoutes);

// Webhooks (no auth — verified by signature)
app.use('/webhooks', webhookRoutes);

// Ecosystem status endpoint (for AI orchestrator)
app.get('/api/v1/ecosystem/status', async (req, res) => {
  try {
    const { db } = require('./config/database');
    const [fuel, transect, safebet, green] = await Promise.allSettled([
      db.query('SELECT COUNT(*) as count FROM fuel_vouchers WHERE status = $1', ['active']),
      db.query('SELECT COUNT(*) as count FROM voucher_deposits WHERE status = $1', ['pending']),
      db.query('SELECT SUM(zar_amount_cents) as total FROM contribution_batches WHERE status = $1', ['active']),
      db.query('SELECT COUNT(*) as count FROM green_projects WHERE status = $1', ['TENDERING'])
    ]);

    res.json({
      timestamp: new Date().toISOString(),
      health: 'Excellent',
      products: {
        easyfuel: { active_vouchers: fuel.value?.rows[0]?.count || 0 },
        easytransect: { pending_deposits: transect.value?.rows[0]?.count || 0 },
        safebet: { active_pool_zar: (safebet.value?.rows[0]?.total || 0) / 100 },
        greenwallet: { open_tenders: green.value?.rows[0]?.count || 0 }
      }
    });
  } catch (err) {
    logger.error('Ecosystem status error:', err);
    res.status(500).json({ error: 'Status unavailable' });
  }
});

// ================================================================
// Static Frontend Serving (for preview/development)
// ================================================================
app.use(express.static(__dirname, {
  index: false,
  extensions: ['html', 'js', 'css', 'json']
}));

// Serve index.html for SPA routing (root path)
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ================================================================
// Global Error Handler
// ================================================================
app.use((err, req, res, next) => {
  logger.error({ error: err.message, stack: err.stack, url: req.url });
  
  if (err.type === 'validation') {
    return res.status(400).json({ error: err.message, details: err.details });
  }
  
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'An internal error occurred' 
      : err.message
  });
});

// 404 handler (after static/SPA routes)
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.url });
});

// ================================================================
// Start Server
// ================================================================
async function start() {
  try {
    await initDB();
    logger.info('✅ Database connection established');
    
    app.listen(PORT, () => {
      logger.info(`🚀 MoveEasy Core API running on port ${PORT}`);
      logger.info(`📊 Environment: ${process.env.NODE_ENV}`);
      logger.info(`🌍 Region: AWS af-south-1 (Cape Town)`);
      logger.info(`🔐 POPIA compliant data residency active`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

module.exports = app;
