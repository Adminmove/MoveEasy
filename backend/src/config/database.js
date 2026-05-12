// ================================================================
// Database Configuration — PostgreSQL Connection Pool
// ================================================================
const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.DB_POOL_MAX) || 20,
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: true,
        ca: process.env.DB_SSL_CERT
      } : false
    });

    pool.on('error', (err) => {
      global.logger?.error('Unexpected DB pool error:', err);
    });

    pool.on('connect', () => {
      global.logger?.debug('New DB connection established');
    });
  }
  return pool;
}

async function initDB() {
  const client = await getPool().connect();
  try {
    await client.query('SELECT NOW()');
    global.logger?.info('PostgreSQL connection pool initialized');
  } finally {
    client.release();
  }
}

// Atomic transaction wrapper
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  db: getPool(),
  getPool,
  initDB,
  withTransaction
};
