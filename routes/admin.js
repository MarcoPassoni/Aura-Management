// Area amministratore.
//
// Riscrittura completa del file originale (3049 righe). Cosa e' cambiato:
//  - Tutti i calcoli passano da services/commissions.js: non esistono piu' due
//    formule diverse per il guadagno admin (5% fisso nella overview contro
//    (100 - %PR - 85) nella pagina guadagni).
//  - Ogni identificativo ricevuto dall'esterno passa da verificaAmbitoAdmin.
//    Prima le API /admin/database/:table/:id non controllavano la gerarchia:
//    bastava conoscere un id per leggere o cancellare i dati di un altro admin.
//  - Rimossi i percorsi duplicati e il pannello CRUD generico sul database.
//
// Aggiunte di questa versione:
//  - registrazione dell'incasso reale della serata, separato dal preventivo;
//  - spostamento di un collaboratore sotto un altro responsabile, con controllo
//    degli anelli (prima l'unica strada era disattivarlo e ricrearlo, perdendo
//    il collegamento con il suo storico);
//  - pagina Verifica con i controlli di integrita';
//  - anteprima di quanto costera' un tavolo prima di approvarlo.

const express = require('express');
const router = express.Router();

const { requireAdmin, caricaGerarchia, verificaAmbitoAdmin } = require('../middleware/auth');
const { adminLimiter } = require('../utils/rate-limiter');
const v = require('../services/validation');
const utenti = require('../services/users');
const tavoliSrv = require('../services/tavoli');
const pagamentiSrv = require('../services/pagamenti');
const impostazioniSrv = require('../services/settings');
const quoteSrv = require('../services/quote');
const diagnostica = require('../services/diagnostica');
const { get, all, run, transaction } = require('../services/db-helpers');
const {
  computeCommissions,
  computeAdminEconomics,
  andamentoFatturato,
  euro
} = require('../services/commissions');

const { datiNavigazione } = require('../middleware/navigazione');

router.use(requireAdmin, adminLimiter, caricaGerarchia, datiNavigazione);

/** Id dei collaboratori della gerarchia dell'amministratore collegato. */
function ambito(req) {
  return req.gerarchia.forAdmin(req.session.user.id).map((n) => n.id);
}

/**
 * Interpreta il riferimento al responsabile inviato dal modulo, nella forma
 * "admin:1" oppure "pr:3". Il tipo e' obbligatorio: un identificativo numerico
 * da solo non basta a distinguere un amministratore da un collaboratore.
 */
function leggiRiferimentoPadre(valore) {
  const grezzo = String(valore || '');
  const [tipo, id] = grezzo.split(':');
  if (!['admin', 'pr'].includes(tipo)) {
    throw new v.ErroreValidazione('Responsabile non valido.');
  }
  return { tipo, id: v.idNumerico(id, 'Il responsabile') };
}

function vista(req, nome, dati = {}) {
  return {
    layout: 'layout',
    paginaCorrente: nome,
    titolo: dati.titolo || 'Aura',
    ...dati
  };
}

/** Elenco dei possibili responsabili, per i moduli di creazione e spostamento. */
function possibiliPadri(req, { escludi = null } = {}) {
  const adminId = req.session.user.id;
  const esclusi = new Set();
  if (escludi != null) {
    esclusi.add(Number(escludi));
    for (const n of req.gerarchia.descendants(escludi)) esclusi.add(n.id);
  }

  return [
    {
      valore: `admin:${adminId}`,
      etichetta: `${req.session.user.nickname} (amministrazione)`,
      percentuale: null
    },
    ...req.gerarchia
      .forAdmin(adminId)
      .filter((n) => n.attivo && !esclusi.has(n.id))
      .sort((a, b) => a.nickname.localeCompare(b.nickname, 'it'))
      .map((n) => ({
        valore: `pr:${n.id}`,
        etichetta: `${n.nickname} - ${n.percentuale_provvigione}%`,
        percentuale: n.percentuale_provvigione
      }))
  ];
}

/** Riporta un errore di validazione all'utente senza perdere la pagina. */
function gestisci(err, req, res, next, ritorno) {
  if (err && err.name === 'ErroreValidazione') {
    req.flash('errore', err.message);
    return res.redirect(ritorno);
  }
  return next(err);
}

