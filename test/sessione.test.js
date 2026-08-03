// Verifica della gestione delle sessioni e del logger.
//   npm run test:sessione
//
// Copre:
//  - lo store SQLite mantiene le sessioni fra un riavvio e l'altro quando
//    non gli viene chiesto di svuotarsi, e le cancella tutte quando si;
//  - il controllo di accesso nega la sessione che ha superato la durata
//    massima assoluta, distinguendolo da chi non e' mai stato collegato;
//  - il logger non lancia mai, nemmeno per chi lo chiama senza una richiesta.

const aiuto = require('./aiuto');
const dbFile = aiuto.preparaDatabase('sessione');

const session = require('express-session');
const { run, get } = require('../services/db-helpers');
const creaSessionStore = require('../services/session-store');
const auth = require('../middleware/auth');
const { NOME_COOKIE, SESSIONE_MAX_MS } = require('../utils/sessione');
const { logger, logSecurityEvent, logAzione } = require('../utils/secure-logger');

const { check, sezione, riepilogo } = aiuto.creaVerificatore();

const SqliteStore = creaSessionStore(session);

function nuovoStore(opzioni) {
  const store = new SqliteStore(opzioni);
  return store.pronto.then(() => store);
}

/** Simula una richiesta con o senza sessione, per testare i middleware senza un server HTTP. */
function fintaRichiesta({ cookie = false, user = null, creataIl = null } = {}) {
  const risposte = { redirect: null, statusJson: null, bodyJson: null, cookieRimosso: null };
  const req = {
    session: user
      ? {
          user,
          creataIl,
          destroy(cb) {
            req.session.distrutta = true;
            cb();
          }
        }
      : null,
    cookies: cookie ? { [NOME_COOKIE]: 'abc123' } : {},
    headers: {},
    xhr: false
  };
  const res = {
    redirect(url) {
      risposte.redirect = url;
    },
    status(codice) {
      risposte.statusJson = codice;
      return res;
    },
    json(corpo) {
      risposte.bodyJson = corpo;
      return res;
    },
    clearCookie(nome) {
      risposte.cookieRimosso = nome;
    },
    render() {
      return res;
    }
  };
  return { req, res, risposte };
}

