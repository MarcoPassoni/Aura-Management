// Ciclo di vita dei tavoli: richiesta -> approvazione o rifiuto.
//
// Nell'originale l'approvazione eseguiva cinque scritture in sequenza senza
// transazione (inserimento nello storico, statistiche mensili, provvigioni,
// andamento, cancellazione della richiesta): un errore a meta' lasciava il
// database in uno stato incoerente e irrecuperabile. In piu' il rifiuto
// cancellava la riga, perdendo ogni traccia.
//
// Ora la riga resta sempre la stessa e cambia solo `stato`. L'approvazione
// aggiunge una cosa sola, dentro la stessa transazione: la fotografia della
// catena di provvigioni (services/quote.js).
//
// ----------------------------------------------------------------------------
// LE TRE OPERAZIONI CHE POSSONO TOGLIERE SOLDI GIA' PAGATI
//
// Riaprire un tavolo approvato, ridurne l'importo o azzerarne il consuntivo
// fanno diminuire quanto qualcuno ha maturato. Se quel qualcuno e' gia' stato
// pagato, il suo saldo diventerebbe negativo: un credito che non esiste piu' ma
// che risulta versato. Prima succedeva in silenzio.
//
// Adesso ognuna di queste operazioni calcola in anticipo l'effetto sui saldi e
// si ferma se qualcuno finirebbe sotto zero, dicendo chi e di quanto. La via
// d'uscita e' sempre la stessa e viene indicata nel messaggio: annullare prima
// il pagamento in eccesso.

const { run, get, all, transaction } = require('./db-helpers');
const v = require('./validation');
const quote = require('./quote');
const denaro = require('./denaro');
const { saldoCoppiaCent } = require('./commissions');

const { IMPONIBILE_CENT, QUOTA_CENT } = denaro;

const STATI = { ATTESA: 'in_attesa', APPROVATO: 'approvato', RIFIUTATO: 'rifiutato' };

/** Campi comuni a creazione e modifica, tutti validati nello stesso modo. */
function campiTavolo(dati) {
  return {
    data: v.data(dati.data),
    nome_tavolo: v.testo(dati.nome_tavolo, { campo: 'Il nome del tavolo', min: 2, max: 100 }),
    numero_persone: v.intero(dati.numero_persone, {
      campo: 'Il numero di persone',
      min: 1,
      max: 500
    }),
    spesa_prevista: v.importo(dati.spesa_prevista, {
      campo: 'La spesa prevista',
      min: 0,
      max: 1000000
    }),
    omaggi: v.noteLibere(dati.omaggi, 300),
    note_tavolo: v.noteLibere(dati.note_tavolo, 1000)
  };
}

/**
 * L'incasso effettivo e' facoltativo: vuoto significa "non ancora rilevato" e
 * fa ricadere il calcolo sul preventivo. Va distinto da zero, che significa
 * invece "il tavolo non ha consumato nulla".
 */
function leggiIncassoEffettivo(valore) {
  if (valore === undefined || valore === null) return undefined; // campo non inviato
  const testo = String(valore).trim();
  if (testo === '') return null; // consuntivo rimosso
  return v.importo(testo, { campo: "L'incasso effettivo", min: 0, max: 1000000 });
}

