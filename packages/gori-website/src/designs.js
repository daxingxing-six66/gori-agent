import { element } from './dom.js';
import { initializeStudioScene } from './studio-scene.js';
import { mountStudioPage } from './studio-page.js';

export function initializeDesign() {
  const design = document.documentElement.dataset.design ?? 'tabby';
  document.querySelectorAll('[data-design-link]').forEach((link) => {
    if (link.getAttribute('data-design-link') === design) link.setAttribute('aria-current', 'page');
  });
  if (design === 'tabby') {
    const lines = [];
    const glyphs = ' .:0123456789';
    for (let row = 0; row < 46; row += 1) {
      let line = '';
      for (let col = 0; col < 152; col += 1) {
        const dx = (col - 88) / 29;
        const dy = (row - 23) / 15;
        const radius = Math.sqrt(dx * dx + dy * dy);
        const wave = Math.sin(radius * 13 + col / 21) * Math.cos(row / 7);
        const density = Math.max(0, Math.min(1, (wave + 1) * .5 * (1 - Math.min(radius / 4, .8))));
        line += glyphs[Math.floor(density * (glyphs.length - 1))];
      }
      lines.push(line);
    }
    element('#hero-ascii').textContent = lines.join('\n');
  }
  if (design === 'studio') {
    mountStudioPage();
    initializeStudioScene();
  }
}
