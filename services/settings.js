// Impostazioni economiche configurabili per admin.
//
// Nell'originale la quota locale (85%) e le detrazioni (passo 20%, cassa 15%,
// cuzzo 15%) erano numeri fissi dentro routes/admin.js, con nomi incomprensibili
// e impossibili da cambiare senza toccare il codice. Ora vivono nel database,
// sono modificabili dall'interfaccia e ogni admin ha le proprie.

const { all, get, run, transaction } = require('./db-helpers');

const DEFAULT_QUOTA_LOCALE = 85; // % dell'incasso che resta al locale
const DEFAULT_DETRAZIONI = [
  { nome: 'Passo', percentuale: 20, ordine: 1 },
  { nome: 'Cassa', percentuale: 15, ordine: 2 },
  { nome: 'Cuzzo', percentuale: 15, ordine: 3 }
];

async function initSettingsSchema() {
  await run(`CREATE TABLE IF NOT EXISTS impostazioni (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    chiave TEXT NOT NULL,
    valore TEXT NOT NULL,
    UNIQUE(admin_id, chiave),
    FOREIGN KEY(admin_id) REFERENCES admin(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS detrazioni (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    percentuale REAL NOT NULL DEFAULT 0,
    ordine INTEGER NOT NULL DEFAULT 0,
    attiva INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(admin_id) REFERENCES admin(id) ON DELETE CASCADE
  )`);
}

/** Crea le impostazioni di default per un admin che non le ha ancora. */
async function ensureDefaults(adminId) {
  const esistente = await get('SELECT 1 AS ok FROM impostazioni WHERE admin_id = ? AND chiave = ?', [
    adminId,
    'quota_locale'
  ]);
  if (esistente) return;

  await transaction(async (tx) => {
    await tx.run('INSERT OR IGNORE INTO impostazioni (admin_id, chiave, valore) VALUES (?, ?, ?)', [
      adminId,
      'quota_locale',
      String(DEFAULT_QUOTA_LOCALE)
    ]);
    for (const d of DEFAULT_DETRAZIONI) {
      await tx.run(
        'INSERT INTO detrazioni (admin_id, nome, percentuale, ordine, attiva) VALUES (?, ?, ?, ?, 1)',
        [adminId, d.nome, d.percentuale, d.ordine]
      );
    }
  });
}

async function getImpostazioni(adminId) {
  await ensureDefaults(adminId);

  const [righe, detrazioni] = await Promise.all([
    all('SELECT chiave, valore FROM impostazioni WHERE admin_id = ?', [adminId]),
    all(
      'SELECT id, nome, percentuale, ordine, attiva FROM detrazioni WHERE admin_id = ? AND attiva = 1 ORDER BY ordine, id',
      [adminId]
    )
  ]);

  const mappa = new Map(righe.map((r) => [r.chiave, r.valore]));
  const quotaLocale = clampPercent(parseFloat(mappa.get('quota_locale')), DEFAULT_QUOTA_LOCALE);

  return {
    quotaLocale,
    // Quota che resta all'admin prima delle provvigioni e delle detrazioni.
    quotaAdmin: round2(100 - quotaLocale),
    detrazioni: detrazioni.map((d) => ({
      id: d.id,
      nome: d.nome,
      percentuale: clampPercent(Number(d.percentuale), 0)
    }))
  };
}

async function setQuotaLocale(adminId, valore) {
  const pulito = clampPercent(Number(valore), null);
  if (pulito === null) throw new Error('La quota locale deve essere un numero tra 0 e 100.');
  await ensureDefaults(adminId);
  await run(
    `INSERT INTO impostazioni (admin_id, chiave, valore) VALUES (?, 'quota_locale', ?)
     ON CONFLICT(admin_id, chiave) DO UPDATE SET valore = excluded.valore`,
    [adminId, String(pulito)]
  );
  return pulito;
}

async function salvaDetrazioni(adminId, elenco) {
  if (!Array.isArray(elenco)) throw new Error('Formato detrazioni non valido.');

  const pulite = elenco
    .map((d, i) => ({
      nome: String(d.nome || '').trim().slice(0, 40),
      percentuale: clampPercent(Number(d.percentuale), null),
      ordine: i + 1
    }))
    .filter((d) => d.nome.length > 0);

  if (pulite.some((d) => d.percentuale === null)) {
    throw new Error('Ogni detrazione deve avere una percentuale tra 0 e 100.');
  }
  const somma = pulite.reduce((s, d) => s + d.percentuale, 0);
  if (somma > 100) {
    throw new Error(
      `Le detrazioni sommano al ${round2(somma)}%: non possono superare il 100% del guadagno lordo.`
    );
  }

  await ensureDefaults(adminId);
  await transaction(async (tx) => {
    await tx.run('DELETE FROM detrazioni WHERE admin_id = ?', [adminId]);
    for (const d of pulite) {
      await tx.run(
        'INSERT INTO detrazioni (admin_id, nome, percentuale, ordine, attiva) VALUES (?, ?, ?, ?, 1)',
        [adminId, d.nome, d.percentuale, d.ordine]
      );
    }
  });
  return pulite;
}

function clampPercent(valore, fallback) {
  if (!Number.isFinite(valore) || valore < 0 || valore > 100) return fallback;
  return round2(valore);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = {
  initSettingsSchema,
  ensureDefaults,
  getImpostazioni,
  setQuotaLocale,
  salvaDetrazioni,
  DEFAULT_QUOTA_LOCALE,
  DEFAULT_DETRAZIONI
};
