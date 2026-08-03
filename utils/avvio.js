// Identificativo di questo avvio del processo: otto caratteri esadecimali
// casuali, generati una volta sola al require di questo modulo.
//
// Compare in ogni riga di log (vedi utils/secure-logger.js). Su Railway ogni
// deploy o riavvio crea un processo nuovo che scrive nello stesso flusso di
// log del precedente: senza un identificativo che li distingue, i log di due
// avvii consecutivi (compresi eventuali errori dell'ultimo istante del
// vecchio processo e i primi del nuovo) si mescolano e diventa difficile
// capire "questa riga apparteneva a prima o dopo il riavvio?".

const crypto = require('crypto');

const ID = crypto.randomBytes(4).toString('hex');
const avviatoIl = new Date();

module.exports = { ID, avviatoIl };