/** Crea una richiesta di tavolo da parte di un collaboratore. */
async function creaRichiesta(prId, dati) {
  const campi = campiTavolo(dati);
  const pr_id = v.idNumerico(prId, 'Il collaboratore');

  const r = await run(
    `INSERT INTO tavoli (pr_id, data, nome_tavolo, numero_persone, spesa_prevista,
                         omaggi, note_tavolo, stato)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pr_id,
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
  const riga = await get(
    `SELECT t.*,
            p.nickname AS pr_nickname,
            p.percentuale_provvigione,
            ${IMPONIBILE_CENT} AS imponibile_cent,
            (SELECT COALESCE(SUM(${QUOTA_CENT}), 0)
               FROM quote_tavolo q
              WHERE q.tavolo_id = t.id AND q.debitore_tipo = 'admin') AS costo_provvigioni_cent,
            (SELECT COUNT(*) FROM quote_tavolo q WHERE q.tavolo_id = t.id) AS quote_congelate
       FROM tavoli t
       LEFT JOIN pr p ON p.id = t.pr_id
      WHERE t.id = ?`,
    [id]
  );
  return riga ? decora(riga) : null;
}

/**
 * Effetto di una variazione di importo sui saldi gia' regolati.
 *
 * @param imponibileFuturoCent  il nuovo imponibile in centesimi, oppure null se
 *                              il tavolo sta per uscire dai calcoli (riapertura).
 * @returns elenco dei collaboratori che finirebbero in negativo, vuoto se
 *          l'operazione e' sicura.
 */
async function scopertiCausatiDa(tx, tavoloId, imponibileFuturoCent) {
  const righe = await tx.all(
    `SELECT q.pr_id, q.debitore_tipo, q.debitore_id, q.percentuale,
            ${IMPONIBILE_CENT} AS imponibile_cent,
            p.nickname
       FROM quote_tavolo q
       JOIN tavoli t ON t.id = q.tavolo_id
       JOIN pr p ON p.id = q.pr_id
      WHERE q.tavolo_id = ?`,
    [tavoloId]
  );

  const problemi = [];

  for (const q of righe) {
    const attualeCent = denaro.quotaCentesimi(q.imponibile_cent, q.percentuale);
    const futuraCent =
      imponibileFuturoCent === null
        ? 0
        : denaro.quotaCentesimi(imponibileFuturoCent, q.percentuale);
    const variazioneCent = futuraCent - attualeCent;

    // Solo una diminuzione puo' creare uno scoperto.
    if (variazioneCent >= 0) continue;

    const { residuoCent } = await saldoCoppiaCent(
      {
        destinatarioId: q.pr_id,
        debitoreTipo: q.debitore_tipo,
        debitoreId: q.debitore_id
      },
      tx
    );

    const residuoDopoCent = residuoCent + variazioneCent;
    if (residuoDopoCent < 0) {
      problemi.push({
        prId: q.pr_id,
        nickname: q.nickname,
        eccedenza: denaro.aEuro(-residuoDopoCent),
        variazione: denaro.aEuro(variazioneCent)
      });
    }
  }

  return problemi;
}

function bloccaSeScoperti(problemi, azione) {
  if (!problemi.length) return;
  const elenco = problemi
    .map((p) => `${p.nickname} (${p.eccedenza.toFixed(2)} EUR di troppo)`)
    .join(', ');
  throw new v.ErroreValidazione(
    `Non posso ${azione}: risulterebbe gia' pagato piu' del dovuto a ${elenco}. ` +
      'Annulla prima quei pagamenti dalla pagina Pagamenti, poi ripeti l\'operazione.'
  );
}

/**
 * Approva una richiesta.
 *
 * L'unica cosa che viene scritta oltre allo stato e' la fotografia della catena
 * di provvigioni: da questo momento le percentuali di questo tavolo non
 * cambiano piu', qualunque cosa succeda alla struttura.
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

    const congelate = await quote.congela(id, tavolo.pr_id, tx, { bloccaIncoerenze: true });

    await tx.run(
      `UPDATE tavoli SET stato = ?, deciso_il = datetime('now'), deciso_da_nickname = ?,
                         motivo_rifiuto = NULL
       WHERE id = ? AND stato = ?`,
      [STATI.APPROVATO, nicknameDecisore, id, STATI.ATTESA]
    );

    return { tavolo, quote: congelate.righe };
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
 *
 * Se il tavolo e' gia' approvato, le percentuali restano quelle congelate:
 * cambia solo l'importo, e le provvigioni lo seguono.
 */
async function modifica(tavoloId, dati, nicknameModificatore) {
  const id = v.idNumerico(tavoloId, 'Il tavolo');
  const note = v.testo(dati.note_modifiche, {
    campo: 'La motivazione della modifica',
    min: 3,
    max: 500
  });
  const campi = campiTavolo(dati);
  const incasso = leggiIncassoEffettivo(dati.incasso_effettivo);

  return transaction(async (tx) => {
    const tavolo = await tx.get('SELECT * FROM tavoli WHERE id = ?', [id]);
    if (!tavolo) throw new v.ErroreValidazione('Tavolo non trovato.');

    const incassoFinale = incasso === undefined ? tavolo.incasso_effettivo : incasso;
    const imponibileFuturoCent = denaro.aCentesimi(
      incassoFinale === null || incassoFinale === undefined
        ? campi.spesa_prevista
        : incassoFinale
    );

    if (tavolo.stato === STATI.APPROVATO) {
      bloccaSeScoperti(
        await scopertiCausatiDa(tx, id, imponibileFuturoCent),
        'ridurre l\'importo di questo tavolo'
      );
    }

    await tx.run(
      `UPDATE tavoli SET data = ?, nome_tavolo = ?, numero_persone = ?, spesa_prevista = ?,
                         incasso_effettivo = ?, omaggi = ?, note_tavolo = ?, modificata = 1,
                         note_modifiche = ?, modificato_da_nickname = ?
       WHERE id = ?`,
      [
        campi.data,
        campi.nome_tavolo,
        campi.numero_persone,
        campi.spesa_prevista,
        incassoFinale === undefined ? null : incassoFinale,
        campi.omaggi,
        campi.note_tavolo,
        note,
        nicknameModificatore,
        id
      ]
    );

    return {
      precedente: tavolo,
      nuovo: { ...tavolo, ...campi, incasso_effettivo: incassoFinale }
    };
  });
}

/**
 * Registra l'incasso reale della serata senza toccare il resto del tavolo.
 * Passare una stringa vuota rimuove il consuntivo e riporta il calcolo sul
 * preventivo.
 */
async function impostaIncasso(tavoloId, valore, nickname) {
  const id = v.idNumerico(tavoloId, 'Il tavolo');
  const incasso = leggiIncassoEffettivo(valore === undefined ? '' : valore);

  return transaction(async (tx) => {
    const tavolo = await tx.get('SELECT * FROM tavoli WHERE id = ?', [id]);
    if (!tavolo) throw new v.ErroreValidazione('Tavolo non trovato.');

    const imponibileFuturoCent = denaro.aCentesimi(
      incasso === null ? tavolo.spesa_prevista : incasso
    );

    if (tavolo.stato === STATI.APPROVATO) {
      bloccaSeScoperti(
        await scopertiCausatiDa(tx, id, imponibileFuturoCent),
        'registrare questo incasso'
      );
    }

    const nota =
      incasso === null
        ? `[consuntivo rimosso da ${nickname}]`
        : `[incasso reale ${incasso.toFixed(2)} EUR registrato da ${nickname}]`;

    await tx.run(
      `UPDATE tavoli
          SET incasso_effettivo = ?, modificata = 1, modificato_da_nickname = ?,
              note_modifiche = TRIM(COALESCE(note_modifiche, '') || ' ' || ?)
        WHERE id = ?`,
      [incasso, nickname, nota, id]
    );

    return { precedente: tavolo.incasso_effettivo, nuovo: incasso };
  });
}

/**
 * Riporta un tavolo gia' deciso allo stato di attesa.
 * Le quote congelate vengono rimosse: il tavolo esce dai calcoli finche' non
 * viene deciso di nuovo, e alla nuova approvazione la catena viene rifotografata
 * con le percentuali di quel momento.
 */
async function riapri(tavoloId, nickname) {
  const id = v.idNumerico(tavoloId, 'Il tavolo');

  return transaction(async (tx) => {
    const tavolo = await tx.get('SELECT * FROM tavoli WHERE id = ?', [id]);
    if (!tavolo) throw new v.ErroreValidazione('Tavolo non trovato.');
    if (tavolo.stato === STATI.ATTESA) {
      throw new v.ErroreValidazione('Questo tavolo e\' gia\' in attesa di decisione.');
    }

    if (tavolo.stato === STATI.APPROVATO) {
      bloccaSeScoperti(await scopertiCausatiDa(tx, id, null), 'riaprire questo tavolo');
    }

    await quote.libera(id, tx);

    await tx.run(
      `UPDATE tavoli SET stato = ?, deciso_il = NULL, deciso_da_nickname = NULL,
                         motivo_rifiuto = NULL, modificata = 1,
                         note_modifiche = TRIM(COALESCE(note_modifiche, '') || ' ' || ?)
       WHERE id = ?`,
      [STATI.ATTESA, `[riaperto da ${nickname}]`, id]
    );

    return tavolo;
  });
}

/**
 * Elenco tavoli con filtri. `prIds` limita l'ambito di visibilita'.
 *
 * Ogni riga porta con se' l'imponibile usato per i calcoli e il costo delle
 * provvigioni: sono i due numeri che servono per capire una riga senza doverla
 * aprire, e vengono dalla stessa fonte delle pagine economiche.
 */
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

  const righe = await all(
    `SELECT t.*,
            p.nickname AS pr_nickname,
            p.percentuale_provvigione,
            ${IMPONIBILE_CENT} AS imponibile_cent,
            (SELECT COALESCE(SUM(${QUOTA_CENT}), 0)
               FROM quote_tavolo q
              WHERE q.tavolo_id = t.id AND q.debitore_tipo = 'admin') AS costo_provvigioni_cent,
            (SELECT COUNT(*) FROM quote_tavolo q WHERE q.tavolo_id = t.id) AS quote_congelate
       FROM tavoli t
       JOIN pr p ON p.id = t.pr_id
       ${clause}
      ORDER BY t.data DESC, t.id DESC
      LIMIT ?`,
    params
  );

  return righe.map(decora);
}

/** Aggiunge a una riga di tavolo i campi derivati, in un solo posto. */
function decora(t) {
  const suConsuntivo = t.incasso_effettivo !== null && t.incasso_effettivo !== undefined;
  return {
    ...t,
    imponibile: denaro.aEuro(t.imponibile_cent),
    baseCalcolo: suConsuntivo ? 'consuntivo' : 'preventivo',
    costoProvvigioni: denaro.aEuro(t.costo_provvigioni_cent || 0),
    // Un tavolo approvato senza quote non entra in nessun calcolo: la pagina
    // Verifica lo elenca e questa bandiera lo evidenzia anche negli elenchi.
    escluso: t.stato === STATI.APPROVATO && !t.quote_congelate
  };
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

/**
 * Come sarebbe ripartito un tavolo non ancora approvato, con le percentuali di
 * oggi. Serve a mostrare all'amministratore il costo di cio' che sta per
 * approvare. E' dichiaratamente una stima: le percentuali definitive sono
 * quelle che verranno congelate all'atto dell'approvazione.
 */
async function ripartizionePrevista(tavolo) {
  try {
    const catena = await quote.catenaDi(tavolo.pr_id);
    const righe = quote.righeQuota(tavolo.id, catena);
    const imponibileCent = denaro.aCentesimi(
      tavolo.incasso_effettivo === null || tavolo.incasso_effettivo === undefined
        ? tavolo.spesa_prevista
        : tavolo.incasso_effettivo
    );

    const voci = righe.map((q, i) => {
      const lordoCent = denaro.quotaCentesimi(imponibileCent, q.percentuale);
      const sottoCent = denaro.quotaCentesimi(imponibileCent, q.percentuale_sotto);
      return {
        prId: q.pr_id,
        nickname: catena.righe[i].nickname,
        livello: q.livello,
        percentuale: q.percentuale,
        lordo: denaro.aEuro(lordoCent),
        netto: denaro.aEuro(lordoCent - sottoCent)
      };
    });

    return {
      ok: true,
      voci,
      costoTotale: voci.length ? voci[voci.length - 1].lordo : 0,
      incoerenze: catena.incoerenze
    };
  } catch (err) {
    // La catena non e' risolvibile: meglio dirlo prima dell'approvazione che
    // farla fallire dopo il clic.
    return { ok: false, motivo: err.message, voci: [], costoTotale: 0, incoerenze: [] };
  }
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
  impostaIncasso,
  riapri,
  elenca,
  contaInAttesa,
  ripartizionePrevista,
  scopertiCausatiDa,
  etichettaStato
};
