// Passaggio di mano di una richiesta di tavolo lungo la catena di
// responsabilita', prima che arrivi all'amministrazione.
//
// PERCHE' ESISTE QUESTO FILE
//
// Prima una richiesta andava sempre e solo dal PR che l'ha creata
// all'amministrazione. Ora, se sopra il venditore ci sono altri collaboratori,
// la richiesta sale un livello alla volta: ognuno puo' vedere la percentuale
// che spetterebbe di norma al proprio sottoposto diretto (quella impostata sul
// suo profilo), decidere di pagargli questo tavolo specifico a una percentuale
// diversa, ed eventualmente lasciare un commento. Solo quando arriva in cima -
// al collaboratore di primo livello, il cui responsabile e' l'amministrazione -
// tocca all'amministratore decidere la percentuale del capofila e approvare
// davvero: e' l'unica azione che genera il debito (vedi services/tavoli.js).
//
// CHI DECIDE COSA
//
// Chi rivede una richiesta decide SEMPRE la percentuale del proprio sottoposto
// DIRETTO su quel tavolo, mai quella di qualcun altro piu' in basso nella
// catena: quella e' gia' stata decisa da chi sta immediatamente sopra di lui,
// un passaggio alla volta. L'amministratore, allo stesso modo, decide la
// percentuale del capofila (l'unico livello che nessun PR puo' rivedere,
// perche' non ha nessun PR sopra di se').
//
// PERCHE' NON PUO' CREARE NUMERI INCOERENTI
//
// Ogni decisione e' validata contro due limiti, calcolati sui dati disponibili
// in quel momento:
//   - un tetto: non si puo' promettere al proprio sottoposto piu' di quanto si
//     guadagna di norma (la propria percentuale corrente), altrimenti chi
//     rivede lavorerebbe gia' in perdita su questo tavolo;
//   - un pavimento: non si puo' scendere sotto la percentuale gia' decisa per
//     il livello immediatamente sotto, altrimenti sarebbe il livello appena
//     rivisto a lavorare in perdita.
// Rispettati questi due limiti a ogni passaggio, la catena risultante e'
// sempre coerente per costruzione quando arriva il momento di congelarla
// (services/quote.js), non solo controllata a posteriori.
//
// RISERVATEZZA DEI COMMENTI
//
// Un commento e' visibile a chiunque stia SOPRA chi lo ha scritto nella
// catena (compreso l'amministratore, alla fine), mai a chi sta sotto: il
// venditore originale non vede mai i commenti altrui, ne' le percentuali
// decise per collaboratori diversi da se stesso. Questa e' una questione di
// SOLA VISUALIZZAZIONE: ogni dato resta scritto nel database per intero (e'
// la base dell'audit), a deciderne la visibilita' e' chi chiama le funzioni
// di lettura qui sotto (vedi `perSottoposto` contro `situazione`).
//
// COLLABORATORI DISATTIVATI LUNGO LA CATENA
//
// Un collaboratore disattivato non puo' piu' accedere, quindi non puo' agire
// sul proprio turno di revisione. Per non lasciare una richiesta bloccata per
// sempre, il suo passaggio viene completato automaticamente con la
// percentuale di default del suo sottoposto (nessuna vera revisione, lo dice
// il commento generato), e si passa oltre.

const { run, get, all, transaction } = require('./db-helpers');
const v = require('./validation');
const { ErroreValidazione } = v;
const quote = require('./quote');
const denaro = require('./denaro');

const funzioniGlobali = { run, get, all };

/**
 * Avanza la richiesta finche' non trova un revisore che deve agire davvero
 * (un collaboratore attivo, o l'amministrazione), saltando e completando
 * automaticamente ogni livello il cui revisore e' disattivato. Scrive i
 * passaggi automatici e aggiorna `tavoli.revisione_tipo/revisione_id`.
 *
 * @param {object} catena  il risultato di `quote.catenaDi(venditoreId, tx)`
 * @returns {Promise<{tipo: 'pr'|'admin', id: number, livello: number, prId: number}>}
 */
