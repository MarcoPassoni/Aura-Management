// Quote di provvigione congelate sul singolo tavolo.
//
// PERCHE' ESISTE QUESTO FILE
//
// Prima le provvigioni erano calcolate leggendo, ogni volta, le percentuali
// correnti dei collaboratori. Questo rende il passato instabile: se
// l'amministratore cambia la percentuale di qualcuno, tutti i tavoli gia'
// approvati - e gia' pagati - vengono ricalcolati con il nuovo valore. Un
// collaboratore saldato puo' risultare improvvisamente in credito o in debito,
// e nessuno dei due numeri e' verificabile perche' la percentuale con cui era
// stato pagato non esiste piu' da nessuna parte.
//
// Al momento dell'approvazione, quindi, la catena di responsabilita' del
// venditore viene fotografata: chi partecipa, con quale percentuale, e chi deve
// pagare chi. Da quel momento quelle percentuali non cambiano piu'.
//
// COSA RESTA VARIABILE, E PERCHE'
//
// L'importo del tavolo NON e' congelato. Le percentuali sono un accordo
// (contrattuale, quindi si fissa al momento in cui matura il diritto), mentre
// l'importo e' un fatto (quanto ha speso davvero il tavolo). Se il conto della
// serata risulta diverso dal preventivo, l'amministratore lo corregge e le
// provvigioni seguono: e' esattamente quello che ci si aspetta. Cambiare una
// percentuale invece non tocca un solo euro del passato.
//
// STRUTTURA DI UNA RIGA
//
//   tavolo_id + pr_id      chi partecipa a quale tavolo
//   livello                0 e' il venditore, sale verso l'amministrazione
//   percentuale            la sua percentuale, congelata
//   percentuale_sotto      quella del livello immediatamente sotto (0 per il
//                          venditore): serve a calcolare la quota netta senza
//                          dover ricostruire la catena
//   debitore_tipo/_id      chi gli deve materialmente quei soldi
//   admin_id               l'amministrazione di competenza, anch'essa congelata

const { run, get, all } = require('./db-helpers');
const { ErroreValidazione } = require('./validation');
const denaro = require('./denaro');

// Oltre questa profondita' la struttura non e' piu' una gerarchia ma un ciclo.
const PROFONDITA_MASSIMA = 50;

const funzioniGlobali = { run, get, all };

/**
 * Risale la catena di responsabilita' di un collaboratore, dal collaboratore
 * stesso fino all'amministrazione.
 *
 * La risalita e' fatta dal database con una query ricorsiva invece che con
 * chiamate annidate in JavaScript: dentro una transazione deve vedere lo stato
 * appena scritto, e deve essere una sola operazione atomica.
 *
 * `padre_tipo` distingue senza ambiguita' se `fk_padre` punta alla tabella
 * admin o alla tabella pr: i due insiemi di identificativi si sovrappongono,
 * quindi il solo numero non basterebbe.
 *
 * @returns {Promise<{righe: Array, adminId: number, incoerenze: Array}>}
 */
