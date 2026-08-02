// Area amministratore.
//
// Riscrittura completa del file originale (3049 righe). Cosa e' cambiato:
//  - Tutti i calcoli passano da services/commissions.js: non esistono piu' due
//    formule diverse per il guadagno admin (5% fisso nella overview contro
//    (100 - %PR - 85) nella pagina guadagni).
//  - Ogni identificativo ricevuto dall'esterno passa da verificaAmbitoAdmin.
//    Prima le API /admin/database/:table/:id non controllavano la gerarchia:
//    bastava conoscere un id per leggere o cancellare i dati di un altro admin.
//  - Rimossi i percorsi duplicati: /staff/create e /nuovo-utente facevano la
//    stessa cosa, cosi' come tre varianti di registrazione pagamento e due
//    middleware di autorizzazione quasi identici.
//  - Rimosso il pannello CRUD generico sul database: era un accesso diretto
//    alle tabelle senza controlli di coerenza.

const express = require('express');
const router = express.Router();

const { requireAdmin, caricaGerarchia, verificaAmbitoAdmin } = require('../middleware/auth');
const { adminLimiter } = require('../utils/rate-limiter');
const v = require('../services/validation');
const utenti = require('../services/users');
const tavoliSrv = require('../services/tavoli');
const pagamentiSrv = require('../services/pagamenti');
const impostazioniSrv = require('../services/settings');
const { get, all, run, transaction } = require('../services/db-helpers');
const {
  computeCommissions,
  computeAdminEconomics,
  getAndamentoMensile,
  euro
} = require('../services/commissions');

router.use(requireAdmin, adminLimiter, caricaGerarchia);

/** Id dei PR della gerarchia dell'admin collegato. */
function ambito(req) {
  return req.gerarchia.forAdmin(req.session.user.id).map((n) => n.id);
}

/**
 * Interpreta il riferimento al responsabile inviato dal modulo, nella forma
 * "admin:1" oppure "pr:3". Il tipo e' obbligatorio: un identificativo numerico
 * da solo non basta a distinguere un amministratore da un PR.
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

// ============================================================== RIEPILOGO
router.get('/riepilogo', async (req, res, next) => {
  try {
    const adminId = req.session.user.id;
    const { totali, calcolo, avvisi, impostazioni } = await computeAdminEconomics({ adminId });
    const prIds = ambito(req);

    const [inAttesa, andamento, richiestePr] = await Promise.all([
      tavoliSrv.contaInAttesa(prIds),
      getAndamentoMensile(prIds, 6),
      get("SELECT COUNT(*) AS n FROM richieste_creazione_pr WHERE stato = 'in_attesa'")
    ]);

    const ultimiTavoli = await tavoliSrv.elenca({ prIds, limite: 8 });

    res.render(
      'admin/riepilogo',
      vista(req, 'riepilogo', {
        titolo: 'Riepilogo',
        totali,
        impostazioni,
        avvisi,
        inAttesa,
        richiestePrAperte: richiestePr ? richiestePr.n : 0,
        andamento,
        ultimiTavoli,
        migliori: [...calcolo.elenco]
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
    const nodi = req.gerarchia.forAdmin(adminId);

    // I dati personali arrivano cifrati dal database: si decifrano solo qui.
    const anagrafiche = new Map((await utenti.listPr()).map((p) => [p.id, p]));

    const staff = calcolo.elenco.map((r) => ({
      ...r,
      ...anagrafiche.get(r.id),
      ...r // i valori calcolati hanno la precedenza sui campi grezzi
    }));

    res.render(
      'admin/staff',
      vista(req, 'staff', {
        titolo: 'Staff',
        staff,
        possibiliPadri: [
          {
            valore: `admin:${adminId}`,
            etichetta: `${req.session.user.nickname} (amministrazione)`
          },
          ...nodi
            .filter((n) => n.attivo)
            .map((n) => ({
              valore: `pr:${n.id}`,
              etichetta: `${n.nickname} - ${n.percentuale_provvigione}%`
            }))
        ],
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
      throw new v.ErroreValidazione('Questo nickname e\' gia\' in uso.');
    }

    // Il responsabile arriva nella forma "admin:1" o "pr:3". Il tipo va
    // indicato esplicitamente perche' un admin e un PR possono avere lo stesso
    // numero identificativo.
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
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/staff');
    }
    next(err);
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
        throw new v.ErroreValidazione('Questo nickname e\' gia\' in uso.');
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
    req.flash('messaggio', 'Modifiche salvate.');
    res.redirect('/admin/staff');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/staff');
    }
    next(err);
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
        `${nodo.nickname} ha ancora ${figliAttivi.length} collaboratori attivi: ` +
          'spostali sotto un altro responsabile prima di disattivarlo.'
      );
    }

    await utenti.disattivaPr(controllo.id);
    req.flash('messaggio', `${nodo.nickname} disattivato. Lo storico resta consultabile.`);
    res.redirect('/admin/staff');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/staff');
    }
    next(err);
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
    next(err);
  }
});

// ================================================================= TAVOLI
router.get('/tavoli', async (req, res, next) => {
  try {
    const prIds = ambito(req);
    const filtri = {
      stato: ['in_attesa', 'approvato', 'rifiutato'].includes(req.query.stato)
        ? req.query.stato
        : null
    };
    const from = req.query.da ? v.data(req.query.da, { campo: 'La data iniziale' }) : null;
    const to = req.query.a ? v.data(req.query.a, { campo: 'La data finale' }) : null;

    const elenco = await tavoliSrv.elenca({ prIds, stato: filtri.stato, from, to, limite: 500 });
    const totale = elenco
      .filter((t) => t.stato === 'approvato')
      .reduce((s, t) => s + Number(t.spesa_prevista), 0);

    res.render(
      'admin/tavoli',
      vista(req, 'tavoli', {
        titolo: 'Tavoli',
        elenco,
        filtri: { stato: filtri.stato || '', da: from || '', a: to || '' },
        totaleApprovato: euro(totale)
      })
    );
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/tavoli');
    }
    next(err);
  }
});

// =========================================================== APPROVAZIONI
router.get('/approvazioni', async (req, res, next) => {
  try {
    const prIds = ambito(req);
    const elenco = await tavoliSrv.elenca({ prIds, stato: tavoliSrv.STATI.ATTESA, limite: 200 });
    res.render(
      'admin/approvazioni',
      vista(req, 'approvazioni', { titolo: 'Approvazioni', elenco })
    );
  } catch (err) {
    next(err);
  }
});

/** Verifica che un tavolo appartenga a un PR della gerarchia dell'admin. */
async function tavoloInAmbito(req, tavoloId) {
  const tavolo = await tavoliSrv.getTavolo(v.idNumerico(tavoloId, 'Il tavolo'));
  if (!tavolo) throw new v.ErroreValidazione('Tavolo non trovato.');
  const controllo = verificaAmbitoAdmin(req, tavolo.pr_id);
  if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);
  return tavolo;
}