async function avanza(tavoloId, catena, tx = funzioniGlobali) {
  const { righe, adminId } = catena;
  const ultimo = righe.length - 1;

  const decisi = new Set(
    (await tx.all('SELECT livello FROM revisioni_tavolo WHERE tavolo_id = ?', [tavoloId])).map(
      (r) => r.livello
    )
  );

  let livello = 0;
  while (decisi.has(livello) && livello < ultimo) livello++;

  // Il pavimento di partenza e' quanto e' gia' stato deciso al livello
  // appena sotto (0 se si parte dal venditore stesso).
  let pavimento = livello > 0 ? await percentualeDecisaLivello(tavoloId, livello - 1, tx) : 0;

  while (livello < ultimo) {
    const revisorePr = righe[livello + 1];
    if (Number(revisorePr.attivo) === 1) {
      await impostaRevisione(tavoloId, 'pr', revisorePr.id, tx);
      return { tipo: 'pr', id: revisorePr.id, livello, prId: righe[livello].id };
    }

    // Il revisore naturale e' disattivato: si completa il suo passaggio da
    // solo. Si usa la percentuale di default del sottoposto, a meno che non
    // scenda sotto quanto e' gia' stato deciso al livello appena sotto: in tal
    // caso si usa il pavimento, cosi' anche un completamento automatico non
    // puo' mai far lavorare qualcuno in perdita.
    const decisa = Math.max(righe[livello].percentuale, pavimento);
    await tx.run(
      `INSERT INTO revisioni_tavolo
         (tavolo_id, livello, pr_id, percentuale_suggerita, percentuale_decisa,
          revisore_tipo, revisore_id, commento)
       VALUES (?, ?, ?, ?, ?, 'pr', ?, ?)`,
      [
        tavoloId,
        livello,
        righe[livello].id,
        righe[livello].percentuale,
        decisa,
        revisorePr.id,
        `Percentuale applicata automaticamente: ${revisorePr.nickname} e' disattivato ` +
          'e non ha potuto rivedere questa richiesta.'
      ]
    );
    decisi.add(livello);
    pavimento = decisa;
    livello++;
  }

  // Livello `ultimo` (il capofila): nessun collaboratore puo' riverderlo, e'
  // sempre l'amministrazione a deciderlo, all'atto dell'approvazione finale.
  await impostaRevisione(tavoloId, 'admin', adminId, tx);
  return { tipo: 'admin', id: adminId, livello: ultimo, prId: righe[ultimo].id };
}

async function impostaRevisione(tavoloId, tipo, id, tx) {
  await tx.run('UPDATE tavoli SET revisione_tipo = ?, revisione_id = ? WHERE id = ?', [
    tipo,
    id,
    tavoloId
  ]);
}

/**
 * Avvia il tracciamento di una richiesta appena creata. Va chiamata nella
 * stessa transazione dell'inserimento del tavolo: se la catena del venditore
 * non e' risolvibile (orfano, ciclo), la richiesta non viene creata affatto,
 * invece di nascere gia' bloccata senza che nessuno sappia di doverla
 * sbloccare.
 */
async function avvia(tavoloId, venditoreId, tx = funzioniGlobali) {
  const catena = await quote.catenaDi(venditoreId, tx);
  return avanza(tavoloId, catena, tx);
}

/**
 * Un collaboratore intermedio rivede la richiesta: decide (o conferma) la
 * percentuale del proprio sottoposto diretto su questo tavolo, ed
 * eventualmente lascia un commento per chi sta sopra di lui. Poi la richiesta
 * passa al livello successivo.
 */
async function rivedi({ tavoloId, revisorePrId, percentuale, commento }) {
  const id = v.idNumerico(tavoloId, 'Il tavolo');
  const revisore = v.idNumerico(revisorePrId, 'Il revisore');
  const nota = v.noteLibere(commento, 1000);

  return transaction(async (tx) => {
    const tavolo = await tx.get('SELECT * FROM tavoli WHERE id = ?', [id]);
    if (!tavolo) throw new ErroreValidazione('Richiesta non trovata.');
    if (tavolo.stato !== 'in_attesa') {
      throw new ErroreValidazione("Questa richiesta e' gia' stata gestita.");
    }

    const catena = await quote.catenaDi(tavolo.pr_id, tx);
    // Salta eventuali revisori disattivati apparsi da quando la richiesta e'
    // arrivata qui, prima di verificare chi deve agire davvero.
    const prossimo = await avanza(id, catena, tx);

    if (prossimo.tipo !== 'pr' || prossimo.id !== revisore) {
      throw new ErroreValidazione(
        prossimo.tipo === 'admin'
          ? "Questa richiesta e' gia' arrivata all'amministrazione: non e' piu' possibile rivederla."
          : 'Questa richiesta non e\' (o non e\' piu\') al tuo turno di revisione.'
      );
    }

    const { livello, prId: sottopostoId } = prossimo;
    const sottoposto = catena.righe[livello];
    const suggerita = sottoposto.percentuale;
    const decisa = v.percentuale(percentuale, 'La percentuale');

    const tetto = catena.righe[livello + 1].percentuale; // la percentuale corrente del revisore
    if (decisa > tetto) {
      throw new ErroreValidazione(
        `Non puoi assegnare a ${sottoposto.nickname} piu' del ${tetto}%: e' la tua percentuale ` +
          'attuale, e su questo tavolo ci rimetteresti.'
      );
    }

    const pavimento = livello > 0 ? await percentualeDecisaLivello(id, livello - 1, tx) : 0;
    if (decisa < pavimento) {
      const soggettoSotto = catena.righe[livello - 1].nickname;
      throw new ErroreValidazione(
        `Non puoi scendere sotto il ${pavimento}%: e' gia' stato deciso per ${soggettoSotto}, ` +
          `che dipende da ${sottoposto.nickname}. Scendere di piu' farebbe lavorare in perdita ` +
          `${sottoposto.nickname} su questo tavolo.`
      );
    }

    await tx.run(
      `INSERT INTO revisioni_tavolo
         (tavolo_id, livello, pr_id, percentuale_suggerita, percentuale_decisa,
          revisore_tipo, revisore_id, commento)
       VALUES (?, ?, ?, ?, ?, 'pr', ?, ?)`,
      [id, livello, sottopostoId, suggerita, decisa, revisore, nota || null]
    );

    const successivo = await avanza(id, catena, tx);

    return {
      sottoposto: sottoposto.nickname,
      percentualeSuggerita: suggerita,
      percentualeDecisa: decisa,
      modificata: decisa !== suggerita,
      prossimo: successivo
    };
  });
}

