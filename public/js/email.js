// Setzt geschützte E-Mail-Adressen (a.eml[data-e]) zu Link und Text zusammen.
(function () {
  function decode(e) {
    try {
      return atob(e).split('').reverse().join('');
    } catch (err) {
      return null;
    }
  }
  function run() {
    var links = document.querySelectorAll('a.eml[data-e]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var addr = decode(a.getAttribute('data-e'));
      if (!addr) continue;
      var s = a.getAttribute('data-s');
      a.setAttribute('href', 'mailto:' + addr + (s ? '?subject=' + encodeURIComponent(s) : ''));
      var t = a.querySelectorAll('.eml-t');
      for (var j = 0; j < t.length; j++) t[j].textContent = addr;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
