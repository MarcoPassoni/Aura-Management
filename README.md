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
server.js              avvio, sicurezza, sessioni, route
models/
  db.js                  connessione unica e configurazione di SQLite
  schema.js              definizione dello schema (idempotente)
services/
  denaro.js              aritmetica monetaria: unico punto di arrotondamento
  quote.js               fotografia delle percentuali sul singolo tavolo
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
  auth.js                controlli di accesso e di ambito
  csrf.js                protezione contro le richieste da altri siti
  navigazione.js         contatori della barra laterale
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

## Variabili d'ambiente

| Variabile | Note |
| --- | --- |
| `SESSION_SECRET` | Obbligatoria in produzione, l'avvio si interrompe se manca |
| `ENCRYPTION_KEY` | Chiave di cifratura dei dati personali (32 byte in esadecimale) |
| `PORT` | Predefinita 3000 |
| `NODE_ENV` | `production` attiva cookie sicuri, HSTS e la fiducia nel proxy |
| `DB_PATH` | Percorso del database, utile per test e script |
| `RAILWAY_VOLUME_MOUNT_PATH` | Cartella del volume persistente in produzione |
