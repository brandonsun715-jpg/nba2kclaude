/* =============================================================================
 * audio.js  —  Bussed WebAudio mixer with procedural voices.
 * -----------------------------------------------------------------------------
 * Every sound is a named CUE. A cue is either:
 *   • a procedural voice (a function that builds nodes on demand), or
 *   • a decoded sample buffer.
 *
 * Cues are looked up by name at play time, so dropping real recordings in later
 * is a one-liner per sound — Audio.loadSample('swish', 'assets/swish.wav') —
 * with zero changes to gameplay code. Nothing here needs any external file, so
 * the game is fully audible offline on first open.
 *
 * Routing:  voice -> bus (sfx | crowd | ui) -> master -> destination
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C;

  const Audio = {
    ctx: null,
    ready: false,
    muted: false,
    buses: {},
    volumes: Object.assign({}, C.DEFAULT_VOLUME),
    _cues: Object.create(null),
    _samples: Object.create(null),
    _noise: null,
    _crowd: null,
    _lastPlay: Object.create(null),

    /* ------------------------------------------------------------- lifecycle */
    /**
     * Browsers require a user gesture before audio starts. Call this from any
     * click/keypress; repeated calls are harmless.
     */
    unlock() {
      if (this.ready) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }

      const master = this.ctx.createGain();
      master.gain.value = this.volumes.master;
      // Gentle limiter keeps a full arena from clipping.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 20;
      comp.ratio.value = 6;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      master.connect(comp).connect(this.ctx.destination);
      this.buses.master = master;

      ['sfx', 'crowd', 'ui'].forEach((name) => {
        const g = this.ctx.createGain();
        g.gain.value = this.volumes[name];
        g.connect(master);
        this.buses[name] = g;
      });

      this._noise = makeNoiseBuffer(this.ctx, 2.0);
      this.ready = true;
      registerVoices(this);
      this.startCrowd();
    },

    setVolume(bus, v) {
      this.volumes[bus] = U.clamp01(v);
      if (this.ready && this.buses[bus]) {
        this.buses[bus].gain.setTargetAtTime(this.muted ? 0 : this.volumes[bus], this.ctx.currentTime, 0.05);
      }
    },

    setMuted(m) {
      this.muted = !!m;
      if (!this.ready) return;
      for (const k in this.buses) {
        this.buses[k].gain.setTargetAtTime(this.muted ? 0 : this.volumes[k] || 1, this.ctx.currentTime, 0.05);
      }
    },

    /* ------------------------------------------------------------------ cues */
    /** Register (or replace) a procedural voice. */
    define(name, fn, opts) {
      this._cues[name] = Object.assign({ fn, bus: 'sfx', throttle: 0 }, opts || {});
    },

    /** Swap a procedural cue for a real recording without touching call sites. */
    loadSample(name, url, opts) {
      if (!this.ready) return Promise.resolve(false);
      return fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => this.ctx.decodeAudioData(b))
        .then((buf) => {
          this._samples[name] = buf;
          this._cues[name] = Object.assign({ sample: true, bus: 'sfx', throttle: 0 }, opts || {});
          return true;
        })
        .catch(() => false);
    },

    /**
     * Play a cue.
     * @param {string} name
     * @param {object} [p] { gain, rate, pan, detune }
     */
    play(name, p) {
      if (!this.ready || this.muted) return;
      const cue = this._cues[name];
      if (!cue) return;

      const t = this.ctx.currentTime;
      if (cue.throttle) {
        const last = this._lastPlay[name] || -99;
        if (t - last < cue.throttle) return;
        this._lastPlay[name] = t;
      }

      p = p || EMPTY;
      const bus = this.buses[cue.bus] || this.buses.sfx;
      const out = this.ctx.createGain();
      out.gain.value = p.gain == null ? 1 : p.gain;

      if (p.pan != null && this.ctx.createStereoPanner) {
        const pan = this.ctx.createStereoPanner();
        pan.pan.value = U.clamp(p.pan, -1, 1);
        out.connect(pan).connect(bus);
      } else {
        out.connect(bus);
      }

      if (cue.sample) {
        const src = this.ctx.createBufferSource();
        src.buffer = this._samples[name];
        src.playbackRate.value = p.rate || 1;
        src.connect(out);
        src.start(t);
        src.onended = () => out.disconnect();
      } else {
        cue.fn(this, out, t, p);
        // Voices are short; schedule teardown generously past their tail.
        setTimeout(() => { try { out.disconnect(); } catch (e) { /* noop */ } }, (cue.life || 2.5) * 1000);
      }
    },

    /* ----------------------------------------------------------- crowd layer */
    /** Continuous filtered-noise arena bed whose energy tracks the drama. */
    startCrowd() {
      if (!this.ready || this._crowd) return;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this._noise;
      src.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.55;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 180;

      const g = ctx.createGain();
      g.gain.value = 0.10;

      src.connect(bp).connect(hp).connect(g).connect(this.buses.crowd);
      src.start(0);

      this._crowd = { src, gain: g, filter: bp, level: 0.10 };
    },

    /**
     * @param {number} intensity 0 = idle murmur, 1 = full roar
     * @param {number} [smooth]  seconds of glide
     */
    setCrowdIntensity(intensity, smooth) {
      if (!this._crowd) return;
      const i = U.clamp01(intensity);
      const t = this.ctx.currentTime;
      const tc = (smooth == null ? 0.9 : smooth) / 3;
      this._crowd.gain.gain.setTargetAtTime(0.07 + i * 0.52, t, tc);
      this._crowd.filter.frequency.setTargetAtTime(520 + i * 900, t, tc);
      this._crowd.filter.Q.setTargetAtTime(0.55 + i * 0.5, t, tc);
    },

    /** One-shot swell on top of the bed (made shot, big block, and so on). */
    crowdBurst(strength) {
      if (!this.ready) return;
      this.play('cheer', { gain: U.clamp01(strength) });
    }
  };

  const EMPTY = {};

  /* ------------------------------------------------------------------ voices */
  function registerVoices(A) {
    const noiseSrc = (a, dur) => {
      const s = a.ctx.createBufferSource();
      s.buffer = a._noise;
      s.loop = true;
      s.playbackRate.value = 0.9 + U.rng.f() * 0.2;
      return s;
    };

    /* --- ball on blacktop: short low thud with a slap transient ----------- */
    A.define('dribble', (a, out, t, p) => {
      const ctx = a.ctx;
      const o = ctx.createOscillator();
      o.type = 'sine';
      const base = 130 * (p.rate || 1);
      o.frequency.setValueAtTime(base * 1.9, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.55, t + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.15);

      const n = noiseSrc(a);
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass'; nf.frequency.value = 1800; nf.Q.value = 1.1;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.35, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      n.connect(nf).connect(ng).connect(out);
      n.start(t); n.stop(t + 0.06);
    }, { bus: 'sfx', throttle: 0.045, life: 0.4 });

    /* --- swish: filtered noise sweeping down through the mesh ------------- */
    A.define('swish', (a, out, t) => {
      const ctx = a.ctx;
      const n = noiseSrc(a);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 2.4;
      f.frequency.setValueAtTime(5200, t);
      f.frequency.exponentialRampToValueAtTime(1400, t + 0.28);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
      n.connect(f).connect(g).connect(out);
      n.start(t); n.stop(t + 0.36);
    }, { life: 0.6 });

    /* --- rim: inharmonic metallic ring ------------------------------------ */
    A.define('rim', (a, out, t, p) => {
      const ctx = a.ctx;
      const partials = [1, 2.41, 3.83, 5.17];
      const root = 420 + U.rng.f(-40, 60);
      const amp = p.gain == null ? 1 : 1;
      for (let i = 0; i < partials.length; i++) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = root * partials[i];
        const g = ctx.createGain();
        const a0 = (0.30 / (i + 1)) * amp;
        g.gain.setValueAtTime(a0, t);
        g.gain.exponentialRampToValueAtTime(0.0008, t + 0.30 + i * 0.05);
        o.connect(g).connect(out);
        o.start(t); o.stop(t + 0.55);
      }
      const n = noiseSrc(a);
      const nf = ctx.createBiquadFilter();
      nf.type = 'highpass'; nf.frequency.value = 3000;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.22, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      n.connect(nf).connect(ng).connect(out);
      n.start(t); n.stop(t + 0.06);
    }, { throttle: 0.03, life: 0.8 });

    /* --- backboard: woody glass knock ------------------------------------- */
    A.define('board', (a, out, t) => {
      const ctx = a.ctx;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(260, t);
      o.frequency.exponentialRampToValueAtTime(120, t + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.8, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.24);

      const n = noiseSrc(a);
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.8;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.30, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
      n.connect(nf).connect(ng).connect(out);
      n.start(t); n.stop(t + 0.12);
    }, { throttle: 0.03, life: 0.5 });

    /* --- net flick: soft high rustle -------------------------------------- */
    A.define('net', (a, out, t) => {
      const ctx = a.ctx;
      const n = noiseSrc(a);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 4200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      n.connect(f).connect(g).connect(out);
      n.start(t); n.stop(t + 0.18);
    }, { throttle: 0.05, life: 0.4 });

    /* --- footstep / squeak ------------------------------------------------ */
    A.define('squeak', (a, out, t, p) => {
      const ctx = a.ctx;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = 900 + U.rng.f(-180, 320);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.8, t + 0.07);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.14, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
      o.connect(bp).connect(g).connect(out);
      o.start(t); o.stop(t + 0.13);
    }, { throttle: 0.06, life: 0.3 });

    /* --- whistle ---------------------------------------------------------- */
    A.define('whistle', (a, out, t) => {
      const ctx = a.ctx;
      for (let i = 0; i < 2; i++) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        const f = i === 0 ? 2350 : 2980;
        o.frequency.setValueAtTime(f, t);
        // Warble gives it the pea-in-the-barrel character.
        const lfo = ctx.createOscillator();
        lfo.type = 'sine'; lfo.frequency.value = 34;
        const lg = ctx.createGain(); lg.gain.value = 55;
        lfo.connect(lg).connect(o.frequency);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.20 - i * 0.07, t + 0.02);
        g.gain.setValueAtTime(0.20 - i * 0.07, t + 0.30);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
        o.connect(g).connect(out);
        o.start(t); o.stop(t + 0.44);
        lfo.start(t); lfo.stop(t + 0.44);
      }
    }, { life: 0.8 });

    /* --- horn / buzzer ---------------------------------------------------- */
    A.define('buzzer', (a, out, t) => {
      const ctx = a.ctx;
      const freqs = [110, 138.6, 165];
      for (let i = 0; i < freqs.length; i++) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = freqs[i];
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.16, t + 0.015);
        g.gain.setValueAtTime(0.16, t + 1.5);
        g.gain.exponentialRampToValueAtTime(0.001, t + 1.9);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 1400;
        o.connect(lp).connect(g).connect(out);
        o.start(t); o.stop(t + 2.0);
      }
    }, { life: 2.4 });

    /* --- crowd swell ------------------------------------------------------ */
    A.define('cheer', (a, out, t, p) => {
      const ctx = a.ctx;
      const strength = p.gain == null ? 0.7 : p.gain;
      const n = noiseSrc(a);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 0.7;
      f.frequency.setValueAtTime(700, t);
      f.frequency.linearRampToValueAtTime(1500, t + 0.35);
      f.frequency.linearRampToValueAtTime(800, t + 1.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.55 * strength, t + 0.22);
      g.gain.exponentialRampToValueAtTime(0.001, t + 2.1);
      n.connect(f).connect(g).connect(out);
      n.start(t); n.stop(t + 2.2);
    }, { bus: 'crowd', throttle: 0.30, life: 2.6 });

    /* --- UI --------------------------------------------------------------- */
    A.define('uiMove', (a, out, t) => blip(a, out, t, 620, 0.05, 0.10, 'triangle'), { bus: 'ui', throttle: 0.03, life: 0.3 });
    A.define('uiSelect', (a, out, t) => {
      blip(a, out, t, 520, 0.06, 0.16, 'triangle');
      blip(a, out, t + 0.055, 780, 0.09, 0.14, 'triangle');
    }, { bus: 'ui', life: 0.4 });
    A.define('uiBack', (a, out, t) => {
      blip(a, out, t, 460, 0.07, 0.13, 'triangle');
      blip(a, out, t + 0.05, 300, 0.10, 0.12, 'triangle');
    }, { bus: 'ui', life: 0.4 });
    A.define('uiDeny', (a, out, t) => blip(a, out, t, 180, 0.16, 0.16, 'square'), { bus: 'ui', life: 0.4 });

    /* --- shot feedback ---------------------------------------------------- */
    A.define('green', (a, out, t) => {
      // Bright rising major triad — the "perfect release" reward tone.
      const notes = [880, 1174.66, 1567.98];
      for (let i = 0; i < notes.length; i++) {
        const o = a.ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = notes[i];
        const g = a.ctx.createGain();
        const st = t + i * 0.035;
        g.gain.setValueAtTime(0, st);
        g.gain.linearRampToValueAtTime(0.16, st + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, st + 0.34);
        o.connect(g).connect(out);
        o.start(st); o.stop(st + 0.36);
      }
    }, { bus: 'ui', life: 0.7 });
  }

  function blip(a, out, t, freq, dur, amp, type) {
    const o = a.ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.value = freq;
    const g = a.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function makeNoiseBuffer(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Pink-ish noise (Voss approximation) reads warmer than pure white.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
    return buf;
  }

  BB.Audio = Audio;
})(typeof window !== 'undefined' ? window : globalThis);
