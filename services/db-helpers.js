// Helper promisificati per sqlite3 + gestione transazioni.
// Sostituisce il "callback hell" sparso nel codice originale e garantisce
// che ogni operazione multi-tabella sia atomica.
const { db } = require('../models/db');
const { logger } = require('../utils/secure-logger');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

// sqlite3 serializza le query sulla stessa connessione, ma le transazioni
// non sono annidabili: teniamo una coda per evitare BEGIN dentro BEGIN.
let transactionChain = Promise.resolve();

function transaction(work) {
  const result = transactionChain.then(async () => {
    await run('BEGIN IMMEDIATE');
    try {
      const value = await work({ run, get, all });
      await run('COMMIT');
      return value;
    } catch (err) {
      try {
        await run('ROLLBACK');
      } catch (rollbackErr) {
        // Se anche il rollback fallisce, l'errore originale resta quello utile.
        logger.error('Rollback fallito dopo un errore di transazione.', {
          categoria: 'database',
          errore: rollbackErr.message
        });
      }
      throw err;
    }
  });

  // La catena prosegue anche se questa transazione fallisce.
  transactionChain = result.catch(() => {});
  return result;
}

module.exports = { db, run, get, all, transaction };
