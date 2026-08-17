/* =============================================================================
 * engine.js  —  The loop and the scene state machine.
 * -----------------------------------------------------------------------------
 * Simulation runs on a FIXED 1/120s step fed by an accumulator, so physics is
 * identical on a 60Hz laptop and a 144Hz monitor. Rendering happens once per
 * animation frame and receives an interpolation alpha for anything that wants
 * to smooth between steps.
 *
 * Slow motion scales the accumulator input, never the step size, so collision
 * behaviour is unchanged during a replay.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C;

  const Engine = {
    scenes: Object.create(null),
    scene: null,
    state: 'boot',
    pendingState: null,
    pendingParams: null,

    running: false,
    _raf: 0,
    _last: 0,
    _accum: 0,

    /* Wall-clock seconds since start, unaffected by slow motion. */
    elapsed: 0,
    /* Simulation seconds, affected by slow motion. */
    simTime: 0,

    timeScale: 1,
    _targetScale: 1,
    _scaleRate: 6,
    /* Real seconds left on a self-unwinding slow motion; 0 when none. */
    _slowT: 0,

    fps: 60,
    frameMs: 0,
    _fpsAccum: 0,
    _fpsFrames: 0,

    events: new U.Emitter(),

    /* ------------------------------------------------------------- lifecycle */
    register(name, scene) {
      this.scenes[name] = scene;
      scene.name = name;
      return this;
    },

    /**
     * Queue a scene change. The swap happens between frames so a scene can call
     * this from inside its own update without tearing.
     */
    setState(name, params) {
      if (!this.scenes[name]) {
        console.warn('[engine] unknown scene:', name);
        return;
      }
      this.pendingState = name;
      this.pendingParams = params || null;
    },

    _applyPending() {
      if (!this.pendingState) return;
      const next = this.scenes[this.pendingState];
      const params = this.pendingParams;
      this.pendingState = null;
      this.pendingParams = null;

      // A replay is scrubbing over entities that are about to be thrown away.
      if (BB.Replay) BB.Replay.reset();
      if (this.scene && this.scene.exit) this.scene.exit();
      const prev = this.state;
      this.scene = next;
      this.state = next.name;
      if (next.enter) next.enter(params, prev);
      this.events.emit('stateChanged', { from: prev, to: this.state, params });
    },

    start(initialState) {
      if (this.running) return;
      this.running = true;
      this._last = U.now();
      if (initialState) this.setState(initialState);
      this._applyPending();
      this._raf = global.requestAnimationFrame(this._tick);
    },

    stop() {
      this.running = false;
      if (this._raf) global.cancelAnimationFrame(this._raf);
      this._raf = 0;
    },

    /* ------------------------------------------------------------ slow motion */
    /**
     * @param {number} scale   e.g. 0.25 for a poster dunk
     * @param {number} [snap]  true to jump instantly instead of easing in
     */
    setTimeScale(scale, snap) {
      this._targetScale = Math.max(0.02, scale);
      /* An explicit request wins outright, and cancels any slow motion that was
       * running. That is what makes the pause safe: pause sets 0 and resume
       * sets 1, and neither has to know a dunk was in the air — without this a
       * slow motion taken across a pause would come back and re-apply itself
       * to a game the player had already resumed at full speed. */
      this._slowT = 0;
      if (snap) this.timeScale = this._targetScale;
    },

    /**
     * Slow the world down for a moment and let it come back on its own.
     *
     * Everything about a poster dunk is over in about half a second of game
     * time, which is too fast to see the thing you just did. The easing in and
     * out is the existing _scaleRate approach, so it ramps rather than steps,
     * and the timer runs on REAL seconds — a slow motion that measured its own
     * length in slowed time would take three times as long as asked.
     *
     * @param {number} scale  how slow, e.g. 0.30
     * @param {number} secs   how long to hold it, in real seconds
     */
    slowMo(scale, secs) {
      this._targetScale = Math.max(0.02, scale);
      this._slowT = Math.max(0, secs);
    },

    /* ------------------------------------------------------------------ tick */
    _tick: null,

    _step(now) {
      if (!this.running) return;
      const frameStart = now;

      let raw = (now - this._last) / 1000;
      this._last = now;
      // A backgrounded tab can hand us a huge delta; clamp so nothing tunnels.
      if (raw > C.MAX_FRAME) raw = C.MAX_FRAME;
      if (raw < 0) raw = 0;

      this.elapsed += raw;

      /* FPS metering over a rolling half second. */
      this._fpsAccum += raw;
      this._fpsFrames++;
      if (this._fpsAccum >= 0.5) {
        this.fps = this._fpsFrames / this._fpsAccum;
        this._fpsAccum = 0;
        this._fpsFrames = 0;
      }

      if (this._slowT > 0) {
        this._slowT -= raw;
        if (this._slowT <= 0) { this._slowT = 0; this._targetScale = 1; }
      }
      this.timeScale = U.approach(this.timeScale, this._targetScale, this._scaleRate, raw);

      BB.Input.beginFrame();
      this._applyPending();

      const scene = this.scene;
      if (scene) {
        /* Unscaled hook for UI, transitions and camera-independent timers. */
        if (scene.updateRealtime) scene.updateRealtime(raw);

        /* The replay records off the live world and, while it is showing that
         * recording back, writes over it — so the simulation has to sit those
         * frames out entirely. It says so here rather than every scene having
         * to remember to ask. */
        const frozen = BB.Replay ? BB.Replay.beginFrame(raw, scene) : false;

        if (!frozen) {
          if (scene.fixedUpdate) {
            this._accum += raw * this.timeScale;
            let steps = 0;
            while (this._accum >= C.FIXED_DT && steps < 8) {
              scene.fixedUpdate(C.FIXED_DT);
              this._accum -= C.FIXED_DT;
              this.simTime += C.FIXED_DT;
              steps++;
            }
            // Runaway protection: never let the backlog grow unbounded.
            if (steps >= 8) this._accum = 0;
          }

          if (scene.update) scene.update(raw * this.timeScale, raw);
        }

        if (scene.render) scene.render(frozen ? 0 : this._accum / C.FIXED_DT);
      }

      BB.Input.endFrame();

      this.frameMs = U.now() - frameStart;
      this._raf = global.requestAnimationFrame(this._tick);
    }
  };

  Engine._tick = Engine._step.bind(Engine);

  BB.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