// ============================================================== RIEPILOGO
router.get('/riepilogo', async (req, res, next) => {
  try {
    const adminId = req.session.user.id;
    const { totali, calcolo, avvisi, impostazioni } = await computeAdminEconomics({ adminId });
    const prIds = ambito(req);

    // I conteggi delle cose da gestire arrivano gia' dal middleware della barra
    // di navigazione: ricalcolarli qui significherebbe avere due numeri che
    // possono discordare tra loro.
    const inAttesa = res.locals.badge.approvazioni;
    const richiestePrAperte = res.locals.badge['richieste-pr'];

    const [andamento, ultimiTavoli] = await Promise.all([
      andamentoFatturato(prIds, 6),
      tavoliSrv.elenca({ prIds, limite: 8 })
    ]);

    // Segnali che richiedono attenzione, raccolti dai dati gia' calcolati per
    // questa pagina: non costa nessuna query in piu'.
    const scoperti = [];
    for (const r of calcolo.elenco) {
      for (const d of r.debitori) {
        if (d.saldo !== null && d.saldo < 0) {
          scoperti.push(`${r.nickname} risulta pagato ${Math.abs(d.saldo).toFixed(2)} EUR in piu' del dovuto da ${d.nome}.`);
        }
      }
    }

    res.render(
      'admin/riepilogo',
      vista(req, 'riepilogo', {
        titolo: 'Riepilogo',
        totali,
        impostazioni,
        avvisi: avvisi.concat(scoperti),
        tavoliEsclusi: res.locals.badge.verifica || 0,
        inAttesa,
        richiestePrAperte,
        andamento,
        ultimiTavoli,
        migliori: [...calcolo.elenco]
          .filter((r) => !r.fuoriStruttura)
          .sort((a, b) => b.fatturatoSottoalbero - a.fatturatoSottoalbero)
          .slice(0, 5)
      })
    );
  } catch (err) {
    next(err);
  }
});

