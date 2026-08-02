// Schema del database - definizione unica e idempotente.
//
// Differenze rispetto allo schema originale:
//
//  * `richieste_tavoli` + `storico_tavoli` sono state unificate in `tavoli`.
//    Prima l'approvazione spostava fisicamente la riga da una tabella all'altra
//    e il rifiuto la cancellava: lo storico dei rifiuti era irrecuperabile e
//    ogni spostamento poteva lasciare i dati a meta' (non c'erano transazioni).
//
//  * Rimossi da `pr` i contatori `provvigioni_da_pagare`, `tot_spesa_tavolo`,
//    `tot_persone_portate`, `provvigioni_totali_maturate`,
//    `provvigioni_totali_pagate`, e rimosse le tabelle `pr_stats` e
//    `andamento_staff_mensile`. Erano cache incrementali che nessuno
//    decrementava quando un tavolo veniva modificato o cancellato: la causa
//    principale dei numeri che non tornavano. Tutti quei valori ora sono
//    calcolati al volo da services/commissions.js.
//
//  * `pagamenti_provvigioni.pagante_tipo` distingue se a pagare e' stato un
//    admin o un PR. Prima `pr_pagante_id` conteneva indifferentemente l'id di
//    un admin o di un PR, due insiemi di id che possono coincidere.

const { run, all, get } = require('../services/db-helpers');
const { initSettingsSchema } = require('../services/settings');

const TAVOLO_STATI = ['in_attesa', 'approvato', 'rifiutato'];

