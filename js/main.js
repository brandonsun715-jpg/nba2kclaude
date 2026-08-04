/* =============================================================================
 * main.js  —  Boots the game.
 * -----------------------------------------------------------------------------
 * Load order in index.html already guarantees every BB.* namespace exists by
 * the time this file runs. This file's only job is to initialise each system
 * once, in the order that respects their dependencies, then hand control to
 * the engine.
 * ========================================================================== */
(function () {
  'use strict';

  function boot() {
    const BB = window.BB;
    const canvas = document.getElementById('game-canvas');

    /* Settings before anything that reads a setting. */
    BB.Settings.init();

    /* Input needs the canvas for mouse coordinates. */
    BB.Input.init(canvas);

    /* Renderer owns the canvas and sizes the camera. */
    BB.Renderer.init(canvas);
    BB.Renderer.setQuality(BB.Settings.get('quality'));

    BB.FX.init();
    BB.HUD.init();
    BB.Menus.init();
    BB.Commentary.init();

    /* Settings <-> systems wiring, now that every target system exists. */
    BB.Settings.bind();

    /* First user gesture anywhere unlocks WebAudio (browser requirement). */
    const unlock = () => BB.Audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    /* Scenes are registered by game.js when it loaded; just pick one. */
    BB.Engine.start('menu');

    hideBoot();
  }

  function hideBoot() {
    const fill = document.getElementById('boot-fill');
    const boot = document.getElementById('boot');
    if (fill) fill.style.width = '100%';
    setTimeout(() => { if (boot) boot.classList.add('is-hidden'); }, 260);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
