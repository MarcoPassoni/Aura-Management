// Protezione contro le richieste inviate da altri siti.
//
// Ogni operazione dell'applicazione (approvare un tavolo, registrare un
// pagamento, cambiare una password) e' un form POST autenticato dal cookie di
// sessione. Senza questo controllo, una pagina qualsiasi visitata dallo stesso
// browser puo' inviare quel POST a nome dell'utente collegato: il browser
// allega il cookie da solo.
//
// Il cookie e' `sameSite: 'lax'`, che nei browser aggiornati gia' impedisce
// l'invio su una POST proveniente da un altro sito. Ma e' una difesa che sta
// tutta fuori dalla nostra applicazione: dipende dal browser, e non lascia
// traccia quando fallisce. Il token qui sotto e' una verifica esplicita, fatta
// da noi, che si vede nei log quando scatta.
//
// Come funziona: alla prima pagina la sessione riceve un valore casuale, che
// ogni form riporta in un campo nascosto. Un sito esterno puo' far partire la
// richiesta ma non puo' leggere quel valore, quindi non puo' comporla.

const crypto = require('crypto');
const { logSecurityEvent } = require('../utils/secure-logger');

const METODI_SICURI = new Set(['GET', 'HEAD', 'OPTIONS']);

function nuovoToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Confronto a tempo costante: evita di rivelare il token un carattere alla volta. */
function coincidono(a, b) {
  const primo = Buffer.from(String(a || ''), 'utf8');
  const secondo = Buffer.from(String(b || ''), 'utf8');
  if (primo.length === 0 || primo.length !== secondo.length) return false;
  return crypto.timingSafeEqual(primo, secondo);
}

/**
 * Assegna un token nuovo alla sessione corrente.
 * Va chiamata dopo ogni rigenerazione della sessione (cioe' al login), perche'
 * la rigenerazione azzera tutto quello che c'era dentro.
 */
function rinnova(req) {
  if (!req.session) return null;
  req.session.csrf = nuovoToken();
  return req.session.csrf;
}

function csrf(req, res, next) {
  if (!req.session) return next();

  if (!req.session.csrf) req.session.csrf = nuovoToken();
  // Disponibile a tutte le viste: ogni form lo include.
  res.locals.csrf = req.session.csrf;

  if (METODI_SICURI.has(req.method.toUpperCase())) return next();

  const inviato =
    (req.body && req.body._csrf) || req.get('x-csrf-token') || req.get('x-xsrf-token') || '';

  if (coincidono(inviato, req.session.csrf)) return next();

  try {
    logSecurityEvent('csrf_token_non_valido', { percorso: req.originalUrl }, req);
  } catch (_) {
    /* il logging non deve impedire la risposta */
  }

  const messaggio =
    'La pagina da cui hai inviato i dati non e\' piu\' valida: puo\' essere rimasta ' +
    'aperta troppo a lungo, oppure sei entrato di nuovo da un\'altra scheda. ' +
    'Ricarica la pagina e ripeti l\'operazione: non e\' stato modificato nulla.';

  if (
    req.xhr ||
    (req.headers.accept || '').includes('application/json') ||
    (req.headers['content-type'] || '').includes('application/json')
  ) {
    return res.status(403).json({ errore: messaggio });
  }

  return res.status(403).render('errore', {
    layout: false,
    titolo: 'Richiesta non accettata',
    messaggio,
    codice: 403
  });
}

module.exports = { csrf, rinnova, nuovoToken };
