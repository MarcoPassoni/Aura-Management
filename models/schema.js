// Schema del database: definizione unica, idempotente, applicata a ogni avvio.
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
//    decrementava quando un tavolo veniva modificato o cancellato.
//
//  * `pagamenti_provvigioni.pagante_tipo` distingue se a pagare e' stato un
//    admin o un PR. Prima `pr_pagante_id` conteneva indifferentemente l'id di
//    un admin o di un PR, due insiemi di id che possono coincidere.
//
//  * `tavoli.incasso_effettivo` separa il preventivo dal consuntivo: le
//    provvigioni si calcolano sull'incasso reale quando c'e', sul preventivo
//    finche' non c'e'.
//
//  * `quote_tavolo` fotografa le percentuali al momento dell'approvazione, cosi'
//    che cambiare una percentuale non riscriva il passato gia' pagato.

const { run, all, get } = require('../services/db-helpers');
const { initSettingsSchema } = require('../services/settings');
const quote = require('../services/quote');

const TAVOLO_STATI = ['in_attesa', 'approvato', 'rifiutato'];

async function initSchema({ silenzioso = false } = {}) {
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
  //
  // `spesa_prevista` e' il preventivo dichiarato alla prenotazione.
  // `incasso_effettivo` e' il conto reale della serata, inserito dopo.
  // Le provvigioni usano il secondo se c'e', il primo altrimenti: la base di
  // calcolo e' sempre una sola e sempre visibile nell'interfaccia.
  await run(`CREATE TABLE IF NOT EXISTS tavoli (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    nome_tavolo TEXT NOT NULL,
    numero_persone INTEGER NOT NULL CHECK(numero_persone > 0),
    spesa_prevista REAL NOT NULL CHECK(spesa_prevista >= 0),
    incasso_effettivo REAL CHECK(incasso_effettivo IS NULL OR incasso_effettivo >= 0),
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

  // Database gia' esistenti: la colonna viene aggiunta senza CHECK, perche'
  // ALTER TABLE non lo consente in tutte le versioni di SQLite. Il controllo
  // di non negativita' e' comunque applicato da services/validation.js, che e'
  // l'unico punto da cui un importo puo' entrare.
  await assicuraColonna('tavoli', 'incasso_effettivo', 'REAL');

  // ---- Quote di provvigione congelate -------------------------------------
  //
  // Una riga per ogni collaboratore che partecipa a un tavolo approvato, con la
  // percentuale in vigore in quel momento. Vedi services/quote.js per il
  // ragionamento completo.
  await run(`CREATE TABLE IF NOT EXISTS quote_tavolo (
    tavolo_id INTEGER NOT NULL,
    pr_id INTEGER NOT NULL,
    livello INTEGER NOT NULL CHECK(livello >= 0),
    percentuale REAL NOT NULL
      CHECK(percentuale >= 0 AND percentuale <= 100),
    percentuale_sotto REAL NOT NULL DEFAULT 0
      CHECK(percentuale_sotto >= 0 AND percentuale_sotto <= 100),
    debitore_tipo TEXT NOT NULL CHECK(debitore_tipo IN ('admin', 'pr')),
    debitore_id INTEGER NOT NULL,
    admin_id INTEGER NOT NULL,
    PRIMARY KEY (tavolo_id, pr_id),
    FOREIGN KEY(tavolo_id) REFERENCES tavoli(id) ON DELETE CASCADE,
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

  // I tavoli approvati prima dell'introduzione delle quote non hanno una
  // fotografia della catena: la si ricostruisce dalla struttura attuale, una
  // volta sola. A regime questa chiamata non trova nulla da fare.
  const recupero = await quote.ricostruisciMancanti();
  if (!silenzioso && (recupero.ricostruiti || recupero.falliti.length)) {
    console.log(
      `[SCHEMA] Quote di provvigione ricostruite per ${recupero.ricostruiti} tavoli gia' approvati.`
    );
    if (recupero.falliti.length) {
      console.warn(
        `[SCHEMA] ${recupero.falliti.length} tavoli approvati non hanno una catena ` +
          'ricostruibile e restano esclusi dai calcoli: vedi la pagina Verifica.'
      );
    }
  }

  return recupero;
}

async function creaIndici() {
  const indici = [
    'CREATE INDEX IF NOT EXISTS idx_pr_padre ON pr(fk_padre)',
    'CREATE INDEX IF NOT EXISTS idx_pr_attivo ON pr(attivo)',
    'CREATE INDEX IF NOT EXISTS idx_tavoli_pr ON tavoli(pr_id)',
    'CREATE INDEX IF NOT EXISTS idx_tavoli_stato ON tavoli(stato)',
    'CREATE INDEX IF NOT EXISTS idx_tavoli_data ON tavoli(data)',
    'CREATE INDEX IF NOT EXISTS idx_tavoli_stato_data ON tavoli(stato, data)',
    'CREATE INDEX IF NOT EXISTS idx_quote_pr ON quote_tavolo(pr_id)',
    'CREATE INDEX IF NOT EXISTS idx_quote_debitore ON quote_tavolo(debitore_tipo, debitore_id)',
    'CREATE INDEX IF NOT EXISTS idx_quote_admin ON quote_tavolo(admin_id)',
    'CREATE INDEX IF NOT EXISTS idx_pagamenti_dest ON pagamenti_provvigioni(pr_destinatario_id)',
    'CREATE INDEX IF NOT EXISTS idx_pagamenti_coppia ON pagamenti_provvigioni(pr_destinatario_id, pagante_tipo, pagante_id)',
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

/** Aggiunge una colonna se manca. Non tocca nulla se e' gia' presente. */
async function assicuraColonna(tabella, colonna, definizione) {
  const colonne = await colonneDi(tabella);
  if (colonne.size === 0 || colonne.has(colonna)) return false;
  await run(`ALTER TABLE ${tabella} ADD COLUMN ${colonna} ${definizione}`);
  return true;
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
  assicuraColonna,
  tabelleEsistenti,
  colonneDi,
  contaRighe,
  TAVOLO_STATI
};
