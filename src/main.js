// MIDNIGHT APEX — entry point. Boots the game core behind the loading veil.
import { initEmbed } from '@genex-ai/embed-sdk';
import { GENEX } from './genex.config';
import { Game } from './core/game.js';

// Genex player identity (guest or signed-in). Must run first; never blocks rendering.
initEmbed({ slug: GENEX.slug, apiUrl: GENEX.apiUrl, dashboardOrigins: GENEX.dashboardOrigins });

const veil = document.getElementById('veil');

function fatal(msg, err) {
  console.error('[core] fatal:', err || msg);
  const el = document.createElement('div');
  el.className = 'veil-error';
  el.textContent = msg;
  document.body.appendChild(el);
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

if (!webglAvailable()) {
  fatal('MIDNIGHT APEX needs WebGL 2. Please use a recent desktop browser with hardware acceleration enabled.');
} else {
  const game = new Game({ container: document.getElementById('app'), veil });
  game.init().catch((e) => fatal('Something went wrong while loading. See the console for details.', e));
}