// ================================================================== STAFF
router.get('/staff', async (req, res, next) => {
  try {
    const adminId = req.session.user.id;
    const { calcolo } = await computeAdminEconomics({ adminId });

    // I dati personali arrivano cifrati dal database: si decifrano solo qui.
    const anagrafiche = new Map((await utenti.listPr()).map((p) => [p.id, p]));

    const staff = calcolo.elenco.map((r) => {
      const a = anagrafiche.get(r.id) || {};
      return {
        ...r,
        nome: a.nome || r.nome,
        cognome: a.cognome || r.cognome,
        numero_telefono: a.numero_telefono || null,
        possibiliPadri: possibiliPadri(req, { escludi: r.id })
      };
    });

    res.render(
      'admin/staff',
      vista(req, 'staff', {
        titolo: 'Staff',
        staff,
        possibiliPadri: possibiliPadri(req),
        anomalie: calcolo.anomalie
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/staff/crea', async (req, res, next) => {
  try {
    const adminId = req.session.user.id;
    const dati = {
      nome: v.nome(req.body.nome),
      cognome: v.nome(req.body.cognome, 'Il cognome'),
      numero_telefono: v.telefono(req.body.numero_telefono),
      nickname: v.nickname(req.body.nickname),
      password: v.password(req.body.password),
      percentuale_provvigione: v.percentuale(req.body.percentuale_provvigione),
      poteri: req.body.poteri === 'on' || req.body.poteri === '1'
    };

    if (await utenti.nicknameEsiste(dati.nickname)) {
      throw new v.ErroreValidazione("Questo nickname e' gia' in uso.");
    }

    // Il responsabile arriva nella forma "admin:1" o "pr:3". Il tipo va
    // indicato esplicitamente perche' un admin e un collaboratore possono avere
    // lo stesso numero identificativo.
    const { tipo: padreTipo, id: padreId } = leggiRiferimentoPadre(req.body.padre_id);

    if (padreTipo === 'admin') {
      if (padreId !== adminId) {
        throw new v.ErroreValidazione('Puoi assegnare collaboratori solo a te stesso.');
      }
    } else {
      const controllo = verificaAmbitoAdmin(req, padreId);
      if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);
      const padre = req.gerarchia.get(padreId);
      if (dati.percentuale_provvigione > padre.percentuale_provvigione) {
        throw new v.ErroreValidazione(
          `La percentuale non puo' superare quella del responsabile ${padre.nickname} ` +
            `(${padre.percentuale_provvigione}%), altrimenti lavorerebbe in perdita.`
        );
      }
    }

    await utenti.creaPr({ ...dati, fk_padre: padreId, padre_tipo: padreTipo });
    req.flash('messaggio', `Collaboratore ${dati.nickname} creato.`);
    res.redirect('/admin/staff');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/staff');
  }
});

router.post('/staff/:id/modifica', async (req, res, next) => {
  try {
    const controllo = verificaAmbitoAdmin(req, req.params.id);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);
    const prId = controllo.id;
    const nodo = req.gerarchia.get(prId);

    const campi = {};
    if (req.body.nome) campi.nome = v.nome(req.body.nome);
    if (req.body.cognome) campi.cognome = v.nome(req.body.cognome, 'Il cognome');
    if (req.body.numero_telefono) campi.numero_telefono = v.telefono(req.body.numero_telefono);
    if (req.body.nickname) {
      campi.nickname = v.nickname(req.body.nickname);
      if (await utenti.nicknameEsiste(campi.nickname, { escludiPrId: prId })) {
        throw new v.ErroreValidazione("Questo nickname e' gia' in uso.");
      }
    }
    if (req.body.password) campi.password = v.password(req.body.password);
    campi.poteri = req.body.poteri === 'on' || req.body.poteri === '1';

    if (req.body.percentuale_provvigione !== undefined) {
      const perc = v.percentuale(req.body.percentuale_provvigione);
      // Coerenza verso l'alto e verso il basso: il modello differenziale
      // richiede percentuali non crescenti scendendo nella gerarchia.
      if (nodo.parent && perc > nodo.parent.percentuale_provvigione) {
        throw new v.ErroreValidazione(
          `La percentuale non puo' superare quella del responsabile ${nodo.parent.nickname} ` +
            `(${nodo.parent.percentuale_provvigione}%).`
        );
      }
      const figlioTroppoAlto = nodo.children.find((c) => c.percentuale_provvigione > perc);
      if (figlioTroppoAlto) {
        throw new v.ErroreValidazione(
          `Non puoi scendere sotto il ${figlioTroppoAlto.percentuale_provvigione}% di ` +
            `${figlioTroppoAlto.nickname}, che dipende da questo collaboratore.`
        );
      }
      campi.percentuale_provvigione = perc;
    }

    await utenti.aggiornaPr(prId, campi);

    const cambiata =
      campi.percentuale_provvigione !== undefined &&
      campi.percentuale_provvigione !== nodo.percentuale_provvigione;

    req.flash(
      'messaggio',
      cambiata
        ? `Modifiche salvate. La nuova percentuale vale dai prossimi tavoli approvati: ` +
            'quelli gia\' approvati mantengono la percentuale con cui erano stati calcolati.'
        : 'Modifiche salvate.'
    );
    res.redirect('/admin/staff');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/staff');
  }
});

/**
 * Sposta un collaboratore sotto un altro responsabile.
 *
 * Le provvigioni gia' maturate non si spostano: restano dovute da chi era
 * responsabile quando sono maturate. E' il motivo per cui questa operazione e'
 * diventata possibile solo ora che le quote sono congelate; prima avrebbe
 * riscritto tutto lo storico.
 */
router.post('/staff/:id/sposta', async (req, res, next) => {
  try {
    const controllo = verificaAmbitoAdmin(req, req.params.id);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);

    const nodo = req.gerarchia.get(controllo.id);
    const { tipo, id: padreId } = leggiRiferimentoPadre(req.body.padre_id);

    if (tipo === 'admin' && padreId !== req.session.user.id) {
      throw new v.ErroreValidazione('Puoi spostare un collaboratore solo sotto te stesso.');
    }
    if (tipo === 'pr') {
      const controlloPadre = verificaAmbitoAdmin(req, padreId);
      if (!controlloPadre.ok) throw new v.ErroreValidazione(controlloPadre.motivo);
    }

    const esito = req.gerarchia.puoSpostare(controllo.id, { tipo, id: padreId });
    if (!esito.ok) throw new v.ErroreValidazione(esito.motivo);

    await utenti.aggiornaPr(controllo.id, { fk_padre: padreId, padre_tipo: tipo });

    const nuovoNome =
      tipo === 'admin' ? "l'amministrazione" : req.gerarchia.get(padreId).nickname;
    req.flash(
      'messaggio',
      `${nodo.nickname} ora dipende da ${nuovoNome}. I compensi gia' maturati restano ` +
        'a carico del responsabile precedente.'
    );
    res.redirect('/admin/staff');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/staff');
  }
});

router.post('/staff/:id/disattiva', async (req, res, next) => {
  try {
    const controllo = verificaAmbitoAdmin(req, req.params.id);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);

    const nodo = req.gerarchia.get(controllo.id);
    const figliAttivi = nodo.children.filter((c) => c.attivo);
    if (figliAttivi.length) {
      throw new v.ErroreValidazione(
        `${nodo.nickname} ha ancora ${figliAttivi.length} ` +
          `${figliAttivi.length === 1 ? 'collaboratore attivo' : 'collaboratori attivi'}: ` +
          'spostali sotto un altro responsabile prima di disattivarlo.'
      );
    }

    await utenti.disattivaPr(controllo.id);
    req.flash(
      'messaggio',
      `${nodo.nickname} disattivato: non puo' piu' accedere, ma il suo storico e i ` +
        'compensi ancora da versare restano visibili.'
    );
    res.redirect('/admin/staff');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/staff');
  }
});

