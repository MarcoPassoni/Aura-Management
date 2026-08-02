// Gestione utenti (admin e PR) con crittografia trasparente dei dati personali.
//
// Il ruolo `pre_admin` e' stato rimosso: esisteva la tabella e il login
// funzionava, ma non c'era nessuna pagina dedicata e chi entrava trovava una
// schermata vuota.
//
// I campi nome, cognome e numero_telefono sono cifrati a riposo (AES-256-CBC);
// nickname e password restano in chiaro perche' servono per la ricerca e per
// il confronto bcrypt.

const bcrypt = require('bcryptjs');
const { run, get, all } = require('./db-helpers');
const { encryptUserData, decryptUserData, decryptUserArray } = require('../utils/crypto');

const BCRYPT_ROUNDS = 12;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

/**
 * Cerca un utente per nickname in tutte le tabelle.
 * Il confronto e' case-insensitive: prima bastava cambiare una maiuscola
 * per creare un secondo account con lo stesso nome.
 */
async function findByNickname(nickname) {
  const nick = String(nickname || '').trim();
  if (!nick) return null;

  const admin = await get('SELECT * FROM admin WHERE nickname = ? COLLATE NOCASE', [nick]);
  if (admin) return { ...decryptUserData(admin), ruolo: 'admin' };

  const pr = await get('SELECT * FROM pr WHERE nickname = ? COLLATE NOCASE', [nick]);
  if (pr) return { ...decryptUserData(pr), ruolo: 'pr' };

  return null;
}

async function nicknameEsiste(nickname, { escludiPrId = null } = {}) {
  const nick = String(nickname || '').trim();
  if (!nick) return false;

  const admin = await get('SELECT 1 AS x FROM admin WHERE nickname = ? COLLATE NOCASE', [nick]);
  if (admin) return true;

  const pr = escludiPrId
    ? await get('SELECT 1 AS x FROM pr WHERE nickname = ? COLLATE NOCASE AND id != ?', [nick, escludiPrId])
    : await get('SELECT 1 AS x FROM pr WHERE nickname = ? COLLATE NOCASE', [nick]);
  if (pr) return true;

  // Anche una richiesta di creazione ancora aperta prenota il nickname.
  const richiesta = await get(
    "SELECT 1 AS x FROM richieste_creazione_pr WHERE nickname = ? COLLATE NOCASE AND stato = 'in_attesa'",
    [nick]
  );
  return !!richiesta;
}

async function getAdmin(id) {
  const row = await get('SELECT * FROM admin WHERE id = ?', [id]);
  return row ? decryptUserData(row) : null;
}

async function getPr(id) {
  const row = await get('SELECT * FROM pr WHERE id = ?', [id]);
  return row ? decryptUserData(row) : null;
}

/** Tutti i PR, decifrati. Usato per gli elenchi e l'organigramma. */
async function listPr({ soloAttivi = false } = {}) {
  const where = soloAttivi ? 'WHERE attivo = 1' : '';
  const righe = await all(`SELECT * FROM pr ${where} ORDER BY nickname COLLATE NOCASE`);
  return decryptUserArray(righe);
}

/**
 * Crea un PR. La password viene sempre hashata qui e mai altrove: nel codice
 * originale la richiesta di creazione la hashava una volta e l'approvazione la
 * ri-hashava, rendendo l'account inaccessibile con la password scelta.
 */