async function initSchema() {
  // ---- Utenti -------------------------------------------------------------
  await run(`CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cognome TEXT NOT NULL,
    numero_telefono TEXT NOT NULL,
    nickname TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    creato_il TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS pre_admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fk_admin INTEGER NOT NULL,
    nome TEXT NOT NULL,
    cognome TEXT NOT NULL,
    numero_telefono TEXT NOT NULL,
    nickname TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    attivo INTEGER NOT NULL DEFAULT 1,
    creato_il TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(fk_admin) REFERENCES admin(id)
  )`);

  // `fk_padre` punta a admin.id oppure a pr.id: due insiemi di identificativi
  // che si sovrappongono (esistono sia un admin 1 sia un PR 1). Per questo
  // `padre_tipo` dice esplicitamente in quale tabella cercare.
  //
  // L'originale risolveva l'ambiguita' tentando prima una tabella e poi l'altra,
  // con l'effetto che un PR di primo livello con fk_padre = 1 veniva agganciato
  // al PR numero 1 invece che all'amministratore.
  await run(`CREATE TABLE IF NOT EXISTS pr (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fk_padre INTEGER,
    padre_tipo TEXT NOT NULL DEFAULT 'pr' CHECK(padre_tipo IN ('admin', 'pr')),
    nome TEXT NOT NULL,
    cognome TEXT NOT NULL,
    numero_telefono TEXT NOT NULL,
    nickname TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    percentuale_provvigione REAL NOT NULL DEFAULT 0
      CHECK(percentuale_provvigione >= 0 AND percentuale_provvigione <= 100),
    poteri INTEGER NOT NULL DEFAULT 0,
    attivo INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    creato_il TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // ---- Tavoli -------------------------------------------------------------
  await run(`CREATE TABLE IF NOT EXISTS tavoli (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    nome_tavolo TEXT NOT NULL,
    numero_persone INTEGER NOT NULL CHECK(numero_persone > 0),
    spesa_prevista REAL NOT NULL CHECK(spesa_prevista >= 0),
    omaggi TEXT,
    note_tavolo TEXT,
    stato TEXT NOT NULL DEFAULT 'in_attesa'
      CHECK(stato IN ('in_attesa', 'approvato', 'rifiutato')),
    modificata INTEGER NOT NULL DEFAULT 0,
    note_modifiche TEXT,
    modificato_da_nickname TEXT,
    creato_il TEXT DEFAULT CURRENT_TIMESTAMP,
    deciso_il TEXT,
    deciso_da_nickname TEXT,
    motivo_rifiuto TEXT,
    FOREIGN KEY(pr_id) REFERENCES pr(id)
  )`);

  // ---- Pagamenti ----------------------------------------------------------
  await run(`CREATE TABLE IF NOT EXISTS pagamenti_provvigioni (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_destinatario_id INTEGER NOT NULL,
    pagante_tipo TEXT NOT NULL DEFAULT 'pr' CHECK(pagante_tipo IN ('admin', 'pr')),
    pagante_id INTEGER NOT NULL,
    importo REAL NOT NULL CHECK(importo > 0),
    note TEXT,
    data_pagamento TEXT DEFAULT CURRENT_TIMESTAMP,
    registrato_da_nickname TEXT,
    FOREIGN KEY(pr_destinatario_id) REFERENCES pr(id)
  )`);

  // ---- Richieste di creazione PR -----------------------------------------
  await run(`CREATE TABLE IF NOT EXISTS richieste_creazione_pr (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cognome TEXT NOT NULL,
    numero_telefono TEXT NOT NULL,
    nickname TEXT NOT NULL,
    password TEXT NOT NULL,
    percentuale_provvigione REAL NOT NULL DEFAULT 0,
    stato TEXT NOT NULL DEFAULT 'in_attesa'
      CHECK(stato IN ('in_attesa', 'approvata', 'rifiutata')),
    note TEXT,
    fk_richiedente INTEGER,
    fk_padre_proposto INTEGER,
    note_admin TEXT,
    data_richiesta TEXT DEFAULT CURRENT_TIMESTAMP,
    data_risposta TEXT,
    FOREIGN KEY(fk_richiedente) REFERENCES pr(id)
  )`);

  await initSettingsSchema();
  await creaIndici();
}

async function creaIndici() {
  const indici = [
    'CREATE INDEX IF NOT EXISTS idx_pr_padre ON pr(fk_padre)',
    'CREATE INDEX IF NOT EXISTS idx_pr_attivo ON pr(attivo)',
    'CREATE INDEX IF NOT EXISTS idx_tavoli_pr ON tavoli(pr_id)',
    'CREATE INDEX IF NOT EXISTS idx_tavoli_stato ON tavoli(stato)',
    'CREATE INDEX IF NOT EXISTS idx_tavoli_data ON tavoli(data)',
    'CREATE INDEX IF NOT EXISTS idx_tavoli_stato_data ON tavoli(stato, data)',
    'CREATE INDEX IF NOT EXISTS idx_pagamenti_dest ON pagamenti_provvigioni(pr_destinatario_id)',
    'CREATE INDEX IF NOT EXISTS idx_richieste_pr_stato ON richieste_creazione_pr(stato)'
  ];
  // Durante una migrazione gli indici possono riferirsi a colonne che esistono
  // solo nello schema nuovo: si salta l'indice invece di interrompere tutto,
  // tanto creaIndici() viene richiamata a migrazione conclusa.
  for (const sql of indici) {
    try {
      await run(sql);
    } catch (err) {
      if (!/no such column|no such table/i.test(err.message)) throw err;
    }
  }
}

/** Elenco delle tabelle realmente presenti nel database. */
async function tabelleEsistenti() {
  const righe = await all("SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(righe.map((r) => r.name));
}

/** Colonne di una tabella (vuoto se la tabella non esiste). */
async function colonneDi(tabella) {
  const righe = await all(`PRAGMA table_info(${tabella})`);
  return new Set(righe.map((r) => r.name));
}

async function contaRighe(tabella) {
  try {
    const r = await get(`SELECT COUNT(*) AS n FROM ${tabella}`);
    return r ? r.n : 0;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  initSchema,
  creaIndici,
  tabelleEsistenti,
  colonneDi,
  contaRighe,
  TAVOLO_STATI
};
