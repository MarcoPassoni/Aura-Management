// Modello base per utenti (Admin, Pre-Admin, PR) con crittografia automatica
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Path del database - usa volume Railway se disponibile
// DB_PATH ha la precedenza: serve ai test e agli script di verifica per
// lavorare su un database usa e getta senza toccare quello di sviluppo.
const dbPath = process.env.DB_PATH
  ? process.env.DB_PATH
  : process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'iconic.db')
  : './iconic.db';

// [PRODUCTION] Removed console.log('📁 Database path:', dbPath)
const db = new sqlite3.Database(dbPath);
const { encryptUserData, decryptUserData, decryptUserArray } = require('../utils/crypto');

// Crea tabelle se non esistono
const initDB = () => {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      cognome TEXT NOT NULL,
      numero_telefono TEXT NOT NULL,
      nickname TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS pre_admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fk_admin INTEGER,
      nome TEXT NOT NULL,
      cognome TEXT NOT NULL,
      numero_telefono TEXT NOT NULL,
      nickname TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      FOREIGN KEY(fk_admin) REFERENCES admin(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS pr (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fk_padre INTEGER,
      nome TEXT NOT NULL,
      cognome TEXT NOT NULL,
      numero_telefono TEXT NOT NULL,
      nickname TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      percentuale_provvigione REAL,
      poteri BOOLEAN DEFAULT 0,
      provvigioni_da_pagare REAL DEFAULT 0,
      tot_spesa_tavolo REAL DEFAULT 0,
      tot_persone_portate INTEGER DEFAULT 0,
      provvigioni_totali_maturate REAL DEFAULT 0,
      provvigioni_totali_pagate REAL DEFAULT 0,
      attivo INTEGER DEFAULT 1,
      deleted_at TEXT,
      FOREIGN KEY(fk_padre) REFERENCES admin(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS storico_tavoli (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      numero_persone INTEGER NOT NULL,
      nome_tavolo TEXT NOT NULL,
      spesa_prevista REAL NOT NULL,
      omaggi TEXT,
      note_tavolo TEXT,
      modificata INTEGER DEFAULT 0,
      note_modifiche TEXT,
      modificato_da_nickname TEXT,
      FOREIGN KEY(pr_id) REFERENCES pr(id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS andamento_staff_mensile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      mese TEXT NOT NULL, -- formato YYYY-MM
      totale_mese REAL NOT NULL DEFAULT 0,
      UNIQUE(pr_id, mese),
      FOREIGN KEY(pr_id) REFERENCES pr(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS richieste_tavoli (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      numero_persone INTEGER NOT NULL,
      spesa_prevista REAL NOT NULL,
      omaggi TEXT,
      nome_tavolo TEXT NOT NULL,
      note_tavolo TEXT,
      stato TEXT NOT NULL DEFAULT 'in attesa', -- in attesa, approvata, rifiutata
      modificata INTEGER DEFAULT 0,
      note_modifiche TEXT,
      modificato_da_nickname TEXT,
      FOREIGN KEY(pr_id) REFERENCES pr(id)
    )`);

    // Tabella per statistiche mensili dei PR
    db.run(`CREATE TABLE IF NOT EXISTS pr_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      anno INTEGER NOT NULL,
      mese INTEGER NOT NULL,
      totale_persone INTEGER DEFAULT 0,
      totale_tavoli INTEGER DEFAULT 0,
      totale_provvigioni REAL DEFAULT 0,
      UNIQUE(pr_id, anno, mese),
      FOREIGN KEY(pr_id) REFERENCES pr(id)
    )`);

    // Tabella per i pagamenti delle provvigioni tra PR
    db.run(`CREATE TABLE IF NOT EXISTS pagamenti_provvigioni (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_destinatario_id INTEGER NOT NULL,
      pr_pagante_id INTEGER NOT NULL,
      importo REAL NOT NULL,
      note TEXT,
      data_pagamento DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(pr_destinatario_id) REFERENCES pr(id),
      FOREIGN KEY(pr_pagante_id) REFERENCES pr(id)
    )`);

    // Tabella per le richieste di creazione di nuovi PR
    db.run(`CREATE TABLE IF NOT EXISTS richieste_creazione_pr (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      cognome TEXT NOT NULL,
      numero_telefono TEXT NOT NULL,
      nickname TEXT NOT NULL,
      password TEXT NOT NULL,
      percentuale_provvigione REAL,
      data_richiesta DATETIME DEFAULT CURRENT_TIMESTAMP,
      stato TEXT NOT NULL DEFAULT 'in attesa',
      note TEXT,
      fk_richiedente INTEGER,
      fk_padre_proposto INTEGER,
      note_admin TEXT,
      data_risposta DATETIME,
      FOREIGN KEY(fk_richiedente) REFERENCES pr(id),
      FOREIGN KEY(fk_padre_proposto) REFERENCES pr(id)
    )`);
    
    // Migrazione automatica: aggiorna la tabella richieste_creazione_pr se necessario
    db.all(`PRAGMA table_info(richieste_creazione_pr)`, [], (err, columns) => {
      if (err) {
        console.error('❌ Errore verifica struttura richieste_creazione_pr:', err.message);
        return;
      }
      
      const existingColumns = columns.map(col => col.name);
      const requiredColumns = ['fk_padre_proposto', 'note_admin', 'data_risposta'];
      const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));
      
      if (missingColumns.length > 0) {
        // [PRODUCTION] Removed console.log('🔄 Migrazione database: aggiornamento tabella richieste_creazione_pr...')
        
        // Controlla se esiste il vincolo UNIQUE problematico
        db.all(`PRAGMA index_list(richieste_creazione_pr)`, [], (err, indexes) => {
          const hasUniqueNickname = indexes && indexes.some(idx => 
            idx.unique && idx.name.includes('nickname')
          );
          
          if (hasUniqueNickname || missingColumns.length > 0) {
            // Ricreare la tabella per rimuovere il vincolo UNIQUE e aggiungere colonne
            // [PRODUCTION] Removed console.log('🔧 Ricreazione tabella per rimuovere vincolo UNIQUE e aggiungere colonne...')
            
            db.run(`CREATE TABLE richieste_creazione_pr_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              nome TEXT NOT NULL,
              cognome TEXT NOT NULL,
              numero_telefono TEXT NOT NULL,
              nickname TEXT NOT NULL,
              password TEXT NOT NULL,
              percentuale_provvigione REAL,
              data_richiesta DATETIME DEFAULT CURRENT_TIMESTAMP,
              stato TEXT NOT NULL DEFAULT 'in attesa',
              note TEXT,
              fk_richiedente INTEGER,
              fk_padre_proposto INTEGER,
              note_admin TEXT,
              data_risposta DATETIME,
              FOREIGN KEY(fk_richiedente) REFERENCES pr(id),
              FOREIGN KEY(fk_padre_proposto) REFERENCES pr(id)
            )`, (err) => {
              if (err) {
                console.error('❌ Errore creazione tabella nuova:', err.message);
                return;
              }
              
              // Copia i dati esistenti
              const copyColumns = existingColumns.filter(col => 
                ['id', 'nome', 'cognome', 'numero_telefono', 'nickname', 'password', 
                 'percentuale_provvigione', 'data_richiesta', 'stato', 'note', 'fk_richiedente'].includes(col)
              );
              
              if (copyColumns.length > 0) {
                const copyQuery = `INSERT INTO richieste_creazione_pr_new (${copyColumns.join(', ')}) 
                                   SELECT ${copyColumns.join(', ')} FROM richieste_creazione_pr`;
                
                db.run(copyQuery, (err) => {
                  if (err) {
                    console.error('❌ Errore copia dati migrazione:', err.message);
                    return;
                  }
                  
                  // Elimina e rinomina
                  db.run(`DROP TABLE richieste_creazione_pr`, (err) => {
                    if (err) {
                      console.error('❌ Errore eliminazione tabella vecchia:', err.message);
                      return;
                    }
                    
                    db.run(`ALTER TABLE richieste_creazione_pr_new RENAME TO richieste_creazione_pr`, (err) => {
                      if (err) {
                        console.error('❌ Errore rinomina tabella:', err.message);
                        return;
                      }
                      
                      // [PRODUCTION] Removed console.log('✅ Migrazione completata: vincolo UNIQUE rimosso e colonne aggiunte')
                    });
                  });
                });
              } else {
                // Se non ci sono dati da copiare, procedi direttamente
                db.run(`DROP TABLE richieste_creazione_pr`, (err) => {
                  if (err) {
                    console.error('❌ Errore eliminazione tabella vecchia:', err.message);
                    return;
                  }
                  
                  db.run(`ALTER TABLE richieste_creazione_pr_new RENAME TO richieste_creazione_pr`, (err) => {
                    if (err) {
                      console.error('❌ Errore rinomina tabella:', err.message);
                      return;
                    }
                    
                    // [PRODUCTION] Removed console.log('✅ Migrazione completata: tabella ricreata con struttura corretta')
                  });
                });
              }
            });
          } else {
            // Aggiungi solo le colonne mancanti
            missingColumns.forEach(column => {
              const columnDef = {
                'fk_padre_proposto': 'INTEGER',
                'note_admin': 'TEXT',
                'data_risposta': 'DATETIME'
              };
              
              db.run(`ALTER TABLE richieste_creazione_pr ADD COLUMN ${column} ${columnDef[column]}`, (err) => {
                if (err) {
                  console.error(`❌ Errore aggiunta colonna ${column}:`, err.message);
                } else {
                  // [PRODUCTION] Removed console.log(`✅ Colonna ${column} aggiunta`)
                }
              });
            });
          }
        });
      } else {
        // [PRODUCTION] Removed console.log('✅ Tabella richieste_creazione_pr già aggiornata')
      }
    });

    // Migrazione soft-delete PR: aggiunge colonne se mancanti
    db.all(`PRAGMA table_info(pr)`, [], (err, prColumns) => {
      if (err) return;
      const prExisting = prColumns.map(c => c.name);
      const toAdd = [];
      if (!prExisting.includes('attivo')) toAdd.push({ name: 'attivo', def: 'INTEGER DEFAULT 1' });
      if (!prExisting.includes('deleted_at')) toAdd.push({ name: 'deleted_at', def: 'TEXT' });
      toAdd.forEach(col => {
        db.run(`ALTER TABLE pr ADD COLUMN ${col.name} ${col.def}`, () => {});
      });
    });
  });
};

// Funzione di utilità per inserire un admin di default (Admin/AdminPassword123!)
function creaAdminDefault() {
  const bcrypt = require('bcryptjs');
  db.get('SELECT * FROM admin WHERE nickname = ?', ['Admin'], (err, row) => {
    if (!row) {
      bcrypt.hash('AdminPassword123!', 10, (err, hash) => {
        // Cripta i dati personali dell'admin di default
        const adminData = encryptUserData({
          nome: 'Aura',
          cognome: 'Administrator',
          numero_telefono: '0000000000'
        });
        
        db.run('INSERT INTO admin (nome, cognome, numero_telefono, nickname, password) VALUES (?, ?, ?, ?, ?)', 
          [adminData.nome, adminData.cognome, adminData.numero_telefono, 'Admin', hash], (err2) => {
          if (!err2) {
            console.log('👑 Admin di default creato: Admin / AdminPassword123!');
          }
        });
      });
    }
  });
}

// NOTA: initDB() e creaAdminDefault() venivano eseguite qui come effetto
// collaterale del require. Bastava importare il modulo (anche da uno script di
// manutenzione o da un test) per ricreare le tabelle e inserire un admin con
// password nota. Ora l'avvio e' esplicito e avviene solo in server.js.

// Funzioni helper per la gestione automatica della crittografia

/**
 * Inserisce un nuovo utente con crittografia automatica
 * @param {string} table - Nome della tabella (admin, pre_admin, pr)
 * @param {Object} userData - Dati dell'utente da inserire
 * @param {Function} callback - Callback di completamento
 */
function insertUser(table, userData, callback) {
  try {
    // Cripta i dati sensibili
    const encryptedData = encryptUserData(userData);
    
    // Prepara i campi e i valori per l'inserimento
    const fields = Object.keys(encryptedData);
    const placeholders = fields.map(() => '?').join(', ');
    const values = fields.map(field => encryptedData[field]);
    
    const query = `INSERT INTO ${table} (${fields.join(', ')}) VALUES (${placeholders})`;
    
    db.run(query, values, function(err) {
      if (callback) {
        callback(err, err ? null : { id: this.lastID, changes: this.changes });
      }
    });
    
  } catch (error) {
    if (callback) callback(error);
  }
}

/**
 * Aggiorna un utente con crittografia automatica
 * @param {string} table - Nome della tabella
 * @param {number} userId - ID dell'utente da aggiornare
 * @param {Object} userData - Nuovi dati dell'utente
 * @param {Function} callback - Callback di completamento
 */
function updateUser(table, userId, userData, callback) {
  try {
    // Cripta i dati sensibili se presenti
    const dataToUpdate = { ...userData };
    
    // Cripta solo i campi sensibili se presenti
    if (dataToUpdate.nome || dataToUpdate.cognome || dataToUpdate.numero_telefono) {
      const sensitiveData = {};
      if (dataToUpdate.nome) sensitiveData.nome = dataToUpdate.nome;
      if (dataToUpdate.cognome) sensitiveData.cognome = dataToUpdate.cognome;
      if (dataToUpdate.numero_telefono) sensitiveData.numero_telefono = dataToUpdate.numero_telefono;
      
      const encryptedSensitive = encryptUserData(sensitiveData);
      Object.assign(dataToUpdate, encryptedSensitive);
    }
    
    // Prepara la query di aggiornamento
    const fields = Object.keys(dataToUpdate);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const values = [...fields.map(field => dataToUpdate[field]), userId];
    
    const query = `UPDATE ${table} SET ${setClause} WHERE id = ?`;
    
    db.run(query, values, function(err) {
      if (callback) {
        callback(err, err ? null : { changes: this.changes });
      }
    });
    
  } catch (error) {
    if (callback) callback(error);
  }
}

/**
 * Recupera un singolo utente con decrittografia automatica
 * @param {string} table - Nome della tabella
 * @param {number} userId - ID dell'utente
 * @param {Function} callback - Callback con i dati decrittografati
 */
function getUserById(table, userId, callback) {
  const query = `SELECT * FROM ${table} WHERE id = ?`;
  
  db.get(query, [userId], (err, row) => {
    if (err) {
      if (callback) callback(err);
      return;
    }
    
    if (row) {
      // Decritta i dati sensibili
      const decryptedUser = decryptUserData(row);
      if (callback) callback(null, decryptedUser);
    } else {
      if (callback) callback(null, null);
    }
  });
}

/**
 * Recupera tutti gli utenti di una tabella con decrittografia automatica
 * @param {string} table - Nome della tabella
 * @param {string} whereClause - Clausola WHERE opzionale
 * @param {Array} params - Parametri per la clausola WHERE
 * @param {Function} callback - Callback con array di utenti decrittografati
 */
function getAllUsers(table, whereClause = '', params = [], callback) {
  // Se whereClause è una funzione, significa che non ci sono parametri WHERE
  if (typeof whereClause === 'function') {
    callback = whereClause;
    whereClause = '';
    params = [];
  }
  
  let query = `SELECT * FROM ${table}`;
  if (whereClause) {
    query += ` WHERE ${whereClause}`;
  }
  
  db.all(query, params, (err, rows) => {
    if (err) {
      if (callback) callback(err);
      return;
    }
    
    // Decritta tutti i record
    const decryptedUsers = decryptUserArray(rows);
    if (callback) callback(null, decryptedUsers);
  });
}

/**
 * Cerca utenti per nickname (non crittografato)
 * @param {string} table - Nome della tabella
 * @param {string} nickname - Nickname da cercare
 * @param {Function} callback - Callback con i risultati
 */
function getUserByNickname(table, nickname, callback) {
  const query = `SELECT * FROM ${table} WHERE nickname = ?`;
  
  db.get(query, [nickname], (err, row) => {
    if (err) {
      if (callback) callback(err);
      return;
    }
    
    if (row) {
      const decryptedUser = decryptUserData(row);
      if (callback) callback(null, decryptedUser);
    } else {
      if (callback) callback(null, null);
    }
  });
}

/**
 * Elimina un utente
 * @param {string} table - Nome della tabella
 * @param {number} userId - ID dell'utente da eliminare
 * @param {Function} callback - Callback di completamento
 */
function deleteUser(table, userId, callback) {
  // Soft delete per PR per mantenere storico ricavi
  if (table === 'pr') {
    const query = `UPDATE pr SET attivo = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ?`;
    db.run(query, [userId], function(err) {
      if (callback) callback(err, err ? null : { changes: this.changes, softDeleted: true });
    });
    return;
  }
  const query = `DELETE FROM ${table} WHERE id = ?`;
  db.run(query, [userId], function(err) {
    if (callback) callback(err, err ? null : { changes: this.changes });
  });
}

/**
 * Soft delete esplicito per PR (API interna)
 */
function softDeleteUser(userId, callback) {
  const query = `UPDATE pr SET attivo = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.run(query, [userId], function(err) {
    if (callback) callback(err, err ? null : { changes: this.changes, softDeleted: true });
  });
}

module.exports = { 
  db, 
  initDB, 
  creaAdminDefault,
  // Funzioni per la gestione crittografata degli utenti
  insertUser,
  updateUser,
  getUserById,
  getAllUsers,
  getUserByNickname,
  deleteUser,
  softDeleteUser
};

/**
 * Verifica se un nickname esiste già in una delle tabelle utenti attive
 * @param {string} nickname
 * @param {(err: Error|null, exists: boolean)=>void} callback
 */
function nicknameExists(nickname, callback) {
  const sql = `SELECT nickname FROM admin WHERE nickname = ?
    UNION SELECT nickname FROM pre_admin WHERE nickname = ?
    UNION SELECT nickname FROM pr WHERE nickname = ?`;
  db.get(sql, [nickname, nickname, nickname], (err, row) => {
    if (err) return callback(err);
    callback(null, !!row);
  });
}

module.exports.nicknameExists = nicknameExists;
