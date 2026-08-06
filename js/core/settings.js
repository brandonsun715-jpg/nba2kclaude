/* =============================================================================
 * settings.js  —  Persisted preferences.
 * -----------------------------------------------------------------------------
 * A single source of truth for anything the player can change. Writing through
 * set() persists to local storage and notifies listeners, so the audio mixer,
 * renderer and camera all react without knowing the menu exists.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U;

  const DEFAULTS = {
    /* Audio */
    volMaster: 0.8,
    volSfx: 0.9,
    volCrowd: 0.55,
    volUi: 0.7,
    volCommentary: 0.85,
    commentary: true,
    muted: false,

    /* Presentation */
    quality: 'high',          // high | balanced | performance
    cameraMode: 'forward',    // forward | broadcast | wide | tight
    screenShake: 1.0,
    showTrails: true,
    showDebug: false,

    /* Gameplay */
    difficulty: 'pro',        // rookie | pro | allstar | hall
    quarterLength: 6,         // minutes
    shotClock: 24,
    shotMeter: true,
    autoSave: true
  };

  const Settings = {
    values: null,
    events: new U.Emitter(),

    init() {
      const saved = U.store.get('settings', {});
      this.values = Object.assign({}, DEFAULTS, saved);
      // Re-apply everything once so subscribers start in a known state.
      for (const k in this.values) this.events.emit('change:' + k, this.values[k]);
      return this;
    },

    get(key) { return this.values[key]; },

    set(key, value) {
      if (this.values[key] === value) return value;
      this.values[key] = value;
      U.store.set('settings', this.values);
      this.events.emit('change:' + key, value);
      this.events.emit('change', { key, value });
      return value;
    },

    reset() {
      this.values = Object.assign({}, DEFAULTS);
      U.store.set('settings', this.values);
      for (const k in this.values) this.events.emit('change:' + k, this.values[k]);
      this.events.emit('change', { key: '*', value: null });
    },

    /** Wire settings to the systems that consume them. */
    bind() {
      const A = BB.Audio, R = BB.Renderer, Cam = BB.Camera;

      this.events.on('change:volMaster', (v) => A.setVolume('master', v));
      this.events.on('change:volSfx', (v) => A.setVolume('sfx', v));
      this.events.on('change:volCrowd', (v) => A.setVolume('crowd', v));
      this.events.on('change:volUi', (v) => A.setVolume('ui', v));
      this.events.on('change:muted', (v) => A.setMuted(v));
      this.events.on('change:volCommentary', (v) => { if (BB.Commentary) BB.Commentary.setVolume(v); });
      this.events.on('change:commentary', (v) => { if (BB.Commentary) BB.Commentary.setEnabled(v); });

      this.events.on('change:quality', (v) => R.setQuality(v));
      this.events.on('change:showDebug', (v) => { R.showDebug = v; });
      this.events.on('change:cameraMode', (v) => Cam.setMode(v));

      // Push current values through now that listeners exist.
      for (const k in this.values) this.events.emit('change:' + k, this.values[k]);
      return this;
    }
  };

  Settings.DEFAULTS = DEFAULTS;
  BB.Settings = Settings;
})(typeof window !== 'undefined' ? window : globalThis);
