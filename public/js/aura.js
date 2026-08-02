// Interazioni minime dell'interfaccia. Nessuna libreria esterna: la policy di
// sicurezza (CSP) non consente il caricamento da CDN.
(function () {
  'use strict';

  // ---- Menu laterale su schermi piccoli ----------------------------------
  var guscio = document.getElementById('guscio');
  var apri = document.getElementById('apri-menu');
  var velo = document.getElementById('velo');

  function impostaMenu(aperto) {
    if (!guscio) return;
    guscio.classList.toggle('guscio--menu-aperto', aperto);
    if (apri) apri.setAttribute('aria-expanded', aperto ? 'true' : 'false');
  }

  if (apri) {
    apri.addEventListener('click', function () {
      impostaMenu(!guscio.classList.contains('guscio--menu-aperto'));
    });
  }
  if (velo) velo.addEventListener('click', function () { impostaMenu(false); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') impostaMenu(false);
  });

  // ---- Conferme sulle azioni irreversibili -------------------------------
  // Si usa l'attributo data-conferma invece di onclick inline, che la CSP
  // vieterebbe.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var messaggio = form.getAttribute('data-conferma');
    if (messaggio && !window.confirm(messaggio)) {
      e.preventDefault();
    }
  });

  // ---- Blocco del doppio invio -------------------------------------------
  // Un doppio clic sul pulsante di approvazione o di pagamento inviava due
  // richieste identiche.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.getAttribute('data-conferma') && e.defaultPrevented) return;
    var bottoni = form.querySelectorAll('button[type="submit"]');
    window.setTimeout(function () {
      for (var i = 0; i < bottoni.length; i++) {
        bottoni[i].disabled = true;
      }
    }, 0);
  });

  // ---- Righe espandibili --------------------------------------------------
  document.addEventListener('click', function (e) {
    var innesco = e.target.closest('[data-apre]');
    if (!innesco) return;
    var bersaglio = document.getElementById(innesco.getAttribute('data-apre'));
    if (!bersaglio) return;
    var nascosto = bersaglio.hasAttribute('hidden');
    if (nascosto) {
      bersaglio.removeAttribute('hidden');
    } else {
      bersaglio.setAttribute('hidden', '');
    }
    innesco.setAttribute('aria-expanded', nascosto ? 'true' : 'false');
  });

  // ---- Detrazioni: aggiunta e rimozione di righe ---------------------------
  var contenitoreDetrazioni = document.getElementById('detrazioni');
  var aggiungiDetrazione = document.getElementById('aggiungi-detrazione');

  if (contenitoreDetrazioni && aggiungiDetrazione) {
    aggiungiDetrazione.addEventListener('click', function () {
      var riga = document.createElement('div');
      riga.className = 'filtri';
      riga.style.marginBottom = '.6rem';
      riga.innerHTML =
        '<div class="campo" style="flex:2">' +
        '<label class="campo__etichetta">Voce</label>' +
        '<input type="text" name="detrazione_nome" maxlength="40" required>' +
        '</div>' +
        '<div class="campo" style="flex:1">' +
        '<label class="campo__etichetta">Percentuale</label>' +
        '<input type="number" name="detrazione_percentuale" min="0" max="100" step="0.01" value="0" required>' +
        '</div>' +
        '<button type="button" class="pulsante pulsante--pericolo pulsante--piccolo" data-rimuovi>Rimuovi</button>';
      contenitoreDetrazioni.appendChild(riga);
      aggiornaTotaleDetrazioni();
    });

    contenitoreDetrazioni.addEventListener('click', function (e) {
      if (!e.target.hasAttribute('data-rimuovi')) return;
      var riga = e.target.closest('.filtri');
      if (riga) riga.remove();
      aggiornaTotaleDetrazioni();
    });

    contenitoreDetrazioni.addEventListener('input', aggiornaTotaleDetrazioni);
    aggiornaTotaleDetrazioni();
  }

  function aggiornaTotaleDetrazioni() {
    var esito = document.getElementById('totale-detrazioni');
    if (!esito || !contenitoreDetrazioni) return;
    var campi = contenitoreDetrazioni.querySelectorAll('input[name="detrazione_percentuale"]');
    var totale = 0;
    for (var i = 0; i < campi.length; i++) {
      totale += parseFloat(campi[i].value) || 0;
    }
    esito.textContent = totale.toLocaleString('it-IT', { maximumFractionDigits: 2 }) + '%';
    esito.className = totale > 100 ? 'num num--negativo' : 'num';
  }
})();
