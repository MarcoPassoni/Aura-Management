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
// ----------------------------------------------------------------------------
// DUE COSE CAMBIATE RISPETTO ALLA VERSIONE PRECEDENTE
//
// 1. Il controllo "l'importo non supera il dovuto" veniva fatto PRIMA di aprire
//    la transazione. Due richieste inviate nello stesso istante lo superavano
//    entrambe e insieme sforavano il debito. Ora il controllo sta dentro la
//    transazione, che viene aperta in modalita' esclusiva: la seconda richiesta
//    legge il saldo gia' aggiornato dalla prima e viene respinta.
//
// 2. Il debito non e' piu' un numero unico per collaboratore ma una coppia
//    creditore-debitore. Se un collaboratore e' stato spostato sotto un altro
//    responsabile, il vecchio responsabile resta debitore di quello che aveva
//    gia' maturato e il nuovo lo e' solo del maturato successivo. Prima
//    l'intero debito passava automaticamente al nuovo responsabile.
//
// Non serve piu' nessuna tolleranza sui centesimi: gli importi sono numeri
// interi di centesimi e i confronti sono esatti.

const { run, get, all, transaction } = require('./db-helpers');
const v = require('./validation');
const denaro = require('./denaro');
const { saldoCoppiaCent, debitoriDi } = require('./commissions');

/**
 * Registra un pagamento verso un collaboratore.
 *
 * @param {object} opzioni
 * @param {number} opzioni.destinatarioId   collaboratore che riceve
 * @param {'admin'|'pr'} opzioni.paganteTipo
 * @param {number} opzioni.paganteId
 * @param {number} opzioni.importo
 */
