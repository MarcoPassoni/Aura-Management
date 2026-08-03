// Avvio dell'applicazione: configurazione Express, sessioni, sicurezza, route.
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const favicon = require('serve-favicon');
const expressLayouts = require('express-ejs-layouts');

const { initSchema } = require('./models/schema');
const { chiudi: chiudiDatabase, dbPath } = require('./models/db');
const { csrf } = require('./middleware/csrf');
const { logger } = require('./utils/secure-logger');
const { NOME_COOKIE, SESSIONE_IDLE_MS, SESSIONE_MAX_MS } = require('./utils/sessione');
const avvio = require('./utils/avvio');

const app = express();
const PORT = process.env.PORT || 3000;
const IN_PRODUZIONE = process.env.NODE_ENV === 'production';

// In produzione il segreto di sessione deve essere impostato: l'originale
// aveva un valore di ripiego scritto nel codice, quindi pubblico.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && IN_PRODUZIONE) {
  logger.error('SESSION_SECRET non impostato: impossibile avviare in produzione.', {
    categoria: 'sistema'
  });
  process.exit(1);
}

if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

// ---------------------------------------------------------------- sicurezza
app.disable('x-powered-by');

// Ci si fida dell'intestazione X-Forwarded-For solo in produzione, dove davanti
// c'e' davvero un proxy che la imposta. In locale fidarsene significa lasciare
// che chiunque dichiari l'indirizzo che preferisce, e quindi aggiri i limiti
// sui tentativi di accesso semplicemente cambiandolo a ogni richiesta.
app.set('trust proxy', IN_PRODUZIONE ? 1 : false);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // L'interfaccia non carica nulla da CDN esterne: fogli di stile e
        // script sono serviti dall'applicazione.
        //
        // 'unsafe-inline' e' concesso ai soli stili perche' alcune misure sono
        // calcolate a runtime (le altezze delle barre dei grafici) e vivono in
        // attributi style. Senza questa deroga il browser le ignora in silenzio.
        // Gli script restano rigidi: e' li' che si annida il rischio vero.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    hsts: IN_PRODUZIONE ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'same-origin' }
  })
);

// ------------------------------------------------------------- middleware
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// I file statici vengono serviti PRIMA della sessione: un foglio di stile o
// un'immagine non hanno bisogno di sapere chi e' collegato, e passare dalla
// sessione significava una lettura sul database per ogni singolo file.
const faviconPath = path.join(__dirname, 'public', 'img', 'favicon.ico');
if (fs.existsSync(faviconPath)) app.use(favicon(faviconPath));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: IN_PRODUZIONE ? '7d' : 0 }));

// Le sessioni vivono su disco: con il MemoryStore predefinito ogni riavvio del
// server disconnetteva tutti gli utenti collegati, e la memoria cresceva senza
// mai liberarsi.
//
// `svuotaAllAvvio` e' invece una scelta deliberata, solo in produzione: ogni
// riavvio del processo (un deploy, un crash recuperato) invalida tutte le
// sessioni esistenti, cosi' nessuno resta collegato a tempo indeterminato
// senza che il server "se lo ricordi" attivamente. In sviluppo resterebbe solo
// un fastidio, perche' nodemon riavvia il processo a ogni file salvato.
const SqliteStore = require('./services/session-store')(session);

app.use(
  session({
    name: NOME_COOKIE,
    store: new SqliteStore({ svuotaAllAvvio: IN_PRODUZIONE }),
    secret: SESSION_SECRET || 'segreto-di-sviluppo-non-usare-in-produzione',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: IN_PRODUZIONE,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSIONE_IDLE_MS
    }
  })
);
app.use(flash());

// Il controllo anti-CSRF sta subito dopo la sessione e prima di ogni route:
// nessuna operazione puo' saltarlo per dimenticanza.
app.use(csrf);

