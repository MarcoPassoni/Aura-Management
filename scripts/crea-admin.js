// Crea il primo amministratore.
//
// L'originale inseriva automaticamente un admin con nickname "Admin" e password
// "AdminPassword123!" a ogni avvio, scritta in chiaro nel codice sorgente
// pubblicato: chiunque conoscesse il progetto poteva entrare. Ora la creazione
// e' un'operazione esplicita e la password la scegli tu.
//
// Uso:
//   node scripts/crea-admin.js <nickname> <password> [nome] [cognome] [telefono]

const { initSchema } = require('../models/schema');
const utenti = require('../services/users');
const v = require('../services/validation');

(async () => {
  const [, , nickname, password, nome = 'Amministratore', cognome = 'Aura', telefono = '3000000000'] =
    process.argv;

  if (!nickname || !password) {
    console.log('Uso: node scripts/crea-admin.js <nickname> <password> [nome] [cognome] [telefono]');
    console.log('La password deve avere almeno 10 caratteri, con una lettera e un numero.');
    process.exit(1);
  }

  try {
    await initSchema();

    const nick = v.nickname(nickname);
    const pwd = v.password(password);

    if (await utenti.nicknameEsiste(nick)) {
      console.error(`Il nickname "${nick}" e' gia' in uso.`);
      process.exit(1);
    }

    const id = await utenti.creaAdmin({
      nome: v.nome(nome),
      cognome: v.nome(cognome, 'Il cognome'),
      numero_telefono: v.telefono(telefono),
      nickname: nick,
      password: pwd
    });

    console.log(`Amministratore "${nick}" creato con id ${id}.`);
    console.log('Accedi da http://localhost:3000/login');
    process.exit(0);
  } catch (err) {
    console.error('Errore:', err.message);
    process.exit(1);
  }
})();
