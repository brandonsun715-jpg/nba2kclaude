/* =============================================================================
 * replay.js  —  Slow motion and the instant replay.
 * -----------------------------------------------------------------------------
 * When something worth seeing twice happens, the game does what a broadcast
 * does: it cuts to the last second and a half in slow motion, flown on a
 * camera that was never on the floor at the time, freezes on the moment, and
 * cuts back to live play exactly where it left off.
 *
 * How it records
 *   Every frame of live play, the pose of every player and the position of the
 *   ball are written into a ring buffer as flat floats — the same handful of
 *   numbers draw() reads, and nothing else. Six seconds at sixty frames for ten
 *   players is about half a megabyte, allocated once at boot and never grown.
 *   Deriving the pose again on playback was the alternative and it is a trap:
 *   the pose comes out of a dozen smoothed animation fields, so reproducing it
 *   means reproducing the animation state machine exactly, and any drift shows
 *   up as a replay that does not match what the player just watched.
 *
 * How it plays back
 *   The simulation is FROZEN — the engine skips its update entirely — and the
 *   recorded floats are written straight back over the live entities, sampled
 *   between frames so the slow motion is smooth rather than a slideshow of
 *   captured frames. That means the replay is scrubbing over the live world, so
 *   everything it overwrites is stashed on the way in and put back on the way
 *   out, to the float. Nothing about the game state moves while a replay runs.
 *
 * Nothing in here decides anything about the game. It is presentation, it can
 * be switched off in settings, and play resumes exactly where it paused.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  /* ------------------------------------------------------------ the buffer */
  const RATE = 60;                    // captured frames per second of real time
  const SECONDS = 6;
  const FRAMES = RATE * SECONDS;
  const MAX_PLAYERS = 10;
  const BALL_STRIDE = 6;
  const PLAYER_STRIDE = 52;
  const FRAME_STRIDE = BALL_STRIDE + MAX_PLAYERS * PLAYER_STRIDE;

  /* ----------------------------------------------------------- the timings
   * PRE_ROLL is how far back the replay starts, in recorded seconds, and
   * PLAY_RATE how fast that footage is played — 0.55 being the slow motion.
   * HOLD_TAIL runs on past the last recorded frame, where the sampler has
   * nothing left to advance to and simply holds it: the shot freezes at the
   * rim with the camera still swinging round it.
   *
   * There is deliberately no slow-motion beat on the LIVE moment before the
   * cut. A basket is also a restart — 1v1 checks the ball at the top of the
   * key, 5v5 forms up for the inbound — and both of those reposition everybody
   * on the same frame the ball goes through. Hanging on the live moment hangs
   * on that, so the moment worth watching is the recorded one, and the replay
   * is where the slow motion lives. */
  const PRE_ROLL = 1.60;
  const HOLD_TAIL = 0.30;
  const PLAY_RATE = 0.55;
  const OUT_TIME = 0.28;              // real seconds of hand-back to live play
  const COOLDOWN = 8.0;               // real seconds before another may fire

  /** Below this a play is not worth stopping the game for. */
  const THRESHOLD = 0.8;

  const Replay = {
    /* 'off' | 'armed' (asked for, starting next frame) | 'play' | 'out' */
    phase: 'off',
    label: '',
    enabled: true,

    /** True only while recorded frames are on screen and the sim is frozen. */
    playing: false,

    _buf: null,
    _slots: 0,          // players actually written into the current frames
    _abs: 0,            // frames captured since boot, monotonic
    _capT: 0,           // time owed to the next capture
    _cooldown: 0,

    _phaseT: 0,
    _triggerAbs: 0,
    _playT: 0,
    _playSpan: 0,

    /* Where the play happened, for the camera to fly around. */
    _focusX: 0, _focusY: 0, _hoopX: 0, _hoopY: 0,
    _aimX: 0, _aimY: 0, _aimZ: 0, _aimSet: false,

    /* Live state parked while the replay scrubs over it. */
    _parked: null,
    _parkedTrail: null,
    _cast: null,

    /* ------------------------------------------------------------------ init */
    init() {
      this._buf = new Float32Array(FRAMES * FRAME_STRIDE);
      this._parked = new Float32Array(FRAME_STRIDE);
      return this;
    },

    /** Drops everything. Called on any scene change. */
    reset() {
      if (this.playing) this._unpark();
      this.phase = 'off';
      this.playing = false;
      this._abs = 0;
      this._capT = 0;
      this._cooldown = 0;
      this._cast = null;
      this._aimSet = false;
      if (BB.HUD) BB.HUD.setReplay(false);
      if (BB.Camera) BB.Camera.endFly();
      if (BB.Engine) BB.Engine.setTimeScale(1, true);
    },

    /* -------------------------------------------------------------- triggers */
    /**
     * Rates a made basket. Kept here rather than in each scene so 1v1, 5v5 and
     * the shootaround cannot drift apart on what counts as a highlight.
     * @returns {?{weight: number, label: string}}
     */
    rateShot(e, shooter) {
      const type = shooter && shooter.shotType;
      if (type === 'dunk') return { weight: 1.0, label: 'THROWN DOWN' };
      // The one the whole feature is for: nothing but net, from behind the arc.
      if (e.three && e.clean) return { weight: 1.0, label: 'SWISH FROM DEEP' };
      if (e.clean && shooter && shooter.stats.streak >= 3) {
        return { weight: 0.85, label: 'HEATING UP' };
      }
      // A three that rattles in is a good shot and an ugly picture.
      if (e.three) return { weight: 0.5, label: 'FROM DEEP' };
      if (type === 'layup' && shooter && shooter.driving) {
        return { weight: 0.5, label: 'AT THE RIM' };
      }
      return null;
    },

    /**
     * Ask for a highlight. Declines quietly if the play is not big enough, if
     * one just ran, if the feature is off, or if there is not enough recorded
     * footage behind the moment to cut back to.
     *
     * Only ARMS the replay; it starts on the next frame. A score is raised
     * from inside the simulation, and whatever the scene does about it — the
     * restart, the inbound, the new possession — has not happened yet at this
     * point. Playback parks the live world so it can scrub over it, and
     * parking it here would park a half-finished frame and hand that back at
     * the end. The recorded window still ends at the frame BEFORE all of that,
     * which is the last one that has the shot in it.
     *
     * @param {object} o { weight, label, x, y, hoopX, hoopY }
     * @returns {boolean} whether it was taken
     */
    highlight(o) {
      if (!o || (o.weight || 0) < THRESHOLD) return false;
      if (!this.enabled || !this._cast) return false;
      if (this.phase !== 'off' || this._cooldown > 0) return false;
      if (this._abs < PRE_ROLL * RATE + 2) return false;

      this.phase = 'armed';
      this._phaseT = 0;
      this.label = o.label || 'HIGHLIGHT';
      this._triggerAbs = this._abs - 1;
      this._focusX = o.x == null ? C.HALF_L : o.x;
      this._focusY = o.y == null ? C.HALF_W : o.y;
      this._hoopX = o.hoopX == null ? C.COURT_L : o.hoopX;
      this._hoopY = o.hoopY == null ? C.HALF_W : o.hoopY;
      return true;
    },

    /* ------------------------------------------------------------ the frame
     * The one call the engine makes. Returns true when the simulation must sit
     * this frame out because recorded frames are on screen instead.
     */
    beginFrame(rawDt, scene) {
      this.enabled = !BB.Settings || BB.Settings.get('instantReplay') !== false;
      this._cast = (scene && scene.replayCast) ? scene.replayCast() : null;
      if (this._cooldown > 0) this._cooldown -= rawDt;

      // A replay is presentation; a pause menu outranks it and freezes it too.
      const held = BB.Menus && BB.Menus.isOpen;

      if (this.phase === 'armed') {
        if (!held) this._beginPlayback();
      } else if (this.phase === 'play') {
        if (!held) this._advance(rawDt);
      } else if (this.phase === 'out') {
        if (!held) this._phaseT += rawDt;
        if (this._phaseT >= OUT_TIME) this.phase = 'off';
      }

      if (this.playing) return true;
      if (!held) this._capture(rawDt);
      return false;
    },

    /* ------------------------------------------------------------- recording */
    _capture(rawDt) {
      const cast = this._cast;
      if (!cast || !cast.ball || !this._buf) return;

      this._capT += rawDt;
      if (this._capT < 1 / RATE) return;
      // One frame per pass however far behind we are: catching up by writing
      // several identical frames would only pad the buffer with stutter.
      this._capT = Math.min(this._capT - 1 / RATE, 1 / RATE);

      const buf = this._buf;
      let o = (this._abs % FRAMES) * FRAME_STRIDE;
      const b = cast.ball;
      buf[o] = b.x; buf[o + 1] = b.y; buf[o + 2] = b.z;
      buf[o + 3] = b.rot; buf[o + 4] = 0; buf[o + 5] = 0;
      o += BALL_STRIDE;

      const players = cast.players || EMPTY;
      const n = Math.min(players.length, MAX_PLAYERS);
      this._slots = n;
      for (let i = 0; i < n; i++) {
        writePlayer(buf, o, players[i]);
        o += PLAYER_STRIDE;
      }
      this._abs++;
    },

    /* -------------------------------------------------------------- playback */
    _beginPlayback() {
      const cast = this._cast;
      if (!cast || !cast.ball) { this._end(); return; }

      // Park the live world exactly as it stands. Everything below scrubs over
      // these very objects, so this is the only copy of the present.
      const buf = this._parked;
      let o = 0;
      const b = cast.ball;
      buf[o] = b.x; buf[o + 1] = b.y; buf[o + 2] = b.z; buf[o + 3] = b.rot;
      o += BALL_STRIDE;
      const players = cast.players || EMPTY;
      const n = Math.min(players.length, MAX_PLAYERS);
      for (let i = 0; i < n; i++) { writePlayer(buf, o, players[i]); o += PLAYER_STRIDE; }
      this._parkedCount = n;
      // The comet trail is rebuilt from recorded positions during playback, so
      // the live one is set aside whole rather than overwritten.
      this._parkedTrail = b.trail;
      b.trail = [];

      this.phase = 'play';
      this.playing = true;
      this._phaseT = 0;
      this._playT = 0;
      this._playSpan = PRE_ROLL + HOLD_TAIL;
      this._aimSet = false;

      if (BB.HUD) BB.HUD.setReplay(true);

      // Scrub to the first recorded frame and put the camera on it right now.
      // Left until the next update, the frame this cut happens on would render
      // the live world from the live rig — one frame of the present spliced
      // into the front of the replay.
      this._sampleTo(this._triggerAbs - PRE_ROLL * RATE);
      this._flyCamera(0);
    },

    _advance(rawDt) {
      if (BB.Input && (BB.Input.pressed('shoot') || BB.Input.pressed('pass'))) {
        this._end();
        return;
      }
      this._playT += rawDt * PLAY_RATE;
      if (this._playT >= this._playSpan) { this._end(); return; }

      const at = this._triggerAbs - PRE_ROLL * RATE + this._playT * RATE;
      this._sampleTo(at);
      this._flyCamera(U.clamp01(this._playT / this._playSpan));
    },

    _end() {
      this._unpark();
      this.phase = 'out';
      this._phaseT = 0;
      this._cooldown = COOLDOWN;
      BB.Camera.endFly();
      if (BB.HUD) BB.HUD.setReplay(false);
    },

    /** Puts the live world back, to the float. */
    _unpark() {
      if (!this.playing) return;
      this.playing = false;
      const cast = this._cast;
      const buf = this._parked;
      if (cast && cast.ball) {
        const b = cast.ball;
        b.x = buf[0]; b.y = buf[1]; b.z = buf[2]; b.rot = buf[3];
        if (this._parkedTrail) { b.trail = this._parkedTrail; this._parkedTrail = null; }
        const players = cast.players || EMPTY;
        let o = BALL_STRIDE;
        const n = Math.min(this._parkedCount || 0, players.length);
        for (let i = 0; i < n; i++) { readPlayer(buf, o, players[i]); o += PLAYER_STRIDE; }
      }
    },

    /**
     * Writes the recorded world at fractional frame `at` over the live one,
     * blending between the two captured frames either side of it — without
     * that the slow motion runs at the capture rate and reads as a flip-book.
     */
    _sampleTo(at) {
      const cast = this._cast;
      const buf = this._buf;
      if (!cast || !buf) return;

      const oldest = Math.max(0, this._abs - FRAMES);
      const a = U.clamp(Math.floor(at), oldest, this._abs - 1);
      const bIdx = U.clamp(a + 1, oldest, this._abs - 1);
      const t = U.clamp01(at - a);

      const oA = (a % FRAMES) * FRAME_STRIDE;
      const oB = (bIdx % FRAMES) * FRAME_STRIDE;

      const ball = cast.ball;
      ball.x = U.lerp(buf[oA], buf[oB], t);
      ball.y = U.lerp(buf[oA + 1], buf[oB + 1], t);
      ball.z = U.lerp(buf[oA + 2], buf[oB + 2], t);
      ball.rot = U.lerp(buf[oA + 3], buf[oB + 3], t);

      const players = cast.players || EMPTY;
      const n = Math.min(players.length, this._slots);
      for (let i = 0; i < n; i++) {
        lerpPlayer(buf, oA + BALL_STRIDE + i * PLAYER_STRIDE,
                        oB + BALL_STRIDE + i * PLAYER_STRIDE, t, players[i]);
      }

      this._rebuildTrail(ball, a);
    },

    /** The comet behind the ball, rebuilt out of the frames just played. */
    _rebuildTrail(ball, a) {
      const buf = this._buf;
      const trail = ball.trail;
      trail.length = 0;
      const oldest = Math.max(0, this._abs - FRAMES);
      const span = 22;
      for (let k = span; k >= 0; k--) {
        const idx = a - k;
        if (idx < oldest) continue;
        const o = (idx % FRAMES) * FRAME_STRIDE;
        // Only while it is actually in the air; a trail on a dribble is smoke.
        if (buf[o + 2] < 2.5) continue;
        trail.push(buf[o], buf[o + 1], buf[o + 2], 1 - k / (span + 1));
      }
    },

    /* ---------------------------------------------------------------- camera
     * A shot that was never available live: the rig swings round the play at a
     * held distance, looking at the ball. The orbit is what makes a replay read
     * as a replay rather than as the same footage again.
     */
    _flyCamera(t) {
      const cast = this._cast;
      const ball = cast && cast.ball;
      if (!ball) return;

      const cx = U.lerp(this._focusX, this._hoopX, 0.45);
      const cy = U.lerp(this._focusY, this._hoopY, 0.45);
      const reach = U.dist(this._focusX, this._focusY, this._hoopX, this._hoopY);
      const R = U.clamp(reach * 0.60 + 13, 18, 29);

      // Start off the shooter's outside shoulder and sweep round toward the
      // baseline, so the basket comes into frame as the ball does.
      const base = Math.atan2(this._focusY - this._hoopY, this._focusX - this._hoopX);
      const ang = base - 0.55 + U.ease.inOutQuad(t) * 1.15;
      const ex = cx + Math.cos(ang) * R;
      const ey = cy + Math.sin(ang) * R;
      const ez = 9.0 + Math.sin(Math.PI * t) * 3.5;

      /* The aim leads the ball but is pulled a third of the way toward the
       * basket, and only ever half as high as the ball is. Aimed dead at the
       * ball, a shot's apex tips the whole frame up into empty sky and the
       * court leaves the bottom of the picture. */
      const wx = U.lerp(ball.x, this._hoopX, 0.34);
      const wy = U.lerp(ball.y, this._hoopY, 0.34);
      /* And it stays low. Aimed level with a ball at its apex, the frame
       * centres fourteen feet in the air and the players — the point of the
       * shot — slide off the bottom edge of it. */
      const wz = U.clamp(3.2 + ball.z * 0.22, 3.2, 7.2);

      // And it chases rather than snapping: sampled positions jitter by
      // fractions of a foot, and at this range that reads as camera shake.
      if (!this._aimSet) {
        this._aimX = wx; this._aimY = wy; this._aimZ = wz;
        this._aimSet = true;
      }
      this._aimX = U.lerp(this._aimX, wx, 0.16);
      this._aimY = U.lerp(this._aimY, wy, 0.16);
      this._aimZ = U.lerp(this._aimZ, wz, 0.16);

      BB.Camera.flyTo(ex, ey, ez, this._aimX, this._aimY, this._aimZ);
    },

    /* --------------------------------------------------------------- overlay */
    /** Letterbox, badge and scrub line. Screen space, drawn over everything. */
    drawOverlay(ctx, w, h, dpr) {
      const k = this._overlayAmount();
      if (k <= 0.001) return;
      const bar = h * 0.075 * k;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(4,6,10,0.92)';
      ctx.fillRect(0, 0, w, bar);
      ctx.fillRect(0, h - bar, w, bar);

      if (this.phase === 'play' && k > 0.5) {
        const pad = 22 * dpr;
        const mid = bar * 0.5;
        ctx.globalAlpha = U.clamp01((k - 0.5) * 2);

        // Live-looking record dot, and the word.
        ctx.fillStyle = PAL.red;
        ctx.beginPath();
        ctx.arc(pad + 5 * dpr, mid, 5 * dpr, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = PAL.chalk;
        ctx.font = '800 ' + (13 * dpr).toFixed(0) + 'px ui-monospace, Menlo, Consolas, monospace';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText('INSTANT REPLAY', pad + 18 * dpr, mid + dpr);

        ctx.fillStyle = PAL.gold;
        ctx.textAlign = 'right';
        ctx.fillText(this.label, w - pad, mid + dpr);

        ctx.fillStyle = 'rgba(243,240,231,0.35)';
        ctx.font = '600 ' + (11 * dpr).toFixed(0) + 'px ui-monospace, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('SHOOT TO SKIP', w * 0.5, h - bar * 0.5 + dpr);

        // Scrub line across the bottom of the top bar.
        const p = U.clamp01(this._playT / Math.max(0.001, this._playSpan));
        ctx.globalAlpha = ctx.globalAlpha * 0.9;
        ctx.fillStyle = 'rgba(243,240,231,0.18)';
        ctx.fillRect(0, bar - 2 * dpr, w, 2 * dpr);
        ctx.fillStyle = PAL.mint;
        ctx.fillRect(0, bar - 2 * dpr, w * p, 2 * dpr);
      }

      ctx.restore();
    },

    /**
     * 0..1 letterbox openness. Measured off the playback clock rather than a
     * timer of its own, so the bars are shut before the cut back to live play
     * however the replay ended — including when it was skipped.
     */
    _overlayAmount() {
      if (this.phase !== 'play') return 0;
      return Math.min(U.clamp01(this._playT / 0.12),
                      U.clamp01((this._playSpan - this._playT) / 0.12));
    }
  };

  const EMPTY = [];

  /* ------------------------------------------------------- the float layout
   * Everything draw() reads off a player and nothing else: the body's place in
   * the world, and the solved skeleton. Kept as one flat block per player so a
   * frame is a single contiguous run of floats.
   */
  function writePlayer(a, o, p) {
    const s = p.pose;
    a[o] = p.x; a[o + 1] = p.y; a[o + 2] = p.z;
    a[o + 3] = p.facing; a[o + 4] = p.squash; a[o + 5] = p.lean;
    a[o + 6] = s.hipY; a[o + 7] = s.shoulderY; a[o + 8] = s.headY;
    a[o + 9] = s.torsoLean; a[o + 10] = s.hipLean; a[o + 11] = s.armRoll;
    a[o + 12] = s.footL.x; a[o + 13] = s.footL.y; a[o + 14] = s.footL.pitch;
    a[o + 15] = s.footR.x; a[o + 16] = s.footR.y; a[o + 17] = s.footR.pitch;
    a[o + 18] = s.handL.x; a[o + 19] = s.handL.y;
    a[o + 20] = s.handR.x; a[o + 21] = s.handR.y;
    a[o + 22] = s.kneeL.jx; a[o + 23] = s.kneeL.jy; a[o + 24] = s.kneeL.ex; a[o + 25] = s.kneeL.ey;
    a[o + 26] = s.kneeR.jx; a[o + 27] = s.kneeR.jy; a[o + 28] = s.kneeR.ex; a[o + 29] = s.kneeR.ey;
    a[o + 30] = s.elbowL.jx; a[o + 31] = s.elbowL.jy; a[o + 32] = s.elbowL.ex; a[o + 33] = s.elbowL.ey;
    a[o + 34] = s.elbowR.jx; a[o + 35] = s.elbowR.jy; a[o + 36] = s.elbowR.ex; a[o + 37] = s.elbowR.ey;
    /* The off-plane half of the pose, and it is not optional.
     *
     * The solver works in one flat plane per limb pair; everything that leaves
     * that plane — how far the arms are drawn toward the centreline, the
     * lateral offsets that put a guide hand on the side of the ball or throw a
     * dunker's free arm wide, the palm roll — lives in these fields, and none
     * of them were being recorded. draw() reads every one, so a replay was
     * rebuilding the skeleton and then drawing it with all of that at zero:
     * flat, square, palms forward. Most visible on the one clip the highlight
     * system rates highest, a dunk, whose whole silhouette is off-plane.
     *
     * visualLift is here for the same reason — it is drawn height, so a replay
     * without it puts the hand back under the rim. */
    a[o + 38] = s.armTuck || 0;
    a[o + 39] = s.footL.side || 0; a[o + 40] = s.footR.side || 0;
    a[o + 41] = s.handL.side || 0; a[o + 42] = s.handR.side || 0;
    a[o + 43] = s.handL.twist || 0; a[o + 44] = s.handR.twist || 0;
    a[o + 45] = p.visualLift || 0;
    /* Outright lateral placement, which the shot and the dunk use instead of
     * `side` — so leaving it out would put a replayed jump shot's hands back
     * where the tuck alone puts them, on top of each other in front of the
     * face. That is the same omission this block was written to fix, one field
     * later.
     *
     * These four are the only pose values that can be ABSENT rather than zero:
     * null means "derive it from the splay and the tuck", and zero means "on
     * the centreline", which are opposite instructions. NaN carries the null
     * through a Float32Array, and it carries correctly through the blend too —
     * lerping across a frame where the placement appears or disappears gives
     * NaN, i.e. the derived path, which is the right answer for that frame. */
    a[o + 46] = s.handL.lat == null ? NaN : s.handL.lat;
    a[o + 47] = s.handR.lat == null ? NaN : s.handR.lat;
    a[o + 48] = s.handL.elbowLat == null ? NaN : s.handL.elbowLat;
    a[o + 49] = s.handR.elbowLat == null ? NaN : s.handR.elbowLat;
    a[o + 50] = 0; a[o + 51] = 0;
  }

  /** NaN back to null — see writePlayer. */
  function orNull(v) { return v === v ? v : null; }

  function readPlayer(a, o, p) {
    const s = p.pose;
    p.x = a[o]; p.y = a[o + 1]; p.z = a[o + 2];
    p.facing = a[o + 3]; p.squash = a[o + 4]; p.lean = a[o + 5];
    s.hipY = a[o + 6]; s.shoulderY = a[o + 7]; s.headY = a[o + 8];
    s.torsoLean = a[o + 9]; s.hipLean = a[o + 10]; s.armRoll = a[o + 11];
    s.footL.x = a[o + 12]; s.footL.y = a[o + 13]; s.footL.pitch = a[o + 14];
    s.footR.x = a[o + 15]; s.footR.y = a[o + 16]; s.footR.pitch = a[o + 17];
    s.handL.x = a[o + 18]; s.handL.y = a[o + 19];
    s.handR.x = a[o + 20]; s.handR.y = a[o + 21];
    s.kneeL.jx = a[o + 22]; s.kneeL.jy = a[o + 23]; s.kneeL.ex = a[o + 24]; s.kneeL.ey = a[o + 25];
    s.kneeR.jx = a[o + 26]; s.kneeR.jy = a[o + 27]; s.kneeR.ex = a[o + 28]; s.kneeR.ey = a[o + 29];
    s.elbowL.jx = a[o + 30]; s.elbowL.jy = a[o + 31]; s.elbowL.ex = a[o + 32]; s.elbowL.ey = a[o + 33];
    s.elbowR.jx = a[o + 34]; s.elbowR.jy = a[o + 35]; s.elbowR.ex = a[o + 36]; s.elbowR.ey = a[o + 37];
    s.armTuck = a[o + 38];
    s.footL.side = a[o + 39]; s.footR.side = a[o + 40];
    s.handL.side = a[o + 41]; s.handR.side = a[o + 42];
    s.handL.twist = a[o + 43]; s.handR.twist = a[o + 44];
    p.visualLift = a[o + 45];
    s.handL.lat = orNull(a[o + 46]); s.handR.lat = orNull(a[o + 47]);
    s.handL.elbowLat = orNull(a[o + 48]); s.handR.elbowLat = orNull(a[o + 49]);
  }

  /** Same as readPlayer, blended between two frames. */
  function lerpPlayer(a, oA, oB, t, p) {
    const s = p.pose;
    p.x = U.lerp(a[oA], a[oB], t);
    p.y = U.lerp(a[oA + 1], a[oB + 1], t);
    p.z = U.lerp(a[oA + 2], a[oB + 2], t);
    // Heading is the one field that wraps, so it cannot be lerped straight:
    // spinning past PI would send the figure the long way round.
    p.facing = U.angleLerp(a[oA + 3], a[oB + 3], t);
    p.moveFacing = p.facing;
    p.squash = U.lerp(a[oA + 4], a[oB + 4], t);
    p.lean = U.lerp(a[oA + 5], a[oB + 5], t);
    s.hipY = U.lerp(a[oA + 6], a[oB + 6], t);
    s.shoulderY = U.lerp(a[oA + 7], a[oB + 7], t);
    s.headY = U.lerp(a[oA + 8], a[oB + 8], t);
    s.torsoLean = U.lerp(a[oA + 9], a[oB + 9], t);
    s.hipLean = U.lerp(a[oA + 10], a[oB + 10], t);
    s.armRoll = U.lerp(a[oA + 11], a[oB + 11], t);
    s.footL.x = U.lerp(a[oA + 12], a[oB + 12], t);
    s.footL.y = U.lerp(a[oA + 13], a[oB + 13], t);
    s.footL.pitch = U.lerp(a[oA + 14], a[oB + 14], t);
    s.footR.x = U.lerp(a[oA + 15], a[oB + 15], t);
    s.footR.y = U.lerp(a[oA + 16], a[oB + 16], t);
    s.footR.pitch = U.lerp(a[oA + 17], a[oB + 17], t);
    s.handL.x = U.lerp(a[oA + 18], a[oB + 18], t);
    s.handL.y = U.lerp(a[oA + 19], a[oB + 19], t);
    s.handR.x = U.lerp(a[oA + 20], a[oB + 20], t);
    s.handR.y = U.lerp(a[oA + 21], a[oB + 21], t);
    for (let k = 22; k < 50; k++) TMP38[k] = U.lerp(a[oA + k], a[oB + k], t);
    s.kneeL.jx = TMP38[22]; s.kneeL.jy = TMP38[23]; s.kneeL.ex = TMP38[24]; s.kneeL.ey = TMP38[25];
    s.kneeR.jx = TMP38[26]; s.kneeR.jy = TMP38[27]; s.kneeR.ex = TMP38[28]; s.kneeR.ey = TMP38[29];
    s.elbowL.jx = TMP38[30]; s.elbowL.jy = TMP38[31]; s.elbowL.ex = TMP38[32]; s.elbowL.ey = TMP38[33];
    s.elbowR.jx = TMP38[34]; s.elbowR.jy = TMP38[35]; s.elbowR.ex = TMP38[36]; s.elbowR.ey = TMP38[37];
    s.armTuck = TMP38[38];
    s.footL.side = TMP38[39]; s.footR.side = TMP38[40];
    s.handL.side = TMP38[41]; s.handR.side = TMP38[42];
    s.handL.twist = TMP38[43]; s.handR.twist = TMP38[44];
    p.visualLift = TMP38[45];
    s.handL.lat = orNull(TMP38[46]); s.handR.lat = orNull(TMP38[47]);
    s.handL.elbowLat = orNull(TMP38[48]); s.handR.elbowLat = orNull(TMP38[49]);
  }

  const TMP38 = new Float32Array(PLAYER_STRIDE);

  Replay.RATE = RATE;
  Replay.SECONDS = SECONDS;
  /* Exposed so the suite can check the buffer is preallocated and fixed
   * without hard-coding the frame layout — the invariant worth guarding is
   * "it never grows", not "a player is exactly N floats wide", and pinning
   * the latter breaks every time the skeleton gains a field. */
  Replay.MAX_PLAYERS = MAX_PLAYERS;
  Replay.PLAYER_STRIDE = PLAYER_STRIDE;
  Replay.BALL_STRIDE = BALL_STRIDE;
  Replay.THRESHOLD = THRESHOLD;
  Replay.PLAY_RATE = PLAY_RATE;
  Replay.PRE_ROLL = PRE_ROLL;
  Replay.HOLD_TAIL = HOLD_TAIL;

  BB.Replay = Replay.init();
})(typeof window !== 'undefined' ? window : globalThis);