(async () => {
  try {
    sezione('Lo store persiste le sessioni fra un riavvio e l\'altro, se non gli si chiede di svuotarsi');
    let store = await nuovoStore({});
    await run(
      `INSERT INTO sessioni (sid, scadenza, dati) VALUES (?, ?, ?)`,
      ['sid-1', Date.now() + 3_600_000, JSON.stringify({ user: { id: 1 } })]
    );
    const dopoInserimento = await get('SELECT COUNT(*) AS n FROM sessioni');
    check('La sessione e stata scritta', 1, dopoInserimento.n);

    // "Riavvio" senza svuotamento: un nuovo store sulla stessa tabella non
    // deve toccare le righe esistenti.
    store = await nuovoStore({ svuotaAllAvvio: false });
    const dopoRiavvioSenzaSvuotamento = await get('SELECT COUNT(*) AS n FROM sessioni');
    check('Senza svuotaAllAvvio la sessione sopravvive', 1, dopoRiavvioSenzaSvuotamento.n);

    sezione('Con svuotaAllAvvio attivo, un nuovo avvio invalida tutte le sessioni precedenti');
    store = await nuovoStore({ svuotaAllAvvio: true });
    const dopoRiavvioConSvuotamento = await get('SELECT COUNT(*) AS n FROM sessioni');
    check('Con svuotaAllAvvio la sessione precedente sparisce', 0, dopoRiavvioConSvuotamento.n);

    // Lo svuotamento e' un'operazione singola all'avvio, non un comportamento
    // permanente dello store: una sessione scritta DOPO deve restare.
    await run(
      `INSERT INTO sessioni (sid, scadenza, dati) VALUES (?, ?, ?)`,
      ['sid-2', Date.now() + 3_600_000, JSON.stringify({ user: { id: 2 } })]
    );
    const dopoScritturaSuccessiva = await get('SELECT COUNT(*) AS n FROM sessioni');
    check('Una sessione scritta dopo l\'avvio non viene toccata', 1, dopoScritturaSuccessiva.n);

    sezione('Nessuna sessione: si va al login, senza indicazioni fuorvianti');
    let f = fintaRichiesta({ cookie: false });
    auth.requireLogin(f.req, f.res, () => {
      throw new Error('non doveva proseguire');
    });
    check('Reindirizza al login', '/login', f.risposte.redirect);

    sezione('Cookie presente ma nessuna sessione valida: si segnala che la sessione precedente e\' scaduta');
    f = fintaRichiesta({ cookie: true });
    auth.requireLogin(f.req, f.res, () => {
      throw new Error('non doveva proseguire');
    });
    check('Reindirizza al login con il motivo', '/login?motivo=scaduta', f.risposte.redirect);

    sezione('Sessione valida, entro la durata massima: passa');
    let passato = false;
    f = fintaRichiesta({
      user: { id: 1, ruolo: 'admin', nickname: 'boss' },
      creataIl: Date.now() - 1000 // un secondo fa
    });
    auth.requireLogin(f.req, f.res, () => {
      passato = true;
    });
    check('Prosegue', true, passato);
    check('Nessun redirect', null, f.risposte.redirect);

    sezione('Sessione oltre la durata massima assoluta: viene distrutta anche se il resto e\' valido');
    passato = false;
    f = fintaRichiesta({
      user: { id: 1, ruolo: 'admin', nickname: 'boss' },
      creataIl: Date.now() - (SESSIONE_MAX_MS + 60_000) // un minuto oltre il limite
    });
    auth.requireLogin(f.req, f.res, () => {
      passato = true;
    });
    check('Non prosegue', false, passato);
    check('La sessione viene distrutta', true, f.req.session.distrutta);
    check('Il cookie viene rimosso', NOME_COOKIE, f.risposte.cookieRimosso);
    check('Reindirizza segnalando la scadenza', '/login?motivo=scaduta', f.risposte.redirect);

    sezione('requireAdmin e requirePr si appoggiano allo stesso controllo');
    passato = false;
    f = fintaRichiesta({
      user: { id: 1, ruolo: 'pr', nickname: 'marco' },
      creataIl: Date.now()
    });
    auth.requireAdmin(f.req, f.res, () => {
      passato = true;
    });
    check('Un PR non entra nelle pagine admin', false, passato);

    passato = false;
    f = fintaRichiesta({
      user: { id: 1, ruolo: 'admin', nickname: 'boss' },
      creataIl: Date.now() - (SESSIONE_MAX_MS + 60_000)
    });
    auth.requireAdmin(f.req, f.res, () => {
      passato = true;
    });
    check('requireAdmin applica anche la scadenza assoluta', false, passato);
    check('E distrugge la sessione', true, f.req.session.distrutta);

    sezione('Il logger non lancia mai');
    let esploso = false;
    try {
      logger.info('verifica del logger', { categoria: 'test' });
      logSecurityEvent('evento_di_prova', { dettaglio: 1 });
      logAzione('azione_di_prova', { dettaglio: 2 });
      logSecurityEvent('evento_con_richiesta', { dettaglio: 3 }, { method: 'GET', originalUrl: '/x', headers: {} });
    } catch (err) {
      esploso = true;
    }
    check('Nessuna eccezione dal logger', false, esploso);
  } catch (err) {
    console.error('\nERRORE durante i test:', err);
    process.exitCode = 1;
  } finally {
    const falliti = riepilogo('sessione.test.js');
    aiuto.pulisci(dbFile);
    process.exit(falliti > 0 || process.exitCode ? 1 : 0);
  }
})();
