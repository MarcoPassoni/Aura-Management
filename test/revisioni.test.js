// Verifica del motore di revisione a catena: passaggio di mano, tetto e
// pavimento delle percentuali, riservatezza dei commenti, collaboratori
// disattivati lungo il percorso, riapertura, e i tavoli preesistenti.
//   npm run test:revisioni

const aiuto = require('./aiuto');
const dbFile = aiuto.preparaDatabase('revisioni');

const { run, get } = require('../services/db-helpers');
const schema = require('../models/schema');
const utenti = require('../services/users');
const tavoli = require('../services/tavoli');
const quote = require('../services/quote');
const revisioni = require('../services/revisioni');
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

    // Catena a cinque livelli, ricalcando l'esempio della richiesta originale:
    // admin -> uno(20%) -> due(15%) -> tre(10%) -> quattro(7%) -> cinque(5%).
    const adminId = await utenti.creaAdmin({
      nome: 'Boss', cognome: 'X', numero_telefono: '3330000000',
      nickname: 'boss', password: 'PasswordSicura1'
    });
    const unoId = await utenti.creaPr({
      nome: 'Uno', cognome: 'X', numero_telefono: '3330000001', nickname: 'uno',
      password: 'PasswordSicura1', percentuale_provvigione: 20,
      fk_padre: adminId, padre_tipo: 'admin'
    });
    const dueId = await utenti.creaPr({
      nome: 'Due', cognome: 'X', numero_telefono: '3330000002', nickname: 'due',
      password: 'PasswordSicura1', percentuale_provvigione: 15,
      fk_padre: unoId, padre_tipo: 'pr'
    });
    const treId = await utenti.creaPr({
      nome: 'Tre', cognome: 'X', numero_telefono: '3330000003', nickname: 'tre',
      password: 'PasswordSicura1', percentuale_provvigione: 10,
      fk_padre: dueId, padre_tipo: 'pr'
    });
    const quattroId = await utenti.creaPr({
      nome: 'Quattro', cognome: 'X', numero_telefono: '3330000004', nickname: 'quattro',
      password: 'PasswordSicura1', percentuale_provvigione: 7,
      fk_padre: treId, padre_tipo: 'pr'
    });
    const cinqueId = await utenti.creaPr({
      nome: 'Cinque', cognome: 'X', numero_telefono: '3330000005', nickname: 'cinque',
      password: 'PasswordSicura1', percentuale_provvigione: 5,
      fk_padre: quattroId, padre_tipo: 'pr'
    });

    sezione('La richiesta nasce instradata verso il primo responsabile');
    const id1 = await tavoli.creaRichiesta(cinqueId, {
      data: fraGiorni(5), nome_tavolo: 'Tavolo A', numero_persone: 4, spesa_prevista: 1000
    });
    let t = await tavoli.getTavolo(id1);
    check('Instradata verso quattro', 'pr', t.revisione_tipo);
    check('Non verso chiunque altro', quattroId, t.revisione_id);

    sezione('Non si puo rivedere fuori dal proprio turno');
    await respinta(
      'Tre non puo rivedere prima di quattro',
      () => revisioni.rivedi({ tavoloId: id1, revisorePrId: treId, percentuale: 5 }),
      'tuo turno'
    );
    await respinta(
      'Un estraneo alla catena non puo rivedere',
      () => revisioni.rivedi({ tavoloId: id1, revisorePrId: unoId, percentuale: 5 }),
      'tuo turno'
    );

    sezione('Ogni passaggio decide la percentuale del sottoposto diretto, sale di un livello');
    let esito = await revisioni.rivedi({ tavoloId: id1, revisorePrId: quattroId, percentuale: 5 });
    check('Quattro decide per cinque', 'cinque', esito.sottoposto);
    check('Percentuale confermata', 5, esito.percentualeDecisa);
    check('Sale a tre', 'pr', esito.prossimo.tipo);
    check('Verso tre', treId, esito.prossimo.id);

    esito = await revisioni.rivedi({ tavoloId: id1, revisorePrId: treId, percentuale: 7, commento: 'ok' });
    check('Tre decide per quattro', 'quattro', esito.sottoposto);
    check('Sale a due', dueId, esito.prossimo.id);

    esito = await revisioni.rivedi({ tavoloId: id1, revisorePrId: dueId, percentuale: 10 });
    check('Due decide per tre', 'tre', esito.sottoposto);
    check('Sale a uno', unoId, esito.prossimo.id);

    esito = await revisioni.rivedi({ tavoloId: id1, revisorePrId: unoId, percentuale: 15 });
    check('Uno decide per due', 'due', esito.sottoposto);
    check('Arrivata finalmente all amministrazione', 'admin', esito.prossimo.tipo);

    t = await tavoli.getTavolo(id1);
    check('Il tavolo risulta instradato verso l amministrazione', 'admin', t.revisione_tipo);

    await respinta(
      'Nessun altro collaboratore puo piu toccarla',
      () => revisioni.rivedi({ tavoloId: id1, revisorePrId: unoId, percentuale: 15 }),
      "amministrazione"
    );

    sezione('Approvazione finale: decide la percentuale del capofila');
    await tavoli.approva(id1, 'boss', adminId, 20);
    const congelate = await quote.delTavolo(id1);
    check('Cinque livelli congelati', 5, congelate.length);
    const perNickname = new Map(congelate.map((q) => [q.nickname, q.percentuale]));
    check('Cinque congelato al 5%', 5, perNickname.get('cinque'));
    check('Quattro congelato al 7%', 7, perNickname.get('quattro'));
    check('Tre congelato al 10%', 10, perNickname.get('tre'));
    check('Due congelato al 15%', 15, perNickname.get('due'));
    check('Uno congelato al 20%', 20, perNickname.get('uno'));

    const calcolo = await computeCommissions({ adminId });
    check('Cinque trattiene 5% di 1000', 50, calcolo.perPr.get(cinqueId).trattenuto);
    check('Quattro trattiene 7%-5%', 20, calcolo.perPr.get(quattroId).trattenuto);
    check('Tre trattiene 10%-7%', 30, calcolo.perPr.get(treId).trattenuto);
    check('Due trattiene 15%-10%', 50, calcolo.perPr.get(dueId).trattenuto);
    check('Uno trattiene 20%-15%', 50, calcolo.perPr.get(unoId).trattenuto);
    check(
      'La somma di quanto resta a tutti e il costo per l amministrazione, 20% di 1000',
      200,
      calcolo.elenco
        .filter((r) => [cinqueId, quattroId, treId, dueId, unoId].includes(r.id))
        .reduce((s, r) => s + r.trattenuto, 0)
    );

    sezione('Il tetto: non si puo promettere piu di quanto si guadagna');
    const id2 = await tavoli.creaRichiesta(cinqueId, {
      data: fraGiorni(6), nome_tavolo: 'Tavolo B', numero_persone: 2, spesa_prevista: 500
    });
    await respinta(
      'Quattro non puo assegnare a cinque piu del proprio 7%',
      () => revisioni.rivedi({ tavoloId: id2, revisorePrId: quattroId, percentuale: 8 }),
      'ci rimetteresti'
    );
    // Ma puo' assegnargliene meno: e' una scelta legittima, solo per questo tavolo.
    esito = await revisioni.rivedi({
      tavoloId: id2,
      revisorePrId: quattroId,
      percentuale: 3,
      commento: 'Serata fiacca, percentuale ridotta solo per questo tavolo.'
    });
    check('Quattro puo ridurre la percentuale di cinque solo per questo tavolo', 3, esito.percentualeDecisa);
    check('Il profilo di cinque non cambia', 5, (await utenti.getPr(cinqueId)).percentuale_provvigione);

    sezione('Il pavimento: non si puo scendere sotto quanto gia deciso piu in basso');
    await respinta(
      'Tre non puo scendere sotto il 3% gia deciso per cinque',
      () => revisioni.rivedi({ tavoloId: id2, revisorePrId: treId, percentuale: 2 }),
      'perdita'
    );
    esito = await revisioni.rivedi({ tavoloId: id2, revisorePrId: treId, percentuale: 3 });
    check('Tre puo scendere fino al pavimento, non oltre', 3, esito.percentualeDecisa);

    sezione('Riservatezza: il venditore vede solo la propria percentuale, mai i commenti');
    const propria = await revisioni.perSottoposto(id2);
    check('Percentuale visibile a cinque', 3, propria.percentualeDecisa);
    check('Nessun campo commento nella vista del venditore', undefined, propria.commento);
    check(
      'La vista del venditore espone solo i campi previsti',
      true,
      Object.keys(propria).sort().join(',') === 'importo,percentualeDecisa,pressoChi'
    );

    sezione('Chi e sopra vede invece l intero trail, coi commenti');
    const completa = await revisioni.situazione(id2);
    const rigaCinque = completa.righe.find((r) => r.nickname === 'cinque');
    check('Chi puo vedere tutto trova il commento di quattro', 'ok', rigaCinque.passaggio.commento ? 'ok' : 'manca');

    // Si chiude anche questo tavolo, per non lasciarlo a meta': i conteggi
    // delle code piu' avanti devono riflettere una situazione pulita. Mancano
    // ancora due (decide per tre) e uno (decide per due).
    await revisioni.rivedi({ tavoloId: id2, revisorePrId: dueId, percentuale: 10 });
    await revisioni.rivedi({ tavoloId: id2, revisorePrId: unoId, percentuale: 15 });
    await tavoli.approva(id2, 'boss', adminId, 20);
    check('Anche il tavolo B e approvato', 'approvato', (await tavoli.getTavolo(id2)).stato);

    sezione('Un collaboratore disattivato lungo la catena viene saltato da solo');
    await utenti.disattivaPr(treId);
    const id3 = await tavoli.creaRichiesta(cinqueId, {
      data: fraGiorni(7), nome_tavolo: 'Tavolo C', numero_persone: 3, spesa_prevista: 300
    });
    await revisioni.rivedi({ tavoloId: id3, revisorePrId: quattroId, percentuale: 7 });
    t = await tavoli.getTavolo(id3);
    check('Tre e disattivato: si salta direttamente a due', dueId, t.revisione_id);
    const trailSaltato = await revisioni.situazione(id3);
    const rigaQuattro = trailSaltato.righe.find((r) => r.nickname === 'quattro');
    check('Il passaggio di tre e stato completato da solo', true, !!rigaQuattro.passaggio);
    check(
      'Con una nota che spiega perche',
      true,
      /disattivato/.test(rigaQuattro.passaggio.commento || '')
    );
    await utenti.riattivaPr(treId);

    sezione('Riapertura: il trail riparte da zero, non da dove era rimasto');
    esito = await revisioni.rivedi({ tavoloId: id3, revisorePrId: dueId, percentuale: 10 });
    await revisioni.rivedi({ tavoloId: id3, revisorePrId: unoId, percentuale: 15 });
    await tavoli.approva(id3, 'boss', adminId, 20);
    check('Approvato', 'approvato', (await tavoli.getTavolo(id3)).stato);

    await tavoli.riapri(id3, 'boss');
    t = await tavoli.getTavolo(id3);
    check('Torna in attesa', 'in_attesa', t.stato);
    check('Instradato di nuovo verso quattro, non verso due', quattroId, t.revisione_id);
    const trailDopoRiapertura = await revisioni.situazione(id3);
    check(
      'Nessun passaggio precedente sopravvive',
      0,
      trailDopoRiapertura.righe.filter((r) => r.passaggio).length
    );

    sezione('I tavoli in attesa da prima di questo meccanismo vanno dritti in amministrazione');
    const id4 = await run(
      `INSERT INTO tavoli (pr_id, data, nome_tavolo, numero_persone, spesa_prevista, stato)
       VALUES (?, ?, 'Preesistente', 2, 200, 'in_attesa')`,
      [cinqueId, fraGiorni(1)]
    );
    check(
      'Nasce senza instradamento (simula un database precedente)',
      null,
      (await get('SELECT revisione_tipo FROM tavoli WHERE id = ?', [id4.lastID])).revisione_tipo
    );
    const migrati = await revisioni.instradaEsistenti();
    check('Instradato dalla migrazione', 1, migrati);
    const t4 = await tavoli.getTavolo(id4.lastID);
    check('Va dritto in amministrazione, non nel nuovo flusso', 'admin', t4.revisione_tipo);
    check('Verso l amministrazione giusta', adminId, t4.revisione_id);
    check('La migrazione e idempotente', 0, await revisioni.instradaEsistenti());

    sezione('Conteggi per le code');
    check('Coda di due e vuota: ha gia deciso tutto quello che gli spettava', 0, await revisioni.contaCodaPerPr(dueId));
    // Il tavolo C, appena riaperto, e' di nuovo al turno di quattro.
    const inCoda = await revisioni.codaPerPr(quattroId);
    check('Quattro ha in coda il tavolo appena riaperto', 1, inCoda.length);
    check('Ed e proprio il tavolo C', id3, inCoda[0].id);

    const id5 = await utenti.creaPr({
      nome: 'Sei', cognome: 'X', numero_telefono: '3330000006', nickname: 'sei',
      password: 'PasswordSicura1', percentuale_provvigione: 3,
      fk_padre: cinqueId, padre_tipo: 'pr'
    });
    await tavoli.creaRichiesta(id5, {
      data: fraGiorni(8), nome_tavolo: 'Tavolo D', numero_persone: 1, spesa_prevista: 100
    });
    check('Ora cinque ha una richiesta da rivedere', 1, await revisioni.contaCodaPerPr(cinqueId));
  } catch (err) {
    console.error('\nERRORE durante i test:', err);
    process.exitCode = 1;
  } finally {
    const falliti = riepilogo('revisioni.test.js');
    aiuto.pulisci(dbFile);
    process.exit(falliti > 0 || process.exitCode ? 1 : 0);
  }
})();
