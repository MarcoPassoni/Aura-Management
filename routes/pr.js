// Area collaboratore (PR).
//
// Riscrittura del file originale (1215 righe). Cosa e' cambiato:
//  - Una sola dashboard che si adatta: prima esistevano /dashboard e
//    /dashboard-personal con due calcoli diversi e un redirect automatico tra
//    le due a seconda che il collaboratore avesse a sua volta collaboratori.
//  - Le provvigioni arrivano da services/commissions.js e tengono conto della
//    gerarchia. La vecchia calcolaProvvigioniConGerarchia, malgrado il nome,
//    sommava solo i tavoli personali: chi aveva collaboratori vedeva zero.
//  - Ognuno vede e tocca solo il proprio sottoalbero, verificato a ogni richiesta.
//
// In questa versione, chi devo pagare non e' piu' dedotto dalla struttura di
// oggi ma da quanto ciascuno ha effettivamente maturato nei miei confronti: se
// un collaboratore viene spostato sotto un altro responsabile, quello che aveva
// gia' maturato resta a carico mio, e quello che maturera' dopo no.

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
const quoteSrv = require('../services/quote');
const revisioni = require('../services/revisioni');
const { all, run } = require('../services/db-helpers');
const { computeCommissions, andamentoMaturato, euro } = require('../services/commissions');

const { datiNavigazione } = require('../middleware/navigazione');
const { logAzione } = require('../utils/secure-logger');

router.use(requirePr, apiLimiter, caricaGerarchia, datiNavigazione);

/** Id del collaboratore collegato e di tutti i suoi discendenti. */
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

function gestisci(err, req, res, next, ritorno) {
  if (err && err.name === 'ErroreValidazione') {
    req.flash('errore', err.message);
    return res.redirect(ritorno);
  }
  return next(err);
}

/**
 * Dati economici del collaboratore collegato.
 *
 * Il calcolo viene limitato all'amministrazione di appartenenza invece di
 * girare su tutto il database: e' lo stesso risultato, su meno righe.
 */
