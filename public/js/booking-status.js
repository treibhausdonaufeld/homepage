// Matrix-Bestätigung: alle 4 Sekunden nachsehen, ob die Anfrage bestätigt ist.
(function () {
  var el = document.querySelector('[data-status-poll]');
  if (!el || !window.fetch) return;
  var id = el.getAttribute('data-status-poll');
  var tries = 0;
  function check() {
    if (++tries > 450) return;
    fetch('/api/buchung-status?b=' + encodeURIComponent(id), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.status && d.status !== 'unbestaetigt') window.location.href = '/buchen/danke?b=' + encodeURIComponent(id);
        else setTimeout(check, 4000);
      })
      .catch(function () { setTimeout(check, 8000); });
  }
  setTimeout(check, 4000);
})();
