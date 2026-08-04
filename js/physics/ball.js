/* =============================================================================
 * ball.js  —  The basketball.
 * -----------------------------------------------------------------------------
 * Simulated in true 3D feet. Nothing in here knows about the camera; rendering
 * simply flattens height into a screen offset at the end.
 *
 * Collision order per substep matters: floor, then rim, then backboard. Rim is
 * resolved before the board so a ball wedged between them squirts out to the
 * court rather than tunnelling through the glass.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  // See draw()/drawShadow() — cosmetic-only size multiplier so the ball
  // stays trackable against the court and players; never touches physics.
  const VISUAL_BOOST = 1.55;

  const STATE = {
    HELD: 'held',       // in a player's hands
    LOOSE: 'loose',     // live, nobody owns it
    SHOT: 'shot',       // in flight toward a rim
    PASS: 'pass',       // in flight toward a receiver
    DEAD: 'dead'        // whistle; physics frozen
  };

  class Ball {
    constructor(hoops) {
      this.hoops = hoops || [];

      this.x = C.HALF_L; this.y = C.HALF_W; this.z = C.BALL_RADIUS;
      this.vx = 0; this.vy = 0; this.vz = 0;

      this.state = STATE.LOOSE;
      this.owner = null;
      this.lastToucher = null;
      this.shooter = null;
      this.shotWasThree = false;
      this.isFreeThrow = false;
      this.targetHoop = null;
      this.receiver = null;

      /* Presentation */
      this.rot = 0;            // seam rotation, radians
      this.spin = 0;           // rad/s about the screen normal
      this.backspin = 0;       // 0..1, softens rim contact
      this.trail = [];
      this.trailTimer = 0;

      /* Bookkeeping */
      this.prevZ = this.z;
      this.airTime = 0;
      this.scoredThisFlight = false;
      this.touchedRim = false;
      this._rimContactTicks = 0; // consecutive ticks of rim contact - see _rim()
      this.events = new U.Emitter();
    }

    /* --------------------------------------------------------------- control */
    hold(player) {
      this.owner = player;
      this.lastToucher = player;
      this.state = STATE.HELD;
      this.vx = this.vy = this.vz = 0;
      this.trail.length = 0;
      this.scoredThisFlight = false;
      this.touchedRim = false;
    }

    /** Place the ball without altering ownership (used while dribbling). */
    place(x, y, z) { this.x = x; this.y = y; this.z = z; }

    release(state) {
      this.owner = null;
      this.state = state || STATE.LOOSE;
      this.airTime = 0;
      this.scoredThisFlight = false;
      this.touchedRim = false;
    }

    /**
     * Launch the ball with an explicit velocity.
     * @param {number} vx @param {number} vy @param {number} vz
     * @param {string} state STATE.SHOT / STATE.PASS / STATE.LOOSE
     */
    launch(vx, vy, vz, state) {
      this.vx = vx; this.vy = vy; this.vz = vz;
      this.release(state);
      this.spin = -Math.hypot(vx, vy) * 0.55;
      this.backspin = state === STATE.SHOT ? 1 : 0.25;
      this.trail.length = 0;
    }

    /**
     * Solve the launch velocity that carries the ball from its current point to
     * (tx, ty, tz) reaching a peak `apex` feet above the higher endpoint.
     * Returns null when the arc is impossible (target above the requested apex).
     */
    solveArc(tx, ty, tz, apex, out) {
      const g = C.GRAVITY;
      const z0 = this.z;
      const peak = Math.max(z0, tz) + apex;
      const rise = peak - z0;
      if (rise <= 0.05) return null;

      const vz = Math.sqrt(2 * g * rise);
      const tUp = vz / g;
      const drop = peak - tz;
      if (drop < 0) return null;
      const tDown = Math.sqrt(2 * drop / g);
      const t = tUp + tDown;

      out = out || { vx: 0, vy: 0, vz: 0, t: 0 };
      out.vx = (tx - this.x) / t;
      out.vy = (ty - this.y) / t;
      out.vz = vz;
      out.t = t;
      return out;
    }

    /** Convenience: shoot at a hoop with a given apex and error offsets. */
    shootAt(hoop, apex, errX, errY, errShort) {
      const s = this.solveArc(
        hoop.x + (errX || 0),
        hoop.y + (errY || 0),
        C.RIM_HEIGHT + (errShort || 0),
        apex
      );
      if (!s) return false;
      this.targetHoop = hoop;
      this.launch(s.vx, s.vy, s.vz, STATE.SHOT);
      return true;
    }

    /* ---------------------------------------------------------------- update */
    update(dt) {
      if (this.state === STATE.HELD || this.state === STATE.DEAD) {
        this.rot += this.spin * dt * 0.25;
        return;
      }

      this.prevZ = this.z;
      this.airTime += dt;

      /* --- integrate ------------------------------------------------------ */
      const speed = Math.hypot(this.vx, this.vy, this.vz);
      if (speed > 0.001) {
        const drag = C.AIR_DRAG * speed;
        this.vx -= this.vx * drag * dt;
        this.vy -= this.vy * drag * dt;
        this.vz -= this.vz * drag * dt;
      }
      this.vz -= C.GRAVITY * dt;

      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.z += this.vz * dt;

      this.rot += this.spin * dt;

      /* --- collisions ----------------------------------------------------- */
      this._floor(dt);
      for (let i = 0; i < this.hoops.length; i++) {
        this._rim(this.hoops[i]);
        this._backboard(this.hoops[i]);
        this._checkScore(this.hoops[i]);
      }

      /* --- trail ---------------------------------------------------------- */
      if (this.state === STATE.SHOT || this.z > 2.5) {
        this.trailTimer -= dt;
        if (this.trailTimer <= 0) {
          this.trailTimer = 0.016;
          this.trail.push(this.x, this.y, this.z, 1);
          if (this.trail.length > 4 * 26) this.trail.splice(0, 4);
        }
      }
      for (let i = 3; i < this.trail.length; i += 4) {
        this.trail[i] -= dt * 2.6;
      }
      while (this.trail.length && this.trail[3] <= 0) this.trail.splice(0, 4);
    }

    /* --------------------------------------------------------------- floor */
    _floor(dt) {
      const r = C.BALL_RADIUS;
      if (this.z > r) return;

      this.z = r;
      if (this.vz < -C.REST_SPEED) {
        const impact = -this.vz;
        this.vz = impact * C.FLOOR_RESTITUTION;
        this.vx *= C.FLOOR_FRICTION + 0.2;
        this.vy *= C.FLOOR_FRICTION + 0.2;
        this.spin *= 0.75;
        this.events.emit('bounce', { x: this.x, y: this.y, force: U.clamp01(impact / 24) });
        if (this.state === STATE.SHOT && !this.scoredThisFlight) {
          this.state = STATE.LOOSE;
          this.events.emit('miss', { shooter: this.shooter, x: this.x, y: this.y });
        }
      } else {
        this.vz = 0;
        // Rolling friction so a dead ball actually comes to rest.
        const f = Math.exp(-2.4 * dt);
        this.vx *= f;
        this.vy *= f;
        if (Math.hypot(this.vx, this.vy) < 0.25) { this.vx = 0; this.vy = 0; this.spin *= 0.9; }
        if (this.state === STATE.SHOT && !this.scoredThisFlight) {
          this.events.emit('miss', { shooter: this.shooter, x: this.x, y: this.y });
        }
        if (this.state === STATE.SHOT || this.state === STATE.PASS) this.state = STATE.LOOSE;
      }
    }

    /* ----------------------------------------------------------------- rim */
    _rim(hoop) {
      const dx = this.x - hoop.x;
      const dy = this.y - hoop.y;
      const dh = Math.hypot(dx, dy);

      // Cheap reject: nowhere near the ring plane.
      if (Math.abs(this.z - C.RIM_HEIGHT) > C.BALL_RADIUS + C.RIM_TUBE + 0.4 ||
          dh > C.RIM_RADIUS + C.BALL_RADIUS + C.RIM_TUBE + 0.2) {
        this._rimContactTicks = 0;
        return;
      }

      let nx, ny;
      if (dh < 1e-4) { nx = 1; ny = 0; } else { nx = dx / dh; ny = dy / dh; }

      // Closest point on the ring circle.
      const px = hoop.x + nx * C.RIM_RADIUS;
      const py = hoop.y + ny * C.RIM_RADIUS;
      const pz = C.RIM_HEIGHT;

      let ex = this.x - px, ey = this.y - py, ez = this.z - pz;
      const d = Math.hypot(ex, ey, ez);
      const minD = C.BALL_RADIUS + C.RIM_TUBE;
      if (d >= minD || d < 1e-6) {
        this._rimContactTicks = 0;
        return;
      }

      ex /= d; ey /= d; ez /= d;
      this._rimContactTicks++;

      // Sustained, unresolved contact — position correction pushing the ball
      // just clear of the tube and gravity pulling it right back into
      // contact next tick can stalemate for a long time at certain
      // trajectory/rim geometries (this was measured taking multiple real
      // seconds on some deep shots). A real ball never balances on the rim
      // edge like that; force a clean resolution rather than let it rattle.
      if (this._rimContactTicks > 18) {
        const dropIn = dh < C.RIM_RADIUS * 0.55; // nearer the middle than the edge
        this.x += ex * minD * 0.6;
        this.y += ey * minD * 0.6;
        this.z += ez * minD * 0.6;
        if (dropIn) {
          this.vx *= 0.3; this.vy *= 0.3;
          this.vz = Math.min(this.vz, -3.5); // decisively through
        } else {
          this.vx += nx * 2.5; this.vy += ny * 2.5;
          this.vz = Math.max(this.vz, 2.0); // decisively away
        }
        this._rimContactTicks = 0;
        this.touchedRim = true;
        return;
      }

      /* Positional correction first, so the ball can never sink into the ring. */
      const push = (minD - d) + 0.001;
      this.x += ex * push;
      this.y += ey * push;
      this.z += ez * push;

      const vn = this.vx * ex + this.vy * ey + this.vz * ez;
      if (vn < 0) {
        const e = C.RIM_RESTITUTION;
        this.vx -= (1 + e) * vn * ex;
        this.vy -= (1 + e) * vn * ey;
        this.vz -= (1 + e) * vn * ez;

        // Tangential friction bleeds sideways speed off the ring.
        const f = C.RIM_FRICTION;
        const tvx = this.vx - (this.vx * ex + this.vy * ey + this.vz * ez) * ex;
        this.vx = this.vx - tvx * (1 - f) * 0.3;

        /* Backspin is what makes a shooter's roll fall in: bias the bounce
         * back toward the ring's axis in proportion to the spin left on it. */
        if (this.backspin > 0.05) {
          const pull = this.backspin * 3.1;
          this.vx -= nx * pull;
          this.vy -= ny * pull;
          this.vz *= 0.86;
          this.backspin *= 0.45;
        }

        this.touchedRim = true;
        this.events.emit('rim', {
          hoop, x: this.x, y: this.y, z: this.z,
          force: U.clamp01(-vn / 22)
        });
      }
    }

    /* ----------------------------------------------------------- backboard */
    _backboard(hoop) {
      const bx = (hoop.dir > 0 ? 0 : C.COURT_L) + hoop.dir * C.BACKBOARD_INSET;
      if (this.z < C.BACKBOARD_BOTTOM - C.BALL_RADIUS || this.z > C.BACKBOARD_TOP + C.BALL_RADIUS) return;
      if (Math.abs(this.y - hoop.y) > C.BACKBOARD_HALF_W + C.BALL_RADIUS) return;

      const dx = this.x - bx;
      if (Math.abs(dx) > C.BALL_RADIUS) return;

      const side = dx >= 0 ? 1 : -1;
      this.x = bx + side * C.BALL_RADIUS;
      if (this.vx * side < 0) {
        this.events.emit('board', {
          hoop, x: this.x, y: this.y, z: this.z,
          force: U.clamp01(Math.abs(this.vx) / 26)
        });
        this.vx = -this.vx * C.BOARD_RESTITUTION;
        this.vy *= 0.86;
        this.vz *= 0.90;
        this.backspin *= 0.5;
      }
    }

    /* --------------------------------------------------------------- score */
    _checkScore(hoop) {
      if (this.scoredThisFlight) return;
      if (this.vz >= 0) return;
      if (!(this.prevZ > C.RIM_HEIGHT && this.z <= C.RIM_HEIGHT)) return;

      const dh = U.dist(this.x, this.y, hoop.x, hoop.y);
      if (dh > C.RIM_RADIUS * 0.94) return;

      this.scoredThisFlight = true;
      // Passing through drags on the mesh.
      this.vz *= C.NET_DAMPING;
      this.vx *= 0.42;
      this.vy *= 0.42;
      this.events.emit('score', {
        hoop,
        clean: !this.touchedRim,
        shooter: this.shooter,
        three: this.shotWasThree,
        x: this.x, y: this.y
      });
    }

    /* ------------------------------------------------------------ queries */
    get speed() { return Math.hypot(this.vx, this.vy, this.vz); }
    get inFlight() { return this.state === STATE.SHOT || this.state === STATE.PASS; }

    /** Is the ball's floor position outside the lines? */
    isOutOfBounds() {
      return this.x < 0 || this.x > C.COURT_L || this.y < 0 || this.y > C.COURT_W;
    }

    /** Seconds until the ball next passes through height `z` on the way down. */
    timeToHeight(z) {
      const g = C.GRAVITY;
      const disc = this.vz * this.vz + 2 * g * (this.z - z);
      if (disc < 0) return -1;
      return (this.vz + Math.sqrt(disc)) / g;
    }

    /* ---------------------------------------------------------------- draw */
    /** Floor shadow. Grows and fades as the ball rises. */
    drawShadow() {
      const h = U.clamp01(this.z / C.SHADOW_MAX_H);
      const a = (1 - h) * 0.45 + 0.05;
      const r = C.BALL_RADIUS * VISUAL_BOOST * (1 + h * 1.9);
      BB.S3.shadow(this.x, this.y, r * 1.5, a);
    }

    /**
     * The ball, its seams and its motion trail.
     *
     * VISUAL_BOOST renders the ball larger than its true physical size — a
     * real 9.5in ball is otherwise nearly impossible to track at broadcast
     * camera distance. Collision and physics elsewhere always use
     * C.BALL_RADIUS directly, so this is purely cosmetic.
     */
    draw() {
      const S3 = BB.S3;
      const r = C.BALL_RADIUS * VISUAL_BOOST;

      /* Motion trail: a run of shrinking, fading spheres along the recorded
       * path. Cheap, and unlike a 2D polyline it survives any camera angle. */
      if (this.trail.length >= 12) {
        const steps = this.trail.length / 3;
        for (let i = 0; i < steps - 1; i += 3) {
          const k = i / (steps - 1);
          const o = i * 3;
          S3.sphere(this.trail[o], this.trail[o + 1], this.trail[o + 2],
                    r * (0.30 + k * 0.45), trailCol(0.05 + k * 0.16), 0, 0.25, true);
        }
      }

      /* Body. */
      S3.sphere(this.x, this.y, this.z, r, BALL_COL, 0.28, 0.05);

      /* Seams: four bands of dark tube laid over the sphere, rotating with the
       * ball. Two are great circles through the poles and two are the classic
       * offset curves, which together are what make a basketball read as a
       * basketball rather than an orange dot. */
      const sr = r * 1.005;
      const rot = this.rot;
      for (let s = 0; s < SEAMS.length; s++) {
        const seam = SEAMS[s];
        let px = 0, py = 0, pz = 0, have = false;
        for (let i = 0; i <= SEAM_SEGS; i++) {
          const t = (i / SEAM_SEGS) * Math.PI * 2;
          const ct = Math.cos(t), st = Math.sin(t);
          // Point on the unit circle in the seam's own plane, then rotated
          // into the ball's frame by its spin about the horizontal axis.
          const ux = seam[0] * ct + seam[3] * st;
          const uy = seam[1] * ct + seam[4] * st;
          const uz = seam[2] * ct + seam[5] * st;
          const cr = Math.cos(rot), srot = Math.sin(rot);
          const ry = uy * cr - uz * srot;
          const rz = uy * srot + uz * cr;
          const wx = this.x + ux * sr, wy = this.y + ry * sr, wz = this.z + rz * sr;
          if (have) {
            S3.limb(px, py, pz, wx, wy, wz, r * 0.055, SEAM_COL, 0.1);
          }
          px = wx; py = wy; pz = wz; have = true;
        }
      }
    }
  }

  /* ------------------------------------------------------------ appearance
   * Seam planes, each given as two orthogonal unit vectors spanning the plane
   * the seam circle lies in. Two great circles plus two tilted ones is the
   * standard eight-panel basketball layout.
   */
  const SEAM_SEGS = 22;
  const SEAMS = [
    [1, 0, 0, 0, 1, 0],
    [1, 0, 0, 0, 0, 1],
    [0.707, 0.707, 0, 0, 0, 1],
    [0.707, -0.707, 0, 0, 0, 1]
  ];
  const BALL_COL = [0.824, 0.376, 0.118, 1];
  const SEAM_COL = [0.10, 0.055, 0.02, 1];
  const TRAIL_COL = [0.824, 0.376, 0.118, 0.2];
  function trailCol(a) { TRAIL_COL[3] = a; return TRAIL_COL; }

  Ball.STATE = STATE;
  BB.Ball = Ball;
})(typeof window !== 'undefined' ? window : globalThis);