/** Percentuale gia' decisa per un dato livello di un tavolo, o null se non ancora deciso. */
async function percentualeDecisaLivello(tavoloId, livello, tx = funzioniGlobali) {
  const r = await tx.get(
    'SELECT percentuale_decisa FROM revisioni_tavolo WHERE tavolo_id = ? AND livello = ?',
    [tavoloId, livello]
  );
  return r ? Number(r.percentuale_decisa) : 0;
}

/**
 * Registra la decisione dell'amministrazione sulla percentuale del capofila,
 * l'ultimo livello della catena, quello che nessun collaboratore puo'
 * rivedere. Va chiamata dentro la transazione di approvazione, subito prima
 * di congelare le quote (services/quote.js), cosi' che il congelamento veda
 * gia' questa riga fra le percentuali decise.
 *
 * @returns {Promise<Map<number,number>>} tutte le percentuali decise per
 *   questo tavolo (pr_id -> percentuale), pronte per `quote.congela`.
 */
async function registraDecisioneFinale({ tavoloId, venditoreId, adminId, percentuale }, tx) {
  const catena = await quote.catenaDi(venditoreId, tx);
  const prossimo = await avanza(tavoloId, catena, tx);

  if (prossimo.tipo !== 'admin') {
    throw new ErroreValidazione(
      `Questa richiesta e' di nuovo in revisione presso ${
        catena.righe.find((r) => r.id === prossimo.id)?.nickname || 'un collaboratore'
      }: la struttura e' cambiata da quando era arrivata in coda. Riprova quando sara' di nuovo ` +
        'arrivata fino a te.'
    );
  }

  const ultimo = catena.righe.length - 1;
  const capofila = catena.righe[ultimo];
  const suggerita = capofila.percentuale;
  const decisa =
    percentuale === null || percentuale === undefined || percentuale === ''
      ? suggerita
      : v.percentuale(percentuale, 'La percentuale');

  const pavimento = ultimo > 0 ? await percentualeDecisaLivello(tavoloId, ultimo - 1, tx) : 0;
  if (decisa < pavimento) {
    const soggettoSotto = catena.righe[ultimo - 1].nickname;
    throw new ErroreValidazione(
      `Non puoi scendere sotto il ${pavimento}%: e' gia' stato deciso per ${soggettoSotto}, ` +
        `che dipende da ${capofila.nickname}. Scendere di piu' farebbe lavorare in perdita ` +
        `${capofila.nickname} su questo tavolo.`
    );
  }

  await tx.run(
    `INSERT INTO revisioni_tavolo
       (tavolo_id, livello, pr_id, percentuale_suggerita, percentuale_decisa,
        revisore_tipo, revisore_id, commento)
     VALUES (?, ?, ?, ?, ?, 'admin', ?, NULL)`,
    [tavoloId, ultimo, capofila.id, suggerita, decisa, adminId]
  );

  return percentualiDecise(tavoloId, tx);
}