async function creaPr({
  nome,
  cognome,
  numero_telefono,
  nickname,
  password,
  passwordGiaHashata = false,
  percentuale_provvigione = 0,
  poteri = 0,
  fk_padre = null,
  padre_tipo = 'pr'
}) {
  if (!['admin', 'pr'].includes(padre_tipo)) {
    throw new Error('padre_tipo deve essere "admin" o "pr".');
  }
  const hash = passwordGiaHashata ? password : await hashPassword(password);
  const cifrati = encryptUserData({ nome, cognome, numero_telefono });

  const r = await run(
    `INSERT INTO pr (fk_padre, padre_tipo, nome, cognome, numero_telefono, nickname,
                     password, percentuale_provvigione, poteri, attivo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      fk_padre,
      padre_tipo,
      cifrati.nome,
      cifrati.cognome,
      cifrati.numero_telefono,
      String(nickname).trim(),
      hash,
      Number(percentuale_provvigione) || 0,
      poteri ? 1 : 0
    ]
  );
  return r.lastID;
}

async function creaAdmin({ nome, cognome, numero_telefono, nickname, password }) {
  const hash = await hashPassword(password);
  const cifrati = encryptUserData({ nome, cognome, numero_telefono });
  const r = await run(
    `INSERT INTO admin (nome, cognome, numero_telefono, nickname, password)
     VALUES (?, ?, ?, ?, ?)`,
    [cifrati.nome, cifrati.cognome, cifrati.numero_telefono, String(nickname).trim(), hash]
  );
  return r.lastID;
}

/** Aggiorna un PR. Solo i campi passati vengono toccati. */
async function aggiornaPr(id, campi) {
  const set = [];
  const params = [];

  const personali = {};
  for (const c of ['nome', 'cognome', 'numero_telefono']) {
    if (campi[c] !== undefined) personali[c] = campi[c];
  }
  if (Object.keys(personali).length) {
    const cifrati = encryptUserData(personali);
    for (const [k, v] of Object.entries(cifrati)) {
      set.push(`${k} = ?`);
      params.push(v);
    }
  }

  if (campi.nickname !== undefined) {
    set.push('nickname = ?');
    params.push(String(campi.nickname).trim());
  }
  if (campi.percentuale_provvigione !== undefined) {
    set.push('percentuale_provvigione = ?');
    params.push(Number(campi.percentuale_provvigione) || 0);
  }
  if (campi.poteri !== undefined) {
    set.push('poteri = ?');
    params.push(campi.poteri ? 1 : 0);
  }
  if (campi.fk_padre !== undefined) {
    // Il padre va sempre cambiato indicando anche il tipo: altrimenti si
    // ricadrebbe nell'ambiguita' tra id di admin e id di PR.
    if (!['admin', 'pr'].includes(campi.padre_tipo)) {
      throw new Error('Per cambiare il responsabile serve anche padre_tipo.');
    }
    set.push('fk_padre = ?', 'padre_tipo = ?');
    params.push(campi.fk_padre, campi.padre_tipo);
  }
  if (campi.password) {
    set.push('password = ?');
    params.push(await hashPassword(campi.password));
  }

  if (!set.length) return 0;
  params.push(id);
  const r = await run(`UPDATE pr SET ${set.join(', ')} WHERE id = ?`, params);
  return r.changes;
}

async function aggiornaAdmin(id, campi) {
  const set = [];
  const params = [];

  const personali = {};
  for (const c of ['nome', 'cognome', 'numero_telefono']) {
    if (campi[c] !== undefined) personali[c] = campi[c];
  }
  if (Object.keys(personali).length) {
    const cifrati = encryptUserData(personali);
    for (const [k, v] of Object.entries(cifrati)) {
      set.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (campi.nickname !== undefined) {
    set.push('nickname = ?');
    params.push(String(campi.nickname).trim());
  }
  if (campi.password) {
    set.push('password = ?');
    params.push(await hashPassword(campi.password));
  }

  if (!set.length) return 0;
  params.push(id);
  const r = await run(`UPDATE admin SET ${set.join(', ')} WHERE id = ?`, params);
  return r.changes;
}

/**
 * Disattiva un PR senza cancellarlo: i tavoli gia' fatti restano nello storico
 * e continuano a contare nei calcoli economici del periodo in cui sono avvenuti.
 */
async function disattivaPr(id) {
  const r = await run(
    "UPDATE pr SET attivo = 0, deleted_at = datetime('now') WHERE id = ?",
    [id]
  );
  return r.changes;
}

async function riattivaPr(id) {
  const r = await run('UPDATE pr SET attivo = 1, deleted_at = NULL WHERE id = ?', [id]);
  return r.changes;
}

async function contaAdmin() {
  const r = await get('SELECT COUNT(*) AS n FROM admin');
  return r ? r.n : 0;
}

module.exports = {
  BCRYPT_ROUNDS,
  hashPassword,
  verifyPassword,
  findByNickname,
  nicknameEsiste,
  getAdmin,
  getPr,
  listPr,
  creaPr,
  creaAdmin,
  aggiornaPr,
  aggiornaAdmin,
  disattivaPr,
  riattivaPr,
  contaAdmin
};
