/* =============================================================================
 * court.js  —  The playing surface.
 * -----------------------------------------------------------------------------
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
      name: 'HARDWOOD',
      abbr: 'HWD',
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

      drawApron(ctx, this.team);
      drawHardwood(ctx);
      drawGrain(ctx);
      drawKeyPaint(ctx, this.team);
      drawLines(ctx);
      drawCenterLogo(ctx, this.team);
      drawSidelineType(ctx, this.team);
      drawGloss(ctx);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this._texDirty = true;
    }
  };

  /* --------------------------------------------------------------- apron ---- */
  function drawApron(ctx, team) {
    const g = ctx.createLinearGradient(0, -PAD, 0, C.COURT_W + PAD);
    g.addColorStop(0, U.shade(PAL.ink, 0.10));
    g.addColorStop(0.5, PAL.ink);
    g.addColorStop(1, U.shade(PAL.ink, 0.04));
    ctx.fillStyle = g;
    ctx.fillRect(-PAD, -PAD, C.COURT_L + PAD * 2, C.COURT_W + PAD * 2);

    // Courtside LED ribbon in the home team's colour along both sidelines.
    const band = 1.6;
    for (const yTop of [-PAD + 1.4, C.COURT_W + PAD - band - 1.4]) {
      const lg = ctx.createLinearGradient(0, yTop, 0, yTop + band);
      lg.addColorStop(0, U.rgba(team.primary, 0.05));
      lg.addColorStop(0.5, U.rgba(team.primary, 0.55));
      lg.addColorStop(1, U.rgba(team.primary, 0.05));
      ctx.fillStyle = lg;
      ctx.fillRect(-PAD + 2, yTop, C.COURT_L + PAD * 2 - 4, band);
    }

    // The baselines got nothing before — same idea, rotated 90°, sitting
    // right behind each basket where the camera spends most of its time in
    // a half-court game. A grounding shadow first so the accent band reads
    // as sitting against a real back wall, not just painted on the floor.
    const bBand = 1.3;
    for (const xLeft of [-PAD + 1.1, C.COURT_L + PAD - bBand - 1.1]) {
      ctx.fillStyle = U.rgba('#000000', 0.30);
      ctx.fillRect(xLeft - 0.5, -PAD, bBand + 1.0, C.COURT_W + PAD * 2);
      const bg = ctx.createLinearGradient(xLeft, 0, xLeft + bBand, 0);
      bg.addColorStop(0, U.rgba(team.secondary, 0.05));
      bg.addColorStop(0.5, U.rgba(team.secondary, 0.50));
      bg.addColorStop(1, U.rgba(team.secondary, 0.05));
      ctx.fillStyle = bg;
      ctx.fillRect(xLeft, -PAD + 2, bBand, C.COURT_W + PAD * 2 - 4);
    }
  }

  /* ------------------------------------------------------------ hardwood ---- */
  function drawHardwood(ctx) {
    const g = ctx.createLinearGradient(0, 0, C.COURT_L * 0.35, C.COURT_W);
    g.addColorStop(0, PAL.mapleLight);
    g.addColorStop(0.45, PAL.maple);
    g.addColorStop(1, U.shade(PAL.maple, -0.10));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, C.COURT_L, C.COURT_W);

    /* Alternating plank blocks, laid lengthways like a real floor. */
    const plank = 0.55;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, C.COURT_L, C.COURT_W);
    ctx.clip();

    for (let y = 0, row = 0; y < C.COURT_W; y += plank, row++) {
      const tone = (row % 2 === 0) ? 0.035 : -0.030;
      ctx.fillStyle = tone > 0 ? U.rgba('#FFFFFF', tone) : U.rgba('#3B2408', -tone);
      ctx.fillRect(0, y, C.COURT_L, plank);
    }

    /* Board seams: staggered vertical joints every few feet. */
    ctx.strokeStyle = PAL.mapleGrain;
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    for (let y = 0, row = 0; y < C.COURT_W; y += plank, row++) {
      const offset = (row % 3) * 2.7;
      for (let x = offset; x < C.COURT_L; x += 8.1) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + plank);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Long, low-contrast grain streaks that break up the flat fill. */
  function drawGrain(ctx) {
    const rng = U.makeRng(0x5EED);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, C.COURT_L, C.COURT_W);
    ctx.clip();
    ctx.lineWidth = 0.05;
    for (let i = 0; i < 520; i++) {
      const x = rng.f(0, C.COURT_L);
      const y = rng.f(0, C.COURT_W);
      const len = rng.f(1.5, 7);
      ctx.strokeStyle = U.rgba(rng.chance(0.5) ? '#5A3410' : '#E8C089', rng.f(0.03, 0.11));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y + rng.f(-0.06, 0.06));
      ctx.stroke();
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

    /* Faint stained-wood halo beyond each arc so the paint doesn't float. */
    for (const hoop of C.HOOPS) {
      const g = ctx.createRadialGradient(hoop.x, hoop.y, 4, hoop.x, hoop.y, C.THREE_R);
      g.addColorStop(0, U.rgba('#3B2408', 0.14));
      g.addColorStop(1, U.rgba('#3B2408', 0));
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

    /* Soft drop under every line makes the paint sit "on" the wood. */
    const stroke = (path, color, width) => {
      ctx.save();
      ctx.strokeStyle = U.rgba('#3B2408', 0.35);
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

  /* ----------------------------------------------------------------- gloss -- */
  /** Specular sheen + arena light pools. Sells the polish on the boards. */
  function drawGloss(ctx) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, C.COURT_L, C.COURT_W);
    ctx.clip();

    ctx.globalCompositeOperation = 'lighter';
    for (const cx of [20, 47, 74]) {
      const g = ctx.createRadialGradient(cx, C.HALF_W - 6, 2, cx, C.HALF_W - 6, 30);
      g.addColorStop(0, 'rgba(255,240,214,0.085)');
      g.addColorStop(1, 'rgba(255,240,214,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, C.COURT_L, C.COURT_W);
    }

    ctx.globalCompositeOperation = 'source-over';
    // Vignette toward the baselines keeps the eye at mid-court.
    const v = ctx.createLinearGradient(0, 0, C.COURT_L, 0);
    v.addColorStop(0, 'rgba(0,0,0,0.22)');
    v.addColorStop(0.18, 'rgba(0,0,0,0)');
    v.addColorStop(0.82, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, C.COURT_L, C.COURT_W);

    const v2 = ctx.createLinearGradient(0, 0, 0, C.COURT_W);
    v2.addColorStop(0, 'rgba(0,0,0,0.18)');
    v2.addColorStop(0.35, 'rgba(0,0,0,0)');
    v2.addColorStop(1, 'rgba(0,0,0,0.10)');
    ctx.fillStyle = v2;
    ctx.fillRect(0, 0, C.COURT_L, C.COURT_W);

    ctx.restore();
  }

  BB.Court = Court;
})(typeof window !== 'undefined' ? window : globalThis);
