// Verifica del motore provvigioni su scenari a risultato noto.
//   npm run test:calc

const aiuto = require('./aiuto');
const dbFile = aiuto.preparaDatabase('calcoli');

const { run } = require('../services/db-helpers');
const schema = require('../models/schema');
const quote = require('../services/quote');
const denaro = require('../services/denaro');
const {
  computeCommissions,
  computeAdminEconomics,
  andamentoFatturato
} = require('../services/commissions');
const settings = require('../services/settings');

const { check, respinta, sezione, riepilogo } = aiuto.creaVerificatore();

// Admin con id 7: volutamente diverso da 1, per verificare che non ci siano
// riferimenti impliciti all'amministratore numero 1 come nell'originale.
const ADMIN = 7;

/**
 * Date relative a oggi. Le date fisse renderebbero il risultato dipendente dal
 * giorno in cui si eseguono i test: le finestre temporali ("ultimi 12 mesi")
 * scorrono, e una verifica che passa oggi fallirebbe l'anno prossimo.
 */
function meseFa(quanti, giorno = 15) {
  const oggi = new Date();
  const d = new Date(Date.UTC(oggi.getUTCFullYear(), oggi.getUTCMonth() - quanti, giorno));
  return d.toISOString().slice(0, 10);
}

async function seed() {
  await run(
    `INSERT INTO admin (id, nome, cognome, numero_telefono, nickname, password)
     VALUES (?, 'Boss', 'X', '3330000000', 'boss', 'hash')`,
    [ADMIN]
  );

  const pr = (id, padre, padreTipo, nome, nick, perc) =>
    run(
      `INSERT INTO pr (id, fk_padre, padre_tipo, nome, cognome, numero_telefono,
                       nickname, password, percentuale_provvigione)
       VALUES (?, ?, ?, ?, 'X', '3330000000', ?, 'hash', ?)`,
      [id, padre, padreTipo, nome, nick, perc]
    );

  // Catena: sara (12%) -> luca (8%) -> marco (5%)
  await pr(100, ADMIN, 'admin', 'Sara', 'sara', 12);
  await pr(101, 100, 'pr', 'Luca', 'luca', 8);
  await pr(102, 101, 'pr', 'Marco', 'marco', 5);
}

/** Inserisce un tavolo gia' approvato, congelando la catena come fa l'applicazione. */
async function tavoloApprovato(prId, data, persone, nome, spesa, incasso = null) {
  const r = await run(
    `INSERT INTO tavoli (pr_id, data, nome_tavolo, numero_persone, spesa_prevista,
                         incasso_effettivo, stato)
     VALUES (?, ?, ?, ?, ?, ?, 'approvato')`,
    [prId, data, nome, persone, spesa, incasso]
  );
  await quote.congela(r.lastID, prId);
  return r.lastID;
}

