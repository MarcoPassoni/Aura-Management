// Verifica dei controlli di integrita', dello spostamento dei collaboratori,
// del recupero dei tavoli approvati prima delle quote e della protezione CSRF.
//   npm run test:integrita

const aiuto = require('./aiuto');
const dbFile = aiuto.preparaDatabase('integrita');

const { run, get } = require('../services/db-helpers');
const schema = require('../models/schema');
const quote = require('../services/quote');
const utenti = require('../services/users');
const tavoli = require('../services/tavoli');
const pagamenti = require('../services/pagamenti');
const revisioni = require('../services/revisioni');
const diagnostica = require('../services/diagnostica');
const { loadHierarchy } = require('../services/hierarchy');
const { computeCommissions } = require('../services/commissions');
const { csrf, rinnova } = require('../middleware/csrf');

const { check, respinta, sezione, riepilogo } = aiuto.creaVerificatore();

function fraGiorni(quanti) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + quanti);
  return d.toISOString().slice(0, 10);
}

(async () => {
  let adminId;
  let saraId;
  let marcoId;
  let lucaId;

  try {
    await schema.initSchema({ silenzioso: true });

    adminId = await utenti.creaAdmin({
      nome: 'Boss',
      cognome: 'Rossi',
      numero_telefono: '3330000000',
      nickname: 'boss',
      password: 'PasswordSicura1'
    });
    saraId = await utenti.creaPr({
      nome: 'Sara', cognome: 'B', numero_telefono: '3331111111', nickname: 'sara',
      password: 'PasswordSicura1', percentuale_provvigione: 12,
      fk_padre: adminId, padre_tipo: 'admin'
    });
    lucaId = await utenti.creaPr({
      nome: 'Luca', cognome: 'C', numero_telefono: '3333333333', nickname: 'luca',
      password: 'PasswordSicura1', percentuale_provvigione: 10,
      fk_padre: adminId, padre_tipo: 'admin'
    });
    marcoId = await utenti.creaPr({
      nome: 'Marco', cognome: 'V', numero_telefono: '3332222222', nickname: 'marco',
      password: 'PasswordSicura1', percentuale_provvigione: 5,
      fk_padre: saraId, padre_tipo: 'pr'
    });

    // ------------------------------------------------------------------
    sezione('Recupero dei tavoli approvati prima delle quote congelate');
    // Si simula un database preesistente: tavolo approvato scritto direttamente,
    // senza passare dal servizio, quindi senza ripartizione.
    const vecchio = await run(
      `INSERT INTO tavoli (pr_id, data, nome_tavolo, numero_persone, spesa_prevista, stato)
       VALUES (?, ?, 'Storico', 4, 1000, 'approvato')`,
      [marcoId, fraGiorni(-40)]
    );
    check('Prima del recupero il tavolo e escluso', 1, (await quote.tavoliSenzaQuote()).length);

    let c = await computeCommissions({ adminId });
    check('Un tavolo senza ripartizione non conta', 0, c.perPr.get(marcoId).maturato);

    const recupero = await quote.ricostruisciMancanti();
    check('Un tavolo ricostruito', 1, recupero.ricostruiti);
    check('Nessun fallimento', 0, recupero.falliti.length);
    check('Dopo il recupero non resta nulla di escluso', 0, (await quote.tavoliSenzaQuote()).length);

    c = await computeCommissions({ adminId });
    check('Ora Marco matura il 5% di 1000', 50, c.perPr.get(marcoId).maturato);
    check('Il recupero e idempotente', 0, (await quote.ricostruisciMancanti()).ricostruiti);

    // ------------------------------------------------------------------
    sezione('Spostamento di un collaboratore');
    let gerarchia = await loadHierarchy();
    check(
      'Non si puo mettere qualcuno sotto un proprio discendente',
      false,
      gerarchia.puoSpostare(saraId, { tipo: 'pr', id: marcoId }).ok
    );
    check(
      'Non si puo essere responsabili di se stessi',
      false,
      gerarchia.puoSpostare(marcoId, { tipo: 'pr', id: marcoId }).ok
    );
    check(
      'Non si puo passare sotto chi ha una percentuale piu bassa',
      false,
      gerarchia.puoSpostare(saraId, { tipo: 'pr', id: lucaId }).ok
    );
    check(
      'Spostare Marco sotto Luca e consentito',
      true,
      gerarchia.puoSpostare(marcoId, { tipo: 'pr', id: lucaId }).ok
    );

    // Il debito gia' maturato resta a carico di chi era responsabile allora.
    await utenti.aggiornaPr(marcoId, { fk_padre: lucaId, padre_tipo: 'pr' });
    c = await computeCommissions({ adminId });
    const marcoDopo = c.perPr.get(marcoId);
    check('Il maturato di Marco non cambia', 50, marcoDopo.maturato);
    check('Il debito resta di un solo soggetto', 1, marcoDopo.debitori.length);
    check('E resta Sara, non Luca', 'sara', marcoDopo.debitori[0].nome);
    check('Il responsabile di oggi e invece Luca', 'luca', marcoDopo.debitoreCorrente.nome);
    check('Sara continua a dover girare la sua quota', 50, c.perPr.get(saraId).giratoAiCollaboratori);

    // Un tavolo nuovo maturera' invece verso Luca, che ora e' il suo
    // responsabile diretto: e' lui a doverlo rivedere per primo.
    const nuovo = await tavoli.creaRichiesta(marcoId, {
      data: fraGiorni(2),
      nome_tavolo: 'Sala 1 - 9',
      numero_persone: 2,
      spesa_prevista: 1000
    });
    const nuovoTavolo = await tavoli.getTavolo(nuovo);
    check('La richiesta e instradata verso il nuovo responsabile', lucaId, nuovoTavolo.revisione_id);
    await revisioni.rivedi({ tavoloId: nuovo, revisorePrId: lucaId, percentuale: 5 });
    await tavoli.approva(nuovo, 'boss', adminId);
    c = await computeCommissions({ adminId });
    check('Ora Marco ha due debitori distinti', 2, c.perPr.get(marcoId).debitori.length);
    check('Marco ha maturato 100 in tutto', 100, c.perPr.get(marcoId).maturato);

    await respinta(
      'Sara non puo pagare la parte maturata sotto Luca',
      () =>
        pagamenti.registra({
          destinatarioId: marcoId,
          paganteTipo: 'pr',
          paganteId: saraId,
          importo: 100
        }),
      'supera il dovuto'
    );

    // ------------------------------------------------------------------
    sezione('Controlli di integrita');
    let esito = await diagnostica.verifica(adminId);
    check('Nessun problema in una struttura sana', true, esito.tuttoOk);

    // Si crea uno scoperto forzando i dati, come farebbe un intervento manuale.
    await run(
      `INSERT INTO pagamenti_provvigioni
         (pr_destinatario_id, pagante_tipo, pagante_id, importo)
       VALUES (?, 'pr', ?, 999)`,
      [marcoId, saraId]
    );
    esito = await diagnostica.verifica(adminId);
    check('Il pagamento in eccesso viene rilevato', false, esito.tuttoOk);
    check(
      'Ed e classificato come bloccante',
      true,
      esito.conVoci.some((v) => v.id === 'eccedenze' && v.gravita === 'bloccante')
    );
    await run('DELETE FROM pagamenti_provvigioni WHERE importo = 999');

    // Tavolo approvato con catena rotta.
    const orfano = await utenti.creaPr({
      nome: 'Orfa', cognome: 'N', numero_telefono: '3339999999', nickname: 'orfano',
      password: 'PasswordSicura1', percentuale_provvigione: 5,
      fk_padre: saraId, padre_tipo: 'pr'
    });
    await run(
      `INSERT INTO tavoli (pr_id, data, nome_tavolo, numero_persone, spesa_prevista, stato)
       VALUES (?, ?, 'Rotto', 2, 500, 'approvato')`,
      [orfano, fraGiorni(-5)]
    );
    await run('UPDATE pr SET fk_padre = 99999 WHERE id = ?', [orfano]);

    const recupero2 = await quote.ricostruisciMancanti();
    check('Il tavolo con catena rotta non viene inventato', 0, recupero2.ricostruiti);
    check('E viene segnalato come fallito', 1, recupero2.falliti.length);

    esito = await diagnostica.verifica(adminId);
    check(
      'La verifica elenca i tavoli esclusi dai calcoli',
      true,
      esito.conVoci.some((v) => v.id === 'tavoli-senza-quote')
    );
    check('Il contatore per la barra li conta', 1, await diagnostica.contaBloccanti());

    // ------------------------------------------------------------------
    sezione('Protezione CSRF');
    const sessione = {};
    const risposte = [];
    function finto(metodo, corpo, sess) {
      return {
        req: {
          method: metodo,
          body: corpo,
          session: sess,
          originalUrl: '/prova',
          headers: {},
          get: () => undefined
        },
        res: {
          locals: {},
          status(codice) {
            risposte.push(codice);
            return this;
          },
          json() {
            return this;
          },
          render() {
            return this;
          }
        }
      };
    }

    let passato = false;
    let f = finto('GET', {}, sessione);
    csrf(f.req, f.res, () => {
      passato = true;
    });
    check('Una GET passa e riceve un token', true, passato && !!f.res.locals.csrf);
    const token = f.res.locals.csrf;

    passato = false;
    f = finto('POST', { _csrf: token }, sessione);
    csrf(f.req, f.res, () => {
      passato = true;
    });
    check('Una POST con il token corretto passa', true, passato);

    passato = false;
    f = finto('POST', { _csrf: 'sbagliato' }, sessione);
    csrf(f.req, f.res, () => {
      passato = true;
    });
    check('Una POST con token errato viene respinta', false, passato);
    check('Con codice 403', 403, risposte[risposte.length - 1]);

    passato = false;
    f = finto('POST', {}, sessione);
    csrf(f.req, f.res, () => {
      passato = true;
    });
    check('Una POST senza token viene respinta', false, passato);

    const vecchioToken = sessione.csrf;
    rinnova({ session: sessione });
    check('Il rinnovo cambia il token', true, sessione.csrf !== vecchioToken);

    passato = false;
    f = finto('POST', { _csrf: vecchioToken }, sessione);
    csrf(f.req, f.res, () => {
      passato = true;
    });
    check('Il token vecchio non vale piu', false, passato);

    // ------------------------------------------------------------------
    sezione('Vincoli del database realmente applicati');
    await respinta(
      'Un pagamento verso un collaboratore inesistente',
      () =>
        run(
          `INSERT INTO pagamenti_provvigioni (pr_destinatario_id, pagante_tipo, pagante_id, importo)
           VALUES (99999, 'admin', 1, 10)`
        ),
      'FOREIGN KEY'
    );
    await respinta(
      'Un importo di pagamento negativo',
      () =>
        run(
          `INSERT INTO pagamenti_provvigioni (pr_destinatario_id, pagante_tipo, pagante_id, importo)
           VALUES (?, 'admin', ?, -5)`,
          [marcoId, adminId]
        ),
      'CHECK'
    );
    const pragma = await get('PRAGMA foreign_keys');
    check('I vincoli di integrita sono attivi', 1, pragma ? pragma.foreign_keys : 0);
  } catch (err) {
    console.error('\nERRORE durante i test:', err);
    process.exitCode = 1;
  } finally {
    const falliti = riepilogo('integrita.test.js');
    aiuto.pulisci(dbFile);
    process.exit(falliti > 0 || process.exitCode ? 1 : 0);
  }
})();
