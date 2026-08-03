// Controlli di integrita' sui dati economici.
//
// Un gestionale contabile non deve limitarsi a non sbagliare i conti: deve
// anche saper dire quando i dati di partenza sono in uno stato che rende i
// conti non calcolabili, invece di mostrare comunque un numero.
//
// Ogni controllo qui dentro risponde a tre domande: cosa non va, quali righe
// sono coinvolte, cosa bisogna fare per sistemarlo. Sono tutte letture: questo
// modulo non modifica niente.
//
// Le gravita':
//   bloccante    ci sono soldi che non compaiono in nessun calcolo, o che
//                risultano pagati due volte. Va risolto.
//   attenzione   i conti tornano ma la configurazione produrra' perdite o
//                risultati che sorprenderanno chi li legge.
//   informativo  vale la pena saperlo, non c'e' niente di rotto.

const { all } = require('./db-helpers');
const { computeCommissions } = require('./commissions');
const quote = require('./quote');
const denaro = require('./denaro');

const GRAVITA = { BLOCCANTE: 'bloccante', ATTENZIONE: 'attenzione', INFORMATIVO: 'informativo' };

/**
 * Esegue tutti i controlli per un'amministrazione.
 * @returns {Promise<{controlli: Array, problemi: number, bloccanti: number}>}
 */