// ------------------------------------------------------------- log accessi
//
// Una riga per ogni richiesta gestita: metodo, percorso, esito, tempo di
// risposta e chi era collegato (se qualcuno lo era). E' il primo posto da
// guardare per capire cosa sta facendo davvero l'applicazione in un dato
// momento, ed e' quello che rende utile un log "dalla A alla Z" invece che
// solo un elenco di errori.
//
// Sta dopo la sessione (serve sapere chi e' collegato) e prima delle route,
// cosi' cattura ogni richiesta dinamica. Le richieste ai file statici sono gia'
// state gestite sopra e non arrivano qui: loggarle avrebbe solo aggiunto
// rumore senza informazioni utili.
app.use((req, res, next) => {
  const inizio = process.hrtime.bigint();
  res.on('finish', () => {
    const durataMs = Number(process.hrtime.bigint() - inizio) / 1e6;
    const utente =
      req.session && req.session.user
        ? `${req.session.user.ruolo}:${req.session.user.nickname}`
        : 'anonimo';
    logger.info('richiesta gestita', {
      categoria: 'http',
      metodo: req.method,
      percorso: req.originalUrl,
      stato: res.statusCode,
      durataMs: Math.round(durataMs),
      utente,
      ip: req.ip
    });
  });
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', false);

// Funzioni di formattazione disponibili in ogni vista.
Object.assign(app.locals, require('./utils/formato'));

// Dati disponibili a tutte le viste.
app.use((req, res, next) => {
  res.locals.utente = req.session && req.session.user ? req.session.user : null;
  res.locals.percorso = req.path;
  res.locals.messaggiOk = req.flash('messaggio');
  res.locals.messaggiErrore = req.flash('errore');
  next();
});

// ----------------------------------------------------------------- route
app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/pr', require('./routes/pr'));

app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect(req.session.user.ruolo === 'admin' ? '/admin/riepilogo' : '/pr/dashboard');
  }
  res.redirect('/login');
});

app.get('/salute', (req, res) => res.status(200).json({ stato: 'ok' }));

// ------------------------------------------------------- errori e chiusura
app.use((req, res) => {
  res.status(404).render('errore', {
    layout: false,
    titolo: 'Pagina non trovata',
    messaggio: 'L\'indirizzo richiesto non esiste.',
    codice: 404
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const validazione = err && err.name === 'ErroreValidazione';
  if (!validazione) {
    logger.error(err.message, {
      categoria: 'errore',
      stack: err.stack,
      metodo: req.method,
      percorso: req.originalUrl,
      utente: req.session && req.session.user ? req.session.user.nickname : 'anonimo'
    });
  }

  const stato = validazione ? 400 : 500;
  const messaggio = validazione
    ? err.message
    : 'Si e\' verificato un errore imprevisto. Riprova tra poco.';

  if (
    req.xhr ||
    (req.headers.accept || '').includes('application/json') ||
    (req.headers['content-type'] || '').includes('application/json')
  ) {
    return res.status(stato).json({ errore: messaggio });
  }

  res.status(stato).render('errore', {
    layout: false,
    titolo: validazione ? 'Dati non validi' : 'Errore',
    messaggio,
    codice: stato
  });
});

logger.info('Avvio del processo.', {
  categoria: 'sistema',
  ambiente: process.env.NODE_ENV || 'sviluppo',
  avviatoIl: avvio.avviatoIl.toISOString(),
  databasePath: dbPath,
  sessioneIdleOre: Math.round(SESSIONE_IDLE_MS / 3_600_000),
  sessioneMassimaOre: Math.round(SESSIONE_MAX_MS / 3_600_000)
});

(async () => {
  try {
    await initSchema();
  } catch (err) {
    logger.error('Impossibile inizializzare il database.', {
      categoria: 'sistema',
      errore: err.message,
      stack: err.stack
    });
    process.exit(1);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`In ascolto su http://localhost:${PORT}`, { categoria: 'sistema', porta: PORT });
  });

  // Chiusura ordinata: si smette di accettare richieste, si lasciano finire
  // quelle in corso e solo alla fine si chiude il database. Chiuderlo prima
  // significherebbe far fallire una transazione a meta'.
  let inChiusura = false;
  const chiudi = (segnale) => {
    if (inChiusura) return;
    inChiusura = true;
    logger.info('Segnale di arresto ricevuto, chiusura in corso.', {
      categoria: 'sistema',
      segnale
    });
    server.close(async () => {
      try {
        await chiudiDatabase();
        logger.info('Database chiuso correttamente. Arresto completato.', { categoria: 'sistema' });
      } catch (err) {
        logger.error('Errore nella chiusura del database.', {
          categoria: 'sistema',
          errore: err.message
        });
      }
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Chiusura forzata: le connessioni non si sono liberate in tempo.', {
        categoria: 'sistema'
      });
      process.exit(1);
    }, 8000).unref();
  };
  process.on('SIGTERM', () => chiudi('SIGTERM'));
  process.on('SIGINT', () => chiudi('SIGINT'));

  process.on('unhandledRejection', (err) => {
    logger.error('Promise rifiutata senza gestione.', {
      categoria: 'sistema',
      errore: err && err.message,
      stack: err && err.stack
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Eccezione non gestita: il processo si ferma.', {
      categoria: 'sistema',
      errore: err.message,
      stack: err.stack
    });
    process.exit(1);
  });
})();

module.exports = app;