router.post('/staff/:id/riattiva', async (req, res, next) => {
  try {
    const controllo = verificaAmbitoAdmin(req, req.params.id);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);
    await utenti.riattivaPr(controllo.id);
    req.flash('messaggio', 'Collaboratore riattivato.');
    res.redirect('/admin/staff');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/staff');
  }
});

// ================================================================= TAVOLI
router.get('/tavoli', async (req, res, next) => {
  try {
    const prIds = ambito(req);
    const stato = ['in_attesa', 'approvato', 'rifiutato'].includes(req.query.stato)
      ? req.query.stato
      : null;
    const from = req.query.da ? v.data(req.query.da, { campo: 'La data iniziale' }) : null;
    const to = req.query.a ? v.data(req.query.a, { campo: 'La data finale' }) : null;

    if (from && to && from > to) {
      throw new v.ErroreValidazione('La data iniziale e\' successiva a quella finale.');
    }

    const elenco = await tavoliSrv.elenca({ prIds, stato, from, to, limite: 500 });
    const approvati = elenco.filter((t) => t.stato === 'approvato');

    res.render(
      'admin/tavoli',
      vista(req, 'tavoli', {
        titolo: 'Tavoli',
        elenco,
        filtri: { stato: stato || '', da: from || '', a: to || '' },
        totaleImponibile: euro(approvati.reduce((s, t) => s + t.imponibile, 0)),
        totaleProvvigioni: euro(approvati.reduce((s, t) => s + t.costoProvvigioni, 0)),
        senzaConsuntivo: approvati.filter((t) => t.baseCalcolo === 'preventivo').length
      })
    );
  } catch (err) {
    gestisci(err, req, res, next, '/admin/tavoli');
  }
});

/** Verifica che un tavolo appartenga a un collaboratore della propria struttura. */
async function tavoloInAmbito(req, tavoloId) {
  const tavolo = await tavoliSrv.getTavolo(v.idNumerico(tavoloId, 'Il tavolo'));
  if (!tavolo) throw new v.ErroreValidazione('Tavolo non trovato.');
  const controllo = verificaAmbitoAdmin(req, tavolo.pr_id);
  if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);
  return tavolo;
}

/** Registra l'incasso reale della serata. */
router.post('/tavoli/:id/incasso', async (req, res, next) => {
  try {
    await tavoloInAmbito(req, req.params.id);
    const esito = await tavoliSrv.impostaIncasso(
      req.params.id,
      req.body.incasso_effettivo,
      req.session.user.nickname
    );
    req.flash(
      'messaggio',
      esito.nuovo === null
        ? 'Consuntivo rimosso: il tavolo torna a essere calcolato sul preventivo.'
        : `Incasso registrato: ${euro(esito.nuovo).toFixed(2)} EUR. Le provvigioni di ` +
            'questo tavolo sono state aggiornate.'
    );
    res.redirect(req.body.ritorno || '/admin/tavoli');
  } catch (err) {
    gestisci(err, req, res, next, req.body.ritorno || '/admin/tavoli');
  }
});

router.post('/tavoli/:id/riapri', async (req, res, next) => {
  try {
    await tavoloInAmbito(req, req.params.id);
    await tavoliSrv.riapri(req.params.id, req.session.user.nickname);
    req.flash(
      'messaggio',
      'Tavolo riportato in attesa di decisione: e\' uscito dai calcoli finche\' non ' +
        'viene deciso di nuovo.'
    );
    res.redirect('/admin/tavoli');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/tavoli');
  }
});

/** Come e' ripartito un tavolo, riga per riga. */
router.get('/tavoli/:id/dettaglio', async (req, res, next) => {
  try {
    const tavolo = await tavoloInAmbito(req, req.params.id);
    const congelate = await quoteSrv.delTavolo(tavolo.id);
    const previste =
      tavolo.stato === 'in_attesa' ? await tavoliSrv.ripartizionePrevista(tavolo) : null;

    res.render(
      'admin/tavolo-dettaglio',
      vista(req, 'tavoli', {
        titolo: `Tavolo ${tavolo.nome_tavolo}`,
        tavolo,
        // Gli importi arrivano gia' calcolati dal servizio: sono gli stessi che
        // finiscono nei totali delle pagine economiche.
        quote: congelate,
        previste
      })
    );
  } catch (err) {
    gestisci(err, req, res, next, '/admin/tavoli');
  }
});