/** Tutte le percentuali decise per un tavolo, pronte per `quote.congela`. */
async function percentualiDecise(tavoloId, tx = funzioniGlobali) {
  const righe = await tx.all(
    'SELECT pr_id, percentuale_decisa FROM revisioni_tavolo WHERE tavolo_id = ?',
    [tavoloId]
  );
  return new Map(righe.map((r) => [r.pr_id, Number(r.percentuale_decisa)]));
}

/** Azzera l'instradamento e il trail: usata quando un tavolo viene riaperto o rifiutato. */
async function reimposta(tavoloId, tx = funzioniGlobali) {
  await tx.run('DELETE FROM revisioni_tavolo WHERE tavolo_id = ?', [tavoloId]);
  await impostaRevisione(tavoloId, null, null, tx);
}

/**
 * Situazione completa di una richiesta: la catena, cosa e' gia' stato deciso
 * (con commenti e chi ha revisionato), e chi deve agire adesso. Pensata per
 * chi puo' vedere tutto (l'amministrazione, o un revisore che sta guardando
 * il proprio turno, entrambi "sopra" ogni passaggio gia' avvenuto). Non va
 * usata per mostrare qualcosa al venditore originale: vedi `perSottoposto`.
 */
async function situazione(tavoloId) {
  const tavolo = await get('SELECT * FROM tavoli WHERE id = ?', [tavoloId]);
  if (!tavolo) return null;

  const catena = await quote.catenaDi(tavolo.pr_id);
  const passaggi = await all(
    `SELECT rt.*,
            p.nickname,
            CASE rt.revisore_tipo WHEN 'pr' THEN pr2.nickname ELSE ad.nickname END AS revisore_nickname
       FROM revisioni_tavolo rt
       JOIN pr p ON p.id = rt.pr_id
       LEFT JOIN pr pr2 ON pr2.id = rt.revisore_id AND rt.revisore_tipo = 'pr'
       LEFT JOIN admin ad ON ad.id = rt.revisore_id AND rt.revisore_tipo = 'admin'
      WHERE rt.tavolo_id = ?
      ORDER BY rt.livello`,
    [tavoloId]
  );
  const perLivello = new Map(passaggi.map((p) => [p.livello, p]));

  // Imponibile del tavolo, per calcolare quanto varrebbe ciascuna riga: la
  // stessa regola preventivo/consuntivo usata ovunque (services/denaro.js).
  const imponibileCent = denaro.aCentesimi(
    tavolo.incasso_effettivo === null || tavolo.incasso_effettivo === undefined
      ? tavolo.spesa_prevista
      : tavolo.incasso_effettivo
  );

  const ultimo = catena.righe.length - 1;
  let sottoCent = 0;

  const righe = catena.righe.map((r, livello) => {
    const passaggio = perLivello.get(livello) || null;
    // La percentuale che conta: quella gia' decisa se c'e', altrimenti quella
    // consigliata (il valore corrente del profilo) - e' quella che chi deve
    // agire adesso vedrebbe come punto di partenza.
    const percentuale = passaggio ? Number(passaggio.percentuale_decisa) : r.percentuale;
    const lordoCent = denaro.quotaCentesimi(imponibileCent, percentuale);
    const riga = {
      livello,
      prId: r.id,
      nickname: r.nickname,
      percentualeProfilo: r.percentuale,
      attivo: !!r.attivo,
      passaggio,
      percentuale,
      lordo: denaro.aEuro(lordoCent),
      netto: denaro.aEuro(lordoCent - sottoCent)
    };
    sottoCent = lordoCent;
    return riga;
  });

  return {
    righe,
    completo: perLivello.has(ultimo),
    adminId: catena.adminId,
    imponibile: denaro.aEuro(imponibileCent),
    costoTotale: righe.length ? righe[ultimo].lordo : 0
  };
}

/**
 * Cosa puo' vedere il venditore originale della propria richiesta: solo la
 * propria percentuale (se gia' decisa) e presso chi si trova adesso. Mai i
 * commenti, mai le percentuali decise per gli altri livelli della catena.
 */
