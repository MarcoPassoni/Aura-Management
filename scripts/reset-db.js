// Azzera completamente il database: elimina tutti i dati e ricrea lo schema.
//
// ATTENZIONE: operazione irreversibile. Tutti gli utenti, tavoli, provvigioni
// e impostazioni vengono cancellati definitivamente.
//
// Uso:
//   node scripts/reset-db.js --conferma

const { run } = require('../services/db-helpers');
const { initSchema } = require('../models/schema');

const TABELLE = [
  'revisioni_tavolo',
  'quote_tavolo',
  'pagamenti_provvigioni',
  'richieste_creazione_pr',
  'tavoli',
  'detrazioni',
  'impostazioni',
  'pr',
  'admin'
];

(async () => {
  if (!process.argv.includes('--conferma')) {
    console.error('ATTENZIONE: questo script cancella TUTTI i dati del database.');
    console.error('Rieseguilo con il flag --conferma per procedere.');
    process.exit(1);
  }

  try {
    await run('PRAGMA foreign_keys = OFF');

    for (const tabella of TABELLE) {
      await run(`DELETE FROM ${tabella}`);
      await run(`DELETE FROM sqlite_sequence WHERE name = '${tabella}'`);
      console.log(`Svuotata: ${tabella}`);
    }

    await run('PRAGMA foreign_keys = ON');

    // Reinizializza lo schema (ricrea indici e strutture di supporto)
    await initSchema({ silenzioso: true });

    console.log('\nDatabase azzerato e schema reinizializzato.');
    console.log('Crea un nuovo amministratore con:');
    console.log('  node scripts/crea-admin.js <nickname> <password>');
    process.exit(0);
  } catch (err) {
    console.error('Errore durante il reset:', err.message);
    process.exit(1);
  }
})();