(async () => {
  try {
    await schema.initSchema({ silenzioso: true });
    await seed();

    // Marco vende 1000 quattro mesi fa, Sara 2000 di suo.
    await tavoloApprovato(102, meseFa(4, 10), 6, 'Sala 1 - 1', 1000);
    await tavoloApprovato(100, meseFa(4, 12), 4, 'Sala 1 - 2', 2000);

    sezione('Modello differenziale su una catena di tre livelli');
    let c = await computeCommissions({ adminId: ADMIN });
    const marco = c.perPr.get(102);
    const luca = c.perPr.get(101);
    const sara = c.perPr.get(100);

    check('Marco: incasso proprio', 1000, marco.fatturatoDiretto);
    check('Marco: gli spetta il 5% di 1000', 50, marco.maturato);
    check('Marco non gira niente a nessuno', 0, marco.giratoAiCollaboratori);
    check('Marco trattiene tutto il suo', 50, marco.trattenuto);

    check('Luca: incasso della sua struttura', 1000, luca.fatturatoSottoalbero);
    check('Luca: gli spetta l 8% di 1000', 80, luca.maturato);
    check('Luca gira 50 a Marco', 50, luca.giratoAiCollaboratori);
    check('Luca trattiene la differenza 8%-5%', 30, luca.trattenuto);

    check('Sara: incasso della sua struttura', 3000, sara.fatturatoSottoalbero);
    check('Sara: le spetta il 12% di 3000', 360, sara.maturato);
    check('Sara gira 80 a Luca', 80, sara.giratoAiCollaboratori);
    check('Sara trattiene 360-80', 280, sara.trattenuto);

    check('Il debitore di Marco e Luca', 'luca', marco.debitori[0].nome);
    check('Il debitore di Sara e l amministrazione', 'admin', sara.debitori[0].tipo);

    sezione('Cio che resta a tutti e esattamente il costo per l amministrazione');
    const sommaTrattenuto = c.elenco.reduce((s, r) => s + r.trattenuto, 0);
    let econ = await computeAdminEconomics({ adminId: ADMIN });
    check('Costo provvigioni', 360, econ.totali.costoProvvigioni);
    check('Somma dei trattenuti = costo provvigioni', 360, sommaTrattenuto);
    check('Incasso contato una volta sola', 3000, econ.totali.incassoTotale);
    check('Tavoli contati una volta sola', 2, econ.totali.tavoli);
    check('Persone contate una volta sola', 10, econ.totali.persone);

    sezione('Conto economico dell amministrazione');
    // Predefiniti: quota locale 85%, detrazioni 20+15+15 = 50%.
    check('Quota locale, 85% di 3000', 2550, econ.totali.quotaLocale);
    check('Margine disponibile', 450, econ.totali.margineLordo);
    check('Guadagno lordo, 450 meno 360', 90, econ.totali.guadagnoLordo);
    check('Detrazioni, 50% di 90', 45, econ.totali.totaleDetrazioni);
    check('Guadagno netto', 45, econ.totali.guadagnoNetto);

    sezione('Le percentuali sono congelate: cambiarle non tocca il passato');
    await run('UPDATE pr SET percentuale_provvigione = 30 WHERE id = 102');
    c = await computeCommissions({ adminId: ADMIN });
    check('Marco: il maturato non cambia', 50, c.perPr.get(102).maturato);
    check('Marco: la percentuale mostrata e quella nuova', 30, c.perPr.get(102).percentuale);
    check('Marco: la percentuale applicata resta 5', 5, c.perPr.get(102).percentualeApplicataMin);
    check('Luca: continua a girargli 50', 50, c.perPr.get(101).giratoAiCollaboratori);
    econ = await computeAdminEconomics({ adminId: ADMIN });
    check('Il costo per l amministrazione non cambia', 360, econ.totali.costoProvvigioni);

    sezione('Un tavolo nuovo usa invece la percentuale aggiornata');
    await run('UPDATE pr SET percentuale_provvigione = 6 WHERE id = 102');
    await tavoloApprovato(102, meseFa(2, 20), 2, 'Sala 1 - 3', 1000);
    c = await computeCommissions({ adminId: ADMIN });
    check('Marco: 50 sul vecchio piu 60 sul nuovo', 110, c.perPr.get(102).maturato);
    check('Marco: percentuale minima applicata 5', 5, c.perPr.get(102).percentualeApplicataMin);
    check('Marco: percentuale massima applicata 6', 6, c.perPr.get(102).percentualeApplicataMax);

    sezione('L incasso reale sostituisce il preventivo');
    await tavoloApprovato(102, meseFa(1, 1), 3, 'Gabbia 1', 1000, 1500);
    c = await computeCommissions({ adminId: ADMIN });
    check('Marco: il 6% calcolato su 1500, non su 1000', 200, c.perPr.get(102).maturato);
    econ = await computeAdminEconomics({ adminId: ADMIN });
    check('Incasso totale con il consuntivo', 5500, econ.totali.incassoTotale);

    sezione('Filtro di periodo');
    const primoDelMeseScorso = meseFa(1, 1);
    const ultimoDelMeseScorso = meseFa(1, 28);
    c = await computeCommissions({
      adminId: ADMIN,
      from: primoDelMeseScorso,
      to: ultimoDelMeseScorso
    });
    check('Solo il tavolo del mese scorso', 1500, c.perPr.get(102).fatturatoDiretto);
    check('Con un periodo selezionato il saldo non viene mostrato', null, c.perPr.get(102).saldo);
    check('Il periodo risulta filtrato', true, c.periodoFiltrato);

    sezione('Arrotondamenti: i totali sono sempre la somma delle righe');
    // Percentuali e importi scelti per produrre frazioni di centesimo.
    await run(
      `INSERT INTO pr (id, fk_padre, padre_tipo, nome, cognome, numero_telefono,
                       nickname, password, percentuale_provvigione)
       VALUES (200, ?, 'admin', 'Ada', 'X', '3330000000', 'ada', 'hash', 7.33)`,
      [ADMIN]
    );
    await run(
      `INSERT INTO pr (id, fk_padre, padre_tipo, nome, cognome, numero_telefono,
                       nickname, password, percentuale_provvigione)
       VALUES (201, 200, 'pr', 'Bea', 'X', '3330000000', 'bea', 'hash', 3.17)`
    );
    for (let i = 1; i <= 7; i++) {
      await tavoloApprovato(201, meseFa(3, i), 2, `Prive ${i}`, 333.33);
    }
    c = await computeCommissions({ adminId: ADMIN });
    const ada = c.perPr.get(200);
    const bea = c.perPr.get(201);
    check('Il girato di Ada coincide con lo spettante di Bea', bea.maturato, ada.giratoAiCollaboratori);
    check(
      'Spettante = trattenuto + girato, al centesimo',
      ada.maturato,
      Math.round((ada.trattenuto + ada.giratoAiCollaboratori) * 100) / 100
    );

    econ = await computeAdminEconomics({ adminId: ADMIN });
    const sommaFinale = c.elenco.reduce((s, r) => s + r.trattenuto, 0);
    check(
      'Con centesimi scomodi, somma dei trattenuti = costo provvigioni',
      econ.totali.costoProvvigioni,
      Math.round(sommaFinale * 100) / 100
    );

    sezione('Aritmetica monetaria');
    check('Arrotondamento al centesimo', 12.35, denaro.arrotonda(12.345));
    check('Mezzo centesimo si allontana dallo zero', -12.35, denaro.arrotonda(-12.345));
    check('Quota del 7.33% su 333.33 in centesimi', 2443, denaro.quotaCentesimi(33333, 7.33));
    check('Un valore non numerico vale zero', 0, denaro.arrotonda('non un numero'));
    check('Zero resta zero', 0, denaro.aEuro(0));

    sezione('Andamento mensile');
    const andamento = await andamentoFatturato([102], 12);
    check('Marco ha attivita in tre mesi distinti', 3, andamento.length);
    check(
      'La somma dell andamento e il suo incasso diretto',
      c.perPr.get(102).fatturatoDiretto,
      Math.round(andamento.reduce((s, m) => s + m.fatturato, 0) * 100) / 100
    );

    sezione('Catene non risolvibili');
    await run(
      `INSERT INTO pr (id, fk_padre, padre_tipo, nome, cognome, numero_telefono,
                       nickname, password, percentuale_provvigione)
       VALUES (300, 999, 'pr', 'Orfano', 'X', '3330000000', 'orfano', 'hash', 5)`
    );
    await respinta(
      'Risolvere la catena di un collaboratore senza responsabile',
      () => quote.catenaDi(300),
      'non ha un responsabile valido'
    );

    await run(
      `INSERT INTO pr (id, fk_padre, padre_tipo, nome, cognome, numero_telefono,
                       nickname, password, percentuale_provvigione)
       VALUES (401, 300, 'pr', 'Anello', 'X', '3330000000', 'anello', 'hash', 5)`
    );
    await run("UPDATE pr SET fk_padre = 401, padre_tipo = 'pr' WHERE id = 300");
    await respinta('Risolvere una catena che si chiude ad anello', () => quote.catenaDi(300), 'ciclo');

    sezione('Impostazioni economiche');
    await settings.setQuotaLocale(ADMIN, 80);
    econ = await computeAdminEconomics({ adminId: ADMIN });
    check('La quota locale modificata cambia il margine', 20, econ.impostazioni.quotaAdmin);
    await respinta(
      'Detrazioni che superano il 100%',
      () =>
        settings.salvaDetrazioni(ADMIN, [
          { nome: 'A', percentuale: 60 },
          { nome: 'B', percentuale: 50 }
        ]),
      'non possono superare'
    );
  } catch (err) {
    console.error('\nERRORE durante i test:', err);
    process.exitCode = 1;
  } finally {
    const falliti = riepilogo('commissions.test.js');
    aiuto.pulisci(dbFile);
    process.exit(falliti > 0 || process.exitCode ? 1 : 0);
  }
})();