async function verifica(adminId) {
  const calcolo = await computeCommissions({ adminId });
  const { hierarchy } = calcolo;

  const controlli = [];

  // --- 1. Tavoli approvati fuori da ogni calcolo ---------------------------
  const senzaQuote = (await quote.tavoliSenzaQuote()).filter((t) => {
    const nodo = hierarchy.byId.get(t.pr_id);
    // Senza catena non c'e' amministrazione di competenza: si mostra a chi ha
    // il venditore nella propria struttura, e comunque a chi non ce l'ha
    // nessuno (altrimenti nessuno lo vedrebbe mai).
    return !nodo || nodo.adminId === Number(adminId) || nodo.adminId == null;
  });

  controlli.push({
    id: 'tavoli-senza-quote',
    titolo: 'Tavoli approvati esclusi dai calcoli',
    gravita: GRAVITA.BLOCCANTE,
    spiegazione:
      "Questi tavoli sono approvati ma non e' stato possibile ricostruire la catena " +
      'di provvigioni del venditore, quindi non compaiono ne\' negli incassi ne\' nei ' +
      'compensi di nessuno.',
    rimedio:
      'Sistema il responsabile del venditore dalla pagina Staff, poi riapri e riapprova ' +
      'il tavolo: la catena verra\' fotografata di nuovo.',
    voci: senzaQuote.map((t) => ({
      testo: `${t.data} - ${t.nome_tavolo} (${t.pr_nickname || 'venditore sconosciuto'})`,
      dettaglio: `${denaro.arrotonda(
        t.incasso_effettivo == null ? t.spesa_prevista : t.incasso_effettivo
      ).toFixed(2)} EUR non conteggiati`
    }))
  });

  // --- 2. Cicli nella struttura -------------------------------------------
  const inCiclo = hierarchy.orphanedByCycle.filter(
    (n) => n.adminId === Number(adminId) || n.adminId == null
  );
  controlli.push({
    id: 'cicli',
    titolo: 'Collaboratori dentro un anello',
    gravita: GRAVITA.BLOCCANTE,
    spiegazione:
      'Questi collaboratori sono, direttamente o indirettamente, responsabili di se ' +
      'stessi. La catena non arriva mai all\'amministrazione e i loro tavoli non ' +
      'possono essere approvati.',
    rimedio: 'Assegna un responsabile valido dalla pagina Staff.',
    voci: inCiclo.map((n) => ({
      testo: n.nickname,
      dettaglio: `responsabile attuale: ${n.fk_padre ?? 'nessuno'}`
    }))
  });

  // --- 3. Collaboratori senza amministrazione ------------------------------
  const orfani = [...hierarchy.byId.values()].filter(
    (n) => n.adminId == null && !hierarchy.orphanedByCycle.includes(n)
  );
  controlli.push({
    id: 'orfani',
    titolo: 'Collaboratori senza amministrazione di riferimento',
    gravita: GRAVITA.BLOCCANTE,
    spiegazione:
      'Il loro responsabile non esiste piu\', oppure la catena si interrompe prima di ' +
      'arrivare a un\'amministrazione. Non compaiono in nessun conto economico.',
    rimedio: 'Assegna un responsabile dalla pagina Staff.',
    voci: orfani.map((n) => ({
      testo: n.nickname,
      dettaglio: `${n.percentuale_provvigione}%${n.attivo ? '' : ' - disattivato'}`
    }))
  });

  // --- 4. Pagamenti superiori al maturato ---------------------------------
  const eccedenze = [];
  for (const r of calcolo.elenco) {
    for (const d of r.debitori) {
      if (d.saldo !== null && d.saldo < 0) {
        eccedenze.push({
          testo: `${r.nickname} ha ricevuto piu' del dovuto da ${d.nome}`,
          dettaglio: `${Math.abs(d.saldo).toFixed(2)} EUR in eccesso`
        });
      }
    }
  }
  controlli.push({
    id: 'eccedenze',
    titolo: 'Pagamenti superiori a quanto maturato',
    gravita: GRAVITA.BLOCCANTE,
    spiegazione:
      "Qualcuno risulta pagato piu' di quanto gli spetti. Succede se un tavolo e' " +
      "stato riaperto o ridotto dopo il pagamento, oppure se un pagamento e' stato " +
      'registrato due volte.',
    rimedio:
      'Annulla il pagamento in eccesso dalla pagina Pagamenti, oppure verifica il tavolo ' +
      'che e\' cambiato dopo il versamento.',
    voci: eccedenze
  });

  // --- 5. Debitori che non esistono piu' -----------------------------------
  const debitoriMancanti = await all(
    `SELECT DISTINCT q.debitore_tipo, q.debitore_id, COUNT(*) AS quante
       FROM quote_tavolo q
      WHERE q.admin_id = ?
        AND ((q.debitore_tipo = 'pr'
              AND NOT EXISTS (SELECT 1 FROM pr p WHERE p.id = q.debitore_id))
          OR (q.debitore_tipo = 'admin'
              AND NOT EXISTS (SELECT 1 FROM admin a WHERE a.id = q.debitore_id)))
      GROUP BY q.debitore_tipo, q.debitore_id`,
    [Number(adminId)]
  );
  controlli.push({
    id: 'debitori-mancanti',
    titolo: 'Debiti verso soggetti non piu\' presenti',
    gravita: GRAVITA.BLOCCANTE,
    spiegazione:
      'Alcune quote congelate indicano come debitore un soggetto che non esiste piu\' ' +
      'nel database. Quel debito non e\' pagabile da nessuno.',
    rimedio: 'Contatta chi gestisce il sistema: serve un intervento sui dati.',
    voci: debitoriMancanti.map((d) => ({
      testo: `${d.debitore_tipo === 'admin' ? 'Amministrazione' : 'Collaboratore'} ${d.debitore_id}`,
      dettaglio: `${d.quante} quote coinvolte`
    }))
  });

  // --- 6. Percentuali incoerenti nella struttura attuale -------------------
  const incoerenti = calcolo.anomalie.filter((a) => {
    const nodo = hierarchy.byId.get(a.prId);
    return nodo && nodo.adminId === Number(adminId);
  });
  controlli.push({
    id: 'percentuali',
    titolo: 'Percentuali che faranno lavorare in perdita',
    gravita: GRAVITA.ATTENZIONE,
    spiegazione:
      'Un collaboratore ha una percentuale piu\' alta del proprio responsabile. I tavoli ' +
      'gia\' approvati non sono toccati, ma i prossimi non potranno essere approvati ' +
      'finche\' la situazione non e\' sistemata.',
    rimedio: 'Correggi una delle due percentuali dalla pagina Staff.',
    voci: incoerenti.map((a) => ({ testo: a.messaggio, dettaglio: '' }))
  });

  // --- 7. Tavoli approvati ancora senza consuntivo -------------------------
  const senzaConsuntivo = await all(
    `SELECT COUNT(*) AS quanti,
            COALESCE(SUM(CAST(ROUND(t.spesa_prevista * 100) AS INTEGER)), 0) AS cent
       FROM tavoli t
       JOIN quote_tavolo q ON q.tavolo_id = t.id AND q.debitore_tipo = 'admin'
      WHERE t.stato = 'approvato'
        AND t.incasso_effettivo IS NULL
        AND q.admin_id = ?
        AND t.data < date('now')`,
    [Number(adminId)]
  );
  const arretrati = senzaConsuntivo[0] || { quanti: 0, cent: 0 };
  controlli.push({
    id: 'senza-consuntivo',
    titolo: 'Serate passate senza incasso reale',
    gravita: GRAVITA.INFORMATIVO,
    spiegazione:
      'Per questi tavoli le provvigioni sono ancora calcolate sul preventivo. Appena ' +
      'inserisci il conto reale della serata, gli importi si aggiornano da soli.',
    rimedio: 'Inserisci l\'incasso dalla pagina Tavoli, colonna "incasso".',
    voci: arretrati.quanti
      ? [
          {
            testo: `${arretrati.quanti} tavoli gia' passati sono ancora valorizzati a preventivo`,
            dettaglio: `${denaro.aEuro(arretrati.cent).toFixed(2)} EUR di imponibile provvisorio`
          }
        ]
      : []
  });

  const conVoci = controlli.filter((c) => c.voci.length > 0);
  const bloccanti = conVoci.filter((c) => c.gravita === GRAVITA.BLOCCANTE).length;
  const attenzioni = conVoci.filter((c) => c.gravita === GRAVITA.ATTENZIONE).length;

  return {
    controlli,
    conVoci,
    problemi: bloccanti + attenzioni,
    bloccanti,
    attenzioni,
    // Le voci informative non sono problemi: segnalano lavoro ancora da fare
    // (per esempio incassi da registrare), non dati che non tornano. Contarle
    // come problemi renderebbe la pagina permanentemente rossa, e una pagina
    // sempre rossa non la guarda piu' nessuno.
    tuttoOk: bloccanti + attenzioni === 0
  };
}

/**
 * Contatore per la barra di navigazione.
 *
 * Deve costare poco: viene eseguito a ogni pagina. Si limita quindi al segnale
 * piu' grave e piu' economico da ottenere, i tavoli approvati che nessun
 * calcolo sta considerando. Gli altri controlli restano sulla pagina Verifica,
 * dove si paga il costo una volta sola e su richiesta.
 */
async function contaBloccanti() {
  const r = await all(
    `SELECT COUNT(*) AS n
       FROM tavoli t
      WHERE t.stato = 'approvato'
        AND NOT EXISTS (SELECT 1 FROM quote_tavolo q WHERE q.tavolo_id = t.id)`
  );
  return r.length ? Number(r[0].n) || 0 : 0;
}

module.exports = { verifica, contaBloccanti, GRAVITA };
