// Migrazione dallo schema originale a quello ristrutturato.
//
// Esecuzione:  npm run migrate            (mostra solo cosa farebbe)
//              npm run migrate -- --apply (esegue davvero)
//
// Lo script e' conservativo: crea sempre una copia di sicurezza del file prima
// di toccare qualsiasi cosa, e stampa un confronto tra i vecchi contatori
// incrementali e i valori ricalcolati dai dati grezzi, cosi' si vede di quanto
// erano andati in deriva.

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const dbPath =
  process.env.DB_PATH ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'iconic.db')
    : './iconic.db');

const { run, all, get, transaction } = require('../services/db-helpers');
const schema = require('../models/schema');

function log(msg = '') {
  console.log(msg);
}

function euro(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

async function backup() {
  if (!fs.existsSync(dbPath)) {
    log(`Nessun database esistente in ${dbPath}: verra' creato da zero.`);
    return null;
  }
  const dest = `${dbPath}.pre-migrazione-${new Date().toISOString().slice(0, 10)}`;
  if (APPLY) {
    fs.copyFileSync(dbPath, dest);
    log(`Copia di sicurezza creata: ${dest}`);
  } else {
    log(`(simulazione) La copia di sicurezza verrebbe creata in: ${dest}`);
  }
  return dest;
}

/** Confronto tra i contatori memorizzati e la realta' dei dati grezzi. */
async function riconciliazione(tabelle) {
  if (!tabelle.has('pr')) return;
  const colonne = await schema.colonneDi('pr');
  if (!colonne.has('tot_spesa_tavolo')) {
    log('I contatori incrementali non sono presenti: niente da riconciliare.');
    return;
  }

  const sorgente = tabelle.has('storico_tavoli') ? 'storico_tavoli' : null;
  if (!sorgente) {
    log('Nessuno storico tavoli da confrontare.');
    return;
  }

  const righe = await all(`
    SELECT p.id, p.nickname,
           COALESCE(p.tot_spesa_tavolo, 0)      AS contatore_spesa,
           COALESCE(p.provvigioni_da_pagare, 0) AS contatore_provvigioni,
           COALESCE((SELECT SUM(spesa_prevista) FROM ${sorgente} WHERE pr_id = p.id), 0) AS reale_spesa
    FROM pr p ORDER BY p.id`);

  if (righe.length === 0) return;

  log('');
  log('CONFRONTO CONTATORI MEMORIZZATI vs DATI REALI');
  log('(il contatore includeva anche il fatturato dei collaboratori e non veniva');
  log(' mai decrementato: qualsiasi scostamento qui e\' un errore accumulato)');
  log('');
  log('  PR                 contatore     reale      scostamento');
  let scostamentoTotale = 0;
  for (const r of righe) {
    const diff = euro(r.contatore_spesa - r.reale_spesa);
    scostamentoTotale += Math.abs(diff);
    const marcatore = Math.abs(diff) > 0.005 ? '  <-- incoerente' : '';
    log(
      `  ${String(r.nickname).padEnd(18)} ${String(euro(r.contatore_spesa)).padStart(9)} ` +
        `${String(euro(r.reale_spesa)).padStart(9)} ${String(diff).padStart(12)}${marcatore}`
    );
  }
  log('');
  log(`  Scostamento complessivo: ${euro(scostamentoTotale)} EUR`);
  log('  Dopo la migrazione questi contatori spariscono: i valori vengono');
  log('  ricalcolati dai tavoli a ogni richiesta, quindi non possono piu\' divergere.');
}

async function migraTavoli(tabelle) {
  let importati = 0;

  if (tabelle.has('storico_tavoli')) {
    const colonne = await schema.colonneDi('storico_tavoli');
    const modificata = colonne.has('modificata') ? 'modificata' : '0';
    const noteMod = colonne.has('note_modifiche') ? 'note_modifiche' : "''";
    const modDa = colonne.has('modificato_da_nickname') ? 'modificato_da_nickname' : "''";

    const r = await run(`
      INSERT INTO tavoli (pr_id, data, nome_tavolo, numero_persone, spesa_prevista,
                          omaggi, note_tavolo, stato, modificata, note_modifiche,
                          modificato_da_nickname)
      SELECT pr_id, data, nome_tavolo,
             MAX(COALESCE(numero_persone, 1), 1),
             MAX(COALESCE(spesa_prevista, 0), 0),
             omaggi, note_tavolo, 'approvato',
             ${modificata}, ${noteMod}, ${modDa}
      FROM storico_tavoli`);
    importati += r.changes;
    log(`  Tavoli approvati importati da storico_tavoli: ${r.changes}`);
  }

  if (tabelle.has('richieste_tavoli')) {
    const colonne = await schema.colonneDi('richieste_tavoli');
    const modificata = colonne.has('modificata') ? 'COALESCE(modificata, 0)' : '0';
    const noteMod = colonne.has('note_modifiche') ? "COALESCE(note_modifiche, '')" : "''";
    const modDa = colonne.has('modificato_da_nickname')
      ? "COALESCE(modificato_da_nickname, '')"
      : "''";
    const omaggi = colonne.has('omaggi') ? 'omaggi' : 'NULL';

    // Nel vecchio schema `stato` restava quasi sempre 'in attesa' perche' la
    // riga veniva spostata o cancellata al momento della decisione.
    const r = await run(`
      INSERT INTO tavoli (pr_id, data, nome_tavolo, numero_persone, spesa_prevista,
                          omaggi, note_tavolo, stato, modificata, note_modifiche,
                          modificato_da_nickname)
      SELECT pr_id, data, nome_tavolo,
             MAX(COALESCE(numero_persone, 1), 1),
             MAX(COALESCE(spesa_prevista, 0), 0),
             ${omaggi}, note_tavolo,
             CASE
               WHEN LOWER(COALESCE(stato,'')) LIKE 'approv%'  THEN 'approvato'
               WHEN LOWER(COALESCE(stato,'')) LIKE 'rifiut%'  THEN 'rifiutato'
               ELSE 'in_attesa'
             END,
             ${modificata}, ${noteMod}, ${modDa}
      FROM richieste_tavoli`);
    importati += r.changes;
    log(`  Richieste importate da richieste_tavoli: ${r.changes}`);
  }

  return importati;
}

async function migraPagamenti(tabelle) {
  if (!tabelle.has('pagamenti_provvigioni')) return 0;
  const colonne = await schema.colonneDi('pagamenti_provvigioni');
  if (colonne.has('pagante_tipo')) {
    log('  Pagamenti gia\' nel nuovo formato.');
    return 0;
  }

  const vecchi = await all('SELECT * FROM pagamenti_provvigioni');
  if (vecchi.length === 0) return 0;

  const prIds = new Set((await all('SELECT id FROM pr')).map((r) => r.id));
  await run('ALTER TABLE pagamenti_provvigioni RENAME TO pagamenti_provvigioni_old');
  await schema.initSchema();

  let n = 0;
  for (const p of vecchi) {
    if (!(Number(p.importo) > 0)) continue; // il nuovo schema rifiuta importi nulli o negativi
    // Nel vecchio schema l'id del pagante poteva essere di un admin o di un PR,
    // senza modo di distinguerli: se non corrisponde a un PR lo trattiamo come admin.
    const tipo = prIds.has(p.pr_pagante_id) ? 'pr' : 'admin';
    await run(
      `INSERT INTO pagamenti_provvigioni
         (pr_destinatario_id, pagante_tipo, pagante_id, importo, note, data_pagamento)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [p.pr_destinatario_id, tipo, p.pr_pagante_id, p.importo, p.note || null, p.data_pagamento]
    );
    n++;
  }
  await run('DROP TABLE pagamenti_provvigioni_old');
  log(`  Pagamenti migrati al nuovo formato: ${n}`);
  return n;
}

async function ricostruisciTabellaPr(tabelle) {
  if (!tabelle.has('pr')) return;
  const colonne = await schema.colonneDi('pr');
  const contatori = [
    'provvigioni_da_pagare',
    'tot_spesa_tavolo',
    'tot_persone_portate',
    'provvigioni_totali_maturate',
    'provvigioni_totali_pagate'
  ].filter((c) => colonne.has(c));

  if (contatori.length === 0) {
    log('  Tabella pr gia\' priva dei contatori obsoleti.');
    return;
  }

  // SQLite non supporta DROP COLUMN in modo affidabile sulle versioni piu'
  // vecchie: ricostruiamo la tabella copiando solo le colonne che restano.
  await run(`CREATE TABLE pr_nuova (
    id INTEGER PRIMARY KEY,
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

  // Le installazioni piu' vecchie non hanno `attivo` e `deleted_at`: si leggono
  // solo le colonne effettivamente presenti, con un default per le mancanti.
  const attivoExpr = colonne.has('attivo') ? 'COALESCE(attivo, 1)' : '1';
  const deletedExpr = colonne.has('deleted_at') ? 'deleted_at' : 'NULL';
  const poteriExpr = colonne.has('poteri') ? 'COALESCE(poteri, 0)' : '0';
  const percExpr = colonne.has('percentuale_provvigione')
    ? 'MIN(MAX(COALESCE(percentuale_provvigione, 0), 0), 100)'
    : '0';

  // Deduzione di padre_tipo per i dati esistenti: se l'identificativo del padre
  // corrisponde a un altro PR lo consideriamo un PR, altrimenti un admin.
  // Nei casi ambigui (stesso numero presente in entrambe le tabelle) vince il
  // PR, che e' il comportamento del codice originale: eventuali discrepanze
  // vengono elencate a fine migrazione perche' tu possa verificarle.
  const padreTipoExpr = `CASE
      WHEN fk_padre IS NULL THEN 'pr'
      WHEN EXISTS(SELECT 1 FROM pr figlio WHERE figlio.id = pr.fk_padre) THEN 'pr'
      ELSE 'admin'
    END`;

  await run(`INSERT INTO pr_nuova
    (id, fk_padre, padre_tipo, nome, cognome, numero_telefono, nickname, password,
     percentuale_provvigione, poteri, attivo, deleted_at)
    SELECT id, fk_padre, ${padreTipoExpr}, nome, cognome, numero_telefono, nickname, password,
           ${percExpr}, ${poteriExpr}, ${attivoExpr}, ${deletedExpr}
    FROM pr`);

  const ambigui = await all(`
    SELECT p.id, p.nickname, p.fk_padre FROM pr p
    WHERE p.fk_padre IS NOT NULL
      AND EXISTS(SELECT 1 FROM pr q WHERE q.id = p.fk_padre)
      AND EXISTS(SELECT 1 FROM admin a WHERE a.id = p.fk_padre)`);
  if (ambigui.length) {
    log('');
    log('  ATTENZIONE: per questi collaboratori il responsabile e\' ambiguo,');
    log('  perche\' lo stesso identificativo esiste sia tra gli admin sia tra i PR.');
    log('  Sono stati assegnati al PR: verificali dalla pagina Staff.');
    ambigui.forEach((a) => log(`    ${a.nickname} (id ${a.id}) -> padre ${a.fk_padre}`));
    log('');
  }

  await run('DROP TABLE pr');
  await run('ALTER TABLE pr_nuova RENAME TO pr');
  log(`  Contatori rimossi dalla tabella pr: ${contatori.join(', ')}`);
}

/**
 * Rimuove i trigger dello schema originale.
 *
 * `update_pr_stats_on_storico_insert` incrementava tot_spesa_tavolo,
 * tot_persone_portate, provvigioni_da_pagare e andamento_staff_mensile a ogni
 * inserimento in storico_tavoli. Il codice applicativo
 * (aggiornaProvvigioniETotaliPR + aggiornaAndamentoETotali) eseguiva gli
 * stessi identici aggiornamenti subito dopo: ogni tavolo approvato contava
 * DUE VOLTE sui totali del PR che lo aveva venduto.
 *
 * Nel nuovo schema quei contatori non esistono piu' e i valori sono derivati
 * dai tavoli, quindi i trigger non servono e non devono sopravvivere.
 */
async function rimuoviTriggerObsoleti() {
  const trigger = await all("SELECT name FROM sqlite_master WHERE type = 'trigger'");
  for (const t of trigger) {
    await run(`DROP TRIGGER IF EXISTS ${t.name}`);
  }
  if (trigger.length) {
    log(`  Trigger rimossi: ${trigger.length}`);
    log(`    ${trigger.map((t) => t.name).join(', ')}`);
  }

  // Le view del vecchio schema si appoggiano a tabelle che stiamo ricostruendo
  // e bloccherebbero il DROP TABLE.
  const viste = await all("SELECT name FROM sqlite_master WHERE type = 'view'");
  for (const v of viste) {
    await run(`DROP VIEW IF EXISTS ${v.name}`);
  }
  if (viste.length) {
    log(`  View rimosse: ${viste.map((v) => v.name).join(', ')}`);
  }
}

async function eliminaObsolete(tabelle) {
  const obsolete = ['pr_stats', 'andamento_staff_mensile', 'storico_tavoli', 'richieste_tavoli'];
  for (const t of obsolete) {
    if (tabelle.has(t)) {
      await run(`DROP TABLE ${t}`);
      log(`  Tabella obsoleta rimossa: ${t}`);
    }
  }
}

(async () => {
  log('='.repeat(70));
  log(`MIGRAZIONE SCHEMA AURA MANAGER${APPLY ? '' : '  (SIMULAZIONE)'}`);
  log(`Database: ${dbPath}`);
  log('='.repeat(70));

  try {
    const tabelle = await schema.tabelleEsistenti();
    log(`Tabelle presenti: ${[...tabelle].filter((t) => !t.startsWith('sqlite_')).join(', ') || '(nessuna)'}`);

    await backup();
    await riconciliazione(tabelle);

    if (!APPLY) {
      log('');
      log('Operazioni che verrebbero eseguite:');
      log('  1. Creazione delle nuove tabelle (tavoli, impostazioni, detrazioni) e degli indici');
      log('  2. Unificazione di storico_tavoli e richieste_tavoli nella tabella tavoli');
      log('  3. Conversione dei pagamenti al formato con pagante_tipo esplicito');
      log('  4. Rimozione dei contatori obsoleti dalla tabella pr');
      log('  5. Eliminazione di pr_stats, andamento_staff_mensile e delle tabelle sostituite');
      log('');
      log('Nessuna modifica effettuata. Per applicare: npm run migrate -- --apply');
      process.exit(0);
    }

    await schema.initSchema();
    log('');
    log('Migrazione in corso:');

    await transaction(async () => {
      await rimuoviTriggerObsoleti();
      await migraTavoli(tabelle);
      await ricostruisciTabellaPr(tabelle);
      await eliminaObsolete(await schema.tabelleEsistenti());
    });

    // I pagamenti richiedono un rename di tabella: fuori dalla transazione
    // principale per non mescolare DDL e DML sullo stesso oggetto.
    await migraPagamenti(await schema.tabelleEsistenti());
    await schema.creaIndici();

    log('');
    log('Situazione finale:');
    for (const t of ['admin', 'pre_admin', 'pr', 'tavoli', 'pagamenti_provvigioni']) {
      log(`  ${t.padEnd(24)} ${await schema.contaRighe(t)} righe`);
    }
    const perStato = await all('SELECT stato, COUNT(*) AS n FROM tavoli GROUP BY stato');
    for (const s of perStato) log(`    tavoli in stato ${s.stato}: ${s.n}`);

    log('');
    log('Migrazione completata.');
    process.exit(0);
  } catch (err) {
    console.error('');
    console.error('MIGRAZIONE FALLITA:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    console.error('Il database non e\' stato modificato (o e\' ripristinabile dalla copia di sicurezza).');
    process.exit(1);
  }
})();
