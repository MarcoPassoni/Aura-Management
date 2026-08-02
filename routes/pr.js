// Area PR (promoter).
//
// Riscrittura del file originale (1215 righe). Cosa e' cambiato:
//  - Una sola dashboard che si adatta: prima esistevano /dashboard e
//    /dashboard-personal con due calcoli diversi e un redirect automatico tra
//    le due a seconda che il PR avesse collaboratori.
//  - Le provvigioni arrivano da services/commissions.js e tengono conto della
//    gerarchia. La vecchia calcolaProvvigioniConGerarchia, malgrado il nome,
//    sommava solo i tavoli personali: chi aveva collaboratori vedeva zero.
//  - Un PR vede e tocca solo il proprio sottoalbero, verificato a ogni richiesta.

const express = require('express');
const router = express.Router();

const {
  requirePr,
  requirePrConPoteri,
  caricaGerarchia,
  verificaAmbitoPr
} = require('../middleware/auth');
const { apiLimiter } = require('../utils/rate-limiter');
const v = require('../services/validation');
const utenti = require('../services/users');
const tavoliSrv = require('../services/tavoli');
const pagamentiSrv = require('../services/pagamenti');
const { all, run } = require('../services/db-helpers');
const { computeCommissions, getAndamentoMensile, euro } = require('../services/commissions');

router.use(requirePr, apiLimiter, caricaGerarchia);

/** Id del PR collegato e di tutti i suoi discendenti. */
function ambito(req) {
  return req.gerarchia.subtree(req.session.user.id).map((n) => n.id);
}

function vista(req, nome, dati = {}) {
  return {
    layout: 'layout',
    paginaCorrente: nome,
    titolo: dati.titolo || 'Aura',
    ...dati
  };
}

/** Dati economici del PR collegato, sempre calcolati sull'intera gerarchia. */
async function situazione(req) {
  const { perPr } = await computeCommissions({});
  const mia = perPr.get(req.session.user.id);
  if (!mia) throw new v.ErroreValidazione('Profilo non trovato.');
  return { perPr, mia };
}

// ============================================================== DASHBOARD
router.get('/dashboard', async (req, res, next) => {
  try {
    const prId = req.session.user.id;
    const { perPr, mia } = await situazione(req);
    const nodo = req.gerarchia.get(prId);
    const figli = nodo ? nodo.children.map((c) => perPr.get(c.id)).filter(Boolean) : [];

    const [andamento, ultimiTavoli, pagamentiRicevuti, inAttesa] = await Promise.all([
      getAndamentoMensile(ambito(req), 6),
      tavoliSrv.elenca({ prIds: [prId], limite: 5 }),
      pagamentiSrv.ricevutiDa(prId, 5),
      tavoliSrv.contaInAttesa([prId])
    ]);

    res.render(
      'pr/dashboard',
      vista(req, 'dashboard', {
        titolo: 'Dashboard',
        mia,
        figli,
        andamento,
        ultimiTavoli,
        pagamentiRicevuti,
        inAttesa,
        // Quanto devo ancora ai miei collaboratori.
        dovutoAiFigli: euro(figli.reduce((s, f) => s + Math.max(0, f.saldoDaRicevere || 0), 0))
      })
    );
  } catch (err) {
    next(err);
  }
});

// ================================================================= TAVOLI
router.get('/tavoli', async (req, res, next) => {
  try {
    const soloMiei = req.query.ambito !== 'team';
    const prIds = soloMiei ? [req.session.user.id] : ambito(req);
    const stato = ['in_attesa', 'approvato', 'rifiutato'].includes(req.query.stato)
      ? req.query.stato
      : null;

    const elenco = await tavoliSrv.elenca({ prIds, stato, limite: 300 });
    const nodo = req.gerarchia.get(req.session.user.id);

    res.render(
      'pr/tavoli',
      vista(req, 'tavoli', {
        titolo: 'I miei tavoli',
        elenco,
        soloMiei,
        haTeam: !!(nodo && nodo.children.length),
        filtroStato: stato || '',
        totaleApprovato: euro(
          elenco
            .filter((t) => t.stato === 'approvato')
            .reduce((s, t) => s + Number(t.spesa_prevista), 0)
        )
      })
    );
  } catch (err) {
    next(err);
  }
});

