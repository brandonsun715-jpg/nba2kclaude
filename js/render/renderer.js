/* =============================================================================
 * renderer.js  —  Owns the two canvases and the draw order.
 * -----------------------------------------------------------------------------
 * The court is drawn with WebGL2 in true 3D; a second, transparent 2D canvas
 * sits directly on top of it for anything that belongs in screen space —
 * the shot meter, score popups, the flash, the vignette and the debug readout.
 * Text and thin UI strokes stay perfectly crisp there instead of being fought
 * through a perspective transform.
 *
 * Draw order per frame:
 *   1  sky, park ground, fence, trees, onlookers
 *   2  painted court (baked 2D artwork, mapped onto the real floor plane)
 *   3  hoop assemblies (opaque parts)
 *   4  entities — players, then the ball
 *   5  particles
 *   6  hoop glass and nets (blended parts)
 *   7  scene flush: one instanced draw call per primitive type
 *   8  screen-space overlay
 *
 * There is no depth sorting to do any more. The depth buffer resolves what is
 * in front of what, which is the entire reason a leaping player now passes
 * correctly behind the rim instead of being sorted by a flattened y.
 *
 * Nothing in this file makes gameplay decisions; it only asks the scene what to
 * draw. Swapping the presentation never touches the simulation.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  const EMPTY = [];

  const Renderer = {
    canvas: null,        // the WebGL canvas
    overlay: null,       // the 2D screen-space canvas
    ctx: null,           // 2D context of the overlay — scenes draw meters here
    gl: null,
    w: 0, h: 0,
    dpr: 1,
    quality: 'high',     // high | balanced | performance
    showDebug: false,
    supported: true,

    _resizePending: true,
    _t0: 0,

    /* ------------------------------------------------------------------ init */
    init(canvas) {
      this.canvas = canvas;

      this.supported = BB.GLX.init(canvas);
      if (!this.supported) {
        showUnsupported();
        return this;
      }
      this.gl = BB.GLX.gl;
      BB.S3.init();
      // The skinned player mesh reuses the scene's solid lighting verbatim so a
      // character lights identically to the park around it.
      BB.Skin.init(BB.S3.SOLID_FS);

      this.overlay = global.document.getElementById('overlay-canvas');
      this.ctx = this.overlay.getContext('2d', { alpha: true, desynchronized: true });
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';

      this._t0 = now();

      global.addEventListener('resize', () => { this._resizePending = true; });
      this.resize();
      return this;
    },

    setQuality(q) {
      this.quality = q;
      this._resizePending = true;
    },

    resize() {
      const cap = this.quality === 'performance' ? 1 : (this.quality === 'balanced' ? 1.5 : 2);
      const dpr = Math.min(global.devicePixelRatio || 1, cap);
      const cssW = this.canvas.clientWidth || global.innerWidth;
      const cssH = this.canvas.clientHeight || global.innerHeight;
      const w = Math.max(320, Math.round(cssW * dpr));
      const h = Math.max(240, Math.round(cssH * dpr));

      for (const cv of [this.canvas, this.overlay]) {
        if (cv && (cv.width !== w || cv.height !== h)) {
          cv.width = w;
          cv.height = h;
        }
      }
      this.w = w; this.h = h; this.dpr = dpr;
      if (this.gl) this.gl.viewport(0, 0, w, h);
      BB.Camera.resize(w, h, dpr);
      this._resizePending = false;
    },

    /* ------------------------------------------------------------------ draw */
    /**
     * @param {object} scene {
     *   camera, court, park, hoops, ball, entities[], fx, dimmed
     * }
     */
    render(scene) {
      if (!this.supported) return;
      if (this._resizePending) this.resize();

      const gl = this.gl;
      const cam = scene.camera || BB.Camera;
      const S3 = BB.S3;

      gl.viewport(0, 0, this.w, this.h);
      // The sky quad repaints every pixel anyway; this only matters for the
      // frame before the first flush, so it may as well be the sky.
      const sky = S3.SKY_COLOR;
      gl.clearColor(sky[0], sky[1], sky[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      S3.beginFrame(cam, (now() - this._t0) * 0.001);

      /* 1 — the park */
      if (scene.park) scene.park.drawBack();

      /* 2 — the floor */
      if (scene.court) scene.court.draw();

      /* 3 — hoops, opaque parts, plus their floor shadows */
      const hoops = scene.hoops || EMPTY;
      for (let i = 0; i < hoops.length; i++) {
        hoops[i].drawShadow();
        hoops[i].drawBack();
      }

      /* 4 — entities */
      const ents = scene.entities || EMPTY;
      for (let i = 0; i < ents.length; i++) {
        if (ents[i].drawShadow) ents[i].drawShadow();
        ents[i].draw();
      }
      if (scene.ball) {
        scene.ball.drawShadow();
        scene.ball.draw();
      }

      /* 5 — particles */
      if (scene.fx) scene.fx.draw();

      /* 6 — glass and nets, blended, drawn after everything they sit over */
      for (let i = 0; i < hoops.length; i++) hoops[i].drawFront();
      if (scene.park) scene.park.drawFront();

      /* 7 — resolve the whole frame */
      S3.flush();

      /* 8 — screen space */
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);

      if (scene.dimmed > 0) {
        ctx.fillStyle = U.rgba('#03050A', scene.dimmed * 0.72);
        ctx.fillRect(0, 0, this.w, this.h);
      }
      if (scene.fx) {
        scene.fx.drawPopups(ctx, cam);
        scene.fx.drawFlash(ctx, this.w, this.h);
      }
      this.vignette(ctx);
      if (this.showDebug) this.debug(ctx, scene);

      // Left in screen space on purpose: scenes draw their shot meters onto
      // this context immediately after render() returns.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },

    /** Soft frame darkening. Cached because the gradient never changes. */
    vignette(ctx) {
      if (!this._vg || this._vgW !== this.w || this._vgH !== this.h) {
        const g = ctx.createRadialGradient(
          this.w * 0.5, this.h * 0.48, Math.min(this.w, this.h) * 0.34,
          this.w * 0.5, this.h * 0.5, Math.max(this.w, this.h) * 0.80
        );
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.16)');
        this._vg = g; this._vgW = this.w; this._vgH = this.h;
      }
      ctx.fillStyle = this._vg;
      ctx.fillRect(0, 0, this.w, this.h);
    },

    debug(ctx, scene) {
      const cam = scene.camera || BB.Camera;
      const S3 = BB.S3;
      let instances = 0;
      for (const k in S3.meshes) instances += S3.meshes[k].n;

      const lines = [
        'fps ' + BB.Engine.fps.toFixed(0) + '   frame ' + BB.Engine.frameMs.toFixed(2) + 'ms',
        'state ' + BB.Engine.state,
        'cam ' + cam._x.toFixed(1) + ', ' + cam._y.toFixed(1) + '  z' + cam._zoom.toFixed(2) +
          '  eye ' + cam.eye[0].toFixed(0) + '/' + cam.eye[1].toFixed(0) + '/' + cam.eye[2].toFixed(0),
        'ball ' + (scene.ball ? scene.ball.x.toFixed(1) + ', ' + scene.ball.y.toFixed(1) +
          ', ' + scene.ball.z.toFixed(1) + '  ' + scene.ball.state : '—'),
        'inst ' + instances + (S3.dropped ? '  DROPPED ' + S3.dropped : ''),
        'fx ' + (scene.fx ? scene.fx.particles.size : 0) + ' particles'
      ];
      ctx.save();
      ctx.font = '600 ' + (12 * this.dpr).toFixed(0) + 'px ui-monospace, Menlo, Consolas, monospace';
      ctx.textBaseline = 'top';
      const pad = 8 * this.dpr;
      const lh = 16 * this.dpr;
      let wMax = 0;
      for (const l of lines) wMax = Math.max(wMax, ctx.measureText(l).width);
      ctx.fillStyle = 'rgba(4,6,10,0.72)';
      ctx.fillRect(pad, pad, wMax + pad * 2, lines.length * lh + pad * 2);
      ctx.fillStyle = PAL.mint;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], pad * 2, pad * 2 + i * lh);
      }
      ctx.restore();
    }
  };

  function now() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }

  /** WebGL2 is required; say so plainly rather than failing to a black screen. */
  function showUnsupported() {
    const boot = global.document && global.document.getElementById('boot');
    if (!boot) return;
    boot.classList.remove('is-hidden');
    boot.innerHTML = '<div style="max-width:34rem;margin:auto;padding:2rem;'
      + 'color:#F3F0E7;font:500 1rem/1.6 system-ui,sans-serif;text-align:center">'
      + '<h1 style="font-size:1.4rem;margin:0 0 .8rem">WebGL2 required</h1>'
      + 'HARDWOOD renders the court in 3D and needs WebGL2, which this browser '
      + 'either does not support or has disabled. Enabling hardware acceleration '
      + 'in your browser settings usually fixes it.</div>';
  }

  BB.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