async function perSottoposto(tavoloId) {
  const tavolo = await get('SELECT * FROM tavoli WHERE id = ?', [tavoloId]);
  if (!tavolo || tavolo.stato !== 'in_attesa') return null;

  const propria = await get(
    'SELECT percentuale_decisa FROM revisioni_tavolo WHERE tavolo_id = ? AND livello = 0',
    [tavoloId]
  );
  // L'importo si ricava dalla stessa fonte di ogni altro calcolo (imponibile
  // preventivo/consuntivo, arrotondamento in centesimi), non ricalcolato qui.
  const importo = propria
    ? denaro.aEuro(
        denaro.quotaCentesimi(
          denaro.aCentesimi(
            tavolo.incasso_effettivo === null || tavolo.incasso_effettivo === undefined
              ? tavolo.spesa_prevista
              : tavolo.incasso_effettivo
          ),
          propria.percentuale_decisa
        )
      )
    : null;

  let pressoChi = null;
  if (tavolo.revisione_tipo === 'admin') {
    pressoChi = "l'amministrazione";
  } else if (tavolo.revisione_tipo === 'pr' && tavolo.revisione_id) {
    const r = await get('SELECT nickname FROM pr WHERE id = ?', [tavolo.revisione_id]);
    pressoChi = r ? r.nickname : null;
  }

  return {
    percentualeDecisa: propria ? Number(propria.percentuale_decisa) : null,
    importo,
    pressoChi
  };
}

/** Richieste attualmente in attesa della revisione di un dato collaboratore. */
async function codaPerPr(prId) {
  return all(
    `SELECT t.*, p.nickname AS venditore_nickname
       FROM tavoli t
       JOIN pr p ON p.id = t.pr_id
      WHERE t.stato = 'in_attesa' AND t.revisione_tipo = 'pr' AND t.revisione_id = ?
      ORDER BY t.creato_il`,
    [prId]
  );
}

async function contaCodaPerPr(prId) {
  const r = await get(
    `SELECT COUNT(*) AS n FROM tavoli WHERE stato = 'in_attesa' AND revisione_tipo = 'pr' AND revisione_id = ?`,
    [prId]
  );
  return r ? r.n : 0;
}

/**
 * Richieste della struttura di un'amministrazione arrivate in fondo alla
 * catena, pronte per l'approvazione vera e propria. E' un sottoinsieme di
 * "tutte le in_attesa": molte possono essere ancora ferme presso un
 * collaboratore intermedio, e non sono ancora affar suo.
 */
async function contaPerAdmin(prIds) {
  if (!Array.isArray(prIds) || prIds.length === 0) return 0;
  const r = await get(
    `SELECT COUNT(*) AS n FROM tavoli
      WHERE stato = 'in_attesa' AND revisione_tipo = 'admin' AND pr_id IN (${prIds.map(() => '?').join(',')})`,
    prIds
  );
  return r ? r.n : 0;
}

/**
 * Instrada i tavoli in attesa creati prima che questo meccanismo esistesse:
 * non sono mai passati da nessun collaboratore intermedio, quindi vanno
 * direttamente in coda all'amministrazione. Da chiamare una volta sola
 * all'avvio (vedi models/schema.js): a regime non trova mai nulla da fare,
 * perche' ogni tavolo nuovo nasce gia' instradato da `avvia`.
 */
async function instradaEsistenti() {
  const daFare = await all(
    `SELECT id, pr_id FROM tavoli WHERE stato = 'in_attesa' AND revisione_tipo IS NULL`
  );

  let instradati = 0;
  for (const t of daFare) {
    try {
      // Lo stesso limite di profondita' di quote.catenaDi: senza, un ciclo
      // nella gerarchia (che l'app cerca di impedire, ma potrebbe comunque
      // esistere da prima) farebbe girare questa query all'infinito, qui
      // dentro l'avvio del processo.
      const admin = await get(
        `WITH RECURSIVE su(id, fk_padre, padre_tipo, livello) AS (
           SELECT id, fk_padre, COALESCE(padre_tipo, 'pr'), 0 FROM pr WHERE id = ?
           UNION ALL
           SELECT p.id, p.fk_padre, COALESCE(p.padre_tipo, 'pr'), su.livello + 1
             FROM pr p JOIN su ON p.id = su.fk_padre
            WHERE su.padre_tipo = 'pr' AND su.livello < ${quote.PROFONDITA_MASSIMA}
         )
         SELECT fk_padre AS admin_id FROM su WHERE padre_tipo = 'admin'`,
        [t.pr_id]
      );
      if (!admin || !admin.admin_id) continue; // catena non risolvibile: si lascia stare
      await run('UPDATE tavoli SET revisione_tipo = ?, revisione_id = ? WHERE id = ?', [
        'admin',
        admin.admin_id,
        t.id
      ]);
      instradati++;
    } catch (_) {
      // Non deve mai interrompere l'avvio dell'applicazione.
    }
  }
  return instradati;
}

module.exports = {
  avvia,
  rivedi,
  registraDecisioneFinale,
  percentualiDecise,
  reimposta,
  situazione,
  perSottoposto,
  codaPerPr,
  contaCodaPerPr,
  contaPerAdmin,
  instradaEsistenti
};
