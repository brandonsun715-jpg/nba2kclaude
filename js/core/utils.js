/* =============================================================================
 * utils.js  —  Pure helpers. No game state lives here.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});

  const U = {};

  /* ------------------------------------------------------------------ maths */
  U.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  U.clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
  U.remap = (v, a, b, c, d) => U.lerp(c, d, U.clamp01(U.invLerp(a, b, v)));
  U.sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

  U.dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  U.dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };
  U.dist3 = (ax, ay, az, bx, by, bz) => Math.hypot(bx - ax, by - ay, bz - az);

  /** Shortest signed angular difference from a to b, in radians. */
  U.angleDelta = (a, b) => {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  U.angleLerp = (a, b, t) => a + U.angleDelta(a, b) * t;

  /**
   * Frame-rate independent exponential approach.
   * `rate` is roughly "fraction closed per second".
   */
  U.approach = (cur, target, rate, dt) =>
    cur + (target - cur) * (1 - Math.exp(-rate * dt));

  /** Move `cur` toward `target` by at most `maxStep`. */
  U.moveToward = (cur, target, maxStep) => {
    const d = target - cur;
    if (Math.abs(d) <= maxStep) return target;
    return cur + Math.sign(d) * maxStep;
  };

  /* ----------------------------------------------------------------- easing */
  U.ease = {
    linear: (t) => t,
    inQuad: (t) => t * t,
    outQuad: (t) => t * (2 - t),
    inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
    inCubic: (t) => t * t * t,
    outCubic: (t) => (--t) * t * t + 1,
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
    outQuart: (t) => 1 - (--t) * t * t * t,
    outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    outBack: (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    outElastic: (t) => {
      if (t === 0 || t === 1) return t;
      const p = 0.35;
      return Math.pow(2, -10 * t) * Math.sin((t - p / 4) * (2 * Math.PI) / p) + 1;
    },
    inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2
  };

  /* -------------------------------------------------------------------- rng
   * Deterministic RNG so seasons, schedules and rosters can be reproduced from
   * a single seed when saved.
   */
  U.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /** Small RNG object with helpers, backed by a swappable source function. */
  U.makeRng = function (seed) {
    const next = U.mulberry32(seed == null ? (Math.random() * 0xFFFFFFFF) | 0 : seed);
    const r = {
      seed: seed,
      next,
      f: (lo, hi) => (lo == null ? next() : lo + next() * ((hi == null ? 1 : hi) - lo)),
      i: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
      pick: (arr) => arr[Math.floor(next() * arr.length)],
      chance: (p) => next() < p,
      /** Approximately normal via sum of three uniforms (fast, bounded). */
      gauss: (mean, sd) => {
        const s = (next() + next() + next()) / 3; // mean .5, sd ~.1667
        return mean + (s - 0.5) * 6 * (sd / 1.732);
      },
      shuffle: (arr) => {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
      }
    };
    return r;
  };

  /** Shared global RNG for cosmetic, non-reproducible effects (particles etc). */
  U.rng = U.makeRng();

  /* ---------------------------------------------------------------- strings */
  U.pad2 = (n) => (n < 10 ? '0' + n : '' + n);

  /** 743.2 seconds -> "12:23"; under a minute -> "9.4" like a real shot clock. */
  U.clockText = function (seconds, tenthsUnderMinute) {
    if (seconds < 0) seconds = 0;
    if (tenthsUnderMinute && seconds < 60) return seconds.toFixed(1);
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + U.pad2(s);
  };

  U.heightText = function (inches) {
    return Math.floor(inches / 12) + "'" + (inches % 12) + '"';
  };

  /* ----------------------------------------------------------------- colour */
  U.rgba = function (hex, a) {
    const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
    const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  };

  /** Lighten/darken a hex colour. amt in [-1, 1]. */
  U.shade = function (hex, amt) {
    const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
    const n = parseInt(h, 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
    r = Math.round((t - r) * p + r);
    g = Math.round((t - g) * p + g);
    b = Math.round((t - b) * p + b);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  };

  /* ------------------------------------------------------------------- pool
   * Object pooling keeps particle / popup churn out of the GC. Objects are
   * recycled in place; `reset` is called on acquire.
   */
  U.Pool = class Pool {
    constructor(factory, reset, size) {
      this._factory = factory;
      this._reset = reset;
      this._free = [];
      this.active = [];
      for (let i = 0; i < (size || 0); i++) this._free.push(factory());
    }
    acquire() {
      const o = this._free.length ? this._free.pop() : this._factory();
      this._reset(o, arguments);
      this.active.push(o);
      return o;
    }
    /** Release by index inside `active` (swap-remove, O(1), order-agnostic). */
    releaseAt(i) {
      const last = this.active.length - 1;
      const o = this.active[i];
      this.active[i] = this.active[last];
      this.active.pop();
      this._free.push(o);
      return o;
    }
    releaseAll() {
      while (this.active.length) this._free.push(this.active.pop());
    }
    get size() { return this.active.length; }
  };

  /* -------------------------------------------------------------- geometry */
  /** Closest point on segment AB to point P, written into `out`. */
  U.closestOnSegment = function (px, py, ax, ay, bx, by, out) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = U.clamp01(t);
    out.x = ax + dx * t; out.y = ay + dy * t; out.t = t;
    return out;
  };

  /** True if a point lies inside the three-point line for the given hoop. */
  U.isThree = function (x, y, hoop) {
    const C = BB.C;
    const cornerY0 = C.THREE_CORNER_INSET;
    const cornerY1 = C.COURT_W - C.THREE_CORNER_INSET;
    if (y <= cornerY0 || y >= cornerY1) {
      // In the corner channel the line is straight; beyond the break point the
      // arc takes over, so only the straight run counts here.
      const along = hoop.dir > 0 ? x : C.COURT_L - x;
      if (along <= C.THREE_BREAK_X) return true;
    }
    return U.dist(x, y, hoop.x, hoop.y) >= C.THREE_R;
  };

  /** Nearest hoop object to a world point. */
  U.nearestHoop = function (x) {
    return x < BB.C.HALF_L ? BB.C.HOOPS[0] : BB.C.HOOPS[1];
  };

  /* --------------------------------------------------------------- storage */
  U.store = {
    available: (function () {
      try {
        const k = '__bb_probe__';
        global.localStorage.setItem(k, '1');
        global.localStorage.removeItem(k);
        return true;
      } catch (e) { return false; }
    })(),
    /* Saves were written under the old name for the game's whole life, and a
     * rename is no reason to take somebody's career off them. Reads fall back
     * to the old prefix and carry the value forward on the spot, so the first
     * launch after updating migrates whatever it finds and never looks again. */
    prefix: 'blacktop.',
    legacyPrefix: 'hardwood.',
    get(key, fallback) {
      if (!this.available) return fallback;
      try {
        let raw = global.localStorage.getItem(this.prefix + key);
        if (raw == null) {
          raw = global.localStorage.getItem(this.legacyPrefix + key);
          if (raw != null) global.localStorage.setItem(this.prefix + key, raw);
        }
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      if (!this.available) return false;
      try {
        global.localStorage.setItem(this.prefix + key, JSON.stringify(value));
        return true;
      } catch (e) { return false; }
    },
    remove(key) {
      if (!this.available) return;
      try {
        global.localStorage.removeItem(this.prefix + key);
        global.localStorage.removeItem(this.legacyPrefix + key);
      } catch (e) { /* ignore */ }
    }
  };

  /* ------------------------------------------------------------------ misc */
  U.now = () => (global.performance && global.performance.now
    ? global.performance.now()
    : Date.now());

  /** Tiny event emitter used to decouple UI from simulation. */
  U.Emitter = class Emitter {
    constructor() { this._h = Object.create(null); }
    on(evt, fn) { (this._h[evt] || (this._h[evt] = [])).push(fn); return this; }
    off(evt, fn) {
      const a = this._h[evt]; if (!a) return this;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
      return this;
    }
    emit(evt, payload) {
      const a = this._h[evt];
      if (a) for (let i = 0; i < a.length; i++) a[i](payload);
      return this;
    }
  };

  BB.U = U;
})(typeof window !== 'undefined' ? window : globalThis);
