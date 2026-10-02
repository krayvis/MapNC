/* Theme: Auto (follows the system) / Light / Dark.
 * Loaded in <head>, before first paint, so the page never flashes the wrong theme. It resolves the preference to
 * data-theme="light"|"dark" on <html>; all styling keys off that attribute. The preference itself is remembered in
 * localStorage when available (private windows or blocked storage just fall back to Auto).
 */
(function () {
  'use strict';
  var KEY = 'mapnc-theme';
  var ORDER = ['auto', 'light', 'dark'];
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function load() {
    try { var v = localStorage.getItem(KEY); return ORDER.indexOf(v) >= 0 ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* storage unavailable: preference lasts for this visit only */ } }

  var pref = load();

  function apply() {
    var dark = pref === 'dark' || (pref === 'auto' && !!mq && mq.matches);
    var root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-theme-pref', pref);
    var btn = document.getElementById('theme-btn');
    if (btn) {
      var label = pref === 'auto' ? 'Auto' : pref === 'dark' ? 'Dark' : 'Light';
      btn.textContent = 'Theme: ' + label;
      btn.setAttribute('aria-label', 'Colour theme: ' + label + '. Activate to change.');
    }
  }

  apply();
  if (mq) {
    var onChange = function () { if (pref === 'auto') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  document.addEventListener('DOMContentLoaded', function () {
    apply();   // the button exists now
    var btn = document.getElementById('theme-btn');
    if (btn) btn.addEventListener('click', function () {
      pref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
      save(pref);
      apply();
    });
  });
})();
