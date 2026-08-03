// ============================================================================
// MOTORE DI CALCOLO DELLE PROVVIGIONI - unica fonte di verita'.
// ============================================================================
//
// MODELLO: DIFFERENZIALE.
//
// Ogni tavolo ha un imponibile V ed e' venduto da un collaboratore. Risalendo
// la catena di responsabilita', ciascun responsabile trattiene solo la
// DIFFERENZA fra la propria percentuale e quella di chi sta sotto di lui:
//
//   tavolo da 1000 venduto da Marco (5%), sotto Luca (8%), sotto Sara (12%)
//     Marco  -> 1000 * 5%          =  50   (gli deve Luca)
//     Luca   -> 1000 * 8%          =  80   (gli deve Sara), ne trattiene 30
//     Sara   -> 1000 * 12%         = 120   (gliela deve l'admin), trattiene 40
//     costo per l'amministrazione  = 120 = la percentuale del capofila
//
// La somma "telescopa" sulla percentuale del capofila: l'amministrazione paga
// una cifra prevedibile, indipendente da quanti livelli intermedi esistono.
//
// FLUSSO DI CASSA: ogni collaboratore e' pagato dal proprio responsabile
// diretto; i capofila sono pagati dall'amministrazione.
//
// ----------------------------------------------------------------------------
// DA DOVE ARRIVANO I NUMERI
//
// Non da contatori memorizzati (andavano in deriva a ogni modifica) e non piu'
// dalle percentuali correnti (rendevano instabile il passato gia' pagato), ma
// dalla tabella `quote_tavolo`: una fotografia della catena presa al momento
// dell'approvazione. Vedi services/quote.js.
//
// Conseguenze pratiche, tutte volute:
//   - cambiare la percentuale di qualcuno non sposta un euro dei tavoli gia'
//     approvati; vale dal tavolo successivo;
//   - correggere l'importo di un tavolo aggiorna le provvigioni di quel tavolo,
//     perche' l'importo e' un fatto, non un accordo;
//   - spostare un collaboratore sotto un altro responsabile non riscrive chi
//     doveva cosa: i debiti gia' maturati restano in capo a chi li ha maturati.
//
// ----------------------------------------------------------------------------
// ARROTONDAMENTI
//
// Tutto viaggia in centesimi interi (services/denaro.js). L'unico
// arrotondamento avviene sulla quota del singolo collaboratore sul singolo
// tavolo; ogni totale e' una somma di interi. Per questo il totale di una
// colonna coincide sempre, al centesimo, con la somma delle righe mostrate.

const { all, get } = require('./db-helpers');
const { loadHierarchy } = require('./hierarchy');
const { getImpostazioni } = require('./settings');
const denaro = require('./denaro');

const { IMPONIBILE_CENT, QUOTA_CENT, QUOTA_NETTA_CENT, aEuro, aCentesimi } = denaro;

/** Arrotondamento monetario, esposto per le viste e le route. */
const euro = denaro.arrotonda;

/** Chiave stabile per la coppia creditore-debitore. */
function chiaveCoppia(tipo, id) {
  return `${tipo}:${id}`;
}

function condizioniPeriodo(from, to, params) {
  const where = [];
  if (from) {
    where.push('t.data >= ?');
    params.push(from);
  }
  if (to) {
    where.push('t.data <= ?');
    params.push(to);
  }
  return where;
}

/**
 * Aggregati per collaboratore, letti dalle quote congelate.
 *
 * Una riga di `quote_tavolo` esiste per ogni collaboratore che partecipa a un
 * tavolo approvato: il venditore (livello 0) e tutti i suoi responsabili. Di
 * conseguenza il totale calcolato su tutte le righe di un collaboratore e'
 * esattamente il suo sottoalbero, senza bisogno di visitare l'albero e senza
 * possibilita' di contare due volte lo stesso tavolo.
 */
