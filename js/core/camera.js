/* =============================================================================
 * camera.js  —  Broadcast camera (true 3D perspective).
 * -----------------------------------------------------------------------------
 * A real low-side broadcast rig: the camera lives outside the near sideline,
 * dollies along the length of the court, and looks slightly across the floor
 * so the far side of the court stays in frame. Zoom is a dolly, not a
 * focal-length change, which keeps the perspective honest.
 *
 * Every rig is locked to ONE thing: the player the user is steering. Not the
 * ball, and not whoever happens to be holding it. A rig that changes its mind
 * about its subject jumps across the floor mid-possession, and it does it at
 * the worst possible moment — the release of a shot, a change of possession —
 * leaving the player being driven somewhere off frame. The follow itself is a
 * critically damped spring, so the rig glides after them rather than snapping.
 *
 * The public API is unchanged from the original 2D build so nothing else had
 * to be rewritten:
 *   update / reset / snap / setMode / addTrauma   camera movement
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
    BROADCAST: 'broadcast',   // sideline rig at standard height
    WIDE: 'wide',             // pulled back, most of the court in frame
    TIGHT: 'tight',           // pushed in on the action
    FIXED: 'fixed',           // locked to a target point
    PORTRAIT: 'portrait',     // in close at eye level — the front-end standby shot
    FORWARD: 'forward'        // behind the play, looking down the floor at the rim
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
    portrait:  { dist: 6.0, height: 4.4, look: 2.9, across: 1.0 },
    /* The one rig that does not live on the sideline. It sits BEHIND the play
     * on the line running to the basket being attacked and looks down the
     * floor, so the hoop is straight ahead instead of off to one side.
     * `ahead` is how far past the focus it aims, which is what holds the rim
     * up in frame instead of the floor at the player's feet. */
    forward:   { dist: 21, height: 9.0, look: 4.6, across: 0, ahead: 11 }
  };

  const FOV_Y = 44 * Math.PI / 180;
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

    /* ------------------------------------------------------------ follow
     * The rig is pinned to the player and reeled in by a critically damped
     * spring rather than an exponential ease. A spring carries its own
     * velocity, so the frame builds up speed and settles instead of changing
     * pace the instant the thing it follows does; critically damped, it never
     * overshoots and rocks back afterwards. `followOmega` is its natural
     * frequency in radians per second — higher is a shorter leash. */
    followOmega: 6.4,
    _vx: 0,
    _vy: 0,

    /* Lead: how far in front of a moving player the rig aims. Deliberately
     * small and smoothed into place. Aiming a long way ahead of a sprinter
     * means handing all of it back the moment they pull up, which slides the
     * whole frame backwards under a player who never moved backwards. */
    leadFactor: 0.18,
    maxLead: 4.5,
    leadRate: 2.6,
    _leadX: 0,
    _leadY: 0,

    /* A focus that moves further than this between updates did not run there:
     * it is an inbound, a new quarter, a switch to another defender. Gliding
     * across one sends the rig sailing across the park for a second, so a
     * jump that big is taken as a cut and the rig is simply already there. */
    cutDistance: 16,
    _focusX: 0,
    _focusY: 0,
    _tracking: false,

    /* Scale factor tying overlay UI sizes to viewport height. */
    fit: 1,

    /* Which basket the FORWARD rig looks toward. Scenes set it as possession
     * changes; every other rig ignores it. _dx/_dy is the smoothed direction
     * actually used, so the camera swings around behind a player who runs past
     * the rim instead of snapping through 180 degrees. */
    aimX: C.COURT_L, aimY: C.HALF_W,
    _aimA: 0, _dx: 1, _dy: 0,

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
      this._vx = this._vy = 0;
      this._leadX = this._leadY = 0;
      this._tracking = false;
      this._rebuild();
    },

    /**
     * Cuts the rig to whatever it is currently pointed at, with no glide. Used
     * for the moments that are edits rather than movement, and taken
     * automatically when the focus jumps further than a player could run.
     */
    snap() {
      this._x = this.x;
      this._y = this.y;
      this._vx = this._vy = 0;
      this._clampFocus();
      if (this.mode === MODES.FORWARD) {
        this._aimA = this.aimX - this._x >= 0 ? 0 : Math.PI;
        this._dx = Math.cos(this._aimA);
        this._dy = Math.sin(this._aimA);
      }
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

    /** Points the FORWARD rig at a basket. No effect in any other mode. */
    setAim(x, y) { this.aimX = x; this.aimY = y; },

    /* --------------------------------------------------------- cinematic
     * A hand-flown override for the instant replay. While it is on, every rig
     * preset, the follow spring and the shake are all bypassed and the eye and
     * aim are whatever was last handed in — in COURT feet, like everything
     * else a caller ever passes this module. */
    cine: false,
    _cineEye: new Float32Array(3),
    _cineTarget: new Float32Array(3),

    flyTo(ex, ey, ez, tx, ty, tz) {
      this.cine = true;
      this._cineEye[0] = ex; this._cineEye[1] = ey; this._cineEye[2] = ez;
      this._cineTarget[0] = tx; this._cineTarget[1] = ty; this._cineTarget[2] = tz;
      this._rebuild();
    },

    /** Hands the frame back to the rig the settings asked for. */
    endFly() {
      if (!this.cine) return;
      this.cine = false;
      this._rebuild();
    },

    /* ----------------------------------------------------------------- shake */
    /** @param {number} amount 0..1 — added to trauma, clamped. */
    addTrauma(amount) {
      this.trauma = U.clamp01(this.trauma + amount);
    },

    /* ---------------------------------------------------------------- update */
    /**
     * @param {number} dt seconds
     * @param {object} focus { x, y } world point of interest — the player the
     *   user is holding, not the ball
     * @param {object} [vel] { x, y } world velocity used for camera lead
     */
    update(dt, focus, vel) {
      let cut = false;
      if (focus) {
        cut = this._tracking &&
          U.dist2(this._focusX, this._focusY, focus.x, focus.y) >
            this.cutDistance * this.cutDistance;
        this._focusX = focus.x; this._focusY = focus.y;
        this._tracking = true;

        /* The lead eases in and out instead of being read straight off the
         * player's velocity: velocity changes in steps when they push off or
         * pull up, and the rig should not. */
        let lx = 0, ly = 0;
        if (vel && this.mode !== MODES.FIXED) {
          lx = U.clamp(vel.x * this.leadFactor, -this.maxLead, this.maxLead);
          ly = U.clamp(vel.y * this.leadFactor * 0.5, -this.maxLead * 0.4, this.maxLead * 0.4);
        }
        if (cut) { this._leadX = lx; this._leadY = ly; }
        else {
          this._leadX = U.approach(this._leadX, lx, this.leadRate, dt);
          this._leadY = U.approach(this._leadY, ly, this.leadRate, dt);
        }

        this.x = focus.x + this._leadX;
        this.y = focus.y + this._leadY;
      }

      if (cut) this.snap();

      if (this.mode === MODES.FORWARD) {
        /* Aim down the floor. Held steady while the focus is right on top of
         * the basket, where the direction is noise. */
        /* The heading is LOCKED to the court's length. It is either straight
         * down the floor or straight back up it — never anything between.
         *
         * Aiming the rig at the basket from wherever the player happened to
         * be standing swung it left and right all game: drift to the wing and
         * the whole park rotated under you, so "forward" was a different
         * direction every second. Snapping to the axis keeps the far basket
         * dead ahead and the sidelines square no matter where on the floor
         * the play is. The rig still dollies to follow — it just never yaws.
         *
         * Still interpolated, because a change of possession is a 180 and
         * that should swing round rather than cut. */
        const dx = this.aimX - this._x;
        if (Math.abs(dx) > 3) {
          const k = U.clamp01(1 - Math.exp(-2.2 * Math.max(dt, 0)));
          this._aimA = U.angleLerp(this._aimA, dx >= 0 ? 0 : Math.PI, k);
          this._dx = Math.cos(this._aimA);
          this._dy = Math.sin(this._aimA);
        }
      }

      /* Critically damped spring, integrated implicitly so it stays stable at
       * any frame time — solve for the new velocity first, then step the
       * position with it:  v' = (v + h*w^2*(target - x)) / (1 + h*w)^2.
       * Across the width the spring is softer, so a jab step sideways drifts
       * the frame rather than shoving it. */
      if (!cut) {
        const wx = this.mode === MODES.FIXED ? this.followOmega * 0.45 : this.followOmega;
        const wy = wx * 0.85;
        const dx = (1 + wx * dt) * (1 + wx * dt);
        const dy = (1 + wy * dt) * (1 + wy * dt);
        this._vx = (this._vx + wx * wx * (this.x - this._x) * dt) / dx;
        this._vy = (this._vy + wy * wy * (this.y - this._y) * dt) / dy;
        this._x += this._vx * dt;
        this._y += this._vy * dt;
      }
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

    /**
     * Keeps the rig from dollying past the ends of the park. Hitting the stop
     * kills the spring's velocity on that axis: left running, it winds up
     * against the wall and the rig lurches when the play turns back.
     */
    _clampFocus() {
      const x = U.clamp(this._x, -C.APRON, C.COURT_L + C.APRON);
      const y = U.clamp(this._y, -C.APRON, C.COURT_W + C.APRON);
      if (x !== this._x) { this._x = x; this._vx = 0; }
      if (y !== this._y) { this._y = y; this._vy = 0; }
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

      if (this.cine) {
        // Flown by hand. No rig, no follow, no shake: a replay camera is a
        // camera that was never on the floor, and everything about where it
        // is comes from whoever is flying it.
        this.eye[0] = this._cineEye[0];
        this.eye[1] = this._cineEye[2];
        this.eye[2] = this._cineEye[1];
        this.target[0] = this._cineTarget[0];
        this.target[1] = this._cineTarget[2];
        this.target[2] = this._cineTarget[1];
      } else if (this.mode === MODES.FORWARD) {
        // Behind the play, on the line to the basket, looking down the floor.
        const ahead = rig.ahead || 10;
        this.eye[0] = this._x - this._dx * dist + sx;
        this.eye[1] = height + sy;
        this.eye[2] = this._y - this._dy * dist;

        this.target[0] = this._x + this._dx * ahead + sx * 0.4;
        this.target[1] = rig.look;
        this.target[2] = this._y + this._dy * ahead;
      } else {
        // The rig dollies along x with the ball but only leans a fraction of the
        // way across the width, so the far sideline never swings out of frame.
        const aimY = U.lerp(C.HALF_W, this._y, rig.across);

        this.eye[0] = this._x + sx;
        this.eye[1] = height + sy;
        this.eye[2] = C.COURT_W + dist;

        this.target[0] = this._x + sx * 0.4;
        this.target[1] = rig.look;
        this.target[2] = aimY;
      }

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
      // Straight-line distance from the rig to the focus. The old form measured
      // only height and width, which is the same thing ONLY for a rig parked on
      // the sideline — the forward rig stands off along x and read as if it
      // were on top of the play.
      const depth = Math.hypot(this.eye[0] - this._x,
                               this.eye[1],
                               this.eye[2] - this._y) || 1;
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
