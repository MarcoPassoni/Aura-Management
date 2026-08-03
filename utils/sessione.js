// Parametri della sessione, condivisi fra server.js (dove il cookie viene
// configurato), middleware/auth.js (dove si controlla la scadenza assoluta) e
// routes/auth.js (dove la sessione nasce e viene distrutta). Un solo posto da
// cambiare, invece di tre stringhe/numeri ripetuti che potrebbero disallinearsi.

const NOME_COOKIE = 'aura.sid';

/**
 * Finestra di inattivita': quanto puo' restare ferma una sessione prima di
 * scadere. Si rinnova a ogni richiesta (`rolling: true` in server.js), quindi
 * in pratica e' "quanto tempo puo' passare fra un uso e il successivo" prima
 * di dover rifare il login.
 */
const SESSIONE_IDLE_MS =
  Number(process.env.SESSION_IDLE_MS) > 0 ? Number(process.env.SESSION_IDLE_MS) : 8 * 60 * 60 * 1000; // 8 ore

/**
 * Durata massima assoluta di una sessione, indipendente da quanto viene usata.
 *
 * Senza questo limite, un dispositivo usato con regolarita' resta collegato a
 * tempo indeterminato: ogni richiesta rinnova la finestra di inattivita' sopra,
 * quindi la sessione non scade mai da sola. Qui si fissa un tetto assoluto:
 * anche restando attivi tutti i giorni, occorre rifare il login allo scadere
 * di questo intervallo dal momento del login stesso (vedi `creataIl` impostato
 * in routes/auth.js e controllato in middleware/auth.js).
 */
const SESSIONE_MAX_MS =
  Number(process.env.SESSION_MAX_MS) > 0 ? Number(process.env.SESSION_MAX_MS) : 24 * 60 * 60 * 1000; // 24 ore

module.exports = { NOME_COOKIE, SESSIONE_IDLE_MS, SESSIONE_MAX_MS };
