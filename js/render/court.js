/* =============================================================================
 * court.js  —  The playing surface.
 * -----------------------------------------------------------------------------
 * An outdoor park court: acrylic paint rolled straight onto asphalt, teal
 * inside the lines and terracotta outside them, with the blacktop showing
 * through wherever the coating has worn away. Nothing here is polished — a
 * park surface is matt, patched and sun-bleached, and the wear is what stops
 * it reading as a flat green rectangle.
 *
 * The floor never changes during a game, so it is baked once into an offscreen
 * canvas at high resolution and blitted each frame under the camera transform.
 * That turns several hundred vector operations per frame into a single
 * drawImage, which is most of the reason the game holds 60fps on integrated
 * graphics.
 *
 * Call Court.bake() again (via Court.setTeam) when the home team changes.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  const RES = 20;              // offscreen pixels per world foot
  const PAD = C.APRON;         // painted apron beyond the court boundary

  const Court = {
    canvas: null,
    ctx: null,
    w: 0, h: 0,

    /* GPU copy of the baked artwork, rebuilt whenever the bake changes. */
    tex: null,
    _texDirty: true,

    /* World-space rect covered by the baked image. */
    ox: -PAD, oy: -PAD,
    ow: C.COURT_L + PAD * 2,
    oh: C.COURT_W + PAD * 2,

    team: {
      name: 'BLACKTOP',
      abbr: 'BLK',
      primary: PAL.paint,
      secondary: PAL.orange,
      accent: PAL.chalk
    },

    /* ----------------------------------------------------------------- setup */
    init() {
      this.canvas = document.createElement('canvas');
      this.w = this.canvas.width = Math.round(this.ow * RES);
      this.h = this.canvas.height = Math.round(this.oh * RES);
      this.ctx = this.canvas.getContext('2d');
      this.bake();
      return this;
    },

    setTeam(team) {
      Object.assign(this.team, team);
      this.bake();
    },

    /* ------------------------------------------------------------- rendering */
    /**
     * Submits the floor to the 3D scene. The baked Canvas2D artwork becomes a
     * GPU texture the first time it is drawn (and again whenever the team, and
     * therefore the paint and centre logo, changes) — the artwork itself is
     * still the original 2D bake, just mapped onto a real floor plane now.
     */
    draw() {
      const S3 = BB.S3;
      if (!S3 || !S3.ready) return;
      if (this._texDirty || !this.tex) {
        this.tex = BB.GLX.textureFromCanvas(this.canvas, this.tex);
        this._texDirty = false;
      }
      S3.floor(this.ox + this.ow * 0.5, this.oy + this.oh * 0.5, this.ow, this.oh, this.tex);
    },

    /* ------------------------------------------------------------------ bake */
    bake() {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      // Work in world feet from here on.
      ctx.setTransform(RES, 0, 0, RES, PAD * RES, PAD * RES);

      drawSurround(ctx, this.team);
      drawAcrylic(ctx);
      drawWear(ctx);
      drawKeyPaint(ctx, this.team);
      drawLines(ctx);
      drawCenterLogo(ctx, this.team);
      drawSidelineType(ctx, this.team);
      drawSun(ctx);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this._texDirty = true;
    }
  };

  /* ------------------------------------------------------------ surround ---- */
  /**
   * Everything outside the lines: raw blacktop at the edges of the pad, the
   * painted terracotta surround inside that. Two colours meeting at the court
   * boundary is the whole reason a park court reads as a park court from
   * across the street.
   */
  function drawSurround(ctx, team) {
    // Blacktop first, over the entire baked pad.
    const g = ctx.createLinearGradient(0, -PAD, C.COURT_L * 0.4, C.COURT_W + PAD);
    g.addColorStop(0, PAL.asphaltLight);
    g.addColorStop(0.5, PAL.asphalt);
    g.addColorStop(1, PAL.asphaltDark);
    ctx.fillStyle = g;
    ctx.fillRect(-PAD, -PAD, C.COURT_L + PAD * 2, C.COURT_W + PAD * 2);

    /* Aggregate: the asphalt is a stone mix, and without the speckle it is a
     * flat grey card that the eye reads as fog. */
    const rng = U.makeRng(0xA5FA17);
    for (let i = 0; i < 4200; i++) {
      const x = rng.f(-PAD, C.COURT_L + PAD);
      const y = rng.f(-PAD, C.COURT_W + PAD);
      ctx.fillStyle = U.rgba(rng.chance(0.5) ? '#8E99A4' : '#2E353D', rng.f(0.05, 0.22));
      ctx.fillRect(x, y, rng.f(0.06, 0.20), rng.f(0.06, 0.16));
    }

    // The painted surround, stopping short of the pad edge so the blacktop
    // frames it. Rolled paint is never perfectly even, hence the gradient.
    const m = 1.9;                                   // unpainted blacktop margin
    const cg = ctx.createLinearGradient(0, -PAD, C.COURT_L * 0.5, C.COURT_W + PAD);
    cg.addColorStop(0, PAL.clayLight);
    cg.addColorStop(0.55, PAL.clay);
    cg.addColorStop(1, U.shade(PAL.clay, -0.12));
    ctx.fillStyle = cg;
    ctx.fillRect(-PAD + m, -PAD + m,
                 C.COURT_L + PAD * 2 - m * 2, C.COURT_W + PAD * 2 - m * 2);

    /* A band of the home colour along each baseline end of the surround: the
     * one piece of "this court belongs to someone" the park version keeps
     * from the arena's ribbon boards. */
    const band = 2.4;
    for (const xLeft of [-PAD + m + 0.6, C.COURT_L + PAD - m - band - 0.6]) {
      ctx.fillStyle = U.rgba(team.primary, 0.72);
      ctx.fillRect(xLeft, -PAD + m + 0.6, band, C.COURT_W + PAD * 2 - m * 2 - 1.2);
    }
    for (const yTop of [-PAD + m + 0.6, C.COURT_W + PAD - m - 1.4 - 0.6]) {
      ctx.fillStyle = U.rgba(team.secondary, 0.55);
      ctx.fillRect(-PAD + m + 0.6, yTop, C.COURT_L + PAD * 2 - m * 2 - 1.2, 1.4);
    }
  }

  /* ------------------------------------------------------------- acrylic ---- */
  /** The playing surface itself: teal acrylic, rolled on in passes. */
  function drawAcrylic(ctx) {
    const g = ctx.createLinearGradient(0, 0, C.COURT_L * 0.35, C.COURT_W);
    g.addColorStop(0, PAL.acrylicLight);
    g.addColorStop(0.45, PAL.acrylic);
    g.addColorStop(1, PAL.acrylicDark);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, C.COURT_L, C.COURT_W);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, C.COURT_L, C.COURT_W);
    ctx.clip();

    /* Roller passes. A court is painted in overlapping strips down its length,
     * and the seams between them stay faintly visible for years. */
    const strip = 3.6;
    for (let y = 0, row = 0; y < C.COURT_W; y += strip, row++) {
      const tone = (row % 2 === 0) ? 0.030 : -0.026;
      ctx.fillStyle = tone > 0 ? U.rgba('#FFFFFF', tone) : U.rgba('#04322A', -tone);
      ctx.fillRect(0, y, C.COURT_L, strip);
      ctx.fillStyle = U.rgba('#04322A', 0.05);
      ctx.fillRect(0, y, C.COURT_L, 0.10);
    }
    ctx.restore();
  }

  /**
   * Wear: the coating is thin over the high-traffic lane, cracked where the
   * asphalt underneath has moved, and patched where somebody rolled fresh
   * paint over a repair. This is the difference between a park court and a
   * green rectangle.
   */
  function drawWear(ctx) {
    const rng = U.makeRng(0x5EED);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, C.COURT_L, C.COURT_W);
    ctx.clip();

    /* Scuff patches — worn paint showing the blacktop through. Heaviest in
     * the two lanes, which is where the game is actually played. */
    for (let i = 0; i < 240; i++) {
      const heavy = rng.chance(0.55);
      const hoop = C.HOOPS[rng.i(0, 1)];
      const x = heavy ? hoop.x + rng.f(-2, 16) * hoop.dir : rng.f(0, C.COURT_L);
      const y = heavy ? C.HALF_W + rng.f(-9, 9) : rng.f(0, C.COURT_W);
      const r = rng.f(0.5, 3.2);
      const p = ctx.createRadialGradient(x, y, 0, x, y, r);
      p.addColorStop(0, U.rgba(PAL.asphaltDark, rng.f(0.05, 0.16)));
      p.addColorStop(1, U.rgba(PAL.asphaltDark, 0));
      ctx.fillStyle = p;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    /* Cracks. Each one wanders, forks once or twice, and is drawn dark with a
     * pale shoulder — a hairline of pure black reads as a scratch on the
     * screen rather than a split in the surface. */
    ctx.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      let x = rng.f(0, C.COURT_L), y = rng.f(0, C.COURT_W);
      let a = rng.f(0, Math.PI * 2);
      const segs = rng.i(4, 11);
      const pts = [[x, y]];
      for (let s = 0; s < segs; s++) {
        a += rng.f(-0.7, 0.7);
        x += Math.cos(a) * rng.f(0.8, 3.0);
        y += Math.sin(a) * rng.f(0.8, 3.0);
        pts.push([x, y]);
      }
      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let p = 1; p < pts.length; p++) ctx.lineTo(pts[p][0], pts[p][1]);
        ctx.stroke();
      };
      ctx.strokeStyle = U.rgba('#DCE8E2', 0.10);
      ctx.lineWidth = 0.13;
      ctx.save(); ctx.translate(0.05, 0.05); trace(); ctx.restore();
      ctx.strokeStyle = U.rgba('#08201C', rng.f(0.28, 0.55));
      ctx.lineWidth = 0.06;
      trace();
    }

    /* Repainted patches: a slightly-off batch of teal over an old repair. */
    for (let i = 0; i < 14; i++) {
      const x = rng.f(2, C.COURT_L - 2), y = rng.f(2, C.COURT_W - 2);
      ctx.fillStyle = U.rgba(rng.chance(0.5) ? PAL.acrylicLight : PAL.acrylicDark,
                             rng.f(0.10, 0.22));
      ctx.beginPath();
      ctx.ellipse(x, y, rng.f(1.4, 4.5), rng.f(1.0, 3.0), rng.f(0, 3.14), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- paint --- */
  function drawKeyPaint(ctx, team) {
    for (let i = 0; i < 2; i++) {
      const near = i === 0 ? 0 : C.COURT_L;
      const x0 = i === 0 ? 0 : C.COURT_L - C.PAINT_DEPTH;
      const g = ctx.createLinearGradient(x0, 0, x0 + C.PAINT_DEPTH, 0);
      const a = i === 0 ? [0.90, 0.72] : [0.72, 0.90];
      g.addColorStop(0, U.rgba(team.primary, a[0]));
      g.addColorStop(1, U.rgba(team.primary, a[1]));
      ctx.fillStyle = g;
      ctx.fillRect(x0, C.HALF_W - C.PAINT_HALF_W, C.PAINT_DEPTH, C.PAINT_HALF_W * 2);

      // Secondary stripe hugging the free-throw line.
      ctx.fillStyle = U.rgba(team.secondary, 0.55);
      const sx = i === 0 ? C.PAINT_DEPTH - 0.9 : C.COURT_L - C.PAINT_DEPTH;
      ctx.fillRect(sx, C.HALF_W - C.PAINT_HALF_W, 0.9, C.PAINT_HALF_W * 2);
      void near;
    }

    /* Sun-bleach around each arc: the paint fades fastest where nothing ever
     * shades it, so the top of the key is always lighter than the corners. */
    for (const hoop of C.HOOPS) {
      const g = ctx.createRadialGradient(hoop.x, hoop.y, 4, hoop.x, hoop.y, C.THREE_R);
      g.addColorStop(0, U.rgba('#EAF6EF', 0.10));
      g.addColorStop(1, U.rgba('#EAF6EF', 0));
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, C.COURT_L, C.COURT_W);
      ctx.clip();
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, C.COURT_L, C.COURT_W);
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- lines --- */
  function drawLines(ctx) {
    const LW = 0.166;            // 2" painted line
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    /* Soft drop under every line makes the paint sit "on" the surface. */
    const stroke = (path, color, width) => {
      ctx.save();
      ctx.strokeStyle = U.rgba('#08201C', 0.30);
      ctx.lineWidth = (width || LW) * 1.5;
      ctx.translate(0.05, 0.06);
      path();
      ctx.restore();
      ctx.strokeStyle = color || PAL.chalk;
      ctx.lineWidth = width || LW;
      path();
    };

    /* Boundary */
    stroke(() => {
      ctx.beginPath();
      ctx.rect(0, 0, C.COURT_L, C.COURT_W);
      ctx.stroke();
    }, PAL.chalk, LW * 1.35);

    /* Half-court line */
    stroke(() => {
      ctx.beginPath();
      ctx.moveTo(C.HALF_L, 0);
      ctx.lineTo(C.HALF_L, C.COURT_W);
      ctx.stroke();
    });

    /* Centre circles */
    stroke(() => {
      ctx.beginPath();
      ctx.arc(C.HALF_L, C.HALF_W, C.CENTER_R, 0, Math.PI * 2);
      ctx.moveTo(C.HALF_L + C.CENTER_INNER_R, C.HALF_W);
      ctx.arc(C.HALF_L, C.HALF_W, C.CENTER_INNER_R, 0, Math.PI * 2);
      ctx.stroke();
    });

    for (const hoop of C.HOOPS) {
      const dir = hoop.dir;                       // +1 for the left basket
      const base = dir > 0 ? 0 : C.COURT_L;       // that basket's baseline
      const ftX = base + dir * C.PAINT_DEPTH;

      /* Lane boundary + free-throw line */
      stroke(() => {
        ctx.beginPath();
        ctx.moveTo(base, C.HALF_W - C.PAINT_HALF_W);
        ctx.lineTo(ftX, C.HALF_W - C.PAINT_HALF_W);
        ctx.lineTo(ftX, C.HALF_W + C.PAINT_HALF_W);
        ctx.lineTo(base, C.HALF_W + C.PAINT_HALF_W);
        ctx.stroke();
      });

      /* Free-throw circle: solid toward mid-court, dashed inside the lane */
      const a0 = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      stroke(() => {
        ctx.beginPath();
        ctx.arc(ftX, C.HALF_W, C.FT_CIRCLE_R, a0, a0 + Math.PI, dir < 0);
        ctx.stroke();
      });
      ctx.save();
      ctx.setLineDash([0.85, 0.62]);
      ctx.strokeStyle = U.rgba(PAL.chalk, 0.9);
      ctx.lineWidth = LW;
      ctx.beginPath();
      ctx.arc(ftX, C.HALF_W, C.FT_CIRCLE_R, a0 + Math.PI, a0 + Math.PI * 2, dir < 0);
      ctx.stroke();
      ctx.restore();

      /* Lane hash marks (block, then three spaces up the lane) */
      const marks = [7, 11, 14, 17];
      stroke(() => {
        ctx.beginPath();
        for (const m of marks) {
          const x = base + dir * m;
          for (const s of [-1, 1]) {
            const y = C.HALF_W + s * C.PAINT_HALF_W;
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + s * 0.66);
          }
        }
        ctx.stroke();
      }, PAL.chalk, LW * 0.8);

      /* Restricted-area arc under the rim */
      stroke(() => {
        ctx.beginPath();
        ctx.arc(hoop.x, hoop.y, C.RESTRICTED_R, a0, a0 + Math.PI, dir < 0);
        const bx = base + dir * C.BACKBOARD_INSET;
        ctx.moveTo(bx, hoop.y - C.RESTRICTED_R);
        ctx.lineTo(hoop.x, hoop.y - C.RESTRICTED_R);
        ctx.moveTo(bx, hoop.y + C.RESTRICTED_R);
        ctx.lineTo(hoop.x, hoop.y + C.RESTRICTED_R);
        ctx.stroke();
      }, U.rgba(PAL.chalk, 0.82), LW * 0.85);

      /* Backboard footprint */
      stroke(() => {
        const bx = base + dir * C.BACKBOARD_INSET;
        ctx.beginPath();
        ctx.moveTo(bx, hoop.y - C.BACKBOARD_HALF_W);
        ctx.lineTo(bx, hoop.y + C.BACKBOARD_HALF_W);
        ctx.stroke();
      }, PAL.chalk, LW * 1.2);

      /* Three-point line: straight corner runs into a true 23'9" arc */
      const cornerDX = Math.sqrt(
        C.THREE_R * C.THREE_R -
        Math.pow(C.HALF_W - C.THREE_CORNER_INSET, 2)
      );
      const breakX = hoop.x + dir * cornerDX;
      const breakA = Math.atan2(C.THREE_CORNER_INSET - hoop.y, breakX - hoop.x);

      stroke(() => {
        ctx.beginPath();
        // top corner
        ctx.moveTo(base, C.THREE_CORNER_INSET);
        ctx.lineTo(breakX, C.THREE_CORNER_INSET);
        // arc
        if (dir > 0) ctx.arc(hoop.x, hoop.y, C.THREE_R, breakA, -breakA);
        else ctx.arc(hoop.x, hoop.y, C.THREE_R, Math.PI - breakA, Math.PI + breakA, true);
        // bottom corner
        ctx.lineTo(base, C.COURT_W - C.THREE_CORNER_INSET);
        ctx.stroke();
      }, PAL.chalk, LW * 1.1);
    }

    /* Coaching box and substitution hashes on the sidelines */
    stroke(() => {
      ctx.beginPath();
      for (const x of [28, 66]) {
        ctx.moveTo(x, 0); ctx.lineTo(x, 1.0);
        ctx.moveTo(x, C.COURT_W); ctx.lineTo(x, C.COURT_W - 1.0);
      }
      ctx.moveTo(C.HALF_L - 4, C.COURT_W); ctx.lineTo(C.HALF_L - 4, C.COURT_W - 1.4);
      ctx.moveTo(C.HALF_L + 4, C.COURT_W); ctx.lineTo(C.HALF_L + 4, C.COURT_W - 1.4);
      ctx.stroke();
    }, U.rgba(PAL.chalk, 0.75), LW * 0.8);
  }

  /* ----------------------------------------------------------- centre logo -- */
  function drawCenterLogo(ctx, team) {
    ctx.save();
    ctx.translate(C.HALF_L, C.HALF_W);

    // Ring
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = team.secondary;
    ctx.lineWidth = 0.22;
    ctx.beginPath();
    ctx.arc(0, 0, 5.0, 0, Math.PI * 2);
    ctx.stroke();

    // Basketball seams as an abstract mark
    ctx.globalAlpha = 0.42;
    ctx.strokeStyle = team.primary;
    ctx.lineWidth = 0.30;
    ctx.beginPath();
    ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
    ctx.moveTo(-3.2, 0); ctx.lineTo(3.2, 0);
    ctx.moveTo(0, -3.2); ctx.lineTo(0, 3.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-4.4, 0, 3.4, -0.78, 0.78);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(4.4, 0, 3.4, Math.PI - 0.78, Math.PI + 0.78);
    ctx.stroke();

    // Wordmark
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = PAL.chalk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 1.15px "Arial Narrow", Arial, sans-serif';
    ctx.save();
    ctx.scale(1, 1);
    ctx.fillText(team.name.toUpperCase(), 0, 4.05);
    ctx.restore();

    ctx.restore();
  }

  function drawSidelineType(ctx, team) {
    ctx.save();
    ctx.globalAlpha = 0.30;
    ctx.fillStyle = PAL.chalk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 2.2px "Arial Narrow", Arial, sans-serif';

    // Baseline wordmarks read from the bench side, so flip the far one.
    ctx.save();
    ctx.translate(C.HALF_L, C.COURT_W - 22.6);
    ctx.fillText(team.name.toUpperCase(), 0, 0);
    ctx.restore();

    ctx.save();
    ctx.translate(C.HALF_L, 22.6);
    ctx.rotate(Math.PI);
    ctx.fillText(team.name.toUpperCase(), 0, 0);
    ctx.restore();

    ctx.restore();
    void team;
  }

  /* ------------------------------------------------------------------- sun -- */
  /**
   * Open sunlight across the whole pad, and the shadow the fence throws over
   * one corner of it. There is deliberately no vignette here any more: the
   * arena had light pools because it was a dark room with lamps in it, and
   * darkening the far end of a court that is standing in full afternoon sun
   * is exactly what made the old floor read as indoors.
   */
  function drawSun(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(-PAD, -PAD, C.COURT_L * 0.7, C.COURT_W + PAD);
    g.addColorStop(0, 'rgba(255,246,220,0.10)');
    g.addColorStop(0.6, 'rgba(255,246,220,0.03)');
    g.addColorStop(1, 'rgba(255,246,220,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-PAD, -PAD, C.COURT_L + PAD * 2, C.COURT_W + PAD * 2);

    /* The chain link overhead throws a soft diagonal shade onto the near
     * corner. Sharp enough to be read as a shadow, soft enough that nobody
     * mistakes it for paint. */
    ctx.globalCompositeOperation = 'source-over';
    const s = ctx.createLinearGradient(C.COURT_L * 0.62, C.COURT_W + PAD,
                                       C.COURT_L + PAD, C.COURT_W * 0.35);
    s.addColorStop(0, 'rgba(16,32,48,0.20)');
    s.addColorStop(1, 'rgba(16,32,48,0)');
    ctx.fillStyle = s;
    ctx.fillRect(-PAD, -PAD, C.COURT_L + PAD * 2, C.COURT_W + PAD * 2);
    ctx.restore();
  }

  BB.Court = Court;
})(typeof window !== 'undefined' ? window : globalThis);
