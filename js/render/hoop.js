/* =============================================================================
 * hoop.js  —  Backboard, rim, net and stanchion, in 3D.
 * -----------------------------------------------------------------------------
 * Collision lives in physics/ball.js and already worked in true 3D; this module
 * is purely presentation. Every part is a primitive placed at its real world
 * position, so the assembly is now solid from any camera angle instead of being
 * split into hand-authored "behind the ball" and "in front of the ball" layers.
 *
 * The two draw entry points are kept for the renderer's benefit:
 *   drawBack()   opaque metal, padding and glass frame
 *   drawFront()  blended parts — the glass itself and the net
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  const STRANDS = 12;
  const NET_RINGS = 4;

  /* Palette, resolved once into GL float colours. */
  const COL = {};

  /* Park hardware, not arena hardware: galvanised pole, painted frame, a
   * concrete footing instead of a wheeled base with padding on it. The dark
   * charcoal these used to be was built to disappear into an unlit bowl, and
   * out in the sun it reads as a hole cut in the frame. */
  function colors() {
    if (COL.rim) return COL;
    const g = BB.GLX;
    COL.rim = g.color(PAL.rim);
    COL.rimHot = g.color('#FFD08A');
    COL.frame = g.color('#4A5866');
    COL.pad = g.color(PAL.orangeDim);
    COL.steel = g.color('#9BA6AE');
    COL.steelDark = g.color('#79858E');
    COL.glass = g.color(PAL.glass);
    COL.chalk = g.color(PAL.chalk);
    COL.net = g.color(PAL.net);
    COL.base = g.color('#8E8C86');
    return COL;
  }

  class Hoop {
    /** @param {object} def one entry from C.HOOPS */
    constructor(def) {
      this.def = def;
      this.x = def.x;
      this.y = def.y;
      this.dir = def.dir;                       // +1 = left basket faces right
      this.baseX = def.dir > 0 ? 0 : C.COURT_L;
      this.boardX = this.baseX + def.dir * C.BACKBOARD_INSET;

      /* Animation state */
      this.netEnergy = 0;      // 0..1, net billow
      this.netPhase = 0;
      this.rimFlex = 0;        // 0..1, downward rim bend after contact
      this.glass = 0;          // 0..1, backboard flash
      this.scoreGlow = 0;      // 0..1, ring glow after a make
    }

    /* -------------------------------------------------------------- events */
    /** Ball passed cleanly through. */
    swish(strength) {
      this.netEnergy = Math.min(1, this.netEnergy + (strength == null ? 1 : strength));
      this.netPhase = 0;
      this.scoreGlow = 1;
    }
    /** Ball struck the ring. */
    hitRim(strength) {
      this.rimFlex = Math.min(1, this.rimFlex + strength * 0.9);
      this.netEnergy = Math.min(0.7, this.netEnergy + strength * 0.35);
    }
    /** Ball struck the glass. */
    hitBoard(strength) {
      this.glass = Math.min(1, this.glass + strength);
    }

    update(dt) {
      this.netPhase += dt * 9.5;
      this.netEnergy = Math.max(0, this.netEnergy - dt * 1.75);
      this.rimFlex = Math.max(0, this.rimFlex - dt * 3.4);
      this.glass = Math.max(0, this.glass - dt * 4.0);
      this.scoreGlow = Math.max(0, this.scoreGlow - dt * 1.1);
    }

    /* ------------------------------------------------------------- shadow */
    /** Contact shadow under the whole assembly, on the floor. */
    drawShadow() {
      const S3 = BB.S3;
      const cx = (this.boardX + this.baseX - this.dir * 2.4) * 0.5;
      S3.shadow(cx, this.y, 6.2, 0.30);
    }

    /* ------------------------------------------------- opaque construction */
    drawBack() {
      const S3 = BB.S3, c = colors();
      const dir = this.dir;
      const bx = this.boardX;
      const hw = C.BACKBOARD_HALF_W;
      const bot = C.BACKBOARD_BOTTOM, top = C.BACKBOARD_TOP;
      const midZ = (bot + top) * 0.5;

      /* ---- stanchion: base pad, upright column, cantilever arm ---- */
      const baseCx = this.baseX - dir * 4.6;
      S3.box(baseCx, this.y, 0.55, 4.6, 6.4, 1.1, 0, c.base, 0.10);
      S3.box(baseCx, this.y, 3.0, 3.0, 4.6, 3.8, 0, c.steelDark, 0.12);
      S3.tube(baseCx, this.y, 1.0, baseCx, this.y, 13.6, 0.62, c.steel, 0.30);

      // Angled arm running forward from the column to the top of the glass.
      S3.tube(baseCx, this.y, 13.2, bx - dir * 0.35, this.y, top - 0.4, 0.34, c.steel, 0.34);
      // Lower tie-bar keeps the assembly from reading as a single thin pole.
      S3.tube(baseCx + dir * 0.4, this.y, 9.4, bx - dir * 0.30, this.y, bot + 0.35,
              0.20, c.steelDark, 0.24);

      /* ---- backboard frame: four edge rails around the glass ---- */
      const fr = 0.18;
      S3.box(bx, this.y, top, fr, hw * 2 + fr * 2, fr * 2, 0, c.frame, 0.30);
      S3.box(bx, this.y, bot, fr, hw * 2 + fr * 2, fr * 2, 0, c.frame, 0.30);
      S3.box(bx, this.y - hw, midZ, fr, fr * 2, top - bot, 0, c.frame, 0.30);
      S3.box(bx, this.y + hw, midZ, fr, fr * 2, top - bot, 0, c.frame, 0.30);

      /* Padding along the bottom edge — the one part of the board a player
       * ever actually collides with, and a strong colour cue for the hoop. */
      S3.box(bx + dir * 0.10, this.y, bot - 0.16, 0.28, hw * 2, 0.34, 0, c.pad, 0.06);

      /* ---- shooter's square ---- */
      const iw = C.BACKBOARD_INNER_W, ib = C.BACKBOARD_INNER_BOT, it = C.BACKBOARD_INNER_TOP;
      const sq = 0.075;
      const glow = this.glass;
      const sqCol = glow > 0.02 ? c.rimHot : c.chalk;
      const off = dir * 0.055;
      S3.box(bx + off, this.y, it, sq, iw * 2, sq * 2, 0, sqCol, 0.2, glow * 0.9);
      S3.box(bx + off, this.y, ib, sq, iw * 2, sq * 2, 0, sqCol, 0.2, glow * 0.9);
      S3.box(bx + off, this.y - iw, (ib + it) * 0.5, sq, sq * 2, it - ib, 0, sqCol, 0.2, glow * 0.9);
      S3.box(bx + off, this.y + iw, (ib + it) * 0.5, sq, sq * 2, it - ib, 0, sqCol, 0.2, glow * 0.9);

      /* ---- rim: ring, flexing under contact, plus the mount plate ---- */
      const rz = this.rimZ();
      const ringCol = this.scoreGlow > 0.01 ? c.rimHot : c.rim;
      S3.ring(this.x, this.y, rz, C.RIM_RADIUS + C.RIM_TUBE, ringCol, 0.55);
      if (this.scoreGlow > 0.01) {
        // A second, slightly larger ghost ring reads as the ring flaring after
        // a make without needing a bloom pass.
        S3.ring(this.x, this.y, rz, C.RIM_RADIUS + C.RIM_TUBE + 0.06,
                ringCol, 0.2, this.scoreGlow);
      }
      const mountX = this.x - dir * (C.RIM_RADIUS + 0.10);
      S3.box((mountX + bx) * 0.5, this.y, rz + 0.05,
             Math.abs(bx - mountX), 0.55, 0.22, 0, c.rim, 0.4);
      S3.box(bx - dir * 0.02, this.y, rz + 0.42, 0.10, 1.05, 1.1, 0, c.frame, 0.3);
    }

    /* -------------------------------------------------- blended components */
    drawFront() {
      const S3 = BB.S3, c = colors();
      const hw = C.BACKBOARD_HALF_W;
      const bot = C.BACKBOARD_BOTTOM, top = C.BACKBOARD_TOP;

      /* Glass. Alpha lifts briefly when the ball hits it. */
      const a = 0.16 + this.glass * 0.42;
      S3.panel(this.boardX, this.y, (bot + top) * 0.5, hw, (top - bot) * 0.5, c.glass, a);

      this._net();
    }

    /* ------------------------------------------------------------------ net
     * Twelve strands hanging from the ring into a smaller mouth, tied together
     * by horizontal rings. Billow is a radial swell driven by netEnergy, which
     * the ball's own physics feeds in via swish()/hitRim().
     */
    _net() {
      const S3 = BB.S3, c = colors();
      const rz = this.rimZ();
      const rTop = C.RIM_RADIUS - 0.02;
      const rBot = C.RIM_RADIUS * 0.62;
      const e = this.netEnergy;
      const len = C.NET_LENGTH * (1 + e * 0.35);
      const alpha = 0.55;

      /* Cache strand points so the tie rings can reuse them. */
      const pts = this._netPts || (this._netPts = []);
      for (let i = 0; i < STRANDS; i++) {
        const th = (i / STRANDS) * Math.PI * 2;
        const cs = Math.cos(th), sn = Math.sin(th);
        for (let k = 0; k <= NET_RINGS; k++) {
          const t = k / NET_RINGS;
          // Billow pushes the middle of the net outward and lags per strand,
          // which is what sells the "ball just went through" whip.
          const swell = Math.sin(t * Math.PI) * e * 0.22 * Math.sin(this.netPhase + i * 0.8);
          const r = U.lerp(rTop, rBot, t * t) + swell;
          const idx = (i * (NET_RINGS + 1) + k) * 3;
          pts[idx] = this.x + cs * r;
          pts[idx + 1] = this.y + sn * r;
          pts[idx + 2] = rz - len * t;
        }
      }

      /* Vertical strands. */
      for (let i = 0; i < STRANDS; i++) {
        for (let k = 0; k < NET_RINGS; k++) {
          const a = (i * (NET_RINGS + 1) + k) * 3;
          const b = a + 3;
          S3.limb(pts[a], pts[a + 1], pts[a + 2], pts[b], pts[b + 1], pts[b + 2],
                  0.022, netCol(c, alpha), 0.1, true);
        }
      }

      /* Horizontal ties, skipping the very top (that is the ring itself). */
      for (let k = 1; k <= NET_RINGS; k++) {
        for (let i = 0; i < STRANDS; i++) {
          const a = (i * (NET_RINGS + 1) + k) * 3;
          const b = (((i + 1) % STRANDS) * (NET_RINGS + 1) + k) * 3;
          S3.limb(pts[a], pts[a + 1], pts[a + 2], pts[b], pts[b + 1], pts[b + 2],
                  0.018, netCol(c, alpha * 0.8), 0.1, true);
        }
      }
    }

    /** Current ring height, including flex from contact. */
    rimZ() {
      return C.RIM_HEIGHT - this.rimFlex * 0.22;
    }
  }

  const NET_TMP = [1, 1, 1, 1];
  function netCol(c, a) {
    NET_TMP[0] = c.net[0]; NET_TMP[1] = c.net[1]; NET_TMP[2] = c.net[2];
    NET_TMP[3] = a;
    return NET_TMP;
  }

  BB.Hoop = Hoop;
})(typeof window !== 'undefined' ? window : globalThis);
