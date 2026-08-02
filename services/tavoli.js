// Ciclo di vita dei tavoli: richiesta -> approvazione o rifiuto.
//
// Nell'originale l'approvazione eseguiva cinque scritture in sequenza senza
// transazione (inserimento nello storico, statistiche mensili, provvigioni,
// andamento, cancellazione della richiesta): un errore a meta' lasciava il
// database in uno stato incoerente e irrecuperabile. In piu' il rifiuto
// cancellava la riga, perdendo ogni traccia.
//
// Ora la riga resta sempre la stessa e cambia solo `stato`: l'operazione e'
// atomica per costruzione e lo storico e' completo.

const { run, get, all, transaction } = require('./db-helpers');
const v = require('./validation');

const STATI = { ATTESA: 'in_attesa', APPROVATO: 'approvato', RIFIUTATO: 'rifiutato' };

/** Crea una richiesta di tavolo da parte di un PR. */
async function creaRichiesta(prId, dati) {
  const campi = {
    pr_id: v.idNumerico(prId, 'Il PR'),
    data: v.data(dati.data),
    nome_tavolo: v.testo(dati.nome_tavolo, { campo: 'Il nome del tavolo', min: 2, max: 100 }),
    numero_persone: v.intero(dati.numero_persone, { campo: 'Il numero di persone', min: 1, max: 500 }),
    spesa_prevista: v.importo(dati.spesa_prevista, { campo: 'La spesa prevista', min: 0, max: 1000000 }),
    omaggi: v.noteLibere(dati.omaggi, 300),
    note_tavolo: v.noteLibere(dati.note_tavolo, 1000)
  };

  const r = await run(
    `INSERT INTO tavoli (pr_id, data, nome_tavolo, numero_persone, spesa_prevista,
                         omaggi, note_tavolo, stato)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      campi.pr_id,
      campi.data,
      campi.nome_tavolo,
      campi.numero_persone,
      campi.spesa_prevista,
      campi.omaggi,
      campi.note_tavolo,
      STATI.ATTESA
    ]
  );
  return r.lastID;
}

async function getTavolo(id) {
  return get('SELECT * FROM tavoli WHERE id = ?', [id]);
}

/**
 * Approva una richiesta. Non serve ricalcolare o propagare nulla: le
 * provvigioni sono derivate dai tavoli approvati al momento della lettura.
 */
async function approva(tavoloId, nicknameDecisore) {
  const id = v.idNumerico(tavoloId, 'Il tavolo');
  return transaction(async (tx) => {
    const tavolo = await tx.get('SELECT * FROM tavoli WHERE id = ?', [id]);
    if (!tavolo) throw new v.ErroreValidazione('Richiesta non trovata.');
    if (tavolo.stato !== STATI.ATTESA) {
      throw new v.ErroreValidazione(
        `Questa richiesta e' gia' stata gestita (stato attuale: ${etichettaStato(tavolo.stato)}).`
      );
    }
    await tx.run(
      `UPDATE tavoli SET stato = ?, deciso_il = datetime('now'), deciso_da_nickname = ?,
                         motivo_rifiuto = NULL
       WHERE id = ? AND stato = ?`,
      [STATI.APPROVATO, nicknameDecisore, id, STATI.ATTESA]
    );
    return tavolo;
  });
}

/** Rifiuta una richiesta conservandone la traccia e il motivo. */
async function rifiuta(tavoloId, nicknameDecisore, motivo) {
  const id = v.idNumerico(tavoloId, 'Il tavolo');
  const testoMotivo = v.noteLibere(motivo, 500);
  return transaction(async (tx) => {
    const tavolo = await tx.get('SELECT * FROM tavoli WHERE id = ?', [id]);
    if (!tavolo) throw new v.ErroreValidazione('Richiesta non trovata.');
    if (tavolo.stato !== STATI.ATTESA) {
      throw new v.ErroreValidazione(
        `Questa richiesta e' gia' stata gestita (stato attuale: ${etichettaStato(tavolo.stato)}).`
      );
    }
    await tx.run(
      `UPDATE tavoli SET stato = ?, deciso_il = datetime('now'), deciso_da_nickname = ?,
                         motivo_rifiuto = ?
       WHERE id = ? AND stato = ?`,
      [STATI.RIFIUTATO, nicknameDecisore, testoMotivo || null, id, STATI.ATTESA]
    );
    return tavolo;
  });
}

/**
 * Modifica i dati di un tavolo. La nota di motivazione e' obbligatoria: chi
 * vende deve poter capire perche' i suoi numeri sono cambiati.
 */
async function modifica(tavoloId, dati, nicknameModificatore) {
  const id = v.idNumerico(tavoloId, 'Il tavolo');
  const note = v.testo(dati.note_modifiche, {
    campo: 'La motivazione della modifica',
    min: 3,
    max: 500
  });

  const campi = {
    data: v.data(dati.data),
    nome_tavolo: v.testo(dati.nome_tavolo, { campo: 'Il nome del tavolo', min: 2, max: 100 }),
    numero_persone: v.intero(dati.numero_persone, { campo: 'Il numero di persone', min: 1, max: 500 }),
    spesa_prevista: v.importo(dati.spesa_prevista, { campo: 'La spesa prevista', min: 0, max: 1000000 }),
    omaggi: v.noteLibere(dati.omaggi, 300),
    note_tavolo: v.noteLibere(dati.note_tavolo, 1000)
  };

  return transaction(async (tx) => {
    const tavolo = await tx.get('SELECT * FROM tavoli WHERE id = ?', [id]);
    if (!tavolo) throw new v.ErroreValidazione('Tavolo non trovato.');

    await tx.run(
      `UPDATE tavoli SET data = ?, nome_tavolo = ?, numero_persone = ?, spesa_prevista = ?,
                         omaggi = ?, note_tavolo = ?, modificata = 1,
                         note_modifiche = ?, modificato_da_nickname = ?
       WHERE id = ?`,
      [
        campi.data,
        campi.nome_tavolo,
        campi.numero_persone,
        campi.spesa_prevista,
        campi.omaggi,
        campi.note_tavolo,
        note,
        nicknameModificatore,
        id
      ]
    );
    return { precedente: tavolo, nuovo: { ...tavolo, ...campi } };
  });
}

/**
 * Riporta un tavolo gia' deciso allo stato di attesa.
 * Serve per correggere un errore di valutazione senza dover cancellare la riga.
 */
async function riapri(tavoloId, nickname) {
  const id = v.idNumerico(tavoloId, 'Il tavolo');
  const r = await run(
    `UPDATE tavoli SET stato = ?, deciso_il = NULL, deciso_da_nickname = NULL,
                       motivo_rifiuto = NULL, modificata = 1,
                       note_modifiche = COALESCE(note_modifiche, '') || ?
     WHERE id = ? AND stato != ?`,
    [STATI.ATTESA, ` [riaperto da ${nickname}]`, id, STATI.ATTESA]
  );
  return r.changes;
}

/** Elenco tavoli con filtri. `prIds` limita l'ambito di visibilita'. */
async function elenca({ prIds = null, stato = null, from = null, to = null, limite = 500 } = {}) {
  const where = [];
  const params = [];

  if (Array.isArray(prIds)) {
    if (prIds.length === 0) return [];
    where.push(`t.pr_id IN (${prIds.map(() => '?').join(',')})`);
    params.push(...prIds);
  }
  if (stato) {
    where.push('t.stato = ?');
    params.push(stato);
  }
  if (from) {
    where.push('t.data >= ?');
    params.push(from);
  }
  if (to) {
    where.push('t.data <= ?');
    params.push(to);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(Math.min(Number(limite) || 500, 2000));

  return all(
    `SELECT t.*, p.nickname AS pr_nickname, p.percentuale_provvigione
     FROM tavoli t
     JOIN pr p ON p.id = t.pr_id
     ${clause}
     ORDER BY t.data DESC, t.id DESC
     LIMIT ?`,
    params
  );
}

async function contaInAttesa(prIds) {
  if (!Array.isArray(prIds) || prIds.length === 0) return 0;
  const r = await get(
    `SELECT COUNT(*) AS n FROM tavoli
     WHERE stato = ? AND pr_id IN (${prIds.map(() => '?').join(',')})`,
    [STATI.ATTESA, ...prIds]
  );
  return r ? r.n : 0;
}

function etichettaStato(stato) {
  switch (stato) {
    case STATI.APPROVATO:
      return 'approvato';
    case STATI.RIFIUTATO:
      return 'rifiutato';
    default:
      return 'in attesa';
  }
}

module.exports = {
  STATI,
  creaRichiesta,
  getTavolo,
  approva,
  rifiuta,
  modifica,
  riapri,
  elenca,
  contaInAttesa,
  etichettaStato
};