async function aggregatiPerPr({ adminId = null, from = null, to = null } = {}) {
  const params = [];
  const where = ["t.stato = 'approvato'"];
  if (adminId != null) {
    where.push('q.admin_id = ?');
    params.push(Number(adminId));
  }
  where.push(...condizioniPeriodo(from, to, params));

  const righe = await all(
    `SELECT q.pr_id                                        AS pr_id,
            COUNT(*)                                       AS tavoli_sottoalbero,
            COALESCE(SUM(${IMPONIBILE_CENT}), 0)           AS fatturato_sottoalbero_cent,
            COALESCE(SUM(t.numero_persone), 0)             AS persone_sottoalbero,
            COALESCE(SUM(${QUOTA_CENT}), 0)                AS maturato_cent,
            COALESCE(SUM(${QUOTA_NETTA_CENT}), 0)          AS trattenuto_cent,
            COALESCE(SUM(CASE WHEN q.livello = 0 THEN 1 ELSE 0 END), 0)
                                                           AS tavoli_diretti,
            COALESCE(SUM(CASE WHEN q.livello = 0 THEN ${IMPONIBILE_CENT} ELSE 0 END), 0)
                                                           AS fatturato_diretto_cent,
            COALESCE(SUM(CASE WHEN q.livello = 0 THEN t.numero_persone ELSE 0 END), 0)
                                                           AS persone_dirette,
            MIN(q.percentuale)                             AS percentuale_minima,
            MAX(q.percentuale)                             AS percentuale_massima
       FROM quote_tavolo q
       JOIN tavoli t ON t.id = q.tavolo_id
      WHERE ${where.join(' AND ')}
      GROUP BY q.pr_id`,
    params
  );

  return new Map(righe.map((r) => [r.pr_id, r]));
}

/** Quanto ciascun debitore deve a ciascun collaboratore, dalle quote congelate. */
async function maturatoPerCoppia({ adminId = null, from = null, to = null } = {}) {
  const params = [];
  const where = ["t.stato = 'approvato'"];
  if (adminId != null) {
    where.push('q.admin_id = ?');
    params.push(Number(adminId));
  }
  where.push(...condizioniPeriodo(from, to, params));

  return all(
    `SELECT q.pr_id, q.debitore_tipo, q.debitore_id,
            COALESCE(SUM(${QUOTA_CENT}), 0) AS maturato_cent
       FROM quote_tavolo q
       JOIN tavoli t ON t.id = q.tavolo_id
      WHERE ${where.join(' AND ')}
      GROUP BY q.pr_id, q.debitore_tipo, q.debitore_id`,
    params
  );
}

/**
 * Quanto ciascun debitore ha gia' versato a ciascun collaboratore.
 *
 * Non viene mai filtrato per periodo: un pagamento non appartiene a un mese,
 * salda un debito complessivo. Filtrare i pagamenti su un intervallo di date
 * dei tavoli farebbe apparire come scoperto un acconto versato prima.
 */
async function pagamentiPerCoppia() {
  return all(
    `SELECT pr_destinatario_id AS pr_id, pagante_tipo AS debitore_tipo,
            pagante_id AS debitore_id,
            COALESCE(SUM(CAST(ROUND(importo * 100) AS INTEGER)), 0) AS pagato_cent
       FROM pagamenti_provvigioni
      GROUP BY pr_destinatario_id, pagante_tipo, pagante_id`
  );
}

/**
 * Situazione economica completa.
 *
 * I filtri di data agiscono sui tavoli ma non sui pagamenti. Per questo, quando
 * un periodo e' selezionato, `ricevuto` e `saldo` valgono null invece di
 * mostrare un numero che sembrerebbe un saldo ma non lo e'. L'interfaccia lo
 * dichiara esplicitamente.
 */
