'use strict';

const nav = document.getElementById('help-nav');
const content = document.getElementById('help-content');
const entries = Array.from(content.querySelectorAll('section[id]'));
const links = Array.from(nav.querySelectorAll('a[href^="#"]'));

function showEntry() {
  const requested = location.hash.slice(1);
  const entry = entries.find(item => item.id === requested) || entries[0];
  for (const item of entries) item.hidden = item !== entry;
  for (const link of links) {
    if (link.hash === '#' + entry.id) {
      link.setAttribute('aria-current', 'page');
      const group = link.closest('details');
      if (group) group.open = true;
    } else {
      link.removeAttribute('aria-current');
    }
  }
  document.title = entry.querySelector('h2').textContent + ' · 喜悦 Voice 配置指南';
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', showEntry);
showEntry();
