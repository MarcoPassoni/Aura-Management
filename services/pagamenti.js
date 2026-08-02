// Registrazione dei pagamenti delle provvigioni.
//
// Problemi dell'originale risolti qui:
//  - `registraPagamentoProvvigioni` scriveva su `pr.ultima_data_pagamento`, una
//    colonna che non esisteva in nessun CREATE TABLE: l'inserimento del
//    pagamento andava a buon fine e subito dopo l'UPDATE falliva, restituendo
//    un errore all'utente per un pagamento in realta' registrato.
//  - Aggiornava `provvigioni_totali_pagate` ma non decrementava mai
//    `provvigioni_da_pagare`, che quindi cresceva all'infinito.
//  - Non verificava che il pagante fosse davvero chi doveva pagare, ne' che
//    l'importo non superasse il dovuto.
//
// Ora esistono solo i fatti: una riga per ogni pagamento. Ogni saldo e'
// calcolato da services/commissions.js a partire da questi fatti.

const { run, get, all, transaction } = require('./db-helpers');
const v = require('./validation');
const { computeCommissions, euro } = require('./commissions');

// Tolleranza per gli arrotondamenti sui centesimi.
const TOLLERANZA = 0.01;

/**
 * Registra un pagamento verso un PR.
 *
 * @param {object} opzioni
 * @param {number} opzioni.destinatarioId  PR che riceve
 * @param {'admin'|'pr'} opzioni.paganteTipo
 * @param {number} opzioni.paganteId
 * @param {number} opzioni.importo
 */
async function registra({ destinatarioId, paganteTipo, paganteId, importo, note, registratoDa }) {
  const dest = v.idNumerico(destinatarioId, 'Il destinatario');
  const pagante = v.idNumerico(paganteId, 'Il pagante');
  const valore = v.importo(importo, { campo: 'L\'importo', min: 0.01, max: 1000000 });
  const noteP = v.noteLibere(note, 500);

  if (!['admin', 'pr'].includes(paganteTipo)) {
    throw new v.ErroreValidazione('Tipo di pagante non valido.');
  }

  const { perPr } = await computeCommissions({});
  const situazione = perPr.get(dest);
  if (!situazione) throw new v.ErroreValidazione('Collaboratore non trovato.');

  // Solo chi ha effettivamente il debito puo' registrare il pagamento.
  if (situazione.pagante.tipo !== paganteTipo || Number(situazione.pagante.id) !== pagante) {
    throw new v.ErroreValidazione(
      `Le provvigioni di ${situazione.nickname} sono a carico di ${situazione.pagante.nome}, non tue.`
    );
  }

  const residuo = situazione.saldoDaRicevere;
  if (residuo <= TOLLERANZA) {
    throw new v.ErroreValidazione(
      `${situazione.nickname} non ha provvigioni in sospeso: risulta gia' saldato.`
    );
  }
  if (valore > residuo + TOLLERANZA) {
    throw new v.ErroreValidazione(
      `L'importo supera il dovuto: a ${situazione.nickname} restano ${euro(residuo)} EUR.`
    );
  }

  return transaction(async (tx) => {
    const r = await tx.run(
      `INSERT INTO pagamenti_provvigioni
         (pr_destinatario_id, pagante_tipo, pagante_id, importo, note, registrato_da_nickname)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [dest, paganteTipo, pagante, valore, noteP || null, registratoDa || null]
    );
    return { id: r.lastID, importo: valore, residuoDopo: euro(residuo - valore) };
  });
}

/** Annulla un pagamento registrato per errore. */
async function annulla(pagamentoId, richiedente) {
  const id = v.idNumerico(pagamentoId, 'Il pagamento');
  return transaction(async (tx) => {
    const pagamento = await tx.get('SELECT * FROM pagamenti_provvigioni WHERE id = ?', [id]);
    if (!pagamento) throw new v.ErroreValidazione('Pagamento non trovato.');

    // Puo' annullare solo chi lo ha effettuato.
    if (
      richiedente &&
      (pagamento.pagante_tipo !== richiedente.tipo || pagamento.pagante_id !== richiedente.id)
    ) {
      throw new v.ErroreValidazione('Puoi annullare solo i pagamenti che hai effettuato tu.');
    }

    await tx.run('DELETE FROM pagamenti_provvigioni WHERE id = ?', [id]);
    return pagamento;
  });
}

/** Storico dei pagamenti ricevuti da un PR. */
async function ricevutiDa(prId, limite = 100) {
  return all(
    `SELECT pg.*, p.nickname AS pagante_nickname
     FROM pagamenti_provvigioni pg
     LEFT JOIN pr p ON p.id = pg.pagante_id AND pg.pagante_tipo = 'pr'
     WHERE pg.pr_destinatario_id = ?
     ORDER BY pg.data_pagamento DESC
     LIMIT ?`,
    [prId, Math.min(Number(limite) || 100, 500)]
  );
}

/** Storico dei pagamenti effettuati da un admin o da un PR. */
async function effettuatiDa(tipo, id, limite = 100) {
  return all(
    `SELECT pg.*, d.nickname AS destinatario_nickname
     FROM pagamenti_provvigioni pg
     JOIN pr d ON d.id = pg.pr_destinatario_id
     WHERE pg.pagante_tipo = ? AND pg.pagante_id = ?
     ORDER BY pg.data_pagamento DESC
     LIMIT ?`,
    [tipo, id, Math.min(Number(limite) || 100, 500)]
  );
}

/** Ultima data di pagamento per ciascun PR (sostituisce la colonna inesistente). */
async function ultimePerPr(prIds) {
  if (!Array.isArray(prIds) || prIds.length === 0) return new Map();
  const righe = await all(
    `SELECT pr_destinatario_id AS pr_id, MAX(data_pagamento) AS ultima
     FROM pagamenti_provvigioni
     WHERE pr_destinatario_id IN (${prIds.map(() => '?').join(',')})
     GROUP BY pr_destinatario_id`,
    prIds
  );
  return new Map(righe.map((r) => [r.pr_id, r.ultima]));
}

async function totaleVersatoDa(tipo, id) {
  const r = await get(
    'SELECT COALESCE(SUM(importo), 0) AS t FROM pagamenti_provvigioni WHERE pagante_tipo = ? AND pagante_id = ?',
    [tipo, id]
  );
  return euro(r ? r.t : 0);
}

module.exports = {
  registra,
  annulla,
  ricevutiDa,
  effettuatiDa,
  ultimePerPr,
  totaleVersatoDa,
  TOLLERANZA
};