async function computeCommissions({ adminId = null, from = null, to = null } = {}) {
  const periodoFiltrato = Boolean(from || to);

  const [hierarchy, aggregati, coppieMaturato, coppiePagate] = await Promise.all([
    loadHierarchy(),
    aggregatiPerPr({ adminId, from, to }),
    maturatoPerCoppia({ adminId, from, to }),
    periodoFiltrato ? Promise.resolve([]) : pagamentiPerCoppia()
  ]);

  // Insieme dei collaboratori da mostrare: quelli che oggi stanno sotto questo
  // amministratore, piu' quelli che hanno maturato qualcosa sotto di lui in
  // passato anche se nel frattempo sono stati spostati o disattivati. Senza la
  // seconda meta' un debito ancora aperto sparirebbe dalla pagina pagamenti.
  const idsGerarchia =
    adminId != null
      ? hierarchy.forAdmin(adminId).map((n) => n.id)
      : [...hierarchy.byId.keys()];
  const inScope = new Set([...idsGerarchia, ...aggregati.keys()]);

  // Indice dei rapporti per coppia.
  const perCoppia = new Map(); // pr_id -> Map(chiave -> riga)
  function coppia(prId, tipo, id) {
    if (!perCoppia.has(prId)) perCoppia.set(prId, new Map());
    const mappa = perCoppia.get(prId);
    const k = chiaveCoppia(tipo, id);
    if (!mappa.has(k)) {
      mappa.set(k, { tipo, id: Number(id), maturatoCent: 0, pagatoCent: 0 });
    }
    return mappa.get(k);
  }

  for (const r of coppieMaturato) {
    coppia(r.pr_id, r.debitore_tipo, r.debitore_id).maturatoCent += Number(r.maturato_cent) || 0;
  }
  for (const r of coppiePagate) {
    // Un pagamento verso un collaboratore fuori ambito non ci interessa qui,
    // ma un pagamento senza maturato corrispondente si': e' un versamento in
    // eccesso e deve restare visibile.
    if (!inScope.has(r.pr_id)) continue;
    coppia(r.pr_id, r.debitore_tipo, r.debitore_id).pagatoCent += Number(r.pagato_cent) || 0;
  }

  const risultati = new Map();

  for (const prId of inScope) {
    const nodo = hierarchy.byId.get(prId) || null;
    const a = aggregati.get(prId) || null;

    const maturatoCent = a ? Number(a.maturato_cent) || 0 : 0;
    const trattenutoCent = a ? Number(a.trattenuto_cent) || 0 : 0;

    // Elenco dei debitori, ordinato dal debito piu' grande.
    const debitori = [...(perCoppia.get(prId) || new Map()).values()]
      .map((c) => ({
        tipo: c.tipo,
        id: c.id,
        nome: nomeSoggetto(hierarchy, c.tipo, c.id),
        maturato: aEuro(c.maturatoCent),
        ricevuto: periodoFiltrato ? null : aEuro(c.pagatoCent),
        saldo: periodoFiltrato ? null : aEuro(c.maturatoCent - c.pagatoCent)
      }))
      .filter((c) => c.maturato !== 0 || (c.ricevuto !== null && c.ricevuto !== 0))
      .sort((x, y) => (y.saldo || 0) - (x.saldo || 0));

    const pagatoCent = [...(perCoppia.get(prId) || new Map()).values()].reduce(
      (s, c) => s + c.pagatoCent,
      0
    );

    // Il debitore "corrente" e' quello previsto dalla struttura di oggi: e' chi
    // paghera' i tavoli futuri. Puo' differire dai debitori storici se il
    // collaboratore e' stato spostato, ed e' giusto che siano cose distinte.
    const debitoreCorrente = nodo
      ? nodo.parent
        ? { tipo: 'pr', id: nodo.parent.id, nome: nodo.parent.nickname }
        : nodo.adminId != null
        ? {
            tipo: 'admin',
            id: nodo.adminId,
            nome: hierarchy.admins.get(nodo.adminId)?.nickname || 'Amministrazione'
          }
        : null
      : null;

    risultati.set(prId, {
      id: prId,
      nickname: nodo ? nodo.nickname : `collaboratore ${prId}`,
      nome: nodo ? nodo.nome : null,
      cognome: nodo ? nodo.cognome : null,
      attivo: nodo ? nodo.attivo : 0,
      poteri: nodo ? nodo.poteri : 0,
      livello: nodo ? nodo.depth : 0,
      adminId: nodo ? nodo.adminId : (adminId != null ? Number(adminId) : null),
      padreId: nodo && nodo.parent ? nodo.parent.id : null,
      padreNickname: nodo && nodo.parent ? nodo.parent.nickname : null,
      numeroCollaboratori: nodo ? nodo.children.filter((c) => inScope.has(c.id)).length : 0,
      // Fuori struttura: ha numeri storici ma oggi non e' piu' sotto questo
      // amministratore. L'interfaccia lo segnala invece di mescolarlo agli altri.
      fuoriStruttura: !nodo || (adminId != null && nodo.adminId !== Number(adminId)),

      // Percentuale di oggi: vale per i tavoli che verranno approvati d'ora in poi.
      percentuale: nodo ? nodo.percentuale_provvigione : 0,
      // Percentuali effettivamente applicate ai tavoli del periodo. Se minima e
      // massima differiscono, la percentuale e' cambiata nel tempo e mostrarne
      // una sola sarebbe fuorviante.
      percentualeApplicataMin: a ? Number(a.percentuale_minima) : null,
      percentualeApplicataMax: a ? Number(a.percentuale_massima) : null,

      // Attivita' propria (tavoli venduti in prima persona)
      fatturatoDiretto: a ? aEuro(a.fatturato_diretto_cent) : 0,
      tavoliDiretti: a ? Number(a.tavoli_diretti) : 0,
      personeDirette: a ? Number(a.persone_dirette) : 0,

      // Attivita' del sottoalbero (se stesso piu' i collaboratori)
      fatturatoSottoalbero: a ? aEuro(a.fatturato_sottoalbero_cent) : 0,
      tavoliSottoalbero: a ? Number(a.tavoli_sottoalbero) : 0,
      personeSottoalbero: a ? Number(a.persone_sottoalbero) : 0,

      // Economia
      maturato: aEuro(maturatoCent),
      trattenuto: aEuro(trattenutoCent),
      giratoAiCollaboratori: aEuro(maturatoCent - trattenutoCent),
      ricevuto: periodoFiltrato ? null : aEuro(pagatoCent),
      saldo: periodoFiltrato ? null : aEuro(maturatoCent - pagatoCent),

      debitori,
      debitoreCorrente
    });
  }

  const elenco = [...risultati.values()].sort(
    (a, b) =>
      Number(a.fuoriStruttura) - Number(b.fuoriStruttura) ||
      a.livello - b.livello ||
      a.nickname.localeCompare(b.nickname, 'it')
  );

  return {
    hierarchy,
    perPr: risultati,
    elenco,
    periodoFiltrato,
    anomalie: hierarchy.validatePercentages()
  };
}