router.post('/approvazioni/:id/approva', async (req, res, next) => {
  try {
    await tavoloInAmbito(req, req.params.id);
    await tavoliSrv.approva(req.params.id, req.session.user.nickname);
    req.flash('messaggio', 'Tavolo approvato.');
    res.redirect('/admin/approvazioni');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/approvazioni');
    }
    next(err);
  }
});

router.post('/approvazioni/:id/rifiuta', async (req, res, next) => {
  try {
    await tavoloInAmbito(req, req.params.id);
    await tavoliSrv.rifiuta(req.params.id, req.session.user.nickname, req.body.motivo);
    req.flash('messaggio', 'Tavolo rifiutato. Resta consultabile nello storico.');
    res.redirect('/admin/approvazioni');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/approvazioni');
    }
    next(err);
  }
});

router.get('/approvazioni/:id/modifica', async (req, res, next) => {
  try {
    const tavolo = await tavoloInAmbito(req, req.params.id);
    const pr = req.gerarchia.get(tavolo.pr_id);
    res.render(
      'admin/tavolo-modifica',
      vista(req, 'approvazioni', { titolo: 'Modifica tavolo', tavolo, pr })
    );
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/approvazioni');
    }
    next(err);
  }
});

router.post('/approvazioni/:id/modifica', async (req, res, next) => {
  try {
    await tavoloInAmbito(req, req.params.id);
    await tavoliSrv.modifica(req.params.id, req.body, req.session.user.nickname);
    req.flash('messaggio', 'Tavolo aggiornato.');
    res.redirect('/admin/approvazioni');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect(`/admin/approvazioni/${req.params.id}/modifica`);
    }
    next(err);
  }
});

router.post('/tavoli/:id/riapri', async (req, res, next) => {
  try {
    await tavoloInAmbito(req, req.params.id);
    await tavoliSrv.riapri(req.params.id, req.session.user.nickname);
    req.flash('messaggio', 'Tavolo riportato in attesa di decisione.');
    res.redirect('/admin/tavoli');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/tavoli');
    }
    next(err);
  }
});

// ================================================================= REPORT
router.get('/report', async (req, res, next) => {
  try {
    const adminId = req.session.user.id;
    const from = req.query.da ? v.data(req.query.da, { campo: 'La data iniziale' }) : null;
    const to = req.query.a ? v.data(req.query.a, { campo: 'La data finale' }) : null;

    const calcolo = await computeCommissions({ adminId, from, to });
    const totali = {
      fatturato: euro(
        req.gerarchia
          .rootsForAdmin(adminId)
          .reduce((s, n) => s + (calcolo.perPr.get(n.id)?.fatturatoSottoalbero || 0), 0)
      ),
      provvigioni: euro(calcolo.elenco.reduce((s, r) => s + r.guadagnoNetto, 0)),
      tavoli: req.gerarchia
        .rootsForAdmin(adminId)
        .reduce((s, n) => s + (calcolo.perPr.get(n.id)?.tavoliSottoalbero || 0), 0)
    };

    res.render(
      'admin/report',
      vista(req, 'report', {
        titolo: 'Report provvigioni',
        elenco: calcolo.elenco,
        anomalie: calcolo.anomalie,
        periodoFiltrato: calcolo.periodoFiltrato,
        filtri: { da: from || '', a: to || '' },
        totali
      })
    );
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/report');
    }
    next(err);
  }
});

