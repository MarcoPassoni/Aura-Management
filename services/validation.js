// Validazione degli input, applicata davvero.
//
// L'originale aveva utils/input-validator.js con regole severe che pero' non
// erano collegate a nessuna route: le route usavano controlli ad-hoc molto piu'
// permissivi (password di 6 caratteri senza requisiti). Qui c'e' un solo punto
// di verita', usato da tutte le route.

class ErroreValidazione extends Error {
  constructor(messaggi) {
    const elenco = Array.isArray(messaggi) ? messaggi : [messaggi];
    super(elenco.join(' '));
    this.name = 'ErroreValidazione';
    this.messaggi = elenco;
    this.statusCode = 400;
  }
}

const REGEX_NOME = /^[A-Za-zÀ-ÿ' ]{2,50}$/;
const REGEX_NICKNAME = /^[A-Za-z0-9._-]{3,30}$/;
const REGEX_TELEFONO = /^\+?[0-9 ]{8,20}$/;
const REGEX_DATA = /^\d{4}-\d{2}-\d{2}$/;

function testo(valore, { campo, min = 1, max = 200, obbligatorio = true }) {
  const v = String(valore ?? '').trim();
  if (!v) {
    // "e' un dato obbligatorio" evita il problema di concordanza tra campi
    // maschili e femminili ("il nome e' obbligatorio" / "la data e' obbligatoria").
    if (obbligatorio) throw new ErroreValidazione(`${campo} e' un dato obbligatorio.`);
    return '';
  }
  if (v.length < min) throw new ErroreValidazione(`${campo} deve avere almeno ${min} caratteri.`);
  if (v.length > max) throw new ErroreValidazione(`${campo} non puo' superare ${max} caratteri.`);
  return v;
}

function nome(valore, campo = 'Il nome') {
  const v = testo(valore, { campo, min: 2, max: 50 });
  if (!REGEX_NOME.test(v)) {
    throw new ErroreValidazione(`${campo} puo' contenere solo lettere, spazi e apostrofi.`);
  }
  return v;
}

function nickname(valore) {
  const v = testo(valore, { campo: 'Il nickname', min: 3, max: 30 });
  if (!REGEX_NICKNAME.test(v)) {
    throw new ErroreValidazione(
      'Il nickname puo\' contenere solo lettere, numeri, punto, trattino e underscore (3-30 caratteri).'
    );
  }
  return v;
}

function telefono(valore) {
  const v = testo(valore, { campo: 'Il numero di telefono', min: 8, max: 20 });
  if (!REGEX_TELEFONO.test(v)) {
    throw new ErroreValidazione('Il numero di telefono non e\' in un formato valido.');
  }
  return v;
}

/**
 * Password: minimo 10 caratteri con almeno una lettera e una cifra.
 * L'originale accettava 6 caratteri qualsiasi.
 */
function password(valore, { obbligatoria = true } = {}) {
  const v = String(valore ?? '');
  if (!v) {
    if (obbligatoria) throw new ErroreValidazione('La password e\' obbligatoria.');
    return null;
  }
  if (v.length < 10) throw new ErroreValidazione('La password deve avere almeno 10 caratteri.');
  if (v.length > 200) throw new ErroreValidazione('La password e\' troppo lunga.');
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) {
    throw new ErroreValidazione('La password deve contenere almeno una lettera e un numero.');
  }
  return v;
}

function percentuale(valore, campo = 'La percentuale') {
  const v = Number(String(valore ?? '').replace(',', '.'));
  if (!Number.isFinite(v)) throw new ErroreValidazione(`${campo} deve essere un numero.`);
  if (v < 0 || v > 100) throw new ErroreValidazione(`${campo} deve essere compresa tra 0 e 100.`);
  return Math.round(v * 100) / 100;
}

function intero(valore, { campo, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  const v = Number(valore);
  if (!Number.isInteger(v)) throw new ErroreValidazione(`${campo} deve essere un numero intero.`);
  if (v < min || v > max) throw new ErroreValidazione(`${campo} deve essere tra ${min} e ${max}.`);
  return v;
}

function importo(valore, { campo = 'L\'importo', min = 0, max = 1000000 } = {}) {
  const v = Number(String(valore ?? '').replace(',', '.'));
  if (!Number.isFinite(v)) throw new ErroreValidazione(`${campo} deve essere un numero.`);
  if (v < min) throw new ErroreValidazione(`${campo} non puo' essere inferiore a ${min}.`);
  if (v > max) throw new ErroreValidazione(`${campo} non puo' superare ${max}.`);
  return Math.round(v * 100) / 100;
}

/**
 * Data in formato YYYY-MM-DD, validata come data reale.
 * `new Date('2026-02-31')` non lancia errori ma slitta al mese successivo:
 * qui si verifica che i componenti tornino identici dopo la conversione.
 */
function data(valore, { campo = 'La data', maxAnniFuturi = 3 } = {}) {
  const v = String(valore ?? '').trim();
  if (!REGEX_DATA.test(v)) {
    throw new ErroreValidazione(`${campo} deve essere nel formato AAAA-MM-GG.`);
  }
  const [anno, mese, giorno] = v.split('-').map(Number);
  const d = new Date(Date.UTC(anno, mese - 1, giorno));
  if (
    d.getUTCFullYear() !== anno ||
    d.getUTCMonth() !== mese - 1 ||
    d.getUTCDate() !== giorno
  ) {
    throw new ErroreValidazione(`${campo} non esiste nel calendario.`);
  }
  const limite = new Date();
  limite.setUTCFullYear(limite.getUTCFullYear() + maxAnniFuturi);
  if (d > limite) throw new ErroreValidazione(`${campo} e' troppo lontana nel futuro.`);
  if (anno < 2000) throw new ErroreValidazione(`${campo} e' troppo lontana nel passato.`);
  return v;
}

function idNumerico(valore, campo = 'L\'identificativo') {
  const v = Number(valore);
  if (!Number.isInteger(v) || v <= 0) throw new ErroreValidazione(`${campo} non e' valido.`);
  return v;
}

/**
 * Ripulisce le note libere dai caratteri di controllo, mantenendo a capo e
 * tabulazioni. Si filtra per codice carattere invece che con una regex, per
 * non dover scrivere caratteri di controllo nel sorgente.
 */
function noteLibere(valore, max = 1000) {
  const grezzo = String(valore ?? '');
  let pulito = '';
  for (const carattere of grezzo) {
    const codice = carattere.codePointAt(0);
    const eAcapoOTab = carattere === '\n' || carattere === '\r' || carattere === '\t';
    if (codice < 32 && !eAcapoOTab) continue;
    if (codice === 127) continue;
    pulito += carattere;
  }
  return pulito.trim().slice(0, max);
}

module.exports = {
  ErroreValidazione,
  testo,
  nome,
  nickname,
  telefono,
  password,
  percentuale,
  intero,
  importo,
  data,
  idNumerico,
  noteLibere
};
