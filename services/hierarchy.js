// Gestione dell'albero gerarchico dei PR.
//
// Nel codice originale la gerarchia veniva ricalcolata in almeno sei punti diversi
// con implementazioni divergenti (ricorsione a callback, CTE ricorsive con limiti
// arbitrari a 6/10 livelli, filtri in JS). Qui viene caricata UNA volta e tutte le
// operazioni successive avvengono in memoria.
//
// `pr.fk_padre` e' polimorfico: punta a `admin.id` per i PR di primo livello e a
// `pr.id` per tutti gli altri. La distinzione si fa verificando l'esistenza
// dell'id nell'insieme dei PR, non con un confronto hardcoded (l'originale
// assumeva `admin.id === 1`, cosa gia' falsa sui dati reali).

const { all } = require('./db-helpers');

const MAX_DEPTH = 50; // guardia contro cicli residui nei dati

class Hierarchy {
  constructor(prRows, adminRows) {
    this.byId = new Map();
    this.adminIds = new Set(adminRows.map((a) => a.id));
    this.admins = new Map(adminRows.map((a) => [a.id, a]));

    for (const row of prRows) {
      this.byId.set(row.id, {
        ...row,
        percentuale_provvigione: Number(row.percentuale_provvigione) || 0,
        children: [],
        parent: null,
        adminId: null,
        depth: 0
      });
    }

    // Collega padri e figli usando `padre_tipo`, che dice senza ambiguita' se
    // fk_padre si riferisce alla tabella admin o alla tabella pr: i due insiemi
    // di identificativi si sovrappongono, quindi il solo numero non basta.
    for (const node of this.byId.values()) {
      const parentId = node.fk_padre;
      if (parentId == null) continue;

      if (node.padre_tipo === 'admin') {
        if (this.adminIds.has(parentId)) node.adminId = parentId;
        continue;
      }

      const parentNode = this.byId.get(parentId);
      if (parentNode && parentNode.id !== node.id) {
        node.parent = parentNode;
        parentNode.children.push(node);
      }
      // Un fk_padre che non risolve resta orfano (parent null) invece di far
      // esplodere i calcoli.
    }

    this.roots = [...this.byId.values()].filter((n) => n.parent === null);
    this._computeDepthsAndAdmin();
  }

  // Assegna profondita' e admin di appartenenza scendendo dalle radici.
  // I nodi non raggiungibili dalle radici fanno parte di un ciclo: li isoliamo
  // e li segnaliamo invece di lasciarli propagare valori sbagliati.
  _computeDepthsAndAdmin() {
    const visited = new Set();
    const stack = this.roots.map((node) => ({ node, depth: 0, adminId: node.adminId }));

    while (stack.length) {
      const { node, depth, adminId } = stack.pop();
      if (visited.has(node.id) || depth > MAX_DEPTH) continue;
      visited.add(node.id);
      node.depth = depth;
      node.adminId = adminId;
      for (const child of node.children) {
        stack.push({ node: child, depth: depth + 1, adminId });
      }
    }

    // I nodi non raggiungibili dalle radici fanno parte di un ciclo. Non si
    // stampa nulla a video: la gerarchia viene caricata a ogni richiesta e il
    // log si riempirebbe della stessa riga. L'elenco resta disponibile e la
    // pagina Verifica lo mostra a chi puo' intervenire.
    this.orphanedByCycle = [...this.byId.values()].filter((n) => !visited.has(n.id));
  }

  get(prId) {
    return this.byId.get(Number(prId)) || null;
  }

