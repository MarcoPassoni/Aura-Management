// ============================================================================
// MOTORE DI CALCOLO PROVVIGIONI - unica fonte di verita' dell'applicazione.
// ============================================================================
//
// MODELLO ADOTTATO: DIFFERENZIALE.
//
// Ogni tavolo ha un valore V ed e' venduto da un PR. Risalendo la gerarchia,
// ciascun responsabile trattiene solo la DIFFERENZA tra la propria percentuale
// e quella di chi sta sotto di lui:
//
//   tavolo da 1000 EUR venduto da Marco (10%), sotto Luca (15%), sotto Sara (20%)
//     Marco  -> 1000 * 10%           = 100 EUR
//     Luca   -> 1000 * (15% - 10%)   =  50 EUR
//     Sara   -> 1000 * (20% - 15%)   =  50 EUR
//     totale a carico dell'admin     = 200 EUR = 1000 * 20% (la % del capofila)
//
// La somma "telescopa" sulla percentuale del PR di primo livello: l'admin paga
// una cifra prevedibile, indipendente da quanti livelli intermedi esistono.
//
// FLUSSO DI CASSA: ogni PR e' pagato dal proprio responsabile diretto; i PR di
// primo livello sono pagati dall'admin. Quindi un responsabile riceve l'intero
// importo maturato sul proprio sottoalbero, ne trattiene la parte differenziale
// e gira il resto ai propri collaboratori.
//
// COSA E' CAMBIATO RISPETTO ALL'ORIGINALE:
//  - Prima convivevano tre modelli incompatibili: i contatori nel DB usavano il
//    modello cumulativo (ogni livello prendeva la percentuale piena, gonfiando
//    il costo), la pagina report usava il differenziale, e la dashboard PR
//    ignorava del tutto la gerarchia. Ora il modello e' uno solo.
//  - I valori non vengono piu' letti da contatori incrementali (che non
//    venivano mai decrementati e andavano in deriva a ogni modifica o
//    cancellazione). Tutto e' derivato ogni volta dai fatti grezzi:
//    `storico_tavoli` e `pagamenti_provvigioni`.

const { all } = require('./db-helpers');
const { loadHierarchy } = require('./hierarchy');
const { getImpostazioni } = require('./settings');

