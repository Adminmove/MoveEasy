// ================================================================
// Database Configuration (Mock for Preview)
// ================================================================

module.exports = {
  initDB: async () => {
    console.log('📦 Database connection skipped (preview mode)');
  },
  db: {
    query: async () => ({ rows: [] })
  }
};