  /** Il nodo e i suoi discendenti, in ordine di visita dall'alto. */
  subtree(prId) {
    const start = this.get(prId);
    if (!start) return [];
    const out = [];
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const node = stack.pop();
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push(node);
      stack.push(...node.children);
    }
    return out;
  }

  /** Solo i discendenti, escluso il nodo stesso. */
  descendants(prId) {
    return this.subtree(prId).filter((n) => n.id !== Number(prId));
  }

  /** Catena dei padri, dal piu' vicino al piu' lontano. */
  ancestors(prId) {
    const out = [];
    let current = this.get(prId);
    let guard = 0;
    while (current && current.parent && guard++ < MAX_DEPTH) {
      out.push(current.parent);
      current = current.parent;
    }
    return out;
  }

  /** Tutti i PR che ricadono sotto un admin, a qualsiasi profondita'. */
  forAdmin(adminId) {
    const id = Number(adminId);
    return [...this.byId.values()].filter((n) => n.adminId === id);
  }

  /** I PR di primo livello di un admin: sono quelli che l'admin paga di tasca propria. */
  rootsForAdmin(adminId) {
    const id = Number(adminId);
    return this.roots.filter((n) => n.adminId === id);
  }

  /** Un admin puo' operare solo sui PR della propria gerarchia. */
  isInAdminScope(adminId, prId) {
    const node = this.get(prId);
    return !!node && node.adminId === Number(adminId);
  }

  /**
   * Verifica se un collaboratore puo' essere spostato sotto un nuovo
   * responsabile, restituendo il motivo preciso quando non si puo'.
   *
   * Sono tre condizioni distinte e vanno distinte anche nel messaggio: chi
   * sposta deve capire se ha sbagliato bersaglio, se creerebbe un anello, o se
   * romperebbe il vincolo sulle percentuali.
   */
  puoSpostare(prId, nuovoPadre) {
    const nodo = this.get(prId);
    if (!nodo) return { ok: false, motivo: 'Collaboratore non trovato.' };

    if (nuovoPadre.tipo === 'admin') {
      if (!this.adminIds.has(Number(nuovoPadre.id))) {
        return { ok: false, motivo: "L'amministrazione indicata non esiste." };
      }
      const figlioTroppoAlto = nodo.children.find(
        (c) => c.percentuale_provvigione > nodo.percentuale_provvigione
      );
      if (figlioTroppoAlto) {
        return {
          ok: false,
          motivo:
            `${figlioTroppoAlto.nickname} ha il ${figlioTroppoAlto.percentuale_provvigione}%, ` +
            `piu' di ${nodo.nickname} (${nodo.percentuale_provvigione}%): sistema prima le percentuali.`
        };
      }
      return { ok: true };
    }

    const padre = this.get(nuovoPadre.id);
    if (!padre) return { ok: false, motivo: 'Il responsabile indicato non esiste.' };
    if (padre.id === nodo.id) {
      return { ok: false, motivo: 'Un collaboratore non puo\' essere responsabile di se stesso.' };
    }

    // Spostare qualcuno sotto un proprio discendente chiuderebbe un anello:
    // la catena non arriverebbe piu' all'amministrazione e nessun tavolo
    // sarebbe piu' approvabile.
    const discendenti = new Set(this.descendants(nodo.id).map((n) => n.id));
    if (discendenti.has(padre.id)) {
      return {
        ok: false,
        motivo:
          `${padre.nickname} dipende da ${nodo.nickname}: assegnandolo come responsabile ` +
          'si creerebbe un anello nella struttura.'
      };
    }

    if (nodo.percentuale_provvigione > padre.percentuale_provvigione) {
      return {
        ok: false,
        motivo:
          `${nodo.nickname} ha il ${nodo.percentuale_provvigione}% e ${padre.nickname} solo il ` +
          `${padre.percentuale_provvigione}%: il responsabile ci rimetterebbe su ogni tavolo.`
      };
    }

    return { ok: true };
  }

  /**
   * Il modello differenziale richiede che la percentuale non diminuisca mai
   * salendo nella gerarchia: se un figlio guadagna piu' del padre, il padre
   * lavorerebbe in perdita. L'originale non lo verificava e mascherava il
   * risultato negativo con Math.max(0, ...), falsando i report.
   */
  validatePercentages() {
    const problemi = [];
    for (const node of this.byId.values()) {
      if (!node.parent) continue;
      if (node.percentuale_provvigione > node.parent.percentuale_provvigione) {
        problemi.push({
          prId: node.id,
          nickname: node.nickname,
          percentuale: node.percentuale_provvigione,
          padreId: node.parent.id,
          padreNickname: node.parent.nickname,
          percentualePadre: node.parent.percentuale_provvigione,
          messaggio:
            `${node.nickname} ha il ${node.percentuale_provvigione}% ma il suo responsabile ` +
            `${node.parent.nickname} ha solo il ${node.parent.percentuale_provvigione}%: ` +
            'il responsabile ci rimetterebbe su ogni tavolo.'
        });
      }
    }
    return problemi;
  }
}

/**
 * Carica la gerarchia dal database.
 * Di default esclude i PR disattivati dalla struttura ma NON dai calcoli storici:
 * chi e' stato disattivato mantiene i tavoli gia' fatti (vedi commissions.js).
 */
async function loadHierarchy({ includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE COALESCE(attivo, 1) = 1';
  const [prRows, adminRows] = await Promise.all([
    all(`SELECT id, fk_padre, COALESCE(padre_tipo, 'pr') AS padre_tipo, nickname,
                nome, cognome, percentuale_provvigione, poteri,
                COALESCE(attivo, 1) AS attivo, deleted_at
         FROM pr ${where}`),
    all('SELECT id, nickname FROM admin')
  ]);
  return new Hierarchy(prRows, adminRows);
}

module.exports = { Hierarchy, loadHierarchy, MAX_DEPTH };
