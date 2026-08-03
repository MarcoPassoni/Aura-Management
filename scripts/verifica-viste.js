// Controllo di sintassi su tutti i template EJS.
//
// Un errore di sintassi in una vista non si vede finche' qualcuno non apre
// quella pagina: il server parte, i test passano, e il problema salta fuori in
// produzione sulla schermata meno frequentata. Questo controllo li trova tutti
// in un secondo, e fa parte di `npm test`.
//
// Verifica la sintassi del singolo file, non gli `include`: quelli richiedono
// di rendere davvero la pagina con i suoi dati.

const fs = require('fs');
const path = require('path');

const cartellaViste = path.join(__dirname, '..', 'views');
const radice = path.join(__dirname, '..');

function elencaTemplate(cartella) {
  const trovati = [];
  for (const voce of fs.readdirSync(cartella, { withFileTypes: true })) {
    const completo = path.join(cartella, voce.name);
    if (voce.isDirectory()) trovati.push(...elencaTemplate(completo));
    else if (voce.name.endsWith('.ejs')) trovati.push(completo);
  }
  return trovati;
}

(async () => {
  // ejs-lint e' distribuito come modulo ES: si carica con import() dinamico,
  // che funziona anche da qui (CommonJS) su qualunque versione recente di Node.
  let lint;
  try {
    const modulo = await import('ejs-lint');
    lint = typeof modulo === 'function' ? modulo : modulo.default;
  } catch (err) {
    console.log('Controllo delle viste saltato: ejs-lint non disponibile.');
    console.log(`(${err.message})`);
    process.exit(0);
  }

  const file = elencaTemplate(cartellaViste).sort();
  let errori = 0;

  for (const f of file) {
    const relativo = path.relative(radice, f);
    try {
      const problema = lint(fs.readFileSync(f, 'utf8'), { filename: f });
      if (problema) {
        errori++;
        console.log(`  ERRORE  ${relativo}`);
        const testo = problema.annotated || problema.message || String(problema);
        console.log(`          ${testo.split('\n').join('\n          ')}`);
      } else {
        console.log(`  ok      ${relativo}`);
      }
    } catch (err) {
      errori++;
      console.log(`  ERRORE  ${relativo}: ${err.message}`);
    }
  }

  console.log('');
  console.log('='.repeat(64));
  console.log(`viste: ${file.length} controllate, ${errori} con errori`);
  console.log('='.repeat(64));

  process.exit(errori > 0 ? 1 : 0);
})();
