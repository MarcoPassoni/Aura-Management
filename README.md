# Aura Manager

Gestionale per la rete di PR di un locale: prenotazione tavoli, approvazione,
calcolo e pagamento delle provvigioni lungo una struttura gerarchica.

## Avvio

```bash
npm install
npm run crea-admin -- <nickname> <password>
npm run dev
```

L'applicazione risponde su `http://localhost:3000`.

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `npm run dev` | Avvio in sviluppo con ricarica automatica |
| `npm start` | Avvio normale |
| `npm test` | Esegue tutte le verifiche |
| `npm run crea-admin -- <nick> <pwd>` | Crea un amministratore |
| `npm run migrate` | Mostra cosa farebbe la migrazione dallo schema originale |
| `npm run migrate -- --apply` | Esegue la migrazione, con copia di sicurezza |

## Come funzionano le provvigioni

Il modello e' **differenziale**: ogni responsabile trattiene solo la differenza
tra la propria percentuale e quella di chi sta sotto di lui.

Esempio, tavolo da 1000 EUR venduto da Marco (5%), che dipende da Luca (8%),
che dipende da Sara (12%):

| Chi | Gli spetta | Gli resta | Perche' |
| --- | --- | --- | --- |
| Marco | 50 EUR | 50 EUR | 5% di 1000 |
| Luca | 80 EUR | 30 EUR | 8% di 1000, meno i 50 che gira a Marco |
| Sara | 120 EUR | 40 EUR | 12% di 1000, meno gli 80 che gira a Luca |
| **Costo per l'amministrazione** | **120 EUR** | | 12%, la percentuale del capofila |

La somma "telescopa" sempre sulla percentuale del collaboratore di primo
livello: il costo e' prevedibile e non cresce aggiungendo livelli intermedi.
La somma di cio' che resta a ciascuno e' sempre, al centesimo, uguale al costo
totale a carico dell'amministrazione.

Vincolo che ne deriva: **la percentuale di un collaboratore non puo' superare
quella del suo responsabile**, altrimenti il responsabile lavorerebbe in
perdita. L'applicazione rifiuta di approvare un tavolo in questa situazione e
segnala le incoerenze gia' presenti.

**Chi paga chi:** ogni collaboratore e' pagato dal proprio responsabile diretto;
i collaboratori di primo livello sono pagati dall'amministrazione.

## La revisione a catena, prima dell'approvazione

Se sopra il venditore ci sono altri collaboratori, una richiesta di tavolo non
arriva all'amministrazione direttamente: sale la catena un livello alla volta.

Ogni collaboratore intermedio, quando la richiesta arriva a lui, vede la
percentuale che spetterebbe di norma al proprio sottoposto diretto (quella
del suo profilo) e puo':

- confermarla cosi' com'e', oppure cambiarla **solo per questo tavolo** (il
  profilo del sottoposto non viene toccato);
- lasciare un commento, visibile a chiunque stia sopra di lui man mano che la
  richiesta sale (amministrazione compresa), ma mai a chi sta sotto.

Ogni decisione e' vincolata da due limiti: non si puo' promettere al proprio
sottoposto piu' di quanto si guadagna (altrimenti chi rivede ci rimetterebbe),
e non si puo' scendere sotto quanto e' gia' stato deciso al livello appena
sotto (altrimenti sarebbe il livello appena rivisto a rimetterci). Rispettati
questi limiti a ogni passaggio, quando la richiesta arriva infine
all'amministrazione la catena e' gia' coerente per costruzione.

Solo l'amministrazione approva o rifiuta davvero: i collaboratori intermedi
possono solo rivedere e inoltrare. Quando la richiesta arriva in cima,
l'amministrazione decide (o conferma) la percentuale del capofila - l'unico
livello che nessun collaboratore puo' rivedere, perche' non ha nessuno sopra
di se' - e approva. Il venditore originale vede solo la propria percentuale,
una volta decisa, e presso chi si trova la richiesta: mai i commenti ne' le
percentuali altrui.

Un collaboratore disattivato lungo la catena non blocca nulla: il suo
passaggio si completa da solo con la percentuale di default, e la richiesta
prosegue. Riaprire un tavolo gia' deciso azzera l'intero percorso di revisione
e lo fa ripartire da capo sulla struttura attuale.

## Le tre regole che tengono in piedi i conti

### 1. Le percentuali si congelano all'approvazione

Nel momento in cui un tavolo viene approvato, l'applicazione fotografa l'intera
catena di responsabilita': chi partecipa, con quale percentuale, e chi deve
pagare chi. Da quel momento **quelle percentuali non cambiano piu'**.

Cambiare la percentuale di un collaboratore vale quindi dai tavoli successivi.
Il passato resta come era stato calcolato, e come e' stato pagato: nessuno si
ritrova improvvisamente in credito o in debito per una modifica fatta oggi.

Vale anche per la struttura: spostare un collaboratore sotto un altro
responsabile non riscrive i debiti gia' maturati. Chi era responsabile quando la
provvigione e' maturata resta quello che la deve pagare.

### 2. Gli importi invece seguono i fatti

