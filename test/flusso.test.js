// Verifica del flusso completo: richiesta -> approvazione -> provvigioni ->
// pagamento -> saldo, comprese le operazioni che possono disfare qualcosa.
//   npm run test:flusso

const aiuto = require('./aiuto');
const dbFile = aiuto.preparaDatabase('flusso');

const { get, run } = require('../services/db-helpers');
const schema = require('../models/schema');
const tavoli = require('../services/tavoli');
const pagamenti = require('../services/pagamenti');
const utenti = require('../services/users');
const quote = require('../services/quote');
const { computeCommissions } = require('../services/commissions');

const { check, respinta, sezione, riepilogo } = aiuto.creaVerificatore();

function fraGiorni(quanti) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + quanti);
  return d.toISOString().slice(0, 10);
}

(async () => {
  try {
    await schema.initSchema({ silenzioso: true });

    // Struttura: amministrazione -> sara (12%) -> marco (5%)
    const adminId = await utenti.creaAdmin({
      nome: 'Boss',
      cognome: 'Rossi',
      numero_telefono: '3330000000',
      nickname: 'boss',
      password: 'PasswordSicura1'
    });
    const saraId = await utenti.creaPr({
      nome: 'Sara',
      cognome: 'Bianchi',
      numero_telefono: '3331111111',
      nickname: 'sara',
      password: 'PasswordSicura1',
      percentuale_provvigione: 12,
      fk_padre: adminId,
      padre_tipo: 'admin'
    });
    const marcoId = await utenti.creaPr({
      nome: 'Marco',
      cognome: 'Verdi',
      numero_telefono: '3332222222',
      nickname: 'marco',
      password: 'PasswordSicura1',
      percentuale_provvigione: 5,
      fk_padre: saraId,
      padre_tipo: 'pr'
    });

    sezione('Cifratura dei dati personali e accesso');
    const grezzo = await get('SELECT nome, nickname FROM pr WHERE id = ?', [marcoId]);
    check('Il nome e cifrato a riposo', true, grezzo.nome !== 'Marco');
    const trovato = await utenti.findByNickname('MARCO');
    check('Il nickname si cerca senza distinzione di maiuscole', 'marco', trovato.nickname);
    check('Il nome viene decifrato in lettura', 'Marco', trovato.nome);
    check('Password corretta accettata', true, await utenti.verifyPassword('PasswordSicura1', trovato.password));
    check('Password sbagliata respinta', false, await utenti.verifyPassword('sbagliata', trovato.password));

    sezione('Richiesta e approvazione di un tavolo');
    const tavoloId = await tavoli.creaRichiesta(marcoId, {
      data: fraGiorni(7),
      nome_tavolo: 'Sala 1 - 3',
      numero_persone: 6,
      spesa_prevista: 1000,
      note_tavolo: 'compleanno'
    });
    let t = await tavoli.getTavolo(tavoloId);
    check('Il tavolo nasce in attesa', 'in_attesa', t.stato);
    check('La base di calcolo e il preventivo', 'preventivo', t.baseCalcolo);

    let c = await computeCommissions({ adminId });
    check('Un tavolo in attesa non genera provvigioni', 0, c.perPr.get(marcoId).maturato);

    const anteprima = await tavoli.ripartizionePrevista(t);
    check('L anteprima e calcolabile', true, anteprima.ok);
    check('L anteprima prevede 120 di costo', 120, anteprima.costoTotale);

    await tavoli.approva(tavoloId, 'boss');
    t = await tavoli.getTavolo(tavoloId);
    check('Il tavolo risulta approvato', 'approvato', t.stato);
    check('Viene registrato chi ha deciso', 'boss', t.deciso_da_nickname);
    check('La ripartizione e stata congelata', 2, (await quote.delTavolo(tavoloId)).length);

    c = await computeCommissions({ adminId });
    check('Marco matura il 5% di 1000', 50, c.perPr.get(marcoId).maturato);
    check('Sara matura il 12% di 1000', 120, c.perPr.get(saraId).maturato);
    check('Sara trattiene la differenza 12%-5%', 70, c.perPr.get(saraId).trattenuto);

    sezione('Una decisione non si prende due volte');
    await respinta('Approvare due volte lo stesso tavolo', () => tavoli.approva(tavoloId, 'boss'), 'gia');

    sezione('Il rifiuto conserva lo storico');
    const daRifiutare = await tavoli.creaRichiesta(marcoId, {
      data: fraGiorni(8),
      nome_tavolo: 'Gabbia 1',
      numero_persone: 4,
      spesa_prevista: 5000
    });
    await tavoli.rifiuta(daRifiutare, 'boss', 'Data non disponibile');
    const rifiutato = await tavoli.getTavolo(daRifiutare);
    check('Il tavolo rifiutato resta nel database', 'rifiutato', rifiutato.stato);
    check('Il motivo viene conservato', 'Data non disponibile', rifiutato.motivo_rifiuto);
    check('Un rifiutato non ha ripartizione', 0, (await quote.delTavolo(daRifiutare)).length);
    c = await computeCommissions({ adminId });
    check('Il rifiutato non entra nelle provvigioni', 50, c.perPr.get(marcoId).maturato);

    sezione('Chi paga chi');
    await respinta(
      'L amministrazione paga Marco scavalcando Sara',
      () =>
        pagamenti.registra({
          destinatarioId: marcoId,
          paganteTipo: 'admin',
          paganteId: adminId,
          importo: 50
        }),
      'non risulti debitore'
    );
    await respinta(
      'Pagare piu del dovuto',
      () =>
        pagamenti.registra({
          destinatarioId: marcoId,
          paganteTipo: 'pr',
          paganteId: saraId,
          importo: 999
        }),
      'supera il dovuto'
    );
    await respinta(
      'Pagare se stessi',
      () =>
        pagamenti.registra({
          destinatarioId: marcoId,
          paganteTipo: 'pr',
          paganteId: marcoId,
          importo: 10
        }),
      'te stesso'
    );

    const esito = await pagamenti.registra({
      destinatarioId: marcoId,
      paganteTipo: 'pr',
      paganteId: saraId,
      importo: 30,
      note: 'acconto',
      registratoDa: 'sara'
    });
    check('Residuo dopo un acconto di 30', 20, esito.residuoDopo);

    c = await computeCommissions({ adminId });
    check('Marco risulta aver ricevuto 30', 30, c.perPr.get(marcoId).ricevuto);
    check('Saldo residuo di Marco', 20, c.perPr.get(marcoId).saldo);

    await pagamenti.registra({
      destinatarioId: marcoId,
      paganteTipo: 'pr',
      paganteId: saraId,
      importo: 20,
      registratoDa: 'sara'
    });
    await respinta(
      'Pagare ancora a saldo chiuso',
      () =>
        pagamenti.registra({
          destinatarioId: marcoId,
          paganteTipo: 'pr',
          paganteId: saraId,
          importo: 5
        }),
      'gia'
    );

    sezione('Due pagamenti contemporanei non possono sforare il dovuto');
    // Sara deve 120 all'amministrazione: si tentano due versamenti da 80 nello
    // stesso istante. Il controllo sta dentro la transazione, quindi il secondo
    // legge il saldo gia' aggiornato dal primo.
    const esiti = await Promise.allSettled([
      pagamenti.registra({
        destinatarioId: saraId,
        paganteTipo: 'admin',
        paganteId: adminId,
        importo: 80
      }),
      pagamenti.registra({
        destinatarioId: saraId,
        paganteTipo: 'admin',
        paganteId: adminId,
        importo: 80
      })
    ]);
    const riusciti = esiti.filter((e) => e.status === 'fulfilled').length;
    check('Uno solo dei due versamenti passa', 1, riusciti);
    c = await computeCommissions({ adminId });
    check('Sara ha ricevuto 80, non 160', 80, c.perPr.get(saraId).ricevuto);
    check('Il saldo di Sara resta positivo', 40, c.perPr.get(saraId).saldo);

    sezione('Modifica di un tavolo gia pagato');
    await respinta(
      'Ridurre l importo sotto quanto gia versato',
      () =>
        tavoli.modifica(
          tavoloId,
          {
            data: fraGiorni(7),
            nome_tavolo: 'Sala 1 - 3',
            numero_persone: 6,
            spesa_prevista: 100,
            note_modifiche: 'prova di riduzione eccessiva'
          },
          'boss'
        ),
      'gia'
    );
    await respinta(
      'Riaprire un tavolo gia pagato',
      () => tavoli.riapri(tavoloId, 'boss'),
      'gia'
    );

    // Aumentare invece si puo' sempre: nessuno ci rimette.
    await tavoli.modifica(
      tavoloId,
      {
        data: fraGiorni(7),
        nome_tavolo: 'Sala 1 - 3',
        numero_persone: 6,
        spesa_prevista: 2000,
        note_tavolo: 'compleanno',
        note_modifiche: 'Conto finale superiore al preventivo'
      },
      'boss'
    );
    c = await computeCommissions({ adminId });
    check('Le provvigioni seguono l importo corretto', 100, c.perPr.get(marcoId).maturato);
    check('Il gia versato resta 50', 50, c.perPr.get(marcoId).ricevuto);
    check('Il nuovo residuo e 50', 50, c.perPr.get(marcoId).saldo);
    check('Le percentuali restano quelle congelate', 5, c.perPr.get(marcoId).percentualeApplicataMax);

    sezione('Incasso reale della serata');
    await tavoli.impostaIncasso(tavoloId, '2500', 'boss');
    t = await tavoli.getTavolo(tavoloId);
    check('La base di calcolo diventa il consuntivo', 'consuntivo', t.baseCalcolo);
    check('L imponibile e l incasso reale', 2500, t.imponibile);
    c = await computeCommissions({ adminId });
    check('Marco matura il 5% di 2500', 125, c.perPr.get(marcoId).maturato);

    await respinta(
      'Registrare un incasso che scende sotto il gia pagato',
      () => tavoli.impostaIncasso(tavoloId, '10', 'boss'),
      'gia'
    );

    await tavoli.impostaIncasso(tavoloId, '', 'boss');
    t = await tavoli.getTavolo(tavoloId);
    check('Svuotare il campo riporta al preventivo', 'preventivo', t.baseCalcolo);
    check('L imponibile torna al preventivo', 2000, t.imponibile);

    sezione('Riapertura consentita quando non c e nulla di pagato');
    const pulito = await tavoli.creaRichiesta(marcoId, {
      data: fraGiorni(9),
      nome_tavolo: 'Soppalco 2',
      numero_persone: 2,
      spesa_prevista: 500
    });
    await tavoli.approva(pulito, 'boss');
    check('Ripartizione presente dopo l approvazione', 2, (await quote.delTavolo(pulito)).length);
    await tavoli.riapri(pulito, 'boss');
    check('La ripartizione viene rimossa', 0, (await quote.delTavolo(pulito)).length);
    check('Il tavolo torna in attesa', 'in_attesa', (await tavoli.getTavolo(pulito)).stato);

    sezione('Annullamento di un pagamento');
    const versati = await pagamenti.effettuatiDa('pr', saraId, 10);
    await respinta(
      'Annullare un pagamento fatto da un altro',
      () => pagamenti.annulla(versati[0].id, { tipo: 'admin', id: adminId }),
      'solo i pagamenti che hai effettuato'
    );
    await pagamenti.annulla(versati[0].id, { tipo: 'pr', id: saraId });
    c = await computeCommissions({ adminId });
    check('Il saldo di Marco torna scoperto', 30, c.perPr.get(marcoId).ricevuto);

    sezione('Validazioni sui dati di un tavolo');
    await respinta(
      'Zero persone',
      () =>
        tavoli.creaRichiesta(marcoId, {
          data: fraGiorni(3),
          nome_tavolo: 'Test',
          numero_persone: 0,
          spesa_prevista: 100
        }),
      'numero di persone'
    );
    await respinta(
      'Spesa negativa',
      () =>
        tavoli.creaRichiesta(marcoId, {
          data: fraGiorni(3),
          nome_tavolo: 'Test',
          numero_persone: 2,
          spesa_prevista: -50
        }),
      'spesa prevista'
    );
    await respinta(
      'Data che non esiste nel calendario',
      () =>
        tavoli.creaRichiesta(marcoId, {
          data: '2026-02-31',
          nome_tavolo: 'Test',
          numero_persone: 2,
          spesa_prevista: 100
        }),
      'calendario'
    );
    await respinta(
      'Modifica senza motivazione',
      () =>
        tavoli.modifica(
          tavoloId,
          {
            data: fraGiorni(7),
            nome_tavolo: 'Sala 1 - 3',
            numero_persone: 6,
            spesa_prevista: 2000
          },
          'boss'
        ),
      'motivazione'
    );

    sezione('Approvazione bloccata da percentuali incoerenti');
    await run('UPDATE pr SET percentuale_provvigione = 20 WHERE id = ?', [marcoId]);
    const incoerente = await tavoli.creaRichiesta(marcoId, {
      data: fraGiorni(11),
      nome_tavolo: 'Mezza Luna 1',
      numero_persone: 2,
      spesa_prevista: 800
    });
    await respinta(
      'Approvare con il collaboratore sopra al responsabile',
      () => tavoli.approva(incoerente, 'boss'),
      'rimetterebbe'
    );
    await run('UPDATE pr SET percentuale_provvigione = 5 WHERE id = ?', [marcoId]);
    await tavoli.approva(incoerente, 'boss');
    check('Sistemate le percentuali, l approvazione passa', 'approvato', (await tavoli.getTavolo(incoerente)).stato);

    sezione('Nickname duplicati');
    check('Nickname esistente rilevato', true, await utenti.nicknameEsiste('SARA'));
    check('Nickname libero', false, await utenti.nicknameEsiste('nuovo_collaboratore'));
  } catch (err) {
    console.error('\nERRORE durante i test:', err);
    process.exitCode = 1;
  } finally {
    const falliti = riepilogo('flusso.test.js');
    aiuto.pulisci(dbFile);
    process.exit(falliti > 0 || process.exitCode ? 1 : 0);
  }
})();