function nomeSoggetto(hierarchy, tipo, id) {
  if (tipo === 'admin') {
    return hierarchy.admins.get(Number(id))?.nickname || 'Amministrazione';
  }
  return hierarchy.byId.get(Number(id))?.nickname || `collaboratore ${id}`;
}

/**
 * Conto economico dell'amministrazione.
 *
 *   incasso           somma degli imponibili dei tavoli approvati
 *   - quota locale    percentuale configurabile che resta al locale
 *   = margine
 *   - provvigioni     quanto e' dovuto ai capofila (nel modello differenziale
 *                     copre l'intera gerarchia sottostante)
 *   = guadagno lordo
 *   - detrazioni      voci percentuali configurabili
 *   = guadagno netto
 *
 * Ogni tavolo approvato ha esattamente UNA riga di quota con debitore
 * l'amministrazione: quella del capofila. Interrogare quelle righe da' l'incasso
 * e il costo delle provvigioni contando ogni tavolo una volta sola, per
 * costruzione. La versione precedente sommava i sottoalberi dei capofila, che
 * era corretto solo finche' nessun tavolo compariva sotto due capofila diversi.
 */
async function computeAdminEconomics({ adminId, from = null, to = null } = {}) {
  const params = [Number(adminId)];
  const where = ["t.stato = 'approvato'", "q.debitore_tipo = 'admin'", 'q.debitore_id = ?'];
  where.push(...condizioniPeriodo(from, to, params));

  const [calcolo, impostazioni, totale] = await Promise.all([
    computeCommissions({ adminId, from, to }),
    getImpostazioni(adminId),
    get(
      `SELECT COUNT(*)                              AS tavoli,
              COALESCE(SUM(${IMPONIBILE_CENT}), 0)  AS incasso_cent,
              COALESCE(SUM(t.numero_persone), 0)    AS persone,
              COALESCE(SUM(${QUOTA_CENT}), 0)       AS provvigioni_cent
         FROM quote_tavolo q
         JOIN tavoli t ON t.id = q.tavolo_id
        WHERE ${where.join(' AND ')}`,
      params
    )
  ]);

  const incassoCent = Number(totale?.incasso_cent) || 0;
  const provvigioniCent = Number(totale?.provvigioni_cent) || 0;

  const quotaLocaleCent = denaro.quotaCentesimi(incassoCent, impostazioni.quotaLocale);
  const margineCent = incassoCent - quotaLocaleCent;
  const guadagnoLordoCent = margineCent - provvigioniCent;

  // Le detrazioni si applicano al guadagno lordo. Su un lordo negativo non si
  // detrae nulla: una perdita non genera contributi da versare.
  const baseDetrazioniCent = Math.max(0, guadagnoLordoCent);
  const detrazioni = impostazioni.detrazioni.map((d) => {
    const importoCent = denaro.quotaCentesimi(baseDetrazioniCent, d.percentuale);
    return { ...d, importo: aEuro(importoCent), importoCent };
  });
  const totaleDetrazioniCent = detrazioni.reduce((s, d) => s + d.importoCent, 0);
  const guadagnoNettoCent = guadagnoLordoCent - totaleDetrazioniCent;

  const capifila = calcolo.hierarchy.rootsForAdmin(adminId);

  // Segnalazioni utili, invece di numeri silenziosamente sbagliati.
  const avvisi = [];
  if (guadagnoLordoCent < 0) {
    avvisi.push(
      "Il guadagno lordo del periodo e' negativo: le provvigioni maturate superano " +
        `il margine che resta dopo la quota locale del ${impostazioni.quotaLocale}%.`
    );
  }
  for (const capo of capifila) {
    if (capo.percentuale_provvigione > impostazioni.quotaAdmin) {
      avvisi.push(
        `${capo.nickname} ha una provvigione del ${capo.percentuale_provvigione}%, superiore ` +
          `al margine disponibile del ${impostazioni.quotaAdmin}%: ogni suo nuovo tavolo ` +
          'generera\' una perdita.'
      );
    }
  }

  return {
    calcolo,
    impostazioni,
    totali: {
      incassoTotale: aEuro(incassoCent),
      quotaLocale: aEuro(quotaLocaleCent),
      margineLordo: aEuro(margineCent),
      costoProvvigioni: aEuro(provvigioniCent),
      guadagnoLordo: aEuro(guadagnoLordoCent),
      detrazioni: detrazioni.map(({ importoCent, ...d }) => d),
      totaleDetrazioni: aEuro(totaleDetrazioniCent),
      guadagnoNetto: aEuro(guadagnoNettoCent),
      tavoli: Number(totale?.tavoli) || 0,
      persone: Number(totale?.persone) || 0,
      numeroPr: calcolo.elenco.length,
      numeroCapifila: capifila.length
    },
    avvisi: avvisi.concat(calcolo.anomalie.map((a) => a.messaggio))
  };
}