L'importo di un tavolo non e' congelato, perche' non e' un accordo ma un fatto:
quanto ha speso davvero quel tavolo. Ogni tavolo ha due numeri distinti:

- **spesa prevista**, il preventivo dichiarato alla prenotazione;
- **incasso effettivo**, il conto reale della serata, inserito dopo.

Le provvigioni si calcolano sull'incasso effettivo quando c'e', sul preventivo
finche' non c'e'. L'interfaccia mostra sempre quale dei due sta usando, con
un'etichetta accanto all'importo. Correggere l'importo aggiorna subito le
provvigioni di quel tavolo, alle percentuali gia' congelate.

### 3. Non si puo' togliere quello che e' gia' stato pagato

Riaprire un tavolo, ridurne l'importo o azzerarne il consuntivo fa diminuire
quanto qualcuno ha maturato. Se quella persona e' gia' stata pagata, il suo
saldo diventerebbe negativo: un credito che non esiste piu' ma che risulta
versato.

Ognuna di queste operazioni calcola in anticipo l'effetto sui saldi e si ferma
se qualcuno finirebbe sotto zero, dicendo chi e di quanto. La via d'uscita e'
annullare prima il pagamento in eccesso.

## Arrotondamenti

Tutti gli importi vivono come numeri interi di centesimi. Si arrotonda una volta
sola, sulla quota di un collaboratore su un singolo tavolo; ogni totale e' una
somma di interi.

Conseguenza pratica: **il totale di una colonna e' sempre la somma esatta delle
righe che vedi sopra**. Non esistono differenze di un centesimo fra il dettaglio
e il riepilogo.

## Conto economico dell'amministrazione

```
incasso dei tavoli approvati
  - quota del locale        (percentuale configurabile, predefinita 85%)
  = margine disponibile
  - provvigioni             (quanto spetta ai collaboratori di primo livello)
  = guadagno lordo
  - detrazioni              (voci e percentuali configurabili)
  = guadagno netto
```

Ogni tavolo approvato entra nell'incasso una volta sola, per costruzione: la
struttura dei dati non consente di contarlo due volte. Quota e detrazioni si
modificano dalla pagina **Impostazioni** e valgono per il singolo amministratore.

## Verifica dei dati

La pagina **Verifica dati** rilegge tutto e cerca le situazioni in cui un numero
mostrato altrove potrebbe essere incompleto: tavoli approvati la cui catena non
e' ricostruibile, anelli nella struttura, collaboratori senza amministrazione,
pagamenti superiori al maturato, percentuali che faranno lavorare in perdita.
Ogni voce dice cosa non va e come sistemarlo. Non modifica niente.

Il numero rosso accanto alla voce di menu conta i tavoli approvati che nessun
calcolo sta considerando: se compare, i totali delle altre pagine sono
incompleti.

## Struttura del progetto

```
server.js              avvio, sicurezza, sessioni, log di accesso, route
models/
  db.js                  connessione unica e configurazione di SQLite
  schema.js              definizione dello schema (idempotente)
services/
  denaro.js              aritmetica monetaria: unico punto di arrotondamento
  quote.js               fotografia delle percentuali sul singolo tavolo
  revisioni.js            passaggio di mano lungo la catena, prima dell'admin
  commissions.js         motore di calcolo: unica fonte di verita'
  hierarchy.js           albero dei collaboratori, spostamenti, cicli
  tavoli.js              ciclo di vita delle prenotazioni
  pagamenti.js           registrazione e validazione dei pagamenti
  users.js               utenti, con cifratura dei dati personali
  settings.js            quote e detrazioni configurabili
  diagnostica.js         controlli di integrita'
  validation.js          validazione degli input
  session-store.js       sessioni persistenti su SQLite
routes/                orchestrazione: admin, pr, autenticazione
middleware/
  auth.js                controlli di accesso, ambito, scadenza della sessione
  csrf.js                protezione contro le richieste da altri siti
  navigazione.js         contatori della barra laterale
utils/
  secure-logger.js        log dell'applicazione (vedi sotto)
  sessione.js              durate e nome del cookie di sessione
  avvio.js                 identificativo del processo, per correlare i log
views/                 interfaccia (EJS)
test/                  verifiche automatiche
scripts/               creazione amministratore, migrazione
```

## Principio di fondo

I valori economici **non sono memorizzati come contatori**: vengono ricalcolati
a ogni lettura dai fatti grezzi, cioe' i tavoli approvati con la loro
ripartizione congelata e i pagamenti registrati. Non esistono totali da
mantenere allineati, quindi non possono andare in deriva quando un tavolo viene
modificato, rifiutato o riaperto.

I tavoli non cambiano mai tabella: una sola riga con uno `stato`
(`in_attesa`, `approvato`, `rifiutato`). Anche i rifiuti restano nello storico,
con il motivo.

## Dati personali

Nome, cognome e numero di telefono sono cifrati a riposo (AES-256-CBC). La
chiave arriva da `ENCRYPTION_KEY`; in sviluppo viene generata al primo avvio nel
file `.encryption-key`, che non va versionato.

