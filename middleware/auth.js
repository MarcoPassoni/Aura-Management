// Controlli di accesso.
//
// Nell'originale esistevano cinque middleware quasi identici sparsi tra i file
// (isAdmin, ensureAdmin, isAuthenticated, ensurePR, ensurePRWithPowers), usati
// in modo incoerente: alcune route amministrative usavano la variante SENZA il
// controllo di appartenenza alla gerarchia, permettendo a un admin di agire sui
// PR di un altro admin conoscendone l'id.
//
// A quella riscrittura si aggiunge ora un secondo controllo, oltre a "esiste
// una sessione con un utente": la sessione non deve avere superato la durata
// massima assoluta (vedi utils/sessione.js). Senza questo limite, un
// dispositivo usato con regolarita' resta collegato a tempo indeterminato: il
// cookie e' `rolling`, quindi ogni richiesta ne rinnova la scadenza per
// inattivita' e la sessione non muore mai da sola. Il limite assoluto e'
// indipendente dall'attivita': scaduto quello, bisogna rifare il login anche
// se si sta usando l'applicazione in quel preciso momento.
//
// requireAdmin e requirePr sono ora entrambi costruiti sopra requireLogin,
// invece di ripetere lo stesso controllo tre volte.

const { loadHierarchy } = require('../services/hierarchy');
const { getPr } = require('../services/users');
const { logSecurityEvent } = require('../utils/secure-logger');
const { NOME_COOKIE, SESSIONE_MAX_MS } = require('../utils/sessione');

function accettaJson(req) {
  return (
    req.xhr ||
    (req.headers.accept || '').includes('application/json') ||
    (req.headers['content-type'] || '').includes('application/json')
  );
}

/** C'e' un cookie di sessione anche se, per una ragione o per l'altra, non contiene piu' un utente valido. */
function haCookieDiSessione(req) {
  return !!(req.cookies && req.cookies[NOME_COOKIE]);
}

/**
 * Manda alla pagina di accesso. Se il browser presentava ancora un cookie di
 * sessione, non si tratta di "non hai mai fatto login": la sessione
 * precedente e' scaduta, e' stata invalidata da un riavvio del server, o
 * l'utente ha fatto logout da un'altra scheda. Vale la pena distinguerlo,
 * invece di mostrare una schermata di accesso muta come se nulla fosse.
 */
function vaiAlLogin(req, res) {
  const motivo = haCookieDiSessione(req) ? '?motivo=scaduta' : '';
  return res.redirect(`/login${motivo}`);
}

function sessioneAssolutamenteScaduta(req) {
  if (!req.session || !req.session.creataIl) return false;
  return Date.now() - req.session.creataIl > SESSIONE_MAX_MS;
}

/** Distrugge una sessione che ha superato la durata massima e prosegue con `dopo`. */
function scadeSessione(req, res, dopo) {
  const nickname = req.session.user && req.session.user.nickname;
  req.session.destroy(() => {
    res.clearCookie(NOME_COOKIE);
    logSecurityEvent('sessione_scaduta', { nickname, motivo: 'durata_massima_superata' }, req);
    dopo();
  });
}

/**
 * Nega l'accesso a chi non e' collegato o la cui sessione ha superato la
 * durata massima assoluta. E' il controllo di base su cui si appoggiano
 * requireAdmin e requirePr.
 */
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    if (accettaJson(req)) return res.status(401).json({ errore: 'Sessione scaduta.' });
    return vaiAlLogin(req, res);
  }
  if (sessioneAssolutamenteScaduta(req)) {
    return scadeSessione(req, res, () => {
      if (accettaJson(req)) return res.status(401).json({ errore: 'Sessione scaduta.' });
      return res.redirect('/login?motivo=scaduta');
    });
  }
  return next();
}

function requireAdmin(req, res, next) {
  return requireLogin(req, res, () => {
    if (req.session.user.ruolo !== 'admin') {
      if (accettaJson(req)) return res.status(403).json({ errore: 'Accesso non consentito.' });
      return res.status(403).render('errore', {
        layout: false,
        titolo: 'Accesso non consentito',
        messaggio: 'Questa sezione e\' riservata agli amministratori.'
      });
    }
    return next();
  });
}

function requirePr(req, res, next) {
  return requireLogin(req, res, () => {
    if (req.session.user.ruolo !== 'pr') {
      if (accettaJson(req)) return res.status(403).json({ errore: 'Accesso non consentito.' });
      return vaiAlLogin(req, res);
    }
    return next();
  });
}

/**
 * Consente l'accesso solo ai PR abilitati a proporre nuovi collaboratori.
 * Il permesso viene riletto dal database a ogni richiesta: se l'admin lo revoca,
 * l'effetto e' immediato e non serve che il PR rifaccia il login.
 */
async function requirePrConPoteri(req, res, next) {
  try {
    const pr = await getPr(req.session.user.id);
    if (!pr || !pr.poteri || !pr.attivo) {
      if (accettaJson(req)) return res.status(403).json({ errore: 'Permesso non disponibile.' });
      req.flash('errore', 'Non hai il permesso di proporre nuovi collaboratori.');
      return res.redirect('/pr/dashboard');
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Carica la gerarchia e la rende disponibile come `req.gerarchia`.
 * Evita che ogni route se la ricalcoli per conto proprio.
 */
async function caricaGerarchia(req, res, next) {
  try {
    req.gerarchia = await loadHierarchy();
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Verifica che un PR appartenga alla gerarchia dell'admin collegato.
 * Va applicato a OGNI route che riceve un id di PR dall'esterno.
 */
function verificaAmbitoAdmin(req, prId) {
  const id = Number(prId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, motivo: 'Identificativo non valido.' };
  if (!req.gerarchia) return { ok: false, motivo: 'Gerarchia non caricata.' };
  if (!req.gerarchia.isInAdminScope(req.session.user.id, id)) {
    return { ok: false, motivo: 'Questo collaboratore non fa parte della tua struttura.' };
  }
  return { ok: true, id };
}

/**
 * Verifica che un PR sia il PR collegato o un suo discendente.
 * Usato per le operazioni che un PR compie sui propri collaboratori.
 */
function verificaAmbitoPr(req, prId) {
  const id = Number(prId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, motivo: 'Identificativo non valido.' };
  if (!req.gerarchia) return { ok: false, motivo: 'Gerarchia non caricata.' };
  const sottoposti = req.gerarchia.subtree(req.session.user.id).map((n) => n.id);
  if (!sottoposti.includes(id)) {
    return { ok: false, motivo: 'Questo collaboratore non fa parte della tua struttura.' };
  }
  return { ok: true, id };
}

module.exports = {
  requireLogin,
  requireAdmin,
  requirePr,
  requirePrConPoteri,
  caricaGerarchia,
  verificaAmbitoAdmin,
  verificaAmbitoPr,
  accettaJson
};
