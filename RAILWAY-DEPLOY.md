# Deploy su Railway

Questa guida descriveva lo schema originale dell'applicazione e indicava di
accedere con `admin/admin`. Tutte quelle informazioni non sono piu' valide: le
tabelle sono cambiate, il comando `npm run init-tables` non esiste piu' e non
viene creato nessun amministratore predefinito. Il testo qui sotto sostituisce
integralmente il precedente.

## Prima del primo deploy

1. **Volume persistente.** Il database e' un file SQLite: senza un volume viene
   cancellato a ogni rilascio. Monta un volume e imposta
   `RAILWAY_VOLUME_MOUNT_PATH` sul suo percorso.
2. **Variabili d'ambiente.** Vedi la tabella nel README. Due sono obbligatorie:

   | Variabile | Perche' serve |
   | --- | --- |
   | `SESSION_SECRET` | Senza, l'avvio in produzione si interrompe di proposito |
   | `ENCRYPTION_KEY` | Chiave dei dati personali. **Se cambia, i nomi salvati diventano illeggibili**: generala una volta e conservala |
   | `NODE_ENV=production` | Attiva cookie sicuri, HSTS e la fiducia nel proxy |

   Genera la chiave di cifratura una volta sola, con:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

## Primo avvio

Lo schema viene applicato da solo a ogni avvio: e' idempotente, non serve
lanciare niente a mano. In alternativa, per applicarlo senza avviare il server:

```bash
npm run railway-init
```

Poi crea il primo amministratore. Non esiste un account predefinito, e la
password la scegli tu:

```bash
npm run crea-admin -- <nickname> <password>
```

La password deve avere almeno 10 caratteri, con una lettera e un numero.

## Se arrivi da una versione precedente

Se il volume contiene gia' un database dello schema originale (tabelle
`storico_tavoli`, `richieste_tavoli`, `pr_stats`), esegui la migrazione. Prima
in simulazione, per vedere cosa farebbe:

```bash
npm run migrate
```

Poi, quando i numeri riportati ti tornano:

```bash
npm run migrate -- --apply
```

La migrazione crea sempre una copia di sicurezza del file prima di toccarlo, e
al termine elenca i tavoli la cui catena di provvigioni non e' ricostruibile:
quelli restano fuori dai calcoli finche' non sistemi il responsabile del
venditore. Li ritrovi anche nella pagina **Verifica dati** dell'applicazione.

## Dopo il deploy

Apri **Verifica dati** dall'area amministratore. Se dice che i conti tornano,
non c'e' altro da controllare. Se elenca dei problemi, ognuno riporta cosa non
va e come sistemarlo.

Il percorso `/salute` risponde `{"stato":"ok"}` e va bene come health check.

## Note operative

- **Una sola istanza.** Il database e le sessioni vivono nello stesso file
  SQLite: con piu' processi in scrittura si corrompe. Non alzare il numero di
  repliche senza prima passare a un database che regga la concorrenza.
- **Backup.** Il file da salvare e' `iconic.db` dentro il volume. Con la
  modalita' WAL attiva copia anche `iconic.db-wal` se lo trovi accanto.
- **Spegnimento.** Il processo gestisce `SIGTERM`: chiude le richieste in corso
  e poi il database, cosi' un rilascio non interrompe una transazione a meta'.
