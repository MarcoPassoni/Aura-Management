// Autenticazione.
//
// Rispetto all'originale: niente ricerca nella tabella pre_admin (ruolo
// rimosso), messaggio di errore identico per utente inesistente e password
// sbagliata (prima le due situazioni erano distinguibili, permettendo di
// scoprire quali nickname esistessero), e rigenerazione della sessione al
// login per impedire il session fixation.

const express = require('express');
const router = express.Router();

const { findByNickname, verifyPassword } = require('../services/users');
const { loginLimiter } = require('../utils/rate-limiter');
const { logSecurityEvent } = require('../utils/secure-logger');

const MESSAGGIO_CREDENZIALI = 'Nickname o password non corretti.';

router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect(destinazionePerRuolo(req.session.user.ruolo));
  }
  res.render('login', {
    layout: false,
    titolo: 'Accedi',
    errore: req.flash('errore')[0] || null,
    messaggio: req.flash('messaggio')[0] || null
  });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const nickname = String(req.body.nickname || '').trim();
    const password = String(req.body.password || '');

    if (!nickname || !password) {
      req.flash('errore', MESSAGGIO_CREDENZIALI);
      return res.redirect('/login');
    }

    const utente = await findByNickname(nickname);
    const passwordValida = utente ? await verifyPassword(password, utente.password) : false;

    if (!utente || !passwordValida) {
      registraTentativo(req, nickname, false);
      req.flash('errore', MESSAGGIO_CREDENZIALI);
      return res.redirect('/login');
    }

    if (utente.ruolo === 'pr' && !utente.attivo) {
      req.flash('errore', 'Questo profilo e\' stato disattivato. Contatta il tuo responsabile.');
      return res.redirect('/login');
    }

    // Rigenerare la sessione impedisce che un identificativo ottenuto prima
    // dell'autenticazione resti valido dopo il login.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = {
        id: utente.id,
        ruolo: utente.ruolo,
        nickname: utente.nickname,
        nome: utente.nome,
        cognome: utente.cognome
      };
      registraTentativo(req, nickname, true);
      req.session.save((err2) => {
        if (err2) return next(err2);
        res.redirect(destinazionePerRuolo(utente.ruolo));
      });
    });
  } catch (err) {
    next(err);
  }
});

function esegui(req, res) {
  req.session.destroy(() => {
    res.clearCookie('aura.sid');
    res.redirect('/login');
  });
}

router.post('/logout', esegui);
router.get('/logout', esegui);

function destinazionePerRuolo(ruolo) {
  return ruolo === 'admin' ? '/admin/riepilogo' : '/pr/dashboard';
}

function registraTentativo(req, nickname, riuscito) {
  try {
    logSecurityEvent(riuscito ? 'login_riuscito' : 'login_fallito', { nickname }, req);
  } catch (_) {
    /* il logging non deve mai bloccare l'autenticazione */
  }
}

module.exports = router;
