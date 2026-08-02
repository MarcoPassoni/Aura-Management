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
| `npm test` | Esegue tutte le verifiche sui calcoli e sui flussi |
| `npm run crea-admin -- <nick> <pwd>` | Crea un amministratore |
| `npm run migrate` | Mostra cosa farebbe la migrazione dello schema |
| `npm run migrate -- --apply` | Esegue la migrazione, con copia di sicurezza |

## Come funzionano le provvigioni

Il modello e' **differenziale**: ogni responsabile trattiene solo la differenza
tra la propria percentuale e quella di chi sta sotto di lui.

Esempio, tavolo da 1000 EUR venduto da Marco (5%), che dipende da Luca (8%),
che dipende da Sara (12%):

| Chi | Riceve | Perche' |
| --- | --- | --- |
| Marco | 50 EUR | 5% di 1000 |
| Luca | 30 EUR | 8% - 5% |
| Sara | 40 EUR | 12% - 8% |
| **Totale a carico dell'amministrazione** | **120 EUR** | 12%, la percentuale del capofila |

La somma "telescopa" sempre sulla percentuale del collaboratore di primo livello:
il costo e' prevedibile e non cresce aggiungendo livelli intermedi.

Vincolo che ne deriva: **la percentuale di un collaboratore non puo' superare
quella del suo responsabile**, altrimenti il responsabile lavorerebbe in perdita.
L'applicazione lo impedisce e segnala le incoerenze gia' presenti.

**Chi paga chi:** ogni collaboratore e' pagato dal proprio responsabile diretto;
i collaboratori di primo livello sono pagati dall'amministrazione.

## Conto economico dell'amministrazione

```
incasso dei tavoli approvati
  - quota del locale        (percentuale configurabile, predefinita 85%)
  = margine disponibile
  - provvigioni             (somma del maturato dei collaboratori di primo livello)
  = guadagno lordo
  - detrazioni              (voci e percentuali configurabili)
  = guadagno netto
```

Quota e detrazioni si modificano dalla pagina **Impostazioni** e valgono per il
singolo amministratore.

## Struttura del progetto

```
server.js              avvio, sicurezza, sessioni, route
models/schema.js       definizione dello schema (idempotente)
services/              tutta la logica applicativa
  commissions.js         motore di calcolo: unica fonte di verita'
  hierarchy.js           albero dei collaboratori, rilevamento cicli
  tavoli.js              ciclo di vita delle prenotazioni
  pagamenti.js           registrazione e validazione dei pagamenti
  users.js               utenti, con cifratura dei dati personali
  settings.js            quote e detrazioni configurabili
  validation.js          validazione degli input
routes/                orchestrazione: admin, pr, autenticazione
middleware/auth.js     controlli di accesso e di ambito
views/                 interfaccia (EJS)
test/                  verifiche automatiche
scripts/               creazione amministratore, migrazione
```

## Principio di fondo

I valori economici **non sono memorizzati**: vengono ricalcolati a ogni lettura
dai fatti grezzi, cioe' i tavoli approvati e i pagamenti registrati. Non esistono
contatori da mantenere allineati, quindi non possono andare in deriva quando un
tavolo viene modificato, rifiutato o riaperto.

I tavoli non cambiano mai tabella: una sola riga con uno `stato`
(`in_attesa`, `approvato`, `rifiutato`). Anche i rifiuti restano nello storico,
con il motivo.

## Dati personali

Nome, cognome e numero di telefono sono cifrati a riposo (AES-256-CBC). La chiave
arriva da `ENCRYPTION_KEY`; in sviluppo viene generata al primo avvio nel file
`.encryption-key`, che non va versionato.

## Variabili d'ambiente

| Variabile | Note |
| --- | --- |
| `SESSION_SECRET` | Obbligatoria in produzione, l'avvio si interrompe se manca |
| `ENCRYPTION_KEY` | Chiave di cifratura dei dati personali |
| `PORT` | Predefinita 3000 |
| `NODE_ENV` | `production` attiva cookie sicuri e HSTS |
| `DB_PATH` | Percorso del database, utile per test e script |
