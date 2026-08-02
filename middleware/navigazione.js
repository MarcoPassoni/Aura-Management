// Dati della barra di navigazione, calcolati una volta sola per ogni richiesta.
//
// Prima i conteggi vivevano dentro la singola route (solo /admin/riepilogo li
// calcolava) e la barra li leggeva con un controllo `typeof`: su tutte le altre
// pagine la variabile non esisteva e il contatore spariva. Centralizzandoli qui
// la barra e' identica su ogni pagina per costruzione.

const { get } = require('../services/db-helpers');
const tavoliSrv = require('../services/tavoli');

async function datiNavigazione(req, res, next) {
  try {
    const utente = req.session.user;

    if (utente.ruolo === 'admin') {
      const prIds = req.gerarchia.forAdmin(utente.id).map((n) => n.id);

      // Le proposte di nuovi collaboratori vanno contate solo tra quelle della
      // propria struttura: il conteggio precedente non filtrava per gerarchia e
      // includeva anche le richieste inoltrate sotto altri amministratori.
      const richieste = prIds.length
        ? await get(
            `SELECT COUNT(*) AS n FROM richieste_creazione_pr
             WHERE stato = 'in_attesa' AND fk_richiedente IN (${prIds.map(() => '?').join(',')})`,
            prIds
          )
        : null;

      res.locals.badge = {
        approvazioni: await tavoliSrv.contaInAttesa(prIds),
        'richieste-pr': richieste ? richieste.n : 0
      };
    } else {
      // Per un PR l'unico numero che cambia da solo e' quello delle proprie
      // prenotazioni ancora da valutare.
      res.locals.badge = {
        tavoli: await tavoliSrv.contaInAttesa([utente.id])
      };
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { datiNavigazione };
