/* =============================================================================
 * arena.js  —  The building: stands, crowd, benches, scorer's table, lights.
 * -----------------------------------------------------------------------------
 * All real geometry now. The bowl is built from stepped risers, and the crowd
 * is a static block of instances assembled once and copied to the GPU in a
 * single memcpy per frame — their idle bob happens in the vertex shader, so
 * eighteen hundred fans cost essentially nothing on the CPU.
 *
 * Nothing here participates in gameplay; it exists to give the court a room to
 * sit in and to keep the "Court at Night" read: a bright island of maple inside
 * a dark bowl.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  /* Bowl footprint in world feet. */
  const X0 = -34, X1 = C.COURT_L + 34;
  const Y0 = -34, Y1 = C.COURT_W + 34;

  const SIDE_ROWS = 15;
  const END_ROWS = 13;
  const ROW_DEPTH = 2.85;
  const ROW_RISE = 1.55;
  const SEAT_PITCH = 3.4;

  const IF = 24; // instance floats, mirrors GLX.INSTANCE_FLOATS

  const Arena = {
    team: null,
    palette: [],

    _t: 0,
    excitement: 0,      // 0..1, drives bob amplitude and flash frequency
    _standTimer: 0,
    flashes: null,

    /* Static instance blocks, rebuilt only when the team changes. */
    _crowd: null,
    _crowdCount: 0,
    _structure: null,
    _structureCount: 0,

    init(team) {
      this.team = team || { primary: PAL.paint, secondary: PAL.orange };

      this.flashes = new U.Pool(
        () => ({ x: 0, y: 0, z: 0, life: 0, max: 0 }),
        (o, a) => { o.x = a[0]; o.y = a[1]; o.z = a[2]; o.life = o.max = 0.16; },
        48
      );

      this.build(this.team);
      return this;
    },

    setTeam(team) {
      this.team = team;
      this.build(team);
    },

    /* ----------------------------------------------------------------- build */
    build(team) {
      const g = BB.GLX;
      if (!g || !g.gl) return;               // headless: nothing to build

      const primary = g.color((team && team.primary) || PAL.paint);
      const secondary = g.color((team && team.secondary) || PAL.orange);

      /* Shirt palette: mostly team colours, salted with neutrals so the bowl
       * doesn't read as a single flat block of one hue. */
      this.palette = [
        primary, primary, primary,
        secondary, secondary,
        g.color('#2A3140'), g.color('#3C4557'), g.color('#151A24'),
        g.color('#6C5540'), g.color('#8A8272')
      ];

      const rng = U.makeRng(0xC0FFEE);
      const crowd = [];
      const struct = [];

      /* -------------------------------------------------- risers and seating
       * Each side is a run of steps: a solid stepped mass so the bowl reads as
       * concrete, with a row of fans standing on the tread of each step.
       */
      const deck = g.color('#0E141D');
      const tread = g.color('#161E2A');

      /* side = { axis, sign } — 'y' sides run along the length of the court.
       *
       * There are deliberately no stands on the +y sideline. That is where the
       * broadcast camera lives, and a real camera position is inside the lower
       * bowl: building seating there would put a wall of fans two feet from the
       * lens and hide the entire floor. Leaving it open is also what the shot
       * actually looks like on television — you see the far side's crowd. */
      const sides = [
        { axis: 'y', sign: -1, rows: SIDE_ROWS, edge: -C.APRON - 2.5, lo: X0, hi: X1 },
        { axis: 'x', sign: -1, rows: END_ROWS, edge: -C.APRON - 2.5, lo: Y0, hi: Y1 - 22 },
        { axis: 'x', sign: 1, rows: END_ROWS, edge: C.COURT_L + C.APRON + 2.5, lo: Y0, hi: Y1 - 22 }
      ];

      for (const s of sides) {
        for (let r = 0; r < s.rows; r++) {
          const top = 0.9 + r * ROW_RISE;
          const near = s.edge + s.sign * r * ROW_DEPTH;
          const cen = near + s.sign * ROW_DEPTH * 0.5;
          const span = s.hi - s.lo;
          const mid = (s.lo + s.hi) * 0.5;

          if (s.axis === 'y') {
            pushBox(struct, mid, cen, top * 0.5, span, ROW_DEPTH, top,
                    r % 2 ? deck : tread, 0.04, 0);
          } else {
            pushBox(struct, cen, mid, top * 0.5, ROW_DEPTH, span, top,
                    r % 2 ? deck : tread, 0.04, 0);
          }

          /* Fans on this tread. The end rows behind each basket are left
           * sparser, matching how a real bowl thins out in the corners. */
          const density = s.axis === 'y' ? 0.94 : 0.80;
          const n = Math.floor(span / SEAT_PITCH);
          for (let i = 0; i < n; i++) {
            if (!rng.chance(density)) continue;
            const along = s.lo + (i + 0.5) * SEAT_PITCH + rng.f(-0.35, 0.35);
            // Skip the strip directly behind each basket stanchion.
            if (s.axis === 'x' && Math.abs(along - C.HALF_W) < 5 && r < 3) continue;

            const fx = s.axis === 'y' ? along : cen + rng.f(-0.3, 0.3);
            const fy = s.axis === 'y' ? cen + rng.f(-0.3, 0.3) : along;
            const shirt = this.palette[rng.i(0, this.palette.length - 1)];
            const seed = rng.f(0, 1);
            const bob = 0.05 + rng.f(0, 0.05);
            const scale = rng.f(0.92, 1.10);

            // Torso and head. Two boxes per fan is plenty at this distance and
            // keeps the whole crowd inside one instanced draw call.
            pushBox(crowd, fx, fy, top + 1.05 * scale, 1.15, 0.85, 2.1 * scale,
                    shirt, 0.02, 0, seed, bob);
            pushBox(crowd, fx, fy, top + 2.35 * scale, 0.62, 0.62, 0.62,
                    SKIN[rng.i(0, SKIN.length - 1)], 0.05, 0, seed, bob);
          }
        }
      }

      /* ------------------------------------------------- near-side courtside
       * The camera side has no seating bowl, but it cannot be bare floor
       * either: everything between the lens and the near sideline would read
       * as an empty grey apron across the bottom third of the frame. These
       * are all kept under four feet tall so that from the rig's height they
       * fill that band without ever rising in front of the court itself.
       */
      const led = g.color('#0A1018');
      const chair = g.color('#141B26');
      const nearY = C.COURT_W + C.APRON;

      // LED ribbon running the length of the near sideline.
      pushBox(struct, C.HALF_L, nearY + 0.9, 1.05, 88, 0.5, 2.1, led, 0.10, 0);
      // The lit face sits on the camera side of the board, or the board
      // itself would occlude it from the only angle that ever sees it.
      pushBox(struct, C.HALF_L, nearY + 1.17, 1.05, 86, 0.12, 1.7, secondary, 0.05, 1.0);

      // Two rows of courtside chairs behind it, stepped back and up slightly.
      for (let row = 0; row < 3; row++) {
        const cy = nearY + 3.4 + row * 3.1;
        const cz = 0.6 + row * 0.55;
        for (let cx = X0 + 6; cx < X1 - 6; cx += 3.0) {
          pushBox(struct, cx, cy, cz + 0.75, 2.3, 2.0, 1.5, chair, 0.06, 0);
          pushBox(struct, cx, cy - 0.85, cz + 1.55, 2.3, 0.3, 1.6, chair, 0.06, 0);
        }
      }

      // Low rail at the outer edge, which gives the foreground a horizon line.
      pushBox(struct, C.HALF_L, nearY + 11.5, 1.6, X1 - X0, 0.35, 0.3, g.color('#1D2735'), 0.25, 0);

      /* ---------------------------------------------------- courtside tables */
      const tableCol = g.color('#101720');
      const trim = secondary;
      // Scorer's table on the near sideline, facing the camera.
      pushBox(struct, C.HALF_L, -C.APRON + 0.6, 1.35, 34, 2.2, 2.7, tableCol, 0.10, 0);
      pushBox(struct, C.HALF_L, -C.APRON - 0.5, 2.45, 34, 0.35, 0.5, trim, 0.06, 0.35);
      // Benches, one per side of the table.
      for (const bx of [C.HALF_L - 26, C.HALF_L + 26]) {
        pushBox(struct, bx, -C.APRON + 1.2, 0.85, 15, 2.0, 1.7, tableCol, 0.08, 0);
      }

      /* -------------------------------------------------------------- lights
       * Four fixture clusters over the court. They are emissive boxes only —
       * the actual key light direction is fixed in scene3d.js — but they give
       * the camera something bright to find when it tilts up.
       */
      const lamp = g.color('#FFF3D8');
      for (const lx of [C.HALF_L - 30, C.HALF_L + 30]) {
        for (const ly of [-6, C.COURT_W + 6]) {
          pushBox(struct, lx, ly, 46, 7, 3.4, 0.9, lamp, 0.9, 1.0);
          pushBox(struct, lx, ly, 47.4, 7.6, 4.0, 1.9, g.color('#0B0F16'), 0.2, 0);
        }
      }

      /* Ribbon board ringing the top of the lower bowl on the far side, so the
       * background has one horizontal band of colour instead of dead black. */
      const ribbonZ = 0.9 + SIDE_ROWS * ROW_RISE + 1.6;
      pushBox(struct, C.HALF_L, -C.APRON - 2.5 - SIDE_ROWS * ROW_DEPTH,
              ribbonZ, X1 - X0, 0.6, 2.2, primary, 0.15, 0.55);

      this._crowd = new Float32Array(crowd);
      this._crowdCount = crowd.length / IF;
      this._structure = new Float32Array(struct);
      this._structureCount = struct.length / IF;
    },

    /* ---------------------------------------------------------------- update */
    update(dt, excitement) {
      this._t += dt;
      this.excitement = U.approach(this.excitement, U.clamp01(excitement || 0), 2.4, dt);

      /* Camera flashes fire more often the louder the building gets. */
      this._standTimer -= dt;
      if (this._standTimer <= 0) {
        this._standTimer = U.lerp(0.55, 0.05, this.excitement) * U.rng.f(0.6, 1.6);
        if (U.rng.chance(0.35 + this.excitement * 0.6)) {
          const side = U.rng.chance(0.5) ? -1 : 1;
          const r = U.rng.i(1, SIDE_ROWS - 1);
          const x = U.rng.f(X0 + 20, X1 - 20);
          const y = side < 0
            ? -C.APRON - 2.5 - r * ROW_DEPTH
            : C.COURT_W + C.APRON + 2.5 + r * ROW_DEPTH;
          this.flashes.acquire(x, y, 0.9 + r * ROW_RISE + 2.6);
        }
      }
      for (let i = this.flashes.size - 1; i >= 0; i--) {
        const f = this.flashes.active[i];
        f.life -= dt;
        if (f.life <= 0) this.flashes.releaseAt(i);
      }
    },

    /* ------------------------------------------------------------------ draw */
    /** Bowl, crowd and furniture. Submitted before the players. */
    drawBack() {
      const S3 = BB.S3;
      if (!S3 || !S3.ready || !this._crowd) return;

      /* Arena deck: the dark floor the whole building sits on, extending well
       * past the stands so the camera never sees the void behind them.
       *
       * Its top face has to stay clear of the court's floor plane at z = 0.
       * Sitting flush there made the two surfaces coplanar, and at broadcast
       * distance the depth buffer cannot separate them: whichever won varied
       * with sub-pixel camera movement, so the hardwood tore into bands and
       * whole stretches of it flipped to this dark deck colour frame to frame.
       * The court reads as a floor laid on the deck, which is what it is. */
      S3.box(C.HALF_L, C.HALF_W, -0.75, 260, 260, 0.7, 0, DECK, 0.02);

      S3.pushBatch(S3.meshes.box, this._structure, this._structureCount);
      S3.pushBatch(S3.meshes.crowd, this._crowd, this._crowdCount);

      /* Bob amplitude scales with excitement by scaling the whole crowd block's
       * animation through the shared time uniform — see scene3d.js. */
      this._drawFlashes(S3);
    },

    /** Nothing occludes the court from the front in 3D; kept for the renderer. */
    drawFront() {},

    _drawFlashes(S3) {
      for (let i = 0; i < this.flashes.size; i++) {
        const f = this.flashes.active[i];
        const t = f.life / f.max;
        S3.sphere(f.x, f.y, f.z, 0.30 + (1 - t) * 0.35, FLASH, 1.0, 1.0, true);
      }
    }
  };

  const DECK = [0.035, 0.048, 0.070, 1];
  const FLASH = [1, 0.97, 0.88, 0.9];
  const SKIN = [
    [0.79, 0.57, 0.41, 1], [0.62, 0.42, 0.29, 1], [0.42, 0.28, 0.20, 1],
    [0.88, 0.71, 0.56, 1], [0.30, 0.20, 0.14, 1]
  ];

  /**
   * Appends one axis-aligned box instance to a plain array in the exact layout
   * scene3d.js expects: 16 matrix floats, 4 colour, then gloss/emissive/seed/bob.
   * Court coordinates in, GL coordinates out (x, z, y).
   */
  function pushBox(arr, x, y, z, sx, sy, sz, color, gloss, emissive, seed, bob) {
    arr.push(
      sx, 0, 0, 0,
      0, sz, 0, 0,
      0, 0, sy, 0,
      x, z, y, 1,
      color[0], color[1], color[2], color[3] == null ? 1 : color[3],
      gloss || 0, emissive || 0, seed || 0, bob || 0
    );
  }

  BB.Arena = Arena;
})(typeof window !== 'undefined' ? window : globalThis);