// =========================================================== APPROVAZIONI
router.get('/approvazioni', async (req, res, next) => {
  try {
    const prIds = ambito(req);
    // Il limite e' basso di proposito: ogni riga qui sotto ha una scheda
    // completa e una simulazione della ripartizione, che costa una query. Con
    // piu' di cinquanta richieste aperte conviene smaltirne un blocco per volta.
    const elenco = await tavoliSrv.elenca({ prIds, stato: tavoliSrv.STATI.ATTESA, limite: 50 });

    // Quanto costera' ciascun tavolo se approvato adesso: e' la stessa
    // ripartizione che verra' congelata, calcolata in anticipo. Se la catena e'
    // rotta si vede qui, non dopo aver premuto Approva.
    const conStima = await Promise.all(
      elenco.map(async (t) => ({ ...t, stima: await tavoliSrv.ripartizionePrevista(t) }))
    );

    res.render(
      'admin/approvazioni',
      vista(req, 'approvazioni', {
        titolo: 'Approvazioni',
        elenco: conStima,
        totaleImponibile: euro(conStima.reduce((s, t) => s + t.imponibile, 0)),
        totaleCosto: euro(conStima.reduce((s, t) => s + (t.stima.costoTotale || 0), 0)),
        bloccati: conStima.filter((t) => !t.stima.ok).length
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/approvazioni/:id/approva', async (req, res, next) => {
  try {
    await tavoloInAmbito(req, req.params.id);
    const esito = await tavoliSrv.approva(req.params.id, req.session.user.nickname);
    const capofila = esito.quote[esito.quote.length - 1];
    req.flash(
      'messaggio',
      `Tavolo approvato. Provvigioni congelate al ${capofila.percentuale}% del capofila: ` +
        'cambiare le percentuali da ora in poi non tocchera\' questo tavolo.'
    );
    res.redirect('/admin/approvazioni');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/approvazioni');
  }
});

router.post('/approvazioni/:id/rifiuta', async (req, res, next) => {
  try {
    await tavoloInAmbito(req, req.params.id);
    await tavoliSrv.rifiuta(req.params.id, req.session.user.nickname, req.body.motivo);
    req.flash('messaggio', 'Tavolo rifiutato. Resta consultabile nello storico.');
    res.redirect('/admin/approvazioni');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/approvazioni');
  }
});

router.get('/approvazioni/:id/modifica', async (req, res, next) => {
  try {
    const tavolo = await tavoloInAmbito(req, req.params.id);
    const pr = req.gerarchia.get(tavolo.pr_id);
    const quote = tavolo.stato === 'approvato' ? await quoteSrv.delTavolo(tavolo.id) : [];
    res.render(
      'admin/tavolo-modifica',
      vista(req, tavolo.stato === 'approvato' ? 'tavoli' : 'approvazioni', {
        titolo: 'Modifica tavolo',
        tavolo,
        pr,
        quote,
        ritorno: tavolo.stato === 'approvato' ? '/admin/tavoli' : '/admin/approvazioni'
      })
    );
  } catch (err) {
    gestisci(err, req, res, next, '/admin/approvazioni');
  }
});

router.post('/approvazioni/:id/modifica', async (req, res, next) => {
  try {
    const tavolo = await tavoloInAmbito(req, req.params.id);
    await tavoliSrv.modifica(req.params.id, req.body, req.session.user.nickname);
    req.flash('messaggio', 'Tavolo aggiornato.');
    res.redirect(tavolo.stato === 'approvato' ? '/admin/tavoli' : '/admin/approvazioni');
  } catch (err) {
    gestisci(err, req, res, next, `/admin/approvazioni/${req.params.id}/modifica`);
  }
});

// ================================================================= REPORT
router.get('/report', async (req, res, next) => {
  try {
    const adminId = req.session.user.id;
    const from = req.query.da ? v.data(req.query.da, { campo: 'La data iniziale' }) : null;
    const to = req.query.a ? v.data(req.query.a, { campo: 'La data finale' }) : null;
    if (from && to && from > to) {
      throw new v.ErroreValidazione('La data iniziale e\' successiva a quella finale.');
    }

    const { calcolo, totali } = await computeAdminEconomics({ adminId, from, to });

    res.render(
      'admin/report',
      vista(req, 'report', {
        titolo: 'Report provvigioni',
        elenco: calcolo.elenco,
        anomalie: calcolo.anomalie,
        periodoFiltrato: calcolo.periodoFiltrato,
        filtri: { da: from || '', a: to || '' },
        totali: {
          incasso: totali.incassoTotale,
          provvigioni: totali.costoProvvigioni,
          tavoli: totali.tavoli,
          persone: totali.persone,
          // Somma di quanto resta a ciascuno: deve coincidere al centesimo con
          // il costo totale delle provvigioni. Se non coincidesse ci sarebbe un
          // errore nel motore di calcolo, ed e' bene che si veda.
          trattenutoTotale: euro(calcolo.elenco.reduce((s, r) => s + r.trattenuto, 0))
        }
      })
    );
  } catch (err) {
    gestisci(err, req, res, next, '/admin/report');
  }
});

// =============================================================== GUADAGNI
router.get('/guadagni', async (req, res, next) => {
  try {
    const from = req.query.da ? v.data(req.query.da, { campo: 'La data iniziale' }) : null;
    const to = req.query.a ? v.data(req.query.a, { campo: 'La data finale' }) : null;
    if (from && to && from > to) {
      throw new v.ErroreValidazione('La data iniziale e\' successiva a quella finale.');
    }

    const risultato = await computeAdminEconomics({ adminId: req.session.user.id, from, to });
    res.render(
      'admin/guadagni',
      vista(req, 'guadagni', {
        titolo: 'Guadagni',
        ...risultato,
        filtri: { da: from || '', a: to || '' },
        elenco: risultato.calcolo.elenco
      })
    );
  } catch (err) {
    gestisci(err, req, res, next, '/admin/guadagni');
  }
});

// =========================================================== IMPOSTAZIONI
router.get('/impostazioni', async (req, res, next) => {
  try {
    const impostazioni = await impostazioniSrv.getImpostazioni(req.session.user.id);
    res.render(
      'admin/impostazioni',
      vista(req, 'impostazioni', { titolo: 'Impostazioni', impostazioni })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/impostazioni', async (req, res, next) => {
  try {
    await impostazioniSrv.setQuotaLocale(req.session.user.id, req.body.quota_locale);

    // Le detrazioni arrivano come array paralleli dal modulo.
    const nomi = [].concat(req.body.detrazione_nome || []);
    const percentuali = [].concat(req.body.detrazione_percentuale || []);
    const detrazioni = nomi.map((nome, i) => ({ nome, percentuale: percentuali[i] }));
    await impostazioniSrv.salvaDetrazioni(req.session.user.id, detrazioni);

    req.flash('messaggio', 'Impostazioni salvate.');
    res.redirect('/admin/impostazioni');
  } catch (err) {
    req.flash('errore', err.message);
    res.redirect('/admin/impostazioni');
  }
});

// ============================================================== PAGAMENTI
router.get('/pagamenti', async (req, res, next) => {
  try {
    const adminId = req.session.user.id;
    const { elenco } = await computeCommissions({ adminId });

    // L'amministrazione paga solo chi ha maturato qualcosa direttamente da lei:
    // di norma i capofila. Un collaboratore spostato altrove resta in elenco
    // finche' il debito non e' chiuso, ed e' giusto cosi'.
    const daPagare = elenco
      .map((r) => {
        const rapporto = r.debitori.find((d) => d.tipo === 'admin' && d.id === Number(adminId));
        return rapporto ? { ...r, rapporto } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.rapporto.saldo - a.rapporto.saldo);

    const [storico, ultime] = await Promise.all([
      pagamentiSrv.effettuatiDa('admin', adminId, 50),
      pagamentiSrv.ultimePerPr(daPagare.map((d) => d.id), { tipo: 'admin', id: adminId })
    ]);

    res.render(
      'admin/pagamenti',
      vista(req, 'pagamenti', {
        titolo: 'Pagamenti',
        daPagare: daPagare.map((d) => ({ ...d, ultimoPagamento: ultime.get(d.id) || null })),
        storico,
        totaleDovuto: euro(
          daPagare.reduce((s, d) => s + Math.max(0, d.rapporto.saldo), 0)
        ),
        totaleVersato: euro(storico.reduce((s, p) => s + Number(p.importo), 0)),
        inEccesso: daPagare.filter((d) => d.rapporto.saldo < 0)
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/pagamenti/registra', async (req, res, next) => {
  try {
    const id = v.idNumerico(req.body.destinatario_id, 'Il destinatario');

    const esito = await pagamentiSrv.registra({
      destinatarioId: id,
      paganteTipo: 'admin',
      paganteId: req.session.user.id,
      importo: req.body.importo,
      note: req.body.note,
      registratoDa: req.session.user.nickname
    });

    req.flash(
      'messaggio',
      `Registrato il pagamento di ${esito.importo.toFixed(2)} EUR a ${esito.destinatario}. ` +
        `Restano ${esito.residuoDopo.toFixed(2)} EUR.`
    );
    res.redirect('/admin/pagamenti');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/pagamenti');
  }
});

router.post('/pagamenti/:id/annulla', async (req, res, next) => {
  try {
    await pagamentiSrv.annulla(req.params.id, { tipo: 'admin', id: req.session.user.id });
    req.flash('messaggio', 'Pagamento annullato: il saldo torna scoperto.');
    res.redirect('/admin/pagamenti');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/pagamenti');
  }
});

// =============================================================== VERIFICA
router.get('/verifica', async (req, res, next) => {
  try {
    const esito = await diagnostica.verifica(req.session.user.id);
    res.render(
      'admin/verifica',
      vista(req, 'verifica', { titolo: 'Verifica dei dati', ...esito })
    );
  } catch (err) {
    next(err);
  }
});

// =========================================================== ORGANIGRAMMA
router.get('/organigramma', async (req, res, next) => {
  try {
    const adminId = req.session.user.id;
    const { perPr } = await computeCommissions({ adminId });

    function costruisci(nodo) {
      const dati = perPr.get(nodo.id);
      return {
        id: nodo.id,
        nickname: nodo.nickname,
        percentuale: nodo.percentuale_provvigione,
        attivo: nodo.attivo,
        poteri: nodo.poteri,
        fatturato: dati ? dati.fatturatoSottoalbero : 0,
        trattenuto: dati ? dati.trattenuto : 0,
        saldo: dati ? dati.saldo : 0,
        figli: nodo.children.map(costruisci)
      };
    }

    res.render(
      'admin/organigramma',
      vista(req, 'organigramma', {
        titolo: 'Organigramma',
        radici: req.gerarchia.rootsForAdmin(adminId).map(costruisci),
        adminNickname: req.session.user.nickname
      })
    );
  } catch (err) {
    next(err);
  }
});

// ============================================================= CALENDARIO
router.get('/calendario', async (req, res, next) => {
  try {
    const prIds = ambito(req);
    const mese = /^\d{4}-\d{2}$/.test(req.query.mese || '')
      ? req.query.mese
      : new Date().toISOString().slice(0, 7);

    const elenco = await tavoliSrv.elenca({
      prIds,
      from: `${mese}-01`,
      to: `${mese}-31`,
      limite: 500
    });

    const perGiorno = new Map();
    for (const t of elenco) {
      if (!perGiorno.has(t.data)) perGiorno.set(t.data, []);
      perGiorno.get(t.data).push(t);
    }

    res.render(
      'admin/calendario',
      vista(req, 'calendario', {
        titolo: 'Calendario',
        mese,
        mesePrecedente: spostaMese(mese, -1),
        meseSuccessivo: spostaMese(mese, 1),
        giorni: [...perGiorno.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([data, tavoli]) => ({
            data,
            tavoli,
            totale: euro(
              tavoli
                .filter((t) => t.stato === 'approvato')
                .reduce((s, t) => s + t.imponibile, 0)
            )
          }))
      })
    );
  } catch (err) {
    next(err);
  }
});

function spostaMese(aaaaMm, delta) {
  const [a, m] = aaaaMm.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ===================================================== RICHIESTE NUOVI PR
router.get('/richieste-pr', async (req, res, next) => {
  try {
    const prIds = ambito(req);
    const elenco = prIds.length
      ? await all(
          `SELECT r.*, p.nickname AS richiedente_nickname, pp.nickname AS padre_nickname,
                  pp.percentuale_provvigione AS padre_percentuale
             FROM richieste_creazione_pr r
             LEFT JOIN pr p ON p.id = r.fk_richiedente
             LEFT JOIN pr pp ON pp.id = COALESCE(r.fk_padre_proposto, r.fk_richiedente)
            WHERE r.fk_richiedente IN (${prIds.map(() => '?').join(',')})
            ORDER BY CASE r.stato WHEN 'in_attesa' THEN 0 ELSE 1 END, r.data_richiesta DESC`,
          prIds
        )
      : [];

    res.render(
      'admin/richieste-pr',
      vista(req, 'richieste-pr', { titolo: 'Richieste nuovi collaboratori', elenco })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/richieste-pr/:id/approva', async (req, res, next) => {
  try {
    const id = v.idNumerico(req.params.id, 'La richiesta');
    const richiesta = await get('SELECT * FROM richieste_creazione_pr WHERE id = ?', [id]);
    if (!richiesta) throw new v.ErroreValidazione('Richiesta non trovata.');
    if (richiesta.stato !== 'in_attesa') {
      throw new v.ErroreValidazione("Questa richiesta e' gia' stata gestita.");
    }

    const controllo = verificaAmbitoAdmin(req, richiesta.fk_richiedente);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);

    const padreId = richiesta.fk_padre_proposto || richiesta.fk_richiedente;
    const controlloPadre = verificaAmbitoAdmin(req, padreId);
    if (!controlloPadre.ok) throw new v.ErroreValidazione(controlloPadre.motivo);

    if (await utenti.nicknameEsiste(richiesta.nickname)) {
      throw new v.ErroreValidazione(
        `Il nickname ${richiesta.nickname} nel frattempo e' stato assegnato a qualcun altro.`
      );
    }

    const padre = req.gerarchia.get(padreId);
    if (richiesta.percentuale_provvigione > padre.percentuale_provvigione) {
      throw new v.ErroreValidazione(
        `La percentuale richiesta (${richiesta.percentuale_provvigione}%) supera quella di ` +
          `${padre.nickname} (${padre.percentuale_provvigione}%).`
      );
    }

    await transaction(async (tx) => {
      // La password e' gia' stata hashata quando il collaboratore ha inviato la
      // richiesta: va usata cosi' com'e'. L'originale la ri-hashava qui,
      // rendendo impossibile accedere con la password scelta.
      await utenti.creaPr({
        nome: richiesta.nome,
        cognome: richiesta.cognome,
        numero_telefono: richiesta.numero_telefono,
        nickname: richiesta.nickname,
        password: richiesta.password,
        passwordGiaHashata: true,
        percentuale_provvigione: richiesta.percentuale_provvigione,
        fk_padre: padreId,
        padre_tipo: 'pr'
      });
      // I dati personali della richiesta non sono cifrati (a differenza di
      // quelli del collaboratore appena creato): una volta trasferiti nella
      // tabella pr non servono piu' e vengono rimossi.
      await tx.run(
        `UPDATE richieste_creazione_pr
            SET stato = 'approvata', data_risposta = datetime('now'), note_admin = ?,
                nome = '(rimosso)', cognome = '(rimosso)', numero_telefono = '(rimosso)',
                password = ''
          WHERE id = ? AND stato = 'in_attesa'`,
        [v.noteLibere(req.body.note_admin, 500) || null, id]
      );
    });

    req.flash('messaggio', `Collaboratore ${richiesta.nickname} creato.`);
    res.redirect('/admin/richieste-pr');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/richieste-pr');
  }
});

router.post('/richieste-pr/:id/rifiuta', async (req, res, next) => {
  try {
    const id = v.idNumerico(req.params.id, 'La richiesta');
    const richiesta = await get('SELECT * FROM richieste_creazione_pr WHERE id = ?', [id]);
    if (!richiesta) throw new v.ErroreValidazione('Richiesta non trovata.');

    const controllo = verificaAmbitoAdmin(req, richiesta.fk_richiedente);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);

    await run(
      `UPDATE richieste_creazione_pr
          SET stato = 'rifiutata', data_risposta = datetime('now'), note_admin = ?,
              nome = '(rimosso)', cognome = '(rimosso)', numero_telefono = '(rimosso)',
              password = ''
        WHERE id = ? AND stato = 'in_attesa'`,
      [v.noteLibere(req.body.note_admin, 500) || null, id]
    );
    req.flash('messaggio', 'Richiesta rifiutata.');
    res.redirect('/admin/richieste-pr');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/richieste-pr');
  }
});

// ================================================================ PROFILO
router.get('/profilo', async (req, res, next) => {
  try {
    const admin = await utenti.getAdmin(req.session.user.id);
    res.render('admin/profilo', vista(req, 'profilo', { titolo: 'Il mio profilo', admin }));
  } catch (err) {
    next(err);
  }
});

router.post('/profilo', async (req, res, next) => {
  try {
    // Un amministratore puo' modificare solo il proprio profilo.
    const campi = {
      nome: v.nome(req.body.nome),
      cognome: v.nome(req.body.cognome, 'Il cognome'),
      numero_telefono: v.telefono(req.body.numero_telefono)
    };
    if (req.body.password) campi.password = v.password(req.body.password);

    await utenti.aggiornaAdmin(req.session.user.id, campi);
    req.session.user.nome = campi.nome;
    req.session.user.cognome = campi.cognome;
    req.flash('messaggio', 'Profilo aggiornato.');
    res.redirect('/admin/profilo');
  } catch (err) {
    gestisci(err, req, res, next, '/admin/profilo');
  }
});

module.exports = router;
