// Impalcatura minima per le verifiche.
//
// Niente dipendenze esterne: i test si eseguono con `node` e basta, anche su una
// macchina appena installata. Ogni file di test lavora su un database usa e
// getta, creato in una cartella temporanea e cancellato alla fine.

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Prepara un database temporaneo. Va chiamata PRIMA di importare qualunque
 * modulo dell'applicazione: la connessione viene aperta al primo require, e a
 * quel punto DB_PATH deve essere gia' impostato.
 */
function preparaDatabase(nome) {
  const file = path.join(os.tmpdir(), `aura-${nome}-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = file;
  return file;
}

function creaVerificatore() {
  const stato = { passati: 0, falliti: 0, dettagli: [] };

  function check(descrizione, atteso, ottenuto) {
    const ok =
      typeof atteso === 'number'
        ? Number.isFinite(Number(ottenuto)) && Math.abs(atteso - Number(ottenuto)) < 0.005
        : atteso === ottenuto;
    if (ok) {
      stato.passati++;
      console.log(`  ok    ${descrizione}: ${ottenuto}`);
    } else {
      stato.falliti++;
      stato.dettagli.push(`${descrizione}: atteso ${atteso}, ottenuto ${ottenuto}`);
      console.log(`  FALLITA  ${descrizione}: atteso ${atteso}, ottenuto ${ottenuto}`);
    }
    return ok;
  }

  /**
   * Verifica che un'operazione venga respinta.
   * `frammento` (facoltativo) controlla che il messaggio spieghi davvero il
   * motivo giusto: un rifiuto per la ragione sbagliata e' comunque un bug.
   */
  async function respinta(descrizione, fn, frammento = null) {
    try {
      await fn();
      stato.falliti++;
      stato.dettagli.push(`${descrizione}: l'operazione doveva essere respinta`);
      console.log(`  FALLITA  ${descrizione}: doveva essere respinta ma e' riuscita`);
      return false;
    } catch (err) {
      if (frammento && !String(err.message).toLowerCase().includes(frammento.toLowerCase())) {
        stato.falliti++;
        stato.dettagli.push(
          `${descrizione}: respinta con il motivo sbagliato -> ${err.message}`
        );
        console.log(`  FALLITA  ${descrizione}: motivo inatteso -> ${err.message}`);
        return false;
      }
      stato.passati++;
      console.log(`  ok    ${descrizione}: respinta (${err.message})`);
      return true;
    }
  }

  function sezione(titolo) {
    console.log(`\n-- ${titolo}`);
  }

  function riepilogo(file) {
    console.log('');
    console.log('='.repeat(64));
    console.log(`${file}: ${stato.passati} superate, ${stato.falliti} fallite`);
    if (stato.falliti) {
      console.log('');
      stato.dettagli.forEach((d) => console.log(`  - ${d}`));
    }
    console.log('='.repeat(64));
    return stato.falliti;
  }

  return { check, respinta, sezione, riepilogo, stato };
}

/** Cancella il file temporaneo, senza fare rumore se il sistema lo tiene aperto. */
function pulisci(file) {
  for (const suffisso of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(file + suffisso);
    } catch (_) {
      /* su Windows il file puo' restare bloccato finche' il processo non esce */
    }
  }
}

module.exports = { preparaDatabase, creaVerificatore, pulisci };
