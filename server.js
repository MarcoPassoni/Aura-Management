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
const { chiudi: chiudiDatabase } = require('./models/db');
const { csrf } = require('./middleware/csrf');
const { logger } = require('./utils/secure-logger');

const app = express();
const PORT = process.env.PORT || 3000;
const IN_PRODUZIONE = process.env.NODE_ENV === 'production';

// In produzione il segreto di sessione deve essere impostato: l'originale
// aveva un valore di ripiego scritto nel codice, quindi pubblico.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && IN_PRODUZIONE) {
  console.error('SESSION_SECRET non impostato: impossibile avviare in produzione.');
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
const SqliteStore = require('./services/session-store')(session);

app.use(
  session({
    name: 'aura.sid',
    store: new SqliteStore(),
    secret: SESSION_SECRET || 'segreto-di-sviluppo-non-usare-in-produzione',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: IN_PRODUZIONE,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000 // 8 ore
    }
  })
);
app.use(flash());

// Il controllo anti-CSRF sta subito dopo la sessione e prima di ogni route:
// nessuna operazione puo' saltarlo per dimenticanza.
app.use(csrf);

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
  if (!validazione) logger.error(err.message, { stack: err.stack, url: req.originalUrl });

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

(async () => {
  try {
    await initSchema();
  } catch (err) {
    console.error('Impossibile inizializzare il database:', err.message);
    process.exit(1);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Aura Manager in ascolto su http://localhost:${PORT}`);
    console.log(`Ambiente: ${process.env.NODE_ENV || 'sviluppo'}`);
  });

  // Chiusura ordinata: si smette di accettare richieste, si lasciano finire
  // quelle in corso e solo alla fine si chiude il database. Chiuderlo prima
  // significherebbe far fallire una transazione a meta'.
  let inChiusura = false;
  const chiudi = (segnale) => {
    if (inChiusura) return;
    inChiusura = true;
    console.log(`\n${segnale} ricevuto, chiusura in corso.`);
    server.close(async () => {
      try {
        await chiudiDatabase();
      } catch (err) {
        console.error('Errore nella chiusura del database:', err.message);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => chiudi('SIGTERM'));
  process.on('SIGINT', () => chiudi('SIGINT'));
})();

module.exports = app;
