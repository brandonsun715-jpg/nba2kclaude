/* =============================================================================
 * camera.js  —  Broadcast camera (true 3D perspective).
 * -----------------------------------------------------------------------------
 * A real low-side broadcast rig: the camera lives outside the near sideline,
 * dollies along the length of the court to track the ball, and looks slightly
 * across the floor so the far side of the court stays in frame. Zoom is a
 * dolly, not a focal-length change, which keeps the perspective honest.
 *
 * The public API is unchanged from the original 2D build so nothing else had
 * to be rewritten:
 *   update / reset / setMode / addTrauma   camera movement
 *   project / unproject / scale / bounds   world <-> screen for overlay UI
 *   panFor                                 positional audio
 *
 * Coordinates: the simulation is in court space (x length, y width, z height).
 * GL space is right-handed with +Y up, so world (x, y, z) maps to GL (x, z, y).
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, M4 = BB.M4;

  const MODES = {
    BROADCAST: 'broadcast',   // follows the ball, standard rig height
    WIDE: 'wide',             // pulled back, most of the court in frame
    TIGHT: 'tight',           // pushed in on the action
    FIXED: 'fixed',           // locked to a target point
    PORTRAIT: 'portrait'      // in close at eye level — the front-end standby shot
  };

  /* Rig presets in feet. `dist` is how far outside the near sideline the
   * camera body sits, `height` its elevation, `look` the height of the point
   * it aims at (roughly chest height on a standing player).
   *
   * `across` is how far the aim leans off centre court toward the focus: a
   * play rig only leans partway so the far sideline never swings out of frame,
   * but the portrait rig aims dead at its subject, because there is only one
   * and it is the whole shot. */
  const RIG = {
    broadcast: { dist: 33, height: 15.5, look: 2.2, across: 0.46 },
    wide:      { dist: 54, height: 22.0, look: 3.4, across: 0.55 },
    tight:     { dist: 26, height: 10.5, look: 3.0, across: 0.36 },
    fixed:     { dist: 33, height: 15.5, look: 2.2, across: 0.46 },
    portrait:  { dist: 6.0, height: 4.4, look: 2.9, across: 1.0 }
  };

  const FOV_Y = 40 * Math.PI / 180;
  const NEAR = 0.6;
  const FAR = 420;

  const Camera = {
    MODES,

    /* Focus point in world feet (what the rig is tracking). */
    x: C.HALF_L,
    y: C.HALF_W,
    zoom: 1,

    /* Smoothed values actually used for rendering. */
    _x: C.HALF_L,
    _y: C.HALF_W,
    _zoom: 1,

    targetZoom: 1,
    mode: MODES.BROADCAST,

    /* Viewport, in device pixels. */
    vw: 1280,
    vh: 720,
    dpr: 1,

    /* Trauma-based shake: trauma decays, offset uses trauma^2 for punchiness. */
    trauma: 0,
    traumaDecay: 1.6,
    shakeX: 0,
    shakeY: 0,
    _shakeSeed: U.rng.f() * 1000,

    /* Follow tuning. */
    followRate: 4.2,
    leadFactor: 0.42,
    maxLead: 11,

    /* Scale factor tying overlay UI sizes to viewport height. */
    fit: 1,

    /* ---------------------------------------------------------- 3D state
     * The rig sits OUTSIDE the +y sideline looking back across the floor. That
     * side specifically: with the camera on the -y side the view is mirrored
     * (world +x would run leftward across the screen), which would invert every
     * player's sense of which way they are driving. */
    eye: new Float32Array([C.HALF_L, 19.5, C.COURT_W + 44]),   // GL space
    target: new Float32Array([C.HALF_L, 5, C.HALF_W]),
    view: M4.create(),
    proj: M4.create(),
    viewProj: M4.create(),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    fwd: new Float32Array([0, 0, 1]),

    _tmp: new Float32Array(4),

    /* ------------------------------------------------------------- lifecycle */
    resize(w, h, dpr) {
      this.vw = w; this.vh = h; this.dpr = dpr || 1;
      this.fit = h / C.DESIGN_H;
      this._clampFocus();
      this._rebuild();
    },

    reset(x, y, zoom) {
      this.x = this._x = (x == null ? C.HALF_L : x);
      this.y = this._y = (y == null ? C.HALF_W : y);
      this.zoom = this._zoom = this.targetZoom = (zoom == null ? 1 : zoom);
      this.trauma = 0;
      this.shakeX = this.shakeY = 0;
      this._rebuild();
    },

    setMode(mode) {
      this.mode = RIG[mode] ? mode : MODES.BROADCAST;
      switch (this.mode) {
        case MODES.WIDE: this.targetZoom = 1.0; break;
        case MODES.TIGHT: this.targetZoom = 1.0; break;
        case MODES.BROADCAST: this.targetZoom = 1.0; break;
        default: break;
      }
    },

    /* ----------------------------------------------------------------- shake */
    /** @param {number} amount 0..1 — added to trauma, clamped. */
    addTrauma(amount) {
      this.trauma = U.clamp01(this.trauma + amount);
    },

    /* ---------------------------------------------------------------- update */
    /**
     * @param {number} dt seconds
     * @param {object} focus { x, y } world point of interest (usually the ball)
     * @param {object} [vel] { x, y } world velocity used for camera lead
     */
    update(dt, focus, vel) {
      if (focus) {
        let tx = focus.x, ty = focus.y;
        if (vel && this.mode !== MODES.FIXED) {
          tx += U.clamp(vel.x * this.leadFactor, -this.maxLead, this.maxLead);
          ty += U.clamp(vel.y * this.leadFactor * 0.5, -this.maxLead * 0.4, this.maxLead * 0.4);
        }
        this.x = tx;
        this.y = ty;
      }

      const rate = this.mode === MODES.FIXED ? 2.0 : this.followRate;
      this._x = U.approach(this._x, this.x, rate, dt);
      this._y = U.approach(this._y, this.y, rate * 0.85, dt);
      this._zoom = U.approach(this._zoom, this.targetZoom, 3.0, dt);

      this._clampFocus();

      /* Shake */
      if (this.trauma > 0) {
        this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
        const s = this.trauma * this.trauma;
        this._shakeSeed += dt * 34;
        // Two out-of-phase sines per axis approximate smooth noise cheaply.
        this.shakeX = (Math.sin(this._shakeSeed * 1.0) + Math.sin(this._shakeSeed * 2.37) * 0.6) * s;
        this.shakeY = (Math.cos(this._shakeSeed * 1.31) + Math.cos(this._shakeSeed * 3.11) * 0.5) * s;
      } else {
        this.shakeX = this.shakeY = 0;
      }

      this._rebuild();
    },

    /** Keeps the rig from dollying past the ends of the arena. */
    _clampFocus() {
      this._x = U.clamp(this._x, -C.APRON, C.COURT_L + C.APRON);
      this._y = U.clamp(this._y, -C.APRON, C.COURT_W + C.APRON);
    },

    /* --------------------------------------------------- matrix construction */
    _rebuild() {
      const rig = RIG[this.mode] || RIG.broadcast;
      const dist = rig.dist / this._zoom;
      const height = rig.height / Math.sqrt(this._zoom);

      // Shake is applied in feet at the rig, which reads as a real camera
      // being jostled rather than the whole image sliding.
      const sx = this.shakeX * 0.9;
      const sy = this.shakeY * 0.5;

      // The rig dollies along x with the ball but only leans a fraction of the
      // way across the width, so the far sideline never swings out of frame.
      const aimY = U.lerp(C.HALF_W, this._y, rig.across);

      this.eye[0] = this._x + sx;
      this.eye[1] = height + sy;
      this.eye[2] = C.COURT_W + dist;

      this.target[0] = this._x + sx * 0.4;
      this.target[1] = rig.look;
      this.target[2] = aimY;

      const aspect = this.vw / Math.max(1, this.vh);
      M4.perspective(this.proj, FOV_Y, aspect, NEAR, FAR);
      M4.lookAt(this.view, this.eye, this.target, UP);
      M4.multiply(this.viewProj, this.proj, this.view);

      /* Cache the camera basis for unproject(). */
      const f = this.fwd;
      f[0] = this.target[0] - this.eye[0];
      f[1] = this.target[1] - this.eye[1];
      f[2] = this.target[2] - this.eye[2];
      norm(f);
      cross(this.right, f, UP);
      norm(this.right);
      cross(this.up, this.right, f);
      norm(this.up);
    },

    /* ------------------------------------------------------------ projection */
    /**
     * Approximate pixels per world foot at the focus point. Overlay UI (the
     * shot meter, popups) uses this to size itself; it is no longer a single
     * global scale because perspective makes it depth dependent.
     */
    scale() {
      const dz = this.eye[1] - 0;
      const dy = this.eye[2] - this._y;
      const depth = Math.hypot(dz, dy) || 1;
      return (this.vh * 0.5) / (Math.tan(FOV_Y * 0.5) * depth);
    },

    /**
     * World (x, y, z) -> screen pixels, plus `s`, the local pixels-per-foot at
     * that point's depth. `behind` is true when the point is behind the camera.
     */
    project(x, y, z, out) {
      out = out || { x: 0, y: 0, s: 1, behind: false };
      const t = this._tmp;
      M4.transformPoint(t, this.viewProj, x, z || 0, y);
      const w = t[3];
      if (w <= 0.0001) {
        out.behind = true;
        out.x = -9999; out.y = -9999; out.s = 1;
        return out;
      }
      out.behind = false;
      out.x = (t[0] / w * 0.5 + 0.5) * this.vw;
      out.y = (0.5 - t[1] / w * 0.5) * this.vh;
      // proj[5] is 1/tan(fov/2); one world foot of vertical offset moves the
      // point proj[5]/w in NDC, i.e. that times half the viewport in pixels.
      out.s = this.proj[5] * this.vh * 0.5 / w;
      return out;
    },

    /** Screen pixels -> world floor coordinates (z = 0). */
    unproject(px, py, out) {
      out = out || { x: 0, y: 0 };
      const ndcX = (px / this.vw) * 2 - 1;
      const ndcY = 1 - (py / this.vh) * 2;
      const tanY = Math.tan(FOV_Y * 0.5);
      const tanX = tanY * (this.vw / Math.max(1, this.vh));

      // Ray direction in GL space, then swizzled back to court space.
      const dx = this.fwd[0] + this.right[0] * ndcX * tanX + this.up[0] * ndcY * tanY;
      const dy = this.fwd[1] + this.right[1] * ndcX * tanX + this.up[1] * ndcY * tanY;
      const dz = this.fwd[2] + this.right[2] * ndcX * tanX + this.up[2] * ndcY * tanY;

      // GL y is height; solve for the floor plane height = 0.
      if (Math.abs(dy) < 1e-6) { out.x = this._x; out.y = this._y; return out; }
      const t = -this.eye[1] / dy;
      if (t < 0) { out.x = this._x; out.y = this._y; return out; }
      out.x = this.eye[0] + dx * t;
      out.y = this.eye[2] + dz * t;
      return out;
    },

    /**
     * Visible world rectangle on the floor, padded, for culling. Computed from
     * the two bottom screen corners plus the focus, which is conservative but
     * cheap and never under-reports the near field.
     */
    bounds(out, pad) {
      pad = pad || 0;
      out = out || {};
      const a = this.unproject(0, this.vh, TMP_A);
      const b = this.unproject(this.vw, this.vh, TMP_B);
      const c = this.unproject(0, this.vh * 0.35, TMP_C);
      const d = this.unproject(this.vw, this.vh * 0.35, TMP_D);
      out.x0 = Math.min(a.x, b.x, c.x, d.x) - pad;
      out.x1 = Math.max(a.x, b.x, c.x, d.x) + pad;
      out.y0 = Math.min(a.y, b.y, c.y, d.y) - pad;
      out.y1 = Math.max(a.y, b.y, c.y, d.y) + pad;
      return out;
    },

    /** Stereo pan (-1..1) for a world x position, for positional audio. */
    panFor(x) {
      const p = this.project(x, C.HALF_W, 0, TMP_P);
      if (p.behind) return 0;
      return U.clamp((p.x - this.vw * 0.5) / (this.vw * 0.5), -1, 1) * 0.7;
    }
  };

  const UP = new Float32Array([0, 1, 0]);
  const TMP_A = { x: 0, y: 0 }, TMP_B = { x: 0, y: 0 };
  const TMP_C = { x: 0, y: 0 }, TMP_D = { x: 0, y: 0 };
  const TMP_P = { x: 0, y: 0, s: 1, behind: false };

  function norm(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    v[0] /= l; v[1] /= l; v[2] /= l;
  }
  function cross(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2];
    out[0] = ay * b[2] - az * b[1];
    out[1] = az * b[0] - ax * b[2];
    out[2] = ax * b[1] - ay * b[0];
  }

  BB.Camera = Camera;
})(typeof window !== 'undefined' ? window : globalThis);
