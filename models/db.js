// Connessione unica a SQLite e configurazione del motore.
//
// Questo file conteneva anche una seconda definizione dello schema (quello
// originale, con le tabelle storico_tavoli / richieste_tavoli / pr_stats e i
// contatori incrementali) piu' una funzione che inseriva un amministratore con
// password scritta nel sorgente. Bastava importare il modulo per ricreare le
// tabelle vecchie accanto a quelle nuove. Ora resta solo la connessione: lo
// schema vive esclusivamente in models/schema.js.
//
// Tutta l'applicazione usa questa singola connessione. sqlite3 serializza le
// istruzioni sulla stessa connessione, quindi i PRAGMA impostati qui valgono
// per ogni query successiva senza bisogno di attendere.

const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * Percorso del file di database.
 *
 * DB_PATH ha la precedenza (test e script di manutenzione lavorano su un
 * database usa e getta). In produzione su Railway il file vive sul volume
 * persistente, altrimenti sta accanto al codice: il percorso e' assoluto
 * perche' dipendere dalla directory di lavoro significava avere database
 * diversi a seconda di dove veniva lanciato il comando.
 */
function percorsoDatabase() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'iconic.db');
  }
  return path.join(__dirname, '..', 'iconic.db');
}

const dbPath = percorsoDatabase();

// La cartella di destinazione puo' non esistere ancora (primo avvio su volume).
const cartella = path.dirname(dbPath);
if (cartella && !fs.existsSync(cartella)) {
  fs.mkdirSync(cartella, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

// ---------------------------------------------------------------- pragma
//
// Nessuno di questi era impostato: le FOREIGN KEY dichiarate nello schema erano
// puramente decorative (SQLite le ignora se non abilitate esplicitamente, per
// connessione), una scrittura concorrente falliva subito invece di attendere, e
// in caso di interruzione improvvisa si potevano perdere le ultime transazioni.
//
//  foreign_keys  i vincoli di integrita' vengono applicati davvero
//  journal_mode  WAL: letture e scritture non si bloccano a vicenda
//  busy_timeout  attende invece di restituire SQLITE_BUSY
//  synchronous   FULL: una transazione confermata e' su disco. Su dati
//                contabili la sicurezza vale piu' della velocita'.
db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 10000');
  db.run('PRAGMA synchronous = FULL');
});

/** Chiusura ordinata: usata dallo spegnimento del server e dagli script. */
function chiudi() {
  return new Promise((resolve) => {
    db.close(() => resolve());
  });
}

module.exports = { db, dbPath, chiudi, percorsoDatabase };