async function catenaDi(prId, tx = funzioniGlobali) {
  const id = Number(prId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ErroreValidazione('Identificativo del collaboratore non valido.');
  }

  const righe = await tx.all(
    `WITH RECURSIVE catena(id, fk_padre, padre_tipo, percentuale, nickname, livello) AS (
       SELECT id, fk_padre, COALESCE(padre_tipo, 'pr'),
              COALESCE(percentuale_provvigione, 0), nickname, 0
         FROM pr WHERE id = ?
       UNION ALL
       SELECT p.id, p.fk_padre, COALESCE(p.padre_tipo, 'pr'),
              COALESCE(p.percentuale_provvigione, 0), p.nickname, c.livello + 1
         FROM pr p
         JOIN catena c ON p.id = c.fk_padre
        WHERE c.padre_tipo = 'pr' AND c.livello < ${PROFONDITA_MASSIMA}
     )
     SELECT id, fk_padre, padre_tipo, percentuale, nickname, livello
       FROM catena ORDER BY livello`,
    [id]
  );

  if (righe.length === 0) {
    throw new ErroreValidazione('Collaboratore non trovato.');
  }

  // Un identificativo che ricompare significa che qualcuno e', direttamente o
  // indirettamente, responsabile di se stesso. Va bloccato subito: lasciato
  // passare produrrebbe provvigioni moltiplicate all'infinito.
  const visti = new Set();
  for (const r of righe) {
    if (visti.has(r.id)) {
      throw new ErroreValidazione(
        `La struttura contiene un ciclo che coinvolge ${r.nickname}: ` +
          'un collaboratore risulta responsabile di se stesso. ' +
          'Correggi la gerarchia dalla pagina Staff prima di procedere.'
      );
    }
    visti.add(r.id);
  }
  if (righe.length > PROFONDITA_MASSIMA) {
    throw new ErroreValidazione('La catena di responsabilita\' e\' troppo profonda.');
  }

  // In cima ci deve essere un collaboratore agganciato all'amministrazione.
  const capofila = righe[righe.length - 1];
  if (capofila.padre_tipo !== 'admin' || !capofila.fk_padre) {
    throw new ErroreValidazione(
      `${capofila.nickname} non ha un responsabile valido: la catena non arriva ` +
        'a nessuna amministrazione. Assegnagli un responsabile dalla pagina Staff.'
    );
  }
  const admin = await tx.get('SELECT id FROM admin WHERE id = ?', [capofila.fk_padre]);
  if (!admin) {
    throw new ErroreValidazione(
      `${capofila.nickname} risulta agganciato a un'amministrazione che non esiste ` +
        `(identificativo ${capofila.fk_padre}).`
    );
  }

  const adminId = admin.id;

  // Il modello differenziale richiede percentuali non decrescenti salendo: se un
  // collaboratore ha una percentuale piu' alta del proprio responsabile, il
  // responsabile ci rimette su ogni tavolo. Non blocchiamo qui - lo decide chi
  // chiama - ma l'anomalia viene sempre segnalata.
  const incoerenze = [];
  for (let i = 1; i < righe.length; i++) {
    if (righe[i].percentuale < righe[i - 1].percentuale) {
      incoerenze.push({
        prId: righe[i].id,
        nickname: righe[i].nickname,
        percentuale: righe[i].percentuale,
        figlioId: righe[i - 1].id,
        figlioNickname: righe[i - 1].nickname,
        percentualeFiglio: righe[i - 1].percentuale,
        messaggio:
          `${righe[i].nickname} ha il ${righe[i].percentuale}% ma ${righe[i - 1].nickname}, ` +
          `che dipende da lui, ha il ${righe[i - 1].percentuale}%: su questo tavolo ` +
          `${righe[i].nickname} ci rimetterebbe.`
      });
    }
  }

  return { righe, adminId, incoerenze };
}

/**
 * Costruisce le righe di quota a partire da una catena risolta.
 * Nessun accesso al database: e' pura trasformazione, cosi' e' verificabile
 * dai test senza preparare uno scenario.
 */
function righeQuota(tavoloId, catena) {
  const { righe, adminId } = catena;
  const ultimo = righe.length - 1;

  return righe.map((r, i) => ({
    tavolo_id: Number(tavoloId),
    pr_id: r.id,
    livello: i,
    percentuale: Number(r.percentuale) || 0,
    // Il livello sotto e' quello che questo collaboratore deve pagare a sua volta.
    percentuale_sotto: i === 0 ? 0 : Number(righe[i - 1].percentuale) || 0,
    // Chi gli deve i soldi: il proprio responsabile, oppure l'amministrazione
    // se e' lui il capofila.
    debitore_tipo: i === ultimo ? 'admin' : 'pr',
    debitore_id: i === ultimo ? adminId : righe[i + 1].id,
    admin_id: adminId
  }));
}