// =============================================================== GUADAGNI
router.get('/guadagni', async (req, res, next) => {
  try {
    const from = req.query.da ? v.data(req.query.da, { campo: 'La data iniziale' }) : null;
    const to = req.query.a ? v.data(req.query.a, { campo: 'La data finale' }) : null;

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
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/guadagni');
    }
    next(err);
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
    const { perPr } = await computeCommissions({ adminId });

    // L'admin paga solo i propri PR di primo livello: gli altri sono pagati
    // dal rispettivo responsabile.
    const daPagare = req.gerarchia
      .rootsForAdmin(adminId)
      .map((n) => perPr.get(n.id))
      .filter(Boolean);

    const [storico, ultime] = await Promise.all([
      pagamentiSrv.effettuatiDa('admin', adminId, 50),
      pagamentiSrv.ultimePerPr(daPagare.map((d) => d.id))
    ]);

    res.render(
      'admin/pagamenti',
      vista(req, 'pagamenti', {
        titolo: 'Pagamenti',
        daPagare: daPagare.map((d) => ({ ...d, ultimoPagamento: ultime.get(d.id) || null })),
        storico,
        totaleDovuto: euro(daPagare.reduce((s, d) => s + Math.max(0, d.saldoDaRicevere), 0)),
        totaleVersato: euro(storico.reduce((s, p) => s + Number(p.importo), 0))
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/pagamenti/registra', async (req, res, next) => {
  try {
    const controllo = verificaAmbitoAdmin(req, req.body.destinatario_id);
    if (!controllo.ok) throw new v.ErroreValidazione(controllo.motivo);

    const esito = await pagamentiSrv.registra({
      destinatarioId: controllo.id,
      paganteTipo: 'admin',
      paganteId: req.session.user.id,
      importo: req.body.importo,
      note: req.body.note,
      registratoDa: req.session.user.nickname
    });

    req.flash(
      'messaggio',
      `Pagamento di ${esito.importo} EUR registrato. Residuo: ${esito.residuoDopo} EUR.`
    );
    res.redirect('/admin/pagamenti');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/pagamenti');
    }
    next(err);
  }
});

router.post('/pagamenti/:id/annulla', async (req, res, next) => {
  try {
    await pagamentiSrv.annulla(req.params.id, { tipo: 'admin', id: req.session.user.id });
    req.flash('messaggio', 'Pagamento annullato.');
    res.redirect('/admin/pagamenti');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/pagamenti');
    }
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
        netto: dati ? dati.guadagnoNetto : 0,
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
        giorni: [...perGiorno.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([data, tavoli]) => ({
            data,
            tavoli,
            totale: euro(
              tavoli
                .filter((t) => t.stato === 'approvato')
                .reduce((s, t) => s + Number(t.spesa_prevista), 0)
            )
          }))
      })
    );
  } catch (err) {
    next(err);
  }
});

// ===================================================== RICHIESTE NUOVI PR
router.get('/richieste-pr', async (req, res, next) => {
  try {
    const prIds = ambito(req);
    const elenco = prIds.length
      ? await all(
          `SELECT r.*, p.nickname AS richiedente_nickname
           FROM richieste_creazione_pr r
           LEFT JOIN pr p ON p.id = r.fk_richiedente
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
      throw new v.ErroreValidazione('Questa richiesta e\' gia\' stata gestita.');
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

    await transaction(async () => {
      // La password e' gia' stata hashata quando il PR ha inviato la richiesta:
      // va usata cosi' com'e'. L'originale la ri-hashava qui, rendendo
      // impossibile accedere con la password scelta.
      await utenti.creaPr({
        nome: richiesta.nome,
        cognome: richiesta.cognome,
        numero_telefono: richiesta.numero_telefono,
        nickname: richiesta.nickname,
        password: richiesta.password,
        passwordGiaHashata: true,
        percentuale_provvigione: richiesta.percentuale_provvigione,
        fk_padre: padreId
      });
      await run(
        `UPDATE richieste_creazione_pr
         SET stato = 'approvata', data_risposta = datetime('now'), note_admin = ?
         WHERE id = ?`,
        [v.noteLibere(req.body.note_admin, 500) || null, id]
      );
    });

    req.flash('messaggio', `Collaboratore ${richiesta.nickname} creato.`);
    res.redirect('/admin/richieste-pr');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/richieste-pr');
    }
    next(err);
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
       SET stato = 'rifiutata', data_risposta = datetime('now'), note_admin = ?
       WHERE id = ? AND stato = 'in_attesa'`,
      [v.noteLibere(req.body.note_admin, 500) || null, id]
    );
    req.flash('messaggio', 'Richiesta rifiutata.');
    res.redirect('/admin/richieste-pr');
  } catch (err) {
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/richieste-pr');
    }
    next(err);
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
    if (err.name === 'ErroreValidazione') {
      req.flash('errore', err.message);
      return res.redirect('/admin/profilo');
    }
    next(err);
  }
});

module.exports = router;
