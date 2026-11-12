// Dunkelmodus: folgt der Systemeinstellung, Umschalter merkt sich die Wahl.
(function () {
  var KEY = 'th-theme';
  var root = document.documentElement;
  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  var t = stored();
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  function current() {
    var a = root.getAttribute('data-theme');
    if (a) return a;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.addEventListener('DOMContentLoaded', function () {
    var btns = document.querySelectorAll('[data-theme-toggle]');
    function label() {
      btns.forEach(function (b) {
        var dark = current() === 'dark';
        b.setAttribute('aria-pressed', dark ? 'true' : 'false');
        var l = b.querySelector('[data-label]');
        if (l) l.textContent = dark ? (b.dataset.light || 'Hell') : (b.dataset.dark || 'Dunkel');
      });
    }
    btns.forEach(function (b) {
      b.hidden = false;
      b.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem(KEY, next); } catch (e) {}
        label();
      });
    });
    label();
  });
})();
