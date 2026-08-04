/* =============================================================================
 * fx.js  —  Particles, floating popups and screen flashes.
 * -----------------------------------------------------------------------------
 * Everything is pooled and stored in flat objects that are reused forever, so a
 * long game generates essentially zero garbage from effects.
 *
 * Particles live in world feet with a height component, exactly like the ball,
 * and are flattened at draw time.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;


  const KIND = { SPARK: 0, DUST: 1, CONFETTI: 2, RING: 3 };

  const FX = {
    particles: null,
    popups: null,
    flash: 0,
    flashColour: '#FFFFFF',

    init() {
      this.particles = new U.Pool(
        () => ({
          kind: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
          life: 0, max: 1, size: 1, rot: 0, spin: 0, colour: '#fff', gravity: 1, drag: 1
        }),
        (p, a) => { Object.assign(p, a[0]); p.max = p.life; },
        320
      );

      this.popups = new U.Pool(
        () => ({ text: '', sub: '', x: 0, y: 0, z: 0, life: 0, max: 1, colour: '#fff', size: 1, rise: 4 }),
        (o, a) => { Object.assign(o, a[0]); o.max = o.life; },
        24
      );
      return this;
    },

    clear() {
      this.particles.releaseAll();
      this.popups.releaseAll();
      this.flash = 0;
    },

    /* ------------------------------------------------------------- spawners */
    /** Bright radial burst — rim contact, steals, blocks. */
    burst(x, y, z, count, colour, power) {
      power = power || 1;
      for (let i = 0; i < count; i++) {
        const a = U.rng.f(0, Math.PI * 2);
        const s = U.rng.f(2, 9) * power;
        this.particles.acquire({
          kind: KIND.SPARK,
          x, y, z,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s * 0.6,
          vz: U.rng.f(1, 8) * power,
          life: U.rng.f(0.25, 0.6),
          size: U.rng.f(0.06, 0.16),
          colour: colour || PAL.gold,
          rot: 0, spin: 0, gravity: 1, drag: 0.9
        });
      }
    },

    /** Low, slow floor dust — landings, hard cuts, dunks. */
    dust(x, y, count, power) {
      power = power || 1;
      for (let i = 0; i < count; i++) {
        const a = U.rng.f(0, Math.PI * 2);
        const s = U.rng.f(0.6, 3.2) * power;
        this.particles.acquire({
          kind: KIND.DUST,
          x, y, z: 0.05,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s * 0.55,
          vz: U.rng.f(0.4, 2.0) * power,
          life: U.rng.f(0.45, 0.95),
          size: U.rng.f(0.25, 0.7),
          colour: '#E8D2AE',
          rot: 0, spin: 0, gravity: 0.22, drag: 2.6
        });
      }
    },

    /** Championship / big-run confetti falling through the frame. */
    confetti(count, colours, spanX) {
      const span = spanX || C.COURT_L;
      for (let i = 0; i < count; i++) {
        this.particles.acquire({
          kind: KIND.CONFETTI,
          x: U.rng.f(C.HALF_L - span / 2, C.HALF_L + span / 2),
          y: U.rng.f(-4, C.COURT_W + 4),
          z: U.rng.f(24, 42),
          vx: U.rng.f(-1.4, 1.4),
          vy: U.rng.f(-0.7, 0.7),
          vz: U.rng.f(-1, 1),
          life: U.rng.f(3.2, 6.0),
          size: U.rng.f(0.16, 0.34),
          colour: (colours || [PAL.gold, PAL.orange, PAL.chalk])[U.rng.i(0, (colours || [1, 2, 3]).length - 1)],
          rot: U.rng.f(0, 6.28), spin: U.rng.f(-9, 9),
          gravity: 0.22, drag: 1.4
        });
      }
    },

    /** Expanding shock ring on the floor — dunks, big blocks. */
    ring(x, y, colour, size) {
      this.particles.acquire({
        kind: KIND.RING,
        x, y, z: 0.02,
        vx: 0, vy: 0, vz: 0,
        life: 0.45, size: size || 1,
        colour: colour || PAL.chalk,
        rot: 0, spin: 0, gravity: 0, drag: 0
      });
    },

    /**
     * Floating broadcast popup anchored in the world.
     * @param {object} o { text, sub, x, y, z, colour, size, life, rise }
     */
    popup(o) {
      this.popups.acquire(Object.assign({
        text: '', sub: '', x: C.HALF_L, y: C.HALF_W, z: 6,
        life: 1.5, colour: PAL.chalk, size: 1, rise: 4
      }, o));
    },

    screenFlash(colour, strength) {
      this.flashColour = colour || '#FFFFFF';
      this.flash = Math.max(this.flash, U.clamp01(strength == null ? 0.5 : strength));
    },

    /* ---------------------------------------------------------------- update */
    update(dt) {
      const ps = this.particles.active;
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.life -= dt;
        if (p.life <= 0) { this.particles.releaseAt(i); continue; }

        if (p.kind !== KIND.RING) {
          p.vz -= C.GRAVITY * p.gravity * dt;
          const d = Math.exp(-p.drag * dt);
          p.vx *= d; p.vy *= d;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.z += p.vz * dt;
          p.rot += p.spin * dt;
          if (p.z < 0.02) {
            p.z = 0.02;
            p.vz *= -0.32;
            p.vx *= 0.6; p.vy *= 0.6;
            if (p.kind === KIND.CONFETTI) p.life = Math.min(p.life, 0.8);
          }
        }
      }

      const us = this.popups.active;
      for (let i = us.length - 1; i >= 0; i--) {
        const u = us[i];
        u.life -= dt;
        if (u.life <= 0) this.popups.releaseAt(i);
      }

      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 3.2);
    },

    /* ------------------------------------------------------------------ draw */
    /**
     * World-space pass, submitted to the 3D scene. Every particle kind is a
     * blended primitive placed at its real world position, so dust kicked up
     * on the far baseline is correctly smaller than dust at the near sideline
     * — something the old flat pass could only approximate.
     */
    draw() {
      const S3 = BB.S3;
      const ps = this.particles.active;
      if (!ps.length || !S3 || !S3.ready) return;

      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const k = p.life / p.max;
        const col = fxCol(p.colour, k);

        if (p.kind === KIND.SPARK) {
          col[3] = k;
          S3.sphere(p.x, p.y, p.z, p.size * (0.4 + k * 0.9), col, 0.4, 0.9, true);

        } else if (p.kind === KIND.DUST) {
          col[3] = k * 0.30;
          S3.sphere(p.x, p.y, p.z, p.size * (1.4 - k * 0.5), col, 0, 0.1, true);

        } else if (p.kind === KIND.CONFETTI) {
          col[3] = Math.min(1, k * 3);
          // The vertical squash fakes the strip tumbling edge-on.
          const flat = Math.abs(Math.cos(p.rot * 1.7));
          S3.box(p.x, p.y, p.z, p.size * 2, p.size * 0.5,
                 p.size * 0.7 * flat + 0.02, p.rot, col, 0.2, 0.25, true);

        } else if (p.kind === KIND.RING) {
          const t = 1 - k;
          col[3] = k * 0.55;
          S3.ring(p.x, p.y, Math.max(0.03, p.z), p.size * (0.6 + t * 5.2), col, 0.3);
        }
      }
    },

    /**
     * Popups are drawn in SCREEN space so text stays crisp and never inherits
     * the court's vertical squash.
     */
    drawPopups(ctx, cam) {
      const us = this.popups.active;
      if (!us.length) return;
      const pt = { x: 0, y: 0, s: 1 };

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (let i = 0; i < us.length; i++) {
        const u = us[i];
        const t = 1 - u.life / u.max;
        const rise = U.ease.outCubic(U.clamp01(t * 1.4)) * u.rise;
        cam.project(u.x, u.y, u.z + rise, pt);

        // Pop in fast, hold, fade out.
        const alpha = t < 0.12 ? t / 0.12 : (t > 0.72 ? 1 - (t - 0.72) / 0.28 : 1);
        const pop = t < 0.16 ? U.ease.outBack(t / 0.16) : 1;
        const px = 30 * u.size * pop * cam.fit;

        ctx.globalAlpha = U.clamp01(alpha);
        ctx.font = '800 ' + px.toFixed(1) + 'px "Arial Narrow", "Segoe UI", sans-serif';
        ctx.lineWidth = px * 0.16;
        ctx.strokeStyle = 'rgba(4,6,10,0.85)';
        ctx.strokeText(u.text, pt.x, pt.y);
        ctx.fillStyle = u.colour;
        ctx.fillText(u.text, pt.x, pt.y);

        if (u.sub) {
          const sp = px * 0.42;
          ctx.font = '700 ' + sp.toFixed(1) + 'px "Arial Narrow", "Segoe UI", sans-serif';
          ctx.lineWidth = sp * 0.2;
          ctx.strokeStyle = 'rgba(4,6,10,0.85)';
          ctx.strokeText(u.sub, pt.x, pt.y + px * 0.72);
          ctx.fillStyle = U.rgba(PAL.chalk, 0.9);
          ctx.fillText(u.sub, pt.x, pt.y + px * 0.72);
        }
      }
      ctx.restore();
    },

    drawFlash(ctx, w, h) {
      if (this.flash <= 0.001) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = U.rgba(this.flashColour, this.flash * 0.35);
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  };

  FX.KIND = KIND;
  /* Scratch colour, refilled per particle so the draw pass never allocates. */
  const FX_COL = [1, 1, 1, 1];
  const FX_CACHE = Object.create(null);
  function fxCol(css, a) {
    let c = FX_CACHE[css];
    if (!c) c = FX_CACHE[css] = BB.GLX.color(css);
    FX_COL[0] = c[0]; FX_COL[1] = c[1]; FX_COL[2] = c[2]; FX_COL[3] = a;
    return FX_COL;
  }

  BB.FX = FX;
})(typeof window !== 'undefined' ? window : globalThis);
