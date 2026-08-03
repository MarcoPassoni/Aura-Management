// Sistema di log dell'applicazione.
//
// PERCHE' QUESTO FILE E' STATO RISCRITTO
//
// Il logger scriveva sulla console SOLO quando `NODE_ENV !== 'production'`:
//
//     if (process.env.NODE_ENV !== 'production') {
//       logger.add(new winston.transports.Console(...));
//     }
//
// Su Railway (come su qualunque piattaforma che legge i log dallo stdout del
// processo) `NODE_ENV` vale `production`: quella riga disattivava la console
// esattamente dove serviva vederla. I log finivano solo su file dentro il
// container, che e' effimero e non consultabile da un pannello come quello di
// Railway. Il sintomo era "non vedo niente nei log", ed era corretto: non
// c'era davvero niente scritto sullo standard output.
//
// Ora la console e' SEMPRE attiva: e' il canale principale, non quello di
// riserva per lo sviluppo. I file restano come archivio locale aggiuntivo, e
// se per qualsiasi motivo non si possono scrivere (permessi, filesystem in
// sola lettura) l'applicazione non si blocca: continua a loggare su console e
// basta.
//
// COSA VIENE LOGGATO
//
//  - ogni richiesta HTTP gestita (vedi il middleware in server.js);
//  - ogni evento di autenticazione: login riuscito o fallito, logout,
//    sessione scaduta, token anti-CSRF rifiutato;
//  - ogni operazione che modifica dati (creazione di un collaboratore,
//    approvazione di un tavolo, un pagamento, ...) tramite `logAzione`,
//    cosi' si puo' ricostruire chi ha fatto cosa e quando;
//  - ogni errore non previsto, con lo stack completo;
//  - l'avvio e lo spegnimento del processo.
//
// FORMATO
//
// Su console il formato e' pensato per essere letto da una persona mentre
// scorre il terminale: una riga per evento, timestamp, livello, identificativo
// dell'avvio del processo (vedi utils/avvio.js), categoria fra parentesi
// quadre, messaggio, e in coda un JSON compatto con i dettagli. Su file resta
// JSON puro, piu' comodo se in futuro questi log venissero letti da uno
// strumento invece che da un occhio umano.

const fs = require('fs');
const path = require('path');
const winston = require('winston');
const avvio = require('./avvio');

const CARTELLA_LOG = path.join(__dirname, '..', 'logs');

/** Prova a creare la cartella dei log. Non lancia mai: se fallisce si continua senza file. */
function cartellaLogDisponibile() {
  try {
    fs.mkdirSync(CARTELLA_LOG, { recursive: true });
    fs.accessSync(CARTELLA_LOG, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

const SCRIVIBILE = cartellaLogDisponibile();

/** Formato leggibile per la console: una riga per evento. */
const formatoConsole = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, categoria, avvio: idAvvio, servizio, ...resto }) => {
    const livello = level.toUpperCase().padEnd(5);
    const cat = categoria ? `[${categoria}] ` : '';
    const corpo = stack || message;
    const extra = Object.keys(resto).length ? ` ${JSON.stringify(resto)}` : '';
    return `${timestamp} ${livello} #${idAvvio} ${cat}${corpo}${extra}`;
  })
);

/** Formato per i file: JSON strutturato, comodo per un'eventuale lettura automatica. */
const formatoFile = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transports = [
  new winston.transports.Console({ format: formatoConsole })
];

if (SCRIVIBILE) {
  const fileErrori = new winston.transports.File({
    filename: path.join(CARTELLA_LOG, 'error.log'),
    level: 'error',
    format: formatoFile,
    maxsize: 5 * 1024 * 1024,
    maxFiles: 5
  });
  const fileCompleto = new winston.transports.File({
    filename: path.join(CARTELLA_LOG, 'combined.log'),
    format: formatoFile,
    maxsize: 5 * 1024 * 1024,
    maxFiles: 10
  });
  // Un errore di scrittura sul file (disco pieno, permessi revocati a runtime)
  // non deve far cadere il processo: si logga solo su console da quel momento.
  fileErrori.on('error', (err) => console.error('[LOG] file error.log non scrivibile:', err.message));
  fileCompleto.on('error', (err) => console.error('[LOG] file combined.log non scrivibile:', err.message));
  transports.push(fileErrori, fileCompleto);
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { servizio: 'aura-manager', avvio: avvio.ID },
  transports
});

if (!SCRIVIBILE) {
  logger.warn('La cartella logs/ non e\' scrivibile: si continua solo con la console.', {
    categoria: 'sistema'
  });
}

// ---------------------------------------------------------- log di sicurezza
//
// Oltre a comparire nel flusso principale (cosi' non serve guardare due posti
// diversi mentre si segue il terminale), gli eventi di sicurezza vanno anche
// in un file separato quando possibile: un archivio dedicato e' piu' comodo
// da consultare in un secondo momento senza doverlo filtrare dal resto.
const securityTransports = [];
if (SCRIVIBILE) {
  const fileSicurezza = new winston.transports.File({
    filename: path.join(CARTELLA_LOG, 'security.log'),
    format: formatoFile,
    maxsize: 5 * 1024 * 1024,
    maxFiles: 5
  });
  fileSicurezza.on('error', (err) => console.error('[LOG] file security.log non scrivibile:', err.message));
  securityTransports.push(fileSicurezza);
}

const securityLogger = winston.createLogger({
  level: 'warn',
  defaultMeta: { servizio: 'aura-manager', avvio: avvio.ID },
  transports: securityTransports
});

/** Estrae dalla richiesta i dati utili a capire chi e da dove, senza ripeterlo ovunque. */
function datiRichiesta(req) {
  if (!req) return {};
  const utente =
    req.session && req.session.user
      ? `${req.session.user.ruolo}:${req.session.user.nickname}`
      : 'anonimo';
  return {
    utente,
    ip: req.ip || (req.connection && req.connection.remoteAddress) || null,
    metodo: req.method,
    percorso: req.originalUrl
  };
}

/**
 * Log di un evento rilevante per la sicurezza (login, logout, CSRF rifiutato,
 * sessione scaduta, limite di frequenza superato). Va sia nel file dedicato
 * sia nel flusso principale.
 */
function logSecurityEvent(evento, dettagli, req = null) {
  const meta = { categoria: 'sicurezza', evento, ...datiRichiesta(req), ...dettagli };
  securityLogger.warn(evento, meta);
  logger.warn(evento, meta);
}

/**
 * Log di un'operazione che modifica dati applicativi: chi ha creato,
 * modificato, approvato o pagato cosa. E' la traccia che permette di
 * ricostruire "cos'e' successo" a posteriori, non solo "cosa e' andato storto".
 */
function logAzione(azione, dettagli, req = null) {
  logger.info(azione, { categoria: 'azione', ...datiRichiesta(req), ...dettagli });
}

module.exports = {
  logger,
  securityLogger,
  logSecurityEvent,
  logAzione
};