/**
 * Andamento mensile del fatturato dei tavoli venduti da un gruppo di
 * collaboratori. Ogni tavolo e' contato una volta sola, in capo a chi lo ha
 * venduto: passare un intero sottoalbero non produce duplicazioni.
 */
async function andamentoFatturato(prIds, mesi = 12) {
  const ids = (prIds || []).map(Number).filter(Number.isInteger);
  if (ids.length === 0) return [];

  const righe = await all(
    `SELECT strftime('%Y-%m', t.data)               AS mese,
            COUNT(*)                                AS tavoli,
            COALESCE(SUM(${IMPONIBILE_CENT}), 0)    AS fatturato_cent,
            COALESCE(SUM(t.numero_persone), 0)      AS persone
       FROM tavoli t
      WHERE t.stato = 'approvato'
        AND t.pr_id IN (${ids.map(() => '?').join(',')})
        AND t.data >= date('now', 'start of month', ?)
      GROUP BY mese
      ORDER BY mese`,
    [...ids, `-${Math.max(1, Number(mesi) || 12) - 1} months`]
  );

  return righe.map((r) => ({
    mese: r.mese,
    tavoli: r.tavoli,
    fatturato: aEuro(r.fatturato_cent),
    persone: r.persone
  }));
}

/**
 * Andamento mensile di quanto un singolo collaboratore ha maturato: la sua
 * quota congelata sui tavoli del mese, suoi e dei suoi collaboratori.
 */
