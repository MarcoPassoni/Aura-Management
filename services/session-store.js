// Archivio delle sessioni su SQLite, appoggiato alla connessione gia' aperta
// dall'applicazione.
//
// Con il MemoryStore predefinito di express-session ogni riavvio del server
// disconnetteva tutti gli utenti collegati e la memoria occupata dalle sessioni
// scadute non veniva mai liberata. Restare su disco risolve entrambi i
// problemi: le sessioni sopravvivono a un riavvio e vengono ripulite quando
// scadono.
//
// Sopravvivere a un riavvio pero' non e' sempre quello che si vuole: su
// un server di produzione, ogni riavvio del processo (un deploy, un crash
// recuperato, un intervento manuale) e' un momento naturale in cui forzare
// tutti a ripresentare le credenziali, invece di lasciare sessioni aperte a
// tempo indeterminato che nessuno ricorda piu' di avere. Per questo lo store
// accetta l'opzione `svuotaAllAvvio`: quando attiva, la tabella delle sessioni
// viene azzerata una volta, al momento della creazione dello store. La
// decisione se attivarla o no (tipicamente: si in produzione, no in sviluppo,
// dove disconnettere a ogni riavvio di nodemon sarebbe solo un fastidio)
// spetta a chi crea lo store, in server.js.

const { run, get, all } = require('./db-helpers');
const { logger } = require('../utils/secure-logger');

module.exports = function creaSessionStore(session) {
  const Store = session.Store;

  class SqliteStore extends Store {
    constructor(opzioni = {}) {
      super(opzioni);
      this.tabella = 'sessioni';
      this.svuotaAllAvvio = !!opzioni.svuotaAllAvvio;
      // Ogni tanto si ripuliscono le sessioni scadute: senza questa pulizia la
      // tabella cresce indefinitamente.
      this.intervalloPulizia = opzioni.intervalloPulizia || 60 * 60 * 1000;
      this.pronto = this._prepara();

      this.timer = setInterval(() => {
        this.pulisci().catch(() => {});
      }, this.intervalloPulizia);
      // Il timer non deve impedire al processo di terminare.
      if (this.timer.unref) this.timer.unref();
    }

    async _prepara() {
      await run(`CREATE TABLE IF NOT EXISTS ${this.tabella} (
        sid TEXT PRIMARY KEY,
        scadenza INTEGER NOT NULL,
        dati TEXT NOT NULL
      )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_sessioni_scadenza ON ${this.tabella}(scadenza)`);

      if (this.svuotaAllAvvio) {
        const rimosse = await this.svuotaTutto();
        logger.info(`Sessioni precedenti invalidate: nuovo avvio del processo.`, {
          categoria: 'sessioni',
          sessioniRimosse: rimosse
        });
      } else {
        await this.pulisci();
      }
    }

    _scadenza(sess) {
      if (sess && sess.cookie && sess.cookie.expires) {
        return new Date(sess.cookie.expires).getTime();
      }
      const durata = (sess && sess.cookie && sess.cookie.originalMaxAge) || 8 * 60 * 60 * 1000;
      return Date.now() + durata;
    }

    get(sid, callback) {
      this.pronto
        .then(() => get(`SELECT dati, scadenza FROM ${this.tabella} WHERE sid = ?`, [sid]))
        .then((riga) => {
          if (!riga) return callback(null, null);
          if (riga.scadenza < Date.now()) {
            // Scaduta: la si rimuove e si risponde come se non esistesse.
            return run(`DELETE FROM ${this.tabella} WHERE sid = ?`, [sid])
              .then(() => callback(null, null))
              .catch(() => callback(null, null));
          }
          try {
            return callback(null, JSON.parse(riga.dati));
          } catch (err) {
            return callback(null, null);
          }
        })
        .catch((err) => callback(err));
    }

    set(sid, sess, callback) {
      let dati;
      try {
        dati = JSON.stringify(sess);
      } catch (err) {
        return callback(err);
      }
      this.pronto
        .then(() =>
          run(
            `INSERT INTO ${this.tabella} (sid, scadenza, dati) VALUES (?, ?, ?)
             ON CONFLICT(sid) DO UPDATE SET scadenza = excluded.scadenza, dati = excluded.dati`,
            [sid, this._scadenza(sess), dati]
          )
        )
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    touch(sid, sess, callback) {
      this.pronto
        .then(() =>
          run(`UPDATE ${this.tabella} SET scadenza = ? WHERE sid = ?`, [this._scadenza(sess), sid])
        )
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    destroy(sid, callback) {
      this.pronto
        .then(() => run(`DELETE FROM ${this.tabella} WHERE sid = ?`, [sid]))
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    length(callback) {
      this.pronto
        .then(() => get(`SELECT COUNT(*) AS n FROM ${this.tabella}`))
        .then((r) => callback(null, r ? r.n : 0))
        .catch((err) => callback(err));
    }

    clear(callback) {
      this.pronto
        .then(() => run(`DELETE FROM ${this.tabella}`))
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    all(callback) {
      this.pronto
        .then(() => all(`SELECT sid, dati FROM ${this.tabella} WHERE scadenza >= ?`, [Date.now()]))
        .then((righe) => {
          const sessioni = {};
          for (const r of righe) {
            try {
              sessioni[r.sid] = JSON.parse(r.dati);
            } catch (_) {
              /* una sessione illeggibile non deve far fallire le altre */
            }
          }
          callback(null, sessioni);
        })
        .catch((err) => callback(err));
    }

    pulisci() {
      return run(`DELETE FROM ${this.tabella} WHERE scadenza < ?`, [Date.now()]);
    }

    /** Rimuove TUTTE le sessioni, scadute o no. Restituisce quante ne ha rimosse. */
    async svuotaTutto() {
      const prima = await get(`SELECT COUNT(*) AS n FROM ${this.tabella}`);
      await run(`DELETE FROM ${this.tabella}`);
      return prima ? prima.n : 0;
    }
  }

  return SqliteStore;
};