I dati di una proposta di nuovo collaboratore vivono in chiaro finche' la
proposta e' aperta, perche' servono a chi deve valutarla; appena viene approvata
o rifiutata vengono rimossi, e restano solo nel profilo, dove sono cifrati.

**Attenzione:** se `ENCRYPTION_KEY` cambia, i dati gia' salvati non sono piu'
leggibili. Generala una volta e conservala.

## Sicurezza

- Sessioni persistenti su disco, rigenerate al login.
- Ogni operazione richiede un token anti-CSRF verificato lato server.
- Password con bcrypt a 12 giri, minimo 10 caratteri con lettera e numero.
- Limiti sui tentativi di accesso e sulle operazioni amministrative.
- Content Security Policy senza sorgenti esterne.
- Vincoli di integrita' del database realmente attivi (`foreign_keys = ON`).

## Sessioni

Restare collegati indefinitamente e' un rischio quanto una password debole:
un dispositivo smarrito o un browser condiviso restano un varco aperto per
sempre. Il sistema applica tre limiti indipendenti, verificati a ogni
richiesta (vedi `middleware/auth.js`):

1. **Inattivita'**: una sessione scade se non viene usata per
   `SESSION_IDLE_MS` (predefinito 8 ore). Ogni richiesta rinnova questa
   finestra, quindi in pratica e' "quanto tempo puo' passare fra un uso e il
   successivo".
2. **Durata massima assoluta**: indipendentemente da quanto viene usata, una
   sessione non supera mai `SESSION_MAX_MS` (predefinito 24 ore) dal momento
   del login. Anche restando attivi senza interruzioni, occorre rifare
   l'accesso allo scadere di questo intervallo. E' il limite che impedisce di
   restare "collegati per sempre".
3. **Riavvio del processo**: in produzione, ogni volta che il server si
   riavvia (un deploy, un crash recuperato) tutte le sessioni esistenti
   vengono invalidate in blocco, prima ancora di accettare la prima
   richiesta (`services/session-store.js`, opzione `svuotaAllAvvio`). Un
   riavvio non lascia mai sessioni "dimenticate" aperte. In sviluppo
   (`npm run dev`) questo comportamento e' disattivato, perche' nodemon
   riavvia il processo a ogni file salvato e disconnettersi ogni volta
   sarebbe solo un ostacolo al lavoro.

Chi arriva alla pagina di accesso con un cookie di sessione ancora presente
ma non piu' valido (per uno dei tre motivi sopra, o perche' ha fatto logout
da un'altra scheda) vede un avviso che lo spiega, invece di una schermata di
accesso muta.

## Log

Tutto quello che fa il server viene scritto sullo standard output
(`utils/secure-logger.js`), sempre, in ogni ambiente: e' li' che Railway (o
qualunque piattaforma che legga i log dal processo) li mostra. In precedenza
la console veniva disattivata quando `NODE_ENV=production`, che e' esattamente
il valore impostato da Railway: era per questo che i log non comparivano nel
terminale.

Ogni riga porta data e ora, livello (`info`, `warn`, `error`), un
identificativo dell'avvio del processo (utile per distinguere i log di un
riavvio da quelli del precedente) e una categoria fra parentesi quadre. Sono
loggati:

- ogni richiesta HTTP gestita, con metodo, percorso, stato, tempo di risposta
  e chi era collegato;
- login riusciti e falliti, logout, sessioni scadute, token anti-CSRF
  rifiutati (`categoria: sicurezza`);
- ogni operazione che modifica dati: creazione o modifica di un
  collaboratore, spostamenti, approvazioni e rifiuti di tavoli, incassi
  registrati, pagamenti registrati o annullati, impostazioni salvate, richieste
  di nuovi collaboratori (`categoria: azione`) — la traccia di chi ha fatto
  cosa e quando;
- avvio e arresto del processo, inizializzazione dello schema, errori non
  gestiti (`categoria: sistema` / `errore`).

Oltre alla console, se la cartella `logs/` e' scrivibile i log vengono anche
salvati su file (JSON, un file separato per gli errori e uno per gli eventi di
sicurezza). Su un file system non scrivibile o effimero l'applicazione non si
blocca: continua a funzionare solo con la console.

## Variabili d'ambiente

| Variabile | Note |
| --- | --- |
| `SESSION_SECRET` | Obbligatoria in produzione, l'avvio si interrompe se manca |
| `SESSION_IDLE_MS` | Scadenza per inattivita', in millisecondi (predefinita 8 ore) |
| `SESSION_MAX_MS` | Durata massima assoluta di una sessione, in millisecondi (predefinita 24 ore) |
| `ENCRYPTION_KEY` | Chiave di cifratura dei dati personali (32 byte in esadecimale) |
| `LOG_LEVEL` | Livello minimo dei log: `error`, `warn`, `info` (predefinito) o `debug` |
| `PORT` | Predefinita 3000 |
| `NODE_ENV` | `production` attiva cookie sicuri, HSTS, la fiducia nel proxy e l'invalidazione delle sessioni a ogni riavvio |
| `DB_PATH` | Percorso del database, utile per test e script |
| `RAILWAY_VOLUME_MOUNT_PATH` | Cartella del volume persistente in produzione |
