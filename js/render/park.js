/* =============================================================================
 * park.js  —  The place: blacktop, chain link, trees, onlookers, city.
 * -----------------------------------------------------------------------------
 * This replaced the arena bowl. There is no building any more, no seated crowd
 * and no roof: the court is a painted pad in a city park, ringed by a chain
 * link fence with people watching through it, trees past that and a skyline
 * behind them.
 *
 * The trade the old arena made is still the right one here — everything static
 * is assembled once into flat instance blocks and copied to the GPU in one
 * memcpy per frame, so the fence is a couple of hundred instances that cost
 * nothing per frame, and the onlookers get their idle bob for free in the
 * vertex shader.
 *
 * The read to protect is the opposite of what it used to be. It was "a bright
 * island of maple inside a dark bowl" — everything outside the court fell away
 * to black. Here the court sits in an open, evenly lit place and the light
 * comes from the sky, so nothing is allowed to fall to black: the frame is
 * bright edge to edge, and the court holds the eye by being the most saturated
 * thing in it rather than the only lit thing in it.
 *
 * Nothing here participates in gameplay.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  /* The blacktop pad the court is painted on, in world feet. */
  const PAD_X0 = -32, PAD_X1 = C.COURT_L + 32;
  const PAD_Y0 = -24, PAD_Y1 = C.COURT_W + 26;

  /* The fence ring.
   *
   * The court sits at one edge of the lot rather than in the middle of it, so
   * there is a lot of ground on the +y side and very little on -y. That is a
   * normal park layout, and it is also the same call the arena made when it
   * left the near sideline open: every camera rig lives out on +y, and a fence
   * strung across the pad edge there would put chain link a few feet from the
   * lens with the whole court behind it. Out at the lot boundary it reads as
   * the edge of the park instead of as a screen over the shot.
   */
  const FEN_X0 = -36, FEN_X1 = C.COURT_L + 36;
  const FEN_Y0 = -26, FEN_Y1 = C.COURT_W + 66;

  const FEN_H = 12;            // along the sides
  const FEN_H_END = 20;        // backstops behind each basket
  /* The windscreen stops at waist height on the people standing behind it,
   * measured from the grass they are on rather than from the court, which is
   * most of a foot higher. Any taller and the crowd is a row of disembodied
   * heads; any shorter and the fence loses the band of colour that is most of
   * what it contributes to the frame. */
  const SCREEN_H = 3.2;
  const POST_GAP = 12;
  const WIRE_GAP = 4.5;

  /* Ground height at a point: the blacktop pad is a step up from the grass,
   * and both are a step below the court. Everything the park stands on the
   * ground gets its footing from here, or it floats. */
  function groundAt(x, y) {
    return (x > PAD_X0 && x < PAD_X1 && y > PAD_Y0 && y < PAD_Y1) ? -0.40 : -0.95;
  }

  const IF = 24; // instance floats, mirrors GLX.INSTANCE_FLOATS

  const Park = {
    team: null,
    palette: [],

    _t: 0,
    excitement: 0,      // 0..1, how often somebody jumps up out of the crowd
    _popTimer: 0,
    pops: null,

    /* Static instance blocks, rebuilt only when the team changes. */
    _crowd: null,
    _crowdCount: 0,
    _structure: null,
    _structureCount: 0,
    _foliage: null,
    _foliageCount: 0,

    /* Where the onlookers are standing, so a pop happens at a real spectator
     * rather than at a random point in the air. */
    _spots: null,

    init(team) {
      this.team = team || { primary: PAL.paint, secondary: PAL.orange };

      this.pops = new U.Pool(
        () => ({ x: 0, y: 0, z: 0, col: null, life: 0, max: 0 }),
        (o, a) => {
          o.x = a[0]; o.y = a[1]; o.z = a[2]; o.col = a[3];
          o.life = o.max = 0.72;
        },
        24
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

      /* Shirt palette. A park crowd is not wearing team colours — it is
       * whoever was walking past — so this is mostly bright summer clothing
       * with the home colours salted in rather than the other way round. */
      this.palette = [
        g.color('#F2F0E6'), g.color('#E8543C'), g.color('#F2B33D'),
        g.color('#3FA9D6'), g.color('#5FBF6A'), g.color('#8C5BC4'),
        g.color('#2A3140'), g.color('#D96CA8'),
        primary, secondary
      ];

      const rng = U.makeRng(0xC0FFEE);
      const crowd = [];
      const struct = [];
      const leaves = [];
      const spots = [];

      /* -------------------------------------------------------------- ground
       * Grass under everything, blacktop laid on top of it. Both sit BELOW the
       * court's own floor plane at z = 0 by a clear margin: coplanar surfaces
       * cannot be separated by the depth buffer at this distance, and whichever
       * won used to flip with sub-pixel camera movement, tearing the court into
       * bands. Each surface is a distinct step down from the one it borders. */
      pushBox(struct, C.HALF_L, C.HALF_W, -1.30, 620, 620, 0.7,
              g.color(PAL.grassDark), 0.02, 0);
      pushBox(struct, (PAD_X0 + PAD_X1) * 0.5, (PAD_Y0 + PAD_Y1) * 0.5, -0.75,
              PAD_X1 - PAD_X0, PAD_Y1 - PAD_Y0, 0.7, g.color(PAL.asphalt), 0.03, 0);

      /* A worn footpath of bare dirt from the gate to the court. */
      pushBox(struct, C.HALF_L + 22, PAD_Y1 + 26, -1.24, 7, 56, 0.62,
              g.color('#8A7A5C'), 0.02, 0);

      /* --------------------------------------------------------------- fence
       * Four runs. Each is posts, a top and mid rail, a solid windscreen up
       * the bottom, and the mesh itself as vertical wires with a few
       * horizontal courses through them. At any distance the camera ever
       * stands, that is what chain link looks like.
       */
      const wire = g.color(PAL.fence);
      const post = g.color(PAL.fencePost);
      const screens = [primary, secondary, g.color('#2F6E56'), g.color('#B8452C')];

      const runs = [
        { axis: 'x', at: FEN_Y0, lo: FEN_X0, hi: FEN_X1, h: FEN_H },
        { axis: 'x', at: FEN_Y1, lo: FEN_X0, hi: FEN_X1, h: FEN_H },
        { axis: 'y', at: FEN_X0, lo: FEN_Y0, hi: FEN_Y1, h: FEN_H_END },
        { axis: 'y', at: FEN_X1, lo: FEN_Y0, hi: FEN_Y1, h: FEN_H_END }
      ];

      for (const run of runs) {
        const along = run.hi - run.lo;
        const mid = (run.lo + run.hi) * 0.5;
        const at = run.at;
        const h = run.h;
        /** Places one box on this run: `a` is distance along it. */
        const put = (a, z, la, thick, tall, col, gloss, emis) => {
          if (run.axis === 'x') pushBox(struct, a, at, z, la, thick, tall, col, gloss, emis);
          else pushBox(struct, at, a, z, thick, la, tall, col, gloss, emis);
        };

        /* Everything that meets the ground starts below BOTH ground levels the
         * fence crosses. A run laid on z = 0 — the court's plane, not the
         * ground's — leaves a foot of daylight under it out on the grass, and
         * a gap under a fence shows the crowd's shins and reads as the whole
         * thing hovering. */
        const foot = -1.3;

        // Posts, standing a little proud of the fence they carry.
        for (let a = run.lo; a <= run.hi + 0.01; a += POST_GAP) {
          put(a, (h + 0.6 + foot) * 0.5, 0.42, 0.42, h + 0.6 - foot, post, 0.3, 0);
        }
        // Top and mid rails.
        put(mid, h, along, 0.26, 0.26, post, 0.3, 0);
        put(mid, h * 0.52, along, 0.20, 0.20, post, 0.28, 0);
        // Windscreen: solid panels, one per post bay, in rotating colours.
        // This is where nearly all of the fence's colour comes from.
        let bay = 0;
        for (let a = run.lo; a < run.hi - 0.01; a += POST_GAP, bay++) {
          const w = Math.min(POST_GAP, run.hi - a) - 0.5;
          put(a + w * 0.5 + 0.25, (SCREEN_H + foot) * 0.5, w, 0.14, SCREEN_H - foot,
              screens[bay % screens.length], 0.05, 0.10);
        }
        // The mesh: vertical wires all the way up, three horizontal courses.
        for (let a = run.lo; a <= run.hi + 0.01; a += WIRE_GAP) {
          put(a, (SCREEN_H + h) * 0.5, 0.05, 0.05, h - SCREEN_H, wire, 0.45, 0);
        }
        for (let k = 1; k <= 3; k++) {
          put(mid, SCREEN_H + (h - SCREEN_H) * k / 4, along, 0.05, 0.05, wire, 0.45, 0);
        }
      }

      /* ----------------------------------------------------------- onlookers
       * Nobody is sitting down. They are standing at the fence on the three
       * close sides, thickest at the two baselines where the game is, and
       * they are outside the wire looking in — which is the one detail that
       * makes the fence read as a fence rather than as scenery.
       */
      /* `out` is the direction away from the court, and the depth jitter only
       * ever runs that way: people press up against the wire and the ones who
       * cannot get to it stand behind them, so a fence line is a couple of
       * ranks deep on one side and hard up against the fence on the other.
       * Scattering them symmetrically puts half the crowd inside the fence. */
      const lines = [
        { axis: 'x', at: FEN_Y0 - 2.2, out: -1, lo: FEN_X0 + 8, hi: FEN_X1 - 8, density: 0.72 },
        { axis: 'y', at: FEN_X0 - 2.2, out: -1, lo: -14, hi: C.COURT_W + 16, density: 0.92 },
        { axis: 'y', at: FEN_X1 + 2.2, out: 1, lo: -14, hi: C.COURT_W + 16, density: 0.92 },
        // A knot of people on the open side, out on the grass.
        { axis: 'x', at: C.COURT_W + 15, out: 1, lo: 16, hi: 78, density: 0.55 }
      ];

      for (const line of lines) {
        for (let a = line.lo; a < line.hi; a += 2.4) {
          if (!rng.chance(line.density)) continue;
          const jitter = line.at + line.out * rng.f(0, 1) * rng.f(0, 4.2);
          const px = line.axis === 'x' ? a + rng.f(-0.6, 0.6) : jitter;
          const py = line.axis === 'x' ? jitter : a + rng.f(-0.6, 0.6);
          const shirt = this.palette[rng.i(0, this.palette.length - 1)];
          const seed = rng.f(0, 1);
          const bob = 0.04 + rng.f(0, 0.05);
          const h = rng.f(5.4, 6.4);              // standing height, in feet
          const z0 = groundAt(px, py);

          /* Body and head, standing on the ground they are actually on. Two
           * boxes each is plenty at this distance and keeps every spectator
           * inside one instanced draw call — but they have to be the same size
           * as the players, or the fence line reads as a row of children. */
          const headR = h * 0.078;
          pushBox(crowd, px, py, z0 + (h - headR * 2) * 0.5, 1.35, 0.95, h - headR * 2,
                  shirt, 0.02, 0, seed, bob);
          pushBox(crowd, px, py, z0 + h - headR, headR * 2, headR * 2, headR * 2,
                  SKIN[rng.i(0, SKIN.length - 1)], 0.05, 0, seed, bob);
          spots.push(px, py, z0 + h - headR, shirt[0], shirt[1], shirt[2]);
        }
      }

      /* ------------------------------------------------------------- benches
       * Slat benches on the grass, plus the bins and the fountain. Small
       * things, but an empty lawn is what makes an outdoor scene look like a
       * placeholder. */
      const slat = g.color('#9C7A4E');
      const ironwork = g.color('#3E4A44');
      for (const b of [[-16, C.COURT_W + 34], [18, C.COURT_W + 40],
                       [60, C.COURT_W + 38], [104, C.COURT_W + 34],
                       [C.COURT_L + 26, C.COURT_W + 30]]) {
        const z0 = groundAt(b[0], b[1]);
        // Seat, back, and an end frame at each end. The end frames are what
        // stop a bench reading as a plank hanging in the air.
        pushBox(struct, b[0], b[1], z0 + 1.42, 6.0, 1.7, 0.30, slat, 0.10, 0);
        pushBox(struct, b[0], b[1] + 0.78, z0 + 2.18, 6.0, 0.28, 1.40, slat, 0.10, 0);
        for (const s of [-1, 1]) {
          pushBox(struct, b[0] + s * 2.85, b[1], z0 + 0.71, 0.34, 1.7, 1.42,
                  ironwork, 0.20, 0);
        }
      }
      for (const t of [[-24, C.COURT_W + 22], [C.COURT_L + 24, C.COURT_W + 20]]) {
        pushBox(struct, t[0], t[1], groundAt(t[0], t[1]) + 1.6, 2.1, 2.1, 3.2,
                g.color('#2F6E56'), 0.15, 0);
      }
      // Drinking fountain.
      pushBox(struct, C.COURT_L + 12, C.COURT_W + 14, groundAt(C.COURT_L + 12, C.COURT_W + 14) + 1.5,
              1.4, 1.4, 3.0, g.color('#7E8A92'), 0.35, 0);

      /* --------------------------------------------------------------- trees
       * Round the outside of the fence, kept off the two ends so nothing ever
       * stands between the camera and the basket it is aimed at.
       */
      const barks = [g.color(PAL.bark), g.color('#5A3F28')];
      const canopy = [g.color(PAL.leaf), g.color(PAL.leafLight), g.color('#3E7A2A')];
      for (let i = 0; i < 15; i++) {
        const side = i % 3;
        let tx, ty;
        if (side === 0) { tx = rng.f(-46, C.COURT_L + 46); ty = FEN_Y0 - rng.f(10, 34); }
        else if (side === 1) { tx = rng.f(-46, C.COURT_L + 46); ty = FEN_Y1 + rng.f(8, 40); }
        else { tx = rng.chance(0.5) ? FEN_X0 - rng.f(14, 44) : FEN_X1 + rng.f(14, 44);
               ty = rng.f(FEN_Y0 - 20, FEN_Y1 + 20); }

        const z0 = groundAt(tx, ty);
        const th = rng.f(15, 27);            // trunk height
        const cr = rng.f(8, 14);             // canopy radius
        pushBox(struct, tx, ty, z0 + th * 0.5, 1.5, 1.5, th,
                barks[rng.i(0, 1)], 0.06, 0);
        for (let k = 0; k < 3; k++) {
          const r = cr * rng.f(0.62, 1.0);
          pushBox(leaves,
                  tx + rng.f(-cr * 0.4, cr * 0.4),
                  ty + rng.f(-cr * 0.4, cr * 0.4),
                  z0 + th + rng.f(-1, 5),
                  r * 2, r * 2, r * 1.7,
                  canopy[rng.i(0, 2)], 0.04, 0);
        }
      }

      /* --------------------------------------------------------- park lights
       * Unlit at this hour. They are here because a court with no lights over
       * it looks like it closes at dusk, and because they give the camera
       * something to find in the upper half of the frame now that there is no
       * roof up there. */
      const pole = g.color('#8A949C');
      const head = g.color('#D9E2E8');
      for (const lx of [C.HALF_L - 34, C.HALF_L + 34]) {
        for (const ly of [FEN_Y0 + 3, C.COURT_W + 18]) {
          const z0 = groundAt(lx, ly);
          pushBox(struct, lx, ly, z0 + 15, 0.9, 0.9, 30, pole, 0.35, 0);
          pushBox(struct, lx, ly, z0 + 30.4, 4.6, 2.4, 0.8, head, 0.5, 0.22);
        }
      }

      /* -------------------------------------------------------------- skyline
       * Blocks on the horizon, far enough out that the fog has most of them.
       * They are what keeps the sky from being an empty band across the top of
       * every frame, and what says this park is in a city.
       */
      const facade = [g.color('#54637C'), g.color('#5E6E88'), g.color('#485570'),
                      g.color('#6B7A93')];
      const skyRng = U.makeRng(0x5C17A9);
      for (let i = 0; i < 17; i++) {
        /* Kept on the far side of the -y fence and spread wide, so the two
         * ends of the court — the only directions the forward rig ever looks —
         * stay open sky above the backstop. */
        const far = skyRng.f(250, 400);
        const bx = C.HALF_L + skyRng.f(-1, 1) * skyRng.f(120, 460);
        const by = C.HALF_W - far;
        /* Narrow and tall. Wide blocks at this range come back through the fog
         * as flat grey slabs, which read as a wall behind the park rather than
         * as a city standing some distance from it — and they have to be dark
         * enough to survive the haze with an edge still on them. */
        const bw = skyRng.f(13, 26);
        const bh = bw * skyRng.f(2.6, 6.5);
        pushBox(struct, bx, by, bh * 0.5, bw, bw * skyRng.f(0.8, 1.5), bh,
                facade[skyRng.i(0, 3)], 0.12, 0.02);
      }

      this._crowd = new Float32Array(crowd);
      this._crowdCount = crowd.length / IF;
      this._structure = new Float32Array(struct);
      this._structureCount = struct.length / IF;
      this._foliage = new Float32Array(leaves);
      this._foliageCount = leaves.length / IF;
      this._spots = spots;
    },

    /* ---------------------------------------------------------------- update */
    update(dt, excitement) {
      this._t += dt;
      this.excitement = U.approach(this.excitement, U.clamp01(excitement || 0), 2.4, dt);

      /* Somebody jumps up out of the crowd, more often the better the game.
       * The park's answer to the arena's camera flashes, which were invisible
       * in daylight and belonged to a building full of phones anyway. */
      this._popTimer -= dt;
      if (this._popTimer <= 0) {
        this._popTimer = U.lerp(0.85, 0.14, this.excitement) * U.rng.f(0.6, 1.6);
        const spots = this._spots;
        if (spots && spots.length && U.rng.chance(0.4 + this.excitement * 0.55)) {
          const i = U.rng.i(0, spots.length / 6 - 1) * 6;
          this.pops.acquire(spots[i], spots[i + 1], spots[i + 2],
                            [spots[i + 3], spots[i + 4], spots[i + 5], 1]);
        }
      }
      for (let i = this.pops.size - 1; i >= 0; i--) {
        const p = this.pops.active[i];
        p.life -= dt;
        if (p.life <= 0) this.pops.releaseAt(i);
      }
    },

    /* ------------------------------------------------------------------ draw */
    /** Ground, fence, trees, furniture and the crowd. Before the players. */
    drawBack() {
      const S3 = BB.S3;
      if (!S3 || !S3.ready || !this._crowd) return;

      S3.pushBatch(S3.meshes.box, this._structure, this._structureCount);
      S3.pushBatch(S3.meshes.sphere, this._foliage, this._foliageCount);
      S3.pushBatch(S3.meshes.crowd, this._crowd, this._crowdCount);

      this._drawPops(S3);
    },

    /** Nothing occludes the court from the front in 3D; kept for the renderer. */
    drawFront() {},

    /** A spectator coming up off their heels and back down. */
    _drawPops(S3) {
      for (let i = 0; i < this.pops.size; i++) {
        const p = this.pops.active[i];
        const t = 1 - p.life / p.max;              // 0..1 through the jump
        const rise = Math.sin(t * Math.PI) * 1.5;
        S3.box(p.x, p.y, p.z + rise, 0.62, 0.62, 0.62, 0, p.col, 0.05);
      }
    }
  };

  const SKIN = [
    [0.79, 0.57, 0.41, 1], [0.62, 0.42, 0.29, 1], [0.42, 0.28, 0.20, 1],
    [0.88, 0.71, 0.56, 1], [0.30, 0.20, 0.14, 1]
  ];

  /**
   * Appends one instance to a plain array in the exact layout scene3d.js
   * expects: 16 matrix floats, 4 colour, then gloss/emissive/seed/bob. The
   * primitive it ends up as is decided by which mesh the array is batched
   * into, so this places spheres for foliage as readily as it places boxes.
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

  BB.Park = Park;
})(typeof window !== 'undefined' ? window : globalThis);