/** Arrotondamento monetario: due decimali, senza errori di virgola mobile. */
function euro(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Fatturato e volumi per PR, direttamente da storico_tavoli.
 * `omaggi` non entra nel calcolo: e' un campo descrittivo, non un importo.
 */
async function loadFatturatoDiretto({ from = null, to = null } = {}) {
  // Solo i tavoli approvati generano provvigioni: quelli in attesa o rifiutati
  // restano nello storico ma non entrano in nessun calcolo economico.
  const where = ["stato = 'approvato'"];
  const params = [];
  if (from) {
    where.push('data >= ?');
    params.push(from);
  }
  if (to) {
    where.push('data <= ?');
    params.push(to);
  }

  const righe = await all(
    `SELECT pr_id,
            COUNT(*)                          AS tavoli,
            COALESCE(SUM(spesa_prevista), 0)  AS fatturato,
            COALESCE(SUM(numero_persone), 0)  AS persone
     FROM tavoli
     WHERE ${where.join(' AND ')}
     GROUP BY pr_id`,
    params
  );

  return new Map(
    righe.map((r) => [
      r.pr_id,
      { tavoli: r.tavoli, fatturato: Number(r.fatturato) || 0, persone: Number(r.persone) || 0 }
    ])
  );
}

/** Totale effettivamente incassato da ciascun PR. */
async function loadPagamentiRicevuti() {
  const righe = await all(
    `SELECT pr_destinatario_id AS pr_id, COALESCE(SUM(importo), 0) AS totale
     FROM pagamenti_provvigioni GROUP BY pr_destinatario_id`
  );
  return new Map(righe.map((r) => [r.pr_id, Number(r.totale) || 0]));
}

/**
 * Calcola la situazione economica completa.
 *
 * I filtri di data agiscono sul fatturato ma NON sui pagamenti: i saldi
 * (quanto resta da incassare) hanno senso solo sul totale storico, altrimenti
 * un pagamento fatto a gennaio per tavoli di dicembre risulterebbe uno scoperto.
 * Per questo `saldo` viene esposto solo quando non c'e' filtro temporale.
 */
async function computeCommissions({ adminId = null, from = null, to = null } = {}) {
  const periodoFiltrato = Boolean(from || to);

  const [hierarchy, fatturati, pagamenti] = await Promise.all([
    loadHierarchy(),
    loadFatturatoDiretto({ from, to }),
    loadPagamentiRicevuti()
  ]);

  // Insieme di PR su cui lavorare: tutti, oppure solo quelli dell'admin.
  const nodi = adminId != null ? hierarchy.forAdmin(adminId) : [...hierarchy.byId.values()];
  const inScope = new Set(nodi.map((n) => n.id));

  const risultati = new Map();

  // Il calcolo del sottoalbero richiede di visitare i figli prima dei padri:
  // ordiniamo per profondita' decrescente ed elaboriamo dal basso verso l'alto.
  const ordinati = [...nodi].sort((a, b) => b.depth - a.depth);

  for (const nodo of ordinati) {
    const diretto = fatturati.get(nodo.id) || { tavoli: 0, fatturato: 0, persone: 0 };
    const figliInScope = nodo.children.filter((c) => inScope.has(c.id));

    // Aggregati del sottoalbero: i figli sono gia' stati calcolati.
    let fatturatoSottoalbero = diretto.fatturato;
    let tavoliSottoalbero = diretto.tavoli;
    let personeSottoalbero = diretto.persone;
    let dovutoAiFigli = 0;

    for (const figlio of figliInScope) {
      const rf = risultati.get(figlio.id);
      if (!rf) continue;
      fatturatoSottoalbero += rf.fatturatoSottoalbero;
      tavoliSottoalbero += rf.tavoliSottoalbero;
      personeSottoalbero += rf.personeSottoalbero;
      // Al figlio spetta l'intero maturato sul suo sottoalbero, alla sua percentuale.
      dovutoAiFigli += rf.maturatoLordo;
    }

    const percentuale = nodo.percentuale_provvigione;

    // Quanto il responsabile (o l'admin) deve a questo PR in totale.
    const maturatoLordo = euro((fatturatoSottoalbero * percentuale) / 100);

    // Quanto resta a questo PR dopo aver pagato i propri collaboratori.
    const guadagnoNetto = euro(maturatoLordo - dovutoAiFigli);

    const ricevuto = periodoFiltrato ? null : euro(pagamenti.get(nodo.id) || 0);
    const saldoDaRicevere = periodoFiltrato ? null : euro(maturatoLordo - ricevuto);

    // Chi paga: sempre il responsabile diretto; l'admin per i PR di primo livello.
    const pagante = nodo.parent
      ? { tipo: 'pr', id: nodo.parent.id, nome: nodo.parent.nickname }
      : {
          tipo: 'admin',
          id: nodo.adminId,
          nome: hierarchy.admins.get(nodo.adminId)?.nickname || 'Amministratore'
        };

    risultati.set(nodo.id, {
      id: nodo.id,
      nickname: nodo.nickname,
      nome: nodo.nome,
      cognome: nodo.cognome,
      percentuale,
      poteri: nodo.poteri,
      attivo: nodo.attivo,
      livello: nodo.depth,
      adminId: nodo.adminId,
      padreId: nodo.parent ? nodo.parent.id : null,
      padreNickname: nodo.parent ? nodo.parent.nickname : null,
      haFigli: figliInScope.length > 0,
      numeroFigli: figliInScope.length,

      // Attivita' propria
      fatturatoDiretto: euro(diretto.fatturato),
      tavoliDiretti: diretto.tavoli,
      personeDirette: diretto.persone,

      // Attivita' del sottoalbero (se stesso + collaboratori)
      fatturatoSottoalbero: euro(fatturatoSottoalbero),
      tavoliSottoalbero,
      personeSottoalbero,

      // Economia
      maturatoLordo,
      dovutoAiFigli: euro(dovutoAiFigli),
      guadagnoNetto,
      ricevuto,
      saldoDaRicevere,
      pagante
    });
  }

  const elenco = [...risultati.values()].sort(
    (a, b) => a.livello - b.livello || a.nickname.localeCompare(b.nickname)
  );

  return {
    hierarchy,
    perPr: risultati,
    elenco,
    periodoFiltrato,
    anomalie: hierarchy.validatePercentages()
  };
}

/**
 * Conto economico dell'admin.
 *
 * L'originale aveva due formule inconciliabili: la pagina "overview" usava un
 * 5% fisso sull'incasso, la pagina "guadagni" usava
 * `fatturato * (100 - (%PR + 85)) / 100`, che diventava negativa non appena un
 * PR superava il 15% e che, con piu' livelli, contava lo stesso fatturato una
 * volta per ogni PR coinvolto.
 *
 * Qui la struttura e' esplicita e vale a qualsiasi profondita':
 *
 *   margine lordo     = incasso * (100 - quota locale) / 100
 *   costo provvigioni = somma del maturato dei soli PR di primo livello
 *                       (per il modello differenziale copre tutta la gerarchia)
 *   guadagno lordo    = margine lordo - costo provvigioni
 *   detrazioni        = percentuali configurabili sul guadagno lordo
 *   guadagno netto    = guadagno lordo - detrazioni
 *
 * Senza gerarchia il risultato coincide con la vecchia formula
 * (incasso*15% - incasso*p% == incasso*(100-85-p)%), quindi i numeri storici
 * restano confrontabili.
 */
async function computeAdminEconomics({ adminId, from = null, to = null } = {}) {
  const [calcolo, impostazioni] = await Promise.all([
    computeCommissions({ adminId, from, to }),
    getImpostazioni(adminId)
  ]);

  const capifila = calcolo.hierarchy.rootsForAdmin(adminId);

  const incassoTotale = euro(
    capifila.reduce((s, n) => s + (calcolo.perPr.get(n.id)?.fatturatoSottoalbero || 0), 0)
  );
  const costoProvvigioni = euro(
    capifila.reduce((s, n) => s + (calcolo.perPr.get(n.id)?.maturatoLordo || 0), 0)
  );

  const quotaLocale = euro((incassoTotale * impostazioni.quotaLocale) / 100);
  const margineLordo = euro(incassoTotale - quotaLocale);
  const guadagnoLordo = euro(margineLordo - costoProvvigioni);

  // Le detrazioni si applicano al guadagno lordo. Se il lordo e' negativo non
  // si detrae nulla: una perdita non genera contributi da versare.
  const baseDetrazioni = Math.max(0, guadagnoLordo);
  const detrazioni = impostazioni.detrazioni.map((d) => ({
    ...d,
    importo: euro((baseDetrazioni * d.percentuale) / 100)
  }));
  const totaleDetrazioni = euro(detrazioni.reduce((s, d) => s + d.importo, 0));
  const guadagnoNetto = euro(guadagnoLordo - totaleDetrazioni);

  const tavoli = capifila.reduce(
    (s, n) => s + (calcolo.perPr.get(n.id)?.tavoliSottoalbero || 0),
    0
  );
  const persone = capifila.reduce(
    (s, n) => s + (calcolo.perPr.get(n.id)?.personeSottoalbero || 0),
    0
  );

  // Segnalazioni utili invece di numeri silenziosamente sbagliati.
  const avvisi = [];
  if (guadagnoLordo < 0) {
    avvisi.push(
      'Il guadagno lordo e\' negativo: le provvigioni concordate superano il margine che ' +
        `resta dopo la quota locale del ${impostazioni.quotaLocale}%.`
    );
  }
  for (const capo of capifila) {
    if (capo.percentuale_provvigione > impostazioni.quotaAdmin) {
      avvisi.push(
        `${capo.nickname} ha una provvigione del ${capo.percentuale_provvigione}%, superiore ` +
          `al margine disponibile del ${impostazioni.quotaAdmin}%: ogni suo tavolo genera una perdita.`
      );
    }
  }

  return {
    calcolo,
    impostazioni,
    totali: {
      incassoTotale,
      quotaLocale,
      margineLordo,
      costoProvvigioni,
      guadagnoLordo,
      detrazioni,
      totaleDetrazioni,
      guadagnoNetto,
      tavoli,
      persone,
      numeroPr: calcolo.elenco.length,
      numeroCapifila: capifila.length
    },
    avvisi: avvisi.concat(calcolo.anomalie.map((a) => a.messaggio))
  };
}

/**
 * Andamento mensile del fatturato per un insieme di PR.
 * Sostituisce la tabella `andamento_staff_mensile`, che era un contatore
 * incrementale mai corretto in caso di modifica o cancellazione di un tavolo.
 */
async function getAndamentoMensile(prIds, mesi = 12) {
  if (!prIds || prIds.length === 0) return [];
  const ids = prIds.map((n) => Number(n)).filter(Number.isInteger);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const righe = await all(
    `SELECT strftime('%Y-%m', data)        AS mese,
            COUNT(*)                        AS tavoli,
            COALESCE(SUM(spesa_prevista),0) AS fatturato,
            COALESCE(SUM(numero_persone),0) AS persone
     FROM tavoli
     WHERE stato = 'approvato'
       AND pr_id IN (${placeholders})
       AND data >= date('now', ?)
     GROUP BY mese
     ORDER BY mese`,
    [...ids, `-${Number(mesi) || 12} months`]
  );

  return righe.map((r) => ({
    mese: r.mese,
    tavoli: r.tavoli,
    fatturato: euro(r.fatturato),
    persone: r.persone
  }));
}

/**
 * Quanto un pagante puo' ancora versare a un destinatario.
 * Usata per validare i pagamenti prima di registrarli.
 */
async function getSaldoDaPagare(destinatarioId) {
  const { perPr } = await computeCommissions({});
  const r = perPr.get(Number(destinatarioId));
  if (!r) return null;
  return {
    maturato: r.maturatoLordo,
    ricevuto: r.ricevuto,
    residuo: r.saldoDaRicevere,
    pagante: r.pagante
  };
}

module.exports = {
  euro,
  computeCommissions,
  computeAdminEconomics,
  getAndamentoMensile,
  getSaldoDaPagare
};