/** Scrive le quote di un tavolo, sostituendo quelle eventualmente presenti. */
async function scrivi(tavoloId, righe, tx = funzioniGlobali) {
  await tx.run('DELETE FROM quote_tavolo WHERE tavolo_id = ?', [tavoloId]);
  for (const q of righe) {
    await tx.run(
      `INSERT INTO quote_tavolo
         (tavolo_id, pr_id, livello, percentuale, percentuale_sotto,
          debitore_tipo, debitore_id, admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        q.tavolo_id,
        q.pr_id,
        q.livello,
        q.percentuale,
        q.percentuale_sotto,
        q.debitore_tipo,
        q.debitore_id,
        q.admin_id
      ]
    );
  }
  return righe.length;
}

/**
 * Congela la catena di un tavolo. Da usare dentro la transazione di
 * approvazione, mai da sola.
 *
 * @param {boolean} opzioni.bloccaIncoerenze  se true (approvazione manuale)
 *   rifiuta di congelare una catena con percentuali incoerenti, invece di
 *   fissare numeri che nessuno sarebbe in grado di spiegare.
 */
async function congela(tavoloId, prId, tx = funzioniGlobali, { bloccaIncoerenze = true } = {}) {
  const catena = await catenaDi(prId, tx);

  if (bloccaIncoerenze && catena.incoerenze.length) {
    throw new ErroreValidazione(
      catena.incoerenze[0].messaggio +
        ' Correggi le percentuali dalla pagina Staff, poi approva il tavolo.'
    );
  }

  const righe = righeQuota(tavoloId, catena);
  await scrivi(tavoloId, righe, tx);
  return { righe, catena };
}

/** Rimuove le quote di un tavolo (riapertura di una decisione). */
async function libera(tavoloId, tx = funzioniGlobali) {
  const r = await tx.run('DELETE FROM quote_tavolo WHERE tavolo_id = ?', [tavoloId]);
  return r.changes;
}

/**
 * Quote di un tavolo, dal venditore verso l'alto, con gli importi gia'
 * calcolati.
 *
 * Gli importi arrivano dalla stessa formula usata per i totali (services/
 * denaro.js): se le viste li ricalcolassero per conto proprio, potrebbero
 * mostrare un centesimo di differenza rispetto alla pagina dei guadagni, e
 * nessuno saprebbe quale dei due numeri credere.
 */
async function delTavolo(tavoloId) {
  const righe = await all(
    `SELECT q.*, p.nickname,
            ${denaro.QUOTA_CENT}       AS lordo_cent,
            ${denaro.QUOTA_NETTA_CENT} AS netto_cent
       FROM quote_tavolo q
       JOIN tavoli t ON t.id = q.tavolo_id
       JOIN pr p ON p.id = q.pr_id
      WHERE q.tavolo_id = ?
      ORDER BY q.livello`,
    [tavoloId]
  );

  return righe.map((r) => ({
    ...r,
    lordo: denaro.aEuro(r.lordo_cent),
    netto: denaro.aEuro(r.netto_cent),
    // Quanto deve girare al livello sottostante: e' esattamente la quota lorda
    // di chi sta sotto, quindi le due cifre non possono discordare.
    girato: denaro.aEuro(r.lordo_cent - r.netto_cent)
  }));
}

/**
 * Ricostruisce le quote mancanti dei tavoli gia' approvati.
 *
 * Serve una volta sola, quando un database esistente passa a questo schema: i
 * tavoli approvati in precedenza non hanno una fotografia della catena, e
 * l'unica informazione disponibile e' la struttura attuale. Le percentuali di
 * oggi vengono quindi assunte come quelle in vigore allora.
 *
 * Le incoerenze non bloccano: qui si sta registrando quello che e' gia'
 * successo, non autorizzando qualcosa di nuovo. Vengono pero' restituite,
 * perche' la pagina di verifica le mostri.
 */
async function ricostruisciMancanti() {
  const daFare = await all(
    `SELECT t.id, t.pr_id, t.nome_tavolo, t.data
       FROM tavoli t
      WHERE t.stato = 'approvato'
        AND NOT EXISTS (SELECT 1 FROM quote_tavolo q WHERE q.tavolo_id = t.id)
      ORDER BY t.id`
  );

  const esito = { ricostruiti: 0, falliti: [], incoerenti: [] };

  for (const t of daFare) {
    try {
      const catena = await catenaDi(t.pr_id);
      await scrivi(t.id, righeQuota(t.id, catena));
      esito.ricostruiti++;
      if (catena.incoerenze.length) {
        esito.incoerenti.push({ tavoloId: t.id, nome: t.nome_tavolo, incoerenze: catena.incoerenze });
      }
    } catch (err) {
      // Un tavolo la cui catena non e' ricostruibile (venditore orfano, ciclo)
      // resta senza quote: non viene inventato nulla, e la pagina di verifica
      // lo elenca perche' qualcuno decida come sistemarlo.
      esito.falliti.push({
        tavoloId: t.id,
        nome: t.nome_tavolo,
        data: t.data,
        motivo: err.message
      });
    }
  }

  return esito;
}

/** Tavoli approvati rimasti senza quote: sono esclusi da ogni calcolo. */
async function tavoliSenzaQuote() {
  return all(
    `SELECT t.id, t.data, t.nome_tavolo, t.spesa_prevista, t.incasso_effettivo,
            t.pr_id, p.nickname AS pr_nickname
       FROM tavoli t
       LEFT JOIN pr p ON p.id = t.pr_id
      WHERE t.stato = 'approvato'
        AND NOT EXISTS (SELECT 1 FROM quote_tavolo q WHERE q.tavolo_id = t.id)
      ORDER BY t.data DESC`
  );
}

module.exports = {
  PROFONDITA_MASSIMA,
  catenaDi,
  righeQuota,
  scrivi,
  congela,
  libera,
  delTavolo,
  ricostruisciMancanti,
  tavoliSenzaQuote
};
