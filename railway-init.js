// Inizializzazione del database in fase di deploy.
//
// Questo script chiamava initDB() e creaAdminDefault() da models/db.js: creava
// le tabelle dello schema ORIGINALE (storico_tavoli, richieste_tavoli, pr_stats,
// andamento_staff_mensile e la tabella pr con i contatori incrementali) accanto
// a quelle nuove, e inseriva un amministratore con nickname e password scritti
// nel sorgente pubblicato. Chiunque conoscesse il progetto poteva entrare.
//
// Ora applica lo schema reale e basta. Il primo amministratore si crea a mano,
// una volta sola:  npm run crea-admin -- <nickname> <password>

const { initSchema } = require('./models/schema');
const { contaAdmin } = require('./services/users');
const { chiudi } = require('./models/db');

(async () => {
  try {
    await initSchema();
    const quanti = await contaAdmin();

    console.log('Schema del database applicato.');
    if (quanti === 0) {
      console.log('');
      console.log('Nessun amministratore presente. Creane uno con:');
      console.log('  npm run crea-admin -- <nickname> <password>');
      console.log('');
    } else {
      console.log(`Amministratori presenti: ${quanti}.`);
    }

    await chiudi();
    process.exit(0);
  } catch (err) {
    console.error("Inizializzazione fallita:", err.message);
    process.exit(1);
  }
})();
