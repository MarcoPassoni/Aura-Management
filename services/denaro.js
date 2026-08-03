// Aritmetica monetaria.
//
// PROBLEMA CHE RISOLVE
// Gli importi erano numeri in virgola mobile arrotondati a due decimali in
// punti diversi del codice, con la funzione `euro()` applicata a volte al
// singolo valore e a volte alla somma. Il risultato e' che il totale di una
// colonna poteva non coincidere con la somma dei valori scritti sopra: uno
// scarto di un centesimo che, su una pagina di contabilita', costringe a
// chiedersi quale dei due numeri sia quello giusto.
//
// REGOLA UNICA
// Ogni importo vive come NUMERO INTERO DI CENTESIMI. Si arrotonda una volta
// sola, nel punto in cui un importo nasce (la quota di un collaboratore su un
// singolo tavolo). Tutte le somme successive sono somme di interi, quindi
// esatte: il totale di una colonna e' sempre, per costruzione, la somma delle
// righe che l'utente vede.
//
// ARROTONDAMENTO
// Mezzo centesimo si arrotonda allontanandosi dallo zero (0.005 -> 0.01,
// -0.005 -> -0.01). E' la stessa regola della funzione ROUND di SQLite: alcune
// aggregazioni sono fatte dal database e altre da JavaScript, e devono dare lo
// stesso identico numero. Per questo non viene aggiunto nessun epsilon
// correttivo: sarebbe una differenza fra i due mondi.

/** Arrotonda all'intero piu' vicino, mezzo si allontana dallo zero. */
function arrotondaIntero(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** Da euro (numero o stringa) a centesimi interi. */
function aCentesimi(valoreEuro) {
  return arrotondaIntero(Number(valoreEuro) * 100);
}

/** Da centesimi interi a euro, con due decimali esatti. */
function aEuro(centesimi) {
  const n = Number(centesimi);
  if (!Number.isFinite(n)) return 0;
  return arrotondaIntero(n) / 100;
}

/** Normalizza un importo in euro passando dai centesimi. */
function arrotonda(valoreEuro) {
  return aEuro(aCentesimi(valoreEuro));
}

/**
 * Quota percentuale di un imponibile, in centesimi.
 *
 * E' l'unico punto in cui una provvigione viene arrotondata. La stessa formula,
 * espressa in SQL, sta in QUOTA_CENT piu' sotto: le due devono restare
 * identiche perche' i totali sono calcolati dal database e i controlli di
 * sicurezza (per esempio "questo pagamento supera il dovuto?") da JavaScript.
 */
function quotaCentesimi(imponibileCent, percentuale) {
  const base = Number(imponibileCent);
  const perc = Number(percentuale);
  if (!Number.isFinite(base) || !Number.isFinite(perc)) return 0;
  return arrotondaIntero((base * perc) / 100);
}

/** Somma di centesimi, ignorando i valori non numerici. */
function somma(valori) {
  let totale = 0;
  for (const v of valori) {
    const n = Number(v);
    if (Number.isFinite(n)) totale += n;
  }
  return totale;
}

// ---------------------------------------------------------------- espressioni SQL
//
// Le stesse formule, per le aggregazioni fatte dal database. Sono definite qui
// e non copiate nelle query in modo che non possano divergere da quelle di
// JavaScript. `t` e' la tabella tavoli, `q` la tabella quote_tavolo.

/**
 * Imponibile del tavolo in centesimi.
 * E' l'incasso effettivo se e' stato registrato dopo la serata, altrimenti la
 * spesa prevista al momento della prenotazione.
 */
const IMPONIBILE_CENT = 'CAST(ROUND(COALESCE(t.incasso_effettivo, t.spesa_prevista) * 100) AS INTEGER)';

/** Quota lorda di una riga di quote_tavolo, in centesimi. */
const QUOTA_CENT = `CAST(ROUND(${IMPONIBILE_CENT} * q.percentuale / 100.0) AS INTEGER)`;

/**
 * Quota lorda del livello immediatamente sottostante nella stessa catena, in
 * centesimi: e' esattamente quanto questo collaboratore deve girare al proprio
 * collaboratore per questo tavolo.
 */
const QUOTA_SOTTO_CENT = `CAST(ROUND(${IMPONIBILE_CENT} * q.percentuale_sotto / 100.0) AS INTEGER)`;

/**
 * Quota netta: quello che resta a questo collaboratore su questo tavolo.
 * E' una differenza fra due valori gia' arrotondati, quindi la somma delle
 * quote nette di una catena e' sempre uguale, al centesimo, alla quota lorda
 * del capofila. Nessun residuo di arrotondamento puo' comparire nei totali.
 */
const QUOTA_NETTA_CENT = `(${QUOTA_CENT} - ${QUOTA_SOTTO_CENT})`;

module.exports = {
  arrotondaIntero,
  aCentesimi,
  aEuro,
  arrotonda,
  quotaCentesimi,
  somma,
  IMPONIBILE_CENT,
  QUOTA_CENT,
  QUOTA_SOTTO_CENT,
  QUOTA_NETTA_CENT
};