async function andamentoMaturato(prId, mesi = 12) {
  const id = Number(prId);
  if (!Number.isInteger(id)) return [];

  const righe = await all(
    `SELECT strftime('%Y-%m', t.data)            AS mese,
            COUNT(*)                             AS tavoli,
            COALESCE(SUM(${IMPONIBILE_CENT}), 0) AS fatturato_cent,
            COALESCE(SUM(${QUOTA_CENT}), 0)      AS maturato_cent,
            COALESCE(SUM(${QUOTA_NETTA_CENT}), 0) AS trattenuto_cent
       FROM quote_tavolo q
       JOIN tavoli t ON t.id = q.tavolo_id
      WHERE q.pr_id = ?
        AND t.stato = 'approvato'
        AND t.data >= date('now', 'start of month', ?)
      GROUP BY mese
      ORDER BY mese`,
    [id, `-${Math.max(1, Number(mesi) || 12) - 1} months`]
  );

  return righe.map((r) => ({
    mese: r.mese,
    tavoli: r.tavoli,
    fatturato: aEuro(r.fatturato_cent),
    maturato: aEuro(r.maturato_cent),
    trattenuto: aEuro(r.trattenuto_cent)
  }));
}

/**
 * Saldo fra un preciso debitore e un preciso creditore, in centesimi.
 *
 * E' la funzione che autorizza un pagamento, quindi lavora sui centesimi interi
 * e accetta le stesse funzioni di accesso della transazione in corso: il
 * controllo deve vedere lo stato dentro la transazione, non quello di un
 * istante prima.
 */
async function saldoCoppiaCent({ destinatarioId, debitoreTipo, debitoreId }, tx = { all, get }) {
  const dest = Number(destinatarioId);
  const deb = Number(debitoreId);

  const [maturato, pagato] = await Promise.all([
    tx.get(
      `SELECT COALESCE(SUM(${QUOTA_CENT}), 0) AS cent
         FROM quote_tavolo q
         JOIN tavoli t ON t.id = q.tavolo_id
        WHERE q.pr_id = ? AND q.debitore_tipo = ? AND q.debitore_id = ?
          AND t.stato = 'approvato'`,
      [dest, debitoreTipo, deb]
    ),
    tx.get(
      `SELECT COALESCE(SUM(CAST(ROUND(importo * 100) AS INTEGER)), 0) AS cent
         FROM pagamenti_provvigioni
        WHERE pr_destinatario_id = ? AND pagante_tipo = ? AND pagante_id = ?`,
      [dest, debitoreTipo, deb]
    )
  ]);

  const maturatoCent = Number(maturato?.cent) || 0;
  const pagatoCent = Number(pagato?.cent) || 0;
  return { maturatoCent, pagatoCent, residuoCent: maturatoCent - pagatoCent };
}

/**
 * Quanto un collaboratore ha maturato in totale e da chi, senza filtri.
 * Usata dalle schermate di pagamento e dai controlli di integrita'.
 */
async function debitoriDi(prId) {
  const righe = await all(
    `SELECT q.debitore_tipo, q.debitore_id,
            CASE q.debitore_tipo WHEN 'pr' THEN pd.nickname ELSE ad.nickname END AS nome,
            COALESCE(SUM(${QUOTA_CENT}), 0) AS maturato_cent
       FROM quote_tavolo q
       JOIN tavoli t ON t.id = q.tavolo_id
       LEFT JOIN pr pd ON pd.id = q.debitore_id AND q.debitore_tipo = 'pr'
       LEFT JOIN admin ad ON ad.id = q.debitore_id AND q.debitore_tipo = 'admin'
      WHERE q.pr_id = ? AND t.stato = 'approvato'
      GROUP BY q.debitore_tipo, q.debitore_id, nome`,
    [Number(prId)]
  );
  return righe.map((r) => ({
    tipo: r.debitore_tipo,
    id: r.debitore_id,
    nome: r.nome || (r.debitore_tipo === 'admin' ? 'Amministrazione' : `collaboratore ${r.debitore_id}`),
    maturato: aEuro(r.maturato_cent)
  }));
}

module.exports = {
  euro,
  aEuro,
  aCentesimi,
  computeCommissions,
  computeAdminEconomics,
  andamentoFatturato,
  andamentoMaturato,
  saldoCoppiaCent,
  debitoriDi,
  chiaveCoppia
};