async function situazione(req) {
  const prId = req.session.user.id;
  const nodo = req.gerarchia.get(prId);
  const adminId = nodo ? nodo.adminId : null;

  const calcolo = await computeCommissions(adminId != null ? { adminId } : {});
  const mia = calcolo.perPr.get(prId);
  if (!mia) {
    throw new v.ErroreValidazione(
      'Il tuo profilo non risulta collegato a nessuna amministrazione. ' +
        'Contatta il tuo responsabile.'
    );
  }

  // Chi ha maturato qualcosa nei miei confronti: sono io a doverli pagare.
  const daPagare = calcolo.elenco
    .map((r) => {
      const rapporto = r.debitori.find((d) => d.tipo === 'pr' && d.id === prId);
      return rapporto ? { ...r, rapporto } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.rapporto.saldo - a.rapporto.saldo);

  return {
    calcolo,
    mia,
    daPagare,
    dovutoAiCollaboratori: euro(
      daPagare.reduce((s, d) => s + Math.max(0, d.rapporto.saldo), 0)
    )
  };
}

// ============================================================== DASHBOARD
router.get('/dashboard', async (req, res, next) => {
  try {
    const prId = req.session.user.id;
    const { mia, daPagare, dovutoAiCollaboratori } = await situazione(req);

    const [andamento, ultimiTavoli, pagamentiRicevuti, inAttesa, daRivedere] = await Promise.all([
      andamentoMaturato(prId, 6),
      tavoliSrv.elenca({ prIds: [prId], limite: 5 }),
      pagamentiSrv.ricevutiDa(prId, 5),
      tavoliSrv.contaInAttesa([prId]),
      revisioni.contaCodaPerPr(prId)
    ]);

    res.render(
      'pr/dashboard',
      vista(req, 'dashboard', {
        titolo: 'Dashboard',
        mia,
        daPagare,
        dovutoAiCollaboratori,
        andamento,
        ultimiTavoli,
        pagamentiRicevuti,
        inAttesa,
        daRivedere
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

    // "In revisione presso X": solo lo stato, mai i commenti (quelli restano
    // riservati a chi e' effettivamente il turno di vederli, in /pr/revisioni).
    const revisoriPr = [
      ...new Set(elenco.filter((t) => t.revisione_tipo === 'pr').map((t) => t.revisione_id))
    ];
    const nickPerRevisore = new Map(
      revisoriPr.length
        ? req.gerarchia
            .subtree(req.session.user.id)
            .concat(req.gerarchia.ancestors(req.session.user.id))
            .filter((n) => revisoriPr.includes(n.id))
            .map((n) => [n.id, n.nickname])
        : []
    );

    res.render(
      'pr/tavoli',
      vista(req, 'tavoli', {
        titolo: 'I miei tavoli',
        elenco: elenco.map((t) => ({
          ...t,
          revisorePressoChi:
            t.revisione_tipo === 'admin'
              ? "l'amministrazione"
              : t.revisione_tipo === 'pr'
              ? nickPerRevisore.get(t.revisione_id) || null
              : null
        })),
        soloMiei,
        haTeam: !!(nodo && nodo.children.length),
        filtroStato: stato || '',
        totaleImponibile: euro(
          elenco.filter((t) => t.stato === 'approvato').reduce((s, t) => s + t.imponibile, 0)
        )
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Dettaglio di un tavolo: chi prende quanto, e con quali percentuali, se e'
 * approvato. Se e' ancora in attesa, si vede solo lo stato della revisione (a
 * chi punto e' arrivata, e la propria percentuale se gia' decisa): mai i
 * commenti ne' le percentuali altrui, che restano riservati a chi ha
 * effettivamente il turno di vederli.
 */
router.get('/tavoli/:id/dettaglio', async (req, res, next) => {
  try {
    const tavolo = await tavoliSrv.getTavolo(v.idNumerico(req.params.id, 'Il tavolo'));
    if (!tavolo) throw new v.ErroreValidazione('Tavolo non trovato.');

    // Si puo' vedere solo un tavolo del proprio sottoalbero.
    const controllo = verificaAmbitoPr(req, tavolo.pr_id);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);

    const congelate = await quoteSrv.delTavolo(tavolo.id);
    const revisione = tavolo.stato === 'in_attesa' ? await revisioni.perSottoposto(tavolo.id) : null;

    res.render(
      'pr/tavolo-dettaglio',
      vista(req, 'tavoli', {
        titolo: `Tavolo ${tavolo.nome_tavolo}`,
        tavolo,
        // Un collaboratore vede la propria riga e quelle di chi dipende da lui,
        // non quelle dei propri responsabili: quanto guadagna chi sta sopra non
        // lo riguarda.
        quote: congelate.filter((q) => ambito(req).includes(q.pr_id)),
        revisione
      })
    );
  } catch (err) {
    gestisci(err, req, res, next, '/pr/tavoli');
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

    // Presso chi si trova ciascuna richiesta: sempre uno dei propri
    // responsabili, quindi basta guardare la propria catena di ascendenza.
    const nickPerRevisore = new Map(
      req.gerarchia.ancestors(req.session.user.id).map((n) => [n.id, n.nickname])
    );

    res.render(
      'pr/prenotazioni',
      vista(req, 'prenotazioni', {
        titolo: 'Nuova prenotazione',
        elenco: elenco.map((t) => ({
          ...t,
          revisorePressoChi:
            t.revisione_tipo === 'admin'
              ? "l'amministrazione"
              : t.revisione_tipo === 'pr'
              ? nickPerRevisore.get(t.revisione_id) || null
              : null
        })),
        oggi: new Date().toISOString().slice(0, 10)
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/prenotazioni', async (req, res, next) => {
  try {
    const id = await tavoliSrv.creaRichiesta(req.session.user.id, req.body);
    logAzione(
      'tavolo_richiesto',
      { id, nome: req.body.nome_tavolo, data: req.body.data, spesaPrevista: req.body.spesa_prevista },
      req
    );
    req.flash('messaggio', "Richiesta inviata. Verra' valutata dall'amministrazione.");
    res.redirect('/pr/prenotazioni');
  } catch (err) {
    gestisci(err, req, res, next, '/pr/prenotazioni');
  }
});

// =========================================================== REVISIONI
//
// Richieste di tavolo altrui, ferme al mio turno perche' io sono il
// responsabile diretto di chi le ha portate fin qui. Decido (o confermo) la
// sua percentuale su questo tavolo specifico, posso lasciare un commento per
// chi sta sopra di me, e la inoltro. Vedi services/revisioni.js.
router.get('/revisioni', async (req, res, next) => {
  try {
    const prId = req.session.user.id;
    const coda = await revisioni.codaPerPr(prId);

    const conDettaglio = await Promise.all(
      coda.map(async (t) => {
        const sit = await revisioni.situazione(t.id);
        // La riga senza un passaggio ancora registrato e' esattamente quella
        // che tocca a me: la coda gia' garantisce che sia una sola.
        const daDecidere = sit.righe.find((r) => !r.passaggio);
        return { tavolo: t, situazione: sit, daDecidere };
      })
    );

    res.render(
      'pr/revisioni',
      vista(req, 'revisioni', {
        titolo: 'Richieste da rivedere',
        elenco: conDettaglio
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/revisioni/:id/inoltra', async (req, res, next) => {
  try {
    const esito = await revisioni.rivedi({
      tavoloId: req.params.id,
      revisorePrId: req.session.user.id,
      percentuale: req.body.percentuale,
      commento: req.body.commento
    });

    logAzione(
      'tavolo_rivisto',
      {
        tavolo: req.params.id,
        sottoposto: esito.sottoposto,
        percentualeSuggerita: esito.percentualeSuggerita,
        percentualeDecisa: esito.percentualeDecisa,
        modificata: esito.modificata,
        prossimo: esito.prossimo.tipo === 'admin' ? 'amministrazione' : `pr:${esito.prossimo.id}`
      },
      req
    );
    req.flash(
      'messaggio',
      esito.modificata
        ? `Percentuale di ${esito.sottoposto} impostata al ${esito.percentualeDecisa}% per questo ` +
            "tavolo (il suo profilo resta invariato). Richiesta inoltrata."
        : `Percentuale di ${esito.sottoposto} confermata al ${esito.percentualeDecisa}%. ` +
            'Richiesta inoltrata.'
    );
    res.redirect('/pr/revisioni');
  } catch (err) {
    gestisci(err, req, res, next, '/pr/revisioni');
  }
});

// =========================================================== ORGANIGRAMMA
router.get('/organigramma', async (req, res, next) => {
  try {
    const { calcolo } = await situazione(req);
    const nodo = req.gerarchia.get(req.session.user.id);

    function costruisci(n) {
      const dati = calcolo.perPr.get(n.id);
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
        responsabile: nodo && nodo.parent ? nodo.parent.nickname : 'Amministrazione'
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
    const { mia, daPagare, dovutoAiCollaboratori } = await situazione(req);

    const [ricevuti, versati, ultime] = await Promise.all([
      pagamentiSrv.ricevutiDa(prId, 50),
      pagamentiSrv.effettuatiDa('pr', prId, 50),
      pagamentiSrv.ultimePerPr(daPagare.map((d) => d.id), { tipo: 'pr', id: prId })
    ]);

    res.render(
      'pr/provvigioni',
      vista(req, 'provvigioni', {
        titolo: 'Provvigioni',
        mia,
        daPagare: daPagare.map((d) => ({ ...d, ultimoPagamento: ultime.get(d.id) || null })),
        dovutoAiCollaboratori,
        ricevuti,
        versati
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/provvigioni/paga', async (req, res, next) => {
  try {
    const id = v.idNumerico(req.body.destinatario_id, 'Il destinatario');

    // Il controllo definitivo lo fa il servizio pagamenti, che verifica dentro
    // la transazione di essere davvero debitore di questa persona. Qui ci si
    // limita a un messaggio piu' comprensibile per il caso ovvio.
    if (id === req.session.user.id) {
      throw new v.ErroreValidazione('Non puoi registrare un pagamento verso te stesso.');
    }

    const esito = await pagamentiSrv.registra({
      destinatarioId: id,
      paganteTipo: 'pr',
      paganteId: req.session.user.id,
      importo: req.body.importo,
      note: req.body.note,
      registratoDa: req.session.user.nickname
    });

    logAzione(
      'pagamento_registrato',
      { destinatario: esito.destinatario, importo: esito.importo, residuoDopo: esito.residuoDopo },
      req
    );
    req.flash(
      'messaggio',
      `Registrato il pagamento di ${esito.importo.toFixed(2)} EUR a ${esito.destinatario}. ` +
        `Restano ${esito.residuoDopo.toFixed(2)} EUR.`
    );
    res.redirect('/pr/provvigioni');
  } catch (err) {
    gestisci(err, req, res, next, '/pr/provvigioni');
  }
});

router.post('/provvigioni/:id/annulla', async (req, res, next) => {
  try {
    const pagamento = await pagamentiSrv.annulla(req.params.id, { tipo: 'pr', id: req.session.user.id });
    logAzione('pagamento_annullato', { id: pagamento.id, importo: pagamento.importo }, req);
    req.flash('messaggio', 'Pagamento annullato: il saldo torna scoperto.');
    res.redirect('/pr/provvigioni');
  } catch (err) {
    gestisci(err, req, res, next, '/pr/provvigioni');
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
          .sort((a, b) => a.depth - b.depth || a.nickname.localeCompare(b.nickname, 'it'))
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
      throw new v.ErroreValidazione("Questo nickname e' gia' in uso o gia' richiesto.");
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

    logAzione(
      'collaboratore_proposto',
      { nickname: dati.nickname, percentuale: dati.percentuale, responsabileProposto: padre.nickname },
      req
    );
    req.flash('messaggio', "Richiesta inviata all'amministrazione.");
    res.redirect('/pr/richiesta-nuovo-pr');
  } catch (err) {
    gestisci(err, req, res, next, '/pr/richiesta-nuovo-pr');
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
        responsabile: nodo && nodo.parent ? nodo.parent.nickname : 'Amministrazione'
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/profilo', async (req, res, next) => {
  try {
    // Un collaboratore puo' cambiare i propri recapiti e la password, non la
    // percentuale ne' il responsabile: quelli li decide l'amministrazione.
    const campi = {
      nome: v.nome(req.body.nome),
      cognome: v.nome(req.body.cognome, 'Il cognome'),
      numero_telefono: v.telefono(req.body.numero_telefono)
    };
    if (req.body.password) campi.password = v.password(req.body.password);

    await utenti.aggiornaPr(req.session.user.id, campi);
    req.session.user.nome = campi.nome;
    req.session.user.cognome = campi.cognome;
    logAzione('profilo_aggiornato', { passwordCambiata: !!campi.password }, req);
    req.flash('messaggio', 'Profilo aggiornato.');
    res.redirect('/pr/profilo');
  } catch (err) {
    gestisci(err, req, res, next, '/pr/profilo');
  }
});

module.exports = router;