async function registra({ destinatarioId, paganteTipo, paganteId, importo, note, registratoDa }) {
  const dest = v.idNumerico(destinatarioId, 'Il destinatario');
  const pagante = v.idNumerico(paganteId, 'Il pagante');
  const valore = v.importo(importo, { campo: "L'importo", min: 0.01, max: 1000000 });
  const noteP = v.noteLibere(note, 500);
  const valoreCent = denaro.aCentesimi(valore);

  if (!['admin', 'pr'].includes(paganteTipo)) {
    throw new v.ErroreValidazione('Tipo di pagante non valido.');
  }
  if (paganteTipo === 'pr' && pagante === dest) {
    throw new v.ErroreValidazione('Non puoi registrare un pagamento verso te stesso.');
  }

  return transaction(async (tx) => {
    const destinatario = await tx.get('SELECT id, nickname FROM pr WHERE id = ?', [dest]);
    if (!destinatario) throw new v.ErroreValidazione('Collaboratore non trovato.');

    const { maturatoCent, residuoCent } = await saldoCoppiaCent(
      { destinatarioId: dest, debitoreTipo: paganteTipo, debitoreId: pagante },
      tx
    );

    // Nessun rapporto di debito fra questi due: dire di chi e' il debito e'
    // piu' utile che dire soltanto "non puoi".
    if (maturatoCent === 0) {
      const debitori = await debitoriDi(dest);
      const dettaglio = debitori.length
        ? ` Le sue provvigioni sono a carico di: ${debitori
            .map((d) => nomeDebitore(d))
            .join(', ')}.`
        : ` ${destinatario.nickname} non ha ancora maturato provvigioni da nessuno.`;
      throw new v.ErroreValidazione(
        `Non risulti debitore di ${destinatario.nickname}.${dettaglio}`
      );
    }

    if (residuoCent <= 0) {
      throw new v.ErroreValidazione(
        `${destinatario.nickname} risulta gia' saldato nei tuoi confronti` +
          (residuoCent < 0
            ? `: ha anzi ricevuto ${denaro.aEuro(-residuoCent).toFixed(2)} EUR in piu' del dovuto.`
            : '.')
      );
    }

    if (valoreCent > residuoCent) {
      throw new v.ErroreValidazione(
        `L'importo supera il dovuto: a ${destinatario.nickname} restano ` +
          `${denaro.aEuro(residuoCent).toFixed(2)} EUR.`
      );
    }

    const r = await tx.run(
      `INSERT INTO pagamenti_provvigioni
         (pr_destinatario_id, pagante_tipo, pagante_id, importo, note, registrato_da_nickname)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [dest, paganteTipo, pagante, valore, noteP || null, registratoDa || null]
    );

    return {
      id: r.lastID,
      importo: valore,
      destinatario: destinatario.nickname,
      residuoDopo: denaro.aEuro(residuoCent - valoreCent)
    };
  });
}

function nomeDebitore(d) {
  return `${d.nome} (${d.maturato.toFixed(2)} EUR)`;
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
      (pagamento.pagante_tipo !== richiedente.tipo ||
        Number(pagamento.pagante_id) !== Number(richiedente.id))
    ) {
      throw new v.ErroreValidazione('Puoi annullare solo i pagamenti che hai effettuato tu.');
    }

    await tx.run('DELETE FROM pagamenti_provvigioni WHERE id = ?', [id]);
    return pagamento;
  });
}

/** Storico dei pagamenti ricevuti da un collaboratore. */
async function ricevutiDa(prId, limite = 100) {
  return all(
    `SELECT pg.*,
            CASE pg.pagante_tipo WHEN 'pr' THEN p.nickname ELSE a.nickname END AS pagante_nickname
       FROM pagamenti_provvigioni pg
       LEFT JOIN pr p ON p.id = pg.pagante_id AND pg.pagante_tipo = 'pr'
       LEFT JOIN admin a ON a.id = pg.pagante_id AND pg.pagante_tipo = 'admin'
      WHERE pg.pr_destinatario_id = ?
      ORDER BY pg.data_pagamento DESC, pg.id DESC
      LIMIT ?`,
    [prId, Math.min(Number(limite) || 100, 500)]
  );
}

/** Storico dei pagamenti effettuati da un'amministrazione o da un collaboratore. */
async function effettuatiDa(tipo, id, limite = 100) {
  return all(
    `SELECT pg.*, d.nickname AS destinatario_nickname
       FROM pagamenti_provvigioni pg
       JOIN pr d ON d.id = pg.pr_destinatario_id
      WHERE pg.pagante_tipo = ? AND pg.pagante_id = ?
      ORDER BY pg.data_pagamento DESC, pg.id DESC
      LIMIT ?`,
    [tipo, id, Math.min(Number(limite) || 100, 500)]
  );
}

/** Ultima data di pagamento per ciascun collaboratore, da un dato debitore. */
async function ultimePerPr(prIds, debitore = null) {
  if (!Array.isArray(prIds) || prIds.length === 0) return new Map();

  const params = [...prIds];
  let filtro = '';
  if (debitore) {
    filtro = ' AND pagante_tipo = ? AND pagante_id = ?';
    params.push(debitore.tipo, debitore.id);
  }

  const righe = await all(
    `SELECT pr_destinatario_id AS pr_id, MAX(data_pagamento) AS ultima
       FROM pagamenti_provvigioni
      WHERE pr_destinatario_id IN (${prIds.map(() => '?').join(',')})${filtro}
      GROUP BY pr_destinatario_id`,
    params
  );
  return new Map(righe.map((r) => [r.pr_id, r.ultima]));
}

async function totaleVersatoDa(tipo, id) {
  const r = await get(
    `SELECT COALESCE(SUM(CAST(ROUND(importo * 100) AS INTEGER)), 0) AS cent
       FROM pagamenti_provvigioni
      WHERE pagante_tipo = ? AND pagante_id = ?`,
    [tipo, id]
  );
  return denaro.aEuro(r ? r.cent : 0);
}

module.exports = {
  registra,
  annulla,
  ricevutiDa,
  effettuatiDa,
  ultimePerPr,
  totaleVersatoDa
};
