// Controlli di accesso.
//
// Nell'originale esistevano cinque middleware quasi identici sparsi tra i file
// (isAdmin, ensureAdmin, isAuthenticated, ensurePR, ensurePRWithPowers), usati
// in modo incoerente: alcune route amministrative usavano la variante SENZA il
// controllo di appartenenza alla gerarchia, permettendo a un admin di agire sui
// PR di un altro admin conoscendone l'id.

const { loadHierarchy } = require('../services/hierarchy');
const { getPr } = require('../services/users');

function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    if (accettaJson(req)) return res.status(401).json({ errore: 'Sessione scaduta.' });
    return res.redirect('/login');
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    if (accettaJson(req)) return res.status(401).json({ errore: 'Sessione scaduta.' });
    return res.redirect('/login');
  }
  if (req.session.user.ruolo !== 'admin') {
    if (accettaJson(req)) return res.status(403).json({ errore: 'Accesso non consentito.' });
    return res.status(403).render('errore', {
      layout: false,
      titolo: 'Accesso non consentito',
      messaggio: 'Questa sezione e\' riservata agli amministratori.'
    });
  }
  return next();
}

function requirePr(req, res, next) {
  if (!req.session || !req.session.user) {
    if (accettaJson(req)) return res.status(401).json({ errore: 'Sessione scaduta.' });
    return res.redirect('/login');
  }
  if (req.session.user.ruolo !== 'pr') {
    if (accettaJson(req)) return res.status(403).json({ errore: 'Accesso non consentito.' });
    return res.redirect('/login');
  }
  return next();
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

function accettaJson(req) {
  return (
    req.xhr ||
    (req.headers.accept || '').includes('application/json') ||
    (req.headers['content-type'] || '').includes('application/json')
  );
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
