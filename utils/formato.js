// Funzioni di formattazione disponibili in tutte le viste tramite app.locals.
// Vengono definite una volta sola qui invece di essere riscritte in ogni
// template come accadeva nell'originale.

function euro(n) {
  const v = Number(n) || 0;
  return `${v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function numero(n) {
  return (Number(n) || 0).toLocaleString('it-IT');
}

function percentuale(n) {
  const v = Number(n) || 0;
  return `${v.toLocaleString('it-IT', { maximumFractionDigits: 2 })}%`;
}

function dataIt(iso) {
  if (!iso) return '-';
  const parti = String(iso).slice(0, 10).split('-');
  if (parti.length !== 3) return String(iso);
  return `${parti[2]}/${parti[1]}/${parti[0]}`;
}

function dataOraIt(iso) {
  if (!iso) return '-';
  const grezzo = String(iso);
  // SQLite salva "YYYY-MM-DD HH:MM:SS" in UTC senza indicarlo.
  const normalizzato = grezzo.includes('T') ? grezzo : `${grezzo.replace(' ', 'T')}Z`;
  const d = new Date(normalizzato);
  if (Number.isNaN(d.getTime())) return dataIt(iso);
  return d.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function meseIt(aaaaMm) {
  if (!aaaaMm) return '-';
  const [a, m] = String(aaaaMm).split('-').map(Number);
  const nomi = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  return `${nomi[m - 1] || '?'} ${String(a).slice(2)}`;
}

function meseEstesoIt(aaaaMm) {
  if (!aaaaMm) return '-';
  const [a, m] = String(aaaaMm).split('-').map(Number);
  const nomi = [
    'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
    'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
  ];
  return `${nomi[m - 1] || '?'} ${a}`;
}

function classeStato(stato) {
  if (stato === 'approvato') return 'stato--approvato';
  if (stato === 'rifiutato') return 'stato--rifiutato';
  return 'stato--attesa';
}

function etichettaStato(stato) {
  if (stato === 'approvato') return 'Approvato';
  if (stato === 'rifiutato') return 'Rifiutato';
  return 'In attesa';
}

/** Classe di colore in base al segno, per gli importi. */
function segno(n) {
  const v = Number(n) || 0;
  if (v > 0.005) return 'num--positivo';
  if (v < -0.005) return 'num--negativo';
  return '';
}

/** Livello di rientro nelle tabelle gerarchiche, limitato a 4 per non sfondare. */
function rientro(livello) {
  const l = Math.min(Number(livello) || 0, 4);
  return l > 0 ? `rientro-${l}` : '';
}

module.exports = {
  euro,
  numero,
  percentuale,
  dataIt,
  dataOraIt,
  meseIt,
  meseEstesoIt,
  classeStato,
  etichettaStato,
  segno,
  rientro
};