// =========================================================== PRENOTAZIONI
router.get('/prenotazioni', async (req, res, next) => {
  try {
    const elenco = await tavoliSrv.elenca({
      prIds: [req.session.user.id],
      stato: tavoliSrv.STATI.ATTESA,
      limite: 100
    });
    res.render(
      'pr/prenotazioni',
      vista(req, 'prenotazioni', {
        titolo: 'Nuova prenotazione',
        elenco,
        oggi: new Date().toISOString().slice(0, 10)
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/prenotazioni', async (req, res, next) => {
  try {
    await tavoliSrv.creaRichiesta(req.session.user.id, req.body);
    req.flash('messaggio', 'Richiesta inviata. Verra\' valutata dall\'amministratore.');
    res.redirect('/pr/prenotazioni');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/pr/prenotazioni');
    }
    next(err);
  }
});

// =========================================================== ORGANIGRAMMA
router.get('/organigramma', async (req, res, next) => {
  try {
    const { perPr } = await situazione(req);
    const nodo = req.gerarchia.get(req.session.user.id);

    function costruisci(n) {
      const dati = perPr.get(n.id);
      return {
        id: n.id,
        nickname: n.nickname,
        percentuale: n.percentuale_provvigione,
        attivo: n.attivo,
        fatturato: dati ? dati.fatturatoSottoalbero : 0,
        figli: n.children.map(costruisci)
      };
    }

    res.render(
      'pr/organigramma',
      vista(req, 'organigramma', {
        titolo: 'La mia struttura',
        radice: nodo ? costruisci(nodo) : null,
        responsabile: nodo && nodo.parent ? nodo.parent.nickname : 'Amministratore'
      })
    );
  } catch (err) {
    next(err);
  }
});

// ============================================================ PROVVIGIONI
router.get('/provvigioni', async (req, res, next) => {
  try {
    const prId = req.session.user.id;
    const { perPr, mia } = await situazione(req);
    const nodo = req.gerarchia.get(prId);
    const figli = nodo ? nodo.children.map((c) => perPr.get(c.id)).filter(Boolean) : [];

    const [ricevuti, versati] = await Promise.all([
      pagamentiSrv.ricevutiDa(prId, 50),
      pagamentiSrv.effettuatiDa('pr', prId, 50)
    ]);

    res.render(
      'pr/provvigioni',
      vista(req, 'provvigioni', {
        titolo: 'Provvigioni',
        mia,
        figli,
        ricevuti,
        versati,
        dovutoAiFigli: euro(figli.reduce((s, f) => s + Math.max(0, f.saldoDaRicevere || 0), 0))
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/provvigioni/paga', async (req, res, next) => {
  try {
    const controllo = verificaAmbitoPr(req, req.body.destinatario_id);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);
    if (controllo.id === req.session.user.id) {
      throw new v.ErroreValidazione('Non puoi registrare un pagamento verso te stesso.');
    }

    const esito = await pagamentiSrv.registra({
      destinatarioId: controllo.id,
      paganteTipo: 'pr',
      paganteId: req.session.user.id,
      importo: req.body.importo,
      note: req.body.note,
      registratoDa: req.session.user.nickname
    });

    req.flash(
      'messaggio',
      `Pagamento di ${esito.importo} EUR registrato. Residuo: ${esito.residuoDopo} EUR.`
    );
    res.redirect('/pr/provvigioni');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/pr/provvigioni');
    }
    next(err);
  }
});

router.post('/provvigioni/:id/annulla', async (req, res, next) => {
  try {
    await pagamentiSrv.annulla(req.params.id, { tipo: 'pr', id: req.session.user.id });
    req.flash('messaggio', 'Pagamento annullato.');
    res.redirect('/pr/provvigioni');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/pr/provvigioni');
    }
    next(err);
  }
});

// ===================================================== RICHIESTA NUOVO PR
router.get('/richiesta-nuovo-pr', requirePrConPoteri, async (req, res, next) => {
  try {
    const prId = req.session.user.id;
    const io = req.gerarchia.get(prId);
    const miei = await all(
      `SELECT * FROM richieste_creazione_pr WHERE fk_richiedente = ?
       ORDER BY data_richiesta DESC LIMIT 20`,
      [prId]
    );

    res.render(
      'pr/richiesta-nuovo-pr',
      vista(req, 'richiesta-nuovo-pr', {
        titolo: 'Proponi un collaboratore',
        percentualeMassima: io ? io.percentuale_provvigione : 0,
        possibiliPadri: req.gerarchia
          .subtree(prId)
          .filter((n) => n.attivo)
          .map((n) => ({
            id: n.id,
            etichetta: n.id === prId ? `${n.nickname} (io)` : n.nickname,
            percentuale: n.percentuale_provvigione
          })),
        richieste: miei
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/richiesta-nuovo-pr', requirePrConPoteri, async (req, res, next) => {
  try {
    const prId = req.session.user.id;

    const controllo = verificaAmbitoPr(req, req.body.padre_proposto_id || prId);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);
    const padre = req.gerarchia.get(controllo.id);

    const dati = {
      nome: v.nome(req.body.nome),
      cognome: v.nome(req.body.cognome, 'Il cognome'),
      numero_telefono: v.telefono(req.body.numero_telefono),
      nickname: v.nickname(req.body.nickname),
      password: v.password(req.body.password),
      percentuale: v.percentuale(req.body.percentuale_provvigione),
      note: v.noteLibere(req.body.note, 500)
    };

    if (await utenti.nicknameEsiste(dati.nickname)) {
      throw new v.ErroreValidazione('Questo nickname e\' gia\' in uso o gia\' richiesto.');
    }
    if (dati.percentuale > padre.percentuale_provvigione) {
      throw new v.ErroreValidazione(
        `La percentuale non puo' superare il ${padre.percentuale_provvigione}% di ${padre.nickname}.`
      );
    }

    // La password viene hashata qui e basta: all'approvazione viene usata
    // cosi' com'e'. Nell'originale veniva hashata di nuovo dall'admin,
    // rendendo impossibile accedere con la password scelta.
    const hash = await utenti.hashPassword(dati.password);

    await run(
      `INSERT INTO richieste_creazione_pr
        (nome, cognome, numero_telefono, nickname, password, percentuale_provvigione,
         stato, note, fk_richiedente, fk_padre_proposto)
       VALUES (?, ?, ?, ?, ?, ?, 'in_attesa', ?, ?, ?)`,
      [
        dati.nome,
        dati.cognome,
        dati.numero_telefono,
        dati.nickname,
        hash,
        dati.percentuale,
        dati.note || null,
        prId,
        controllo.id
      ]
    );

    req.flash('messaggio', 'Richiesta inviata all\'amministratore.');
    res.redirect('/pr/richiesta-nuovo-pr');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/pr/richiesta-nuovo-pr');
    }
    next(err);
  }
});

// ================================================================ PROFILO
router.get('/profilo', async (req, res, next) => {
  try {
    const pr = await utenti.getPr(req.session.user.id);
    const nodo = req.gerarchia.get(req.session.user.id);
    res.render(
      'pr/profilo',
      vista(req, 'profilo', {
        titolo: 'Il mio profilo',
        pr,
        responsabile: nodo && nodo.parent ? nodo.parent.nickname : 'Amministratore'
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/profilo', async (req, res, next) => {
  try {
    // Un PR puo' cambiare i propri recapiti e la password, non la percentuale
    // ne' il responsabile: quelli li decide l'amministratore.
    const campi = {
      nome: v.nome(req.body.nome),
      cognome: v.nome(req.body.cognome, 'Il cognome'),
      numero_telefono: v.telefono(req.body.numero_telefono)
    };
    if (req.body.password) campi.password = v.password(req.body.password);

    await utenti.aggiornaPr(req.session.user.id, campi);
    req.session.user.nome = campi.nome;
    req.session.user.cognome = campi.cognome;
    req.flash('messaggio', 'Profilo aggiornato.');
    res.redirect('/pr/profilo');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/pr/profilo');
    }
    next(err);
  }
});

module.exports = router;
