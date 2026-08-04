/* =============================================================================
 * scene3d.js  —  The instanced draw list every 3D object submits to.
 * -----------------------------------------------------------------------------
 * Game code never touches WebGL. It calls helpers like S3.limb() or S3.ball()
 * in ordinary court coordinates (x along the length, y across the width, z up)
 * and this module handles the swizzle into GL space, the model matrix, the
 * bucket (opaque / transparent) and the eventual instanced draw call.
 *
 * One frame is:
 *   beginFrame(camera)   reset every bucket, upload the camera matrices
 *   ... submissions ...  from court, arena, hoops, players, ball, fx
 *   flush()              opaque pass, floor, shadow pass, transparent pass
 *
 * Everything is drawn in at most a dozen draw calls regardless of how many
 * limbs, seats and net strands are on screen, because identical primitives are
 * batched into a single instanced draw.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const C = BB.C, M4 = BB.M4, Geo = BB.Geo;

  const IF = 24; // floats per instance, mirrors GLX.INSTANCE_FLOATS

  /* ---------------------------------------------------------------- shaders */

  const COMMON_VS = `#version 300 es
  layout(location=0) in vec3 a_pos;
  layout(location=1) in vec3 a_normal;
  layout(location=2) in vec2 a_uv;
  layout(location=3) in vec4 a_m0;
  layout(location=4) in vec4 a_m1;
  layout(location=5) in vec4 a_m2;
  layout(location=6) in vec4 a_m3;
  layout(location=7) in vec4 a_color;
  layout(location=8) in vec4 a_params;

  uniform mat4 u_viewProj;
  uniform float u_time;
  // Per-draw reinterpretation of a_params.w, so one shared attribute can mean
  // two different things without a second vertex format:
  //   0  nothing  1  crowd bob amplitude  2  limb end-radius ratio
  uniform float u_shapeMode;

  out vec3 v_world;
  out vec3 v_normal;
  out vec2 v_uv;
  out vec4 v_color;
  out vec4 v_params;

  void main() {
    vec3 pos = a_pos;
    vec3 nrm = a_normal;

    // Limb taper. The segment primitive is lathed around local Y with uv.y
    // running 0 at the start cap to 1 at the end cap, so scaling the radial
    // components by a ratio that walks from 1 to a_params.w turns a uniform
    // tube into a real thigh (thick at the hip, narrow at the knee) or calf.
    if (u_shapeMode > 1.5) {
      float ratio = a_params.w;
      float k = mix(1.0, ratio, a_uv.y);
      pos.xz *= k;
      // The lathed normal is (cos, -R', sin) for profile radius R(y). Scaling R
      // by k(y) adds rho * dk/dy to the slope, and dk/dy is (ratio - 1) because
      // the primitive is exactly one unit long. Skipped at the caps, where the
      // radius has collapsed to zero and the normal already points along Y.
      float c = length(a_normal.xz);
      if (c > 1e-4) {
        vec2 dir = a_normal.xz / c;
        float slope = -a_normal.y / c;
        float rho = length(a_pos.xz);
        nrm = normalize(vec3(dir.x, -(slope * k + rho * (ratio - 1.0)), dir.y));
      }
    }

    mat4 model = mat4(a_m0, a_m1, a_m2, a_m3);
    vec4 wp = model * vec4(pos, 1.0);
    // Crowd bob: params.z is a per-instance phase seed and params.w the
    // amplitude in feet. Doing it here means 1800 fans animate for free.
    if (u_shapeMode > 0.5 && u_shapeMode < 1.5 && a_params.w > 0.0001) {
      wp.y += sin(u_time * 3.1 + a_params.z * 6.2831) * a_params.w;
    }
    v_world = wp.xyz;
    // Inverse-transpose so non-uniformly scaled limbs still light correctly.
    v_normal = normalize(mat3(transpose(inverse(model))) * nrm);
    v_uv = a_uv;
    v_color = a_color;
    v_params = a_params;
    gl_Position = u_viewProj * wp;
  }`;

  /* Key light + hemispheric fill + rim. Tuned for "Court at Night": the arena
   * is dark, the floor bounces warm maple light up into everyone's legs, and a
   * cool rim traces every silhouette so players read against the black bowl. */
  const SOLID_FS = `#version 300 es
  precision highp float;

  in vec3 v_world;
  in vec3 v_normal;
  in vec2 v_uv;
  in vec4 v_color;
  in vec4 v_params;

  uniform vec3 u_eye;
  uniform vec3 u_lightDir;
  uniform vec3 u_fogColor;
  uniform float u_fogDensity;

  out vec4 outColor;

  void main() {
    vec3 N = normalize(v_normal);
    vec3 V = normalize(u_eye - v_world);
    if (!gl_FrontFacing) N = -N;

    vec3 L = normalize(u_lightDir);
    float ndl = max(dot(N, L), 0.0);

    // Broad arena rig: a second, weaker light from the opposite side stops the
    // shadow side of every player going completely flat black.
    float ndl2 = max(dot(N, normalize(vec3(-L.x, L.y * 0.55, -L.z))), 0.0);

    // Hemispheric ambient: cool from the roof, warm maple bounce from below.
    float hemi = N.y * 0.5 + 0.5;
    vec3 ambient = mix(vec3(0.16, 0.11, 0.07), vec3(0.20, 0.23, 0.30), hemi);

    vec3 albedo = v_color.rgb;
    float gloss = v_params.x;
    float emissive = v_params.y;

    vec3 diffuse = albedo * (ambient + vec3(1.02, 0.97, 0.88) * ndl * 0.86
                                     + vec3(0.42, 0.50, 0.66) * ndl2 * 0.30);

    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 12.0 + gloss * 90.0) * gloss;

    // Rim term: strongest where the surface turns away from the viewer.
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.55;

    vec3 col = diffuse + vec3(1.0, 0.96, 0.90) * spec
             + vec3(0.36, 0.55, 0.78) * rim
             + albedo * emissive;

    float dist = length(u_eye - v_world);
    float fog = 1.0 - exp(-dist * u_fogDensity);
    col = mix(col, u_fogColor, clamp(fog, 0.0, 1.0));

    outColor = vec4(col, v_color.a);
  }`;

  /* Floor: the baked Canvas2D court art, relit and given a broadcast sheen.
   * The gloss streak is a cheap stand-in for a real reflection — enough to
   * read as polished maple under arena lights without a second render pass. */
  const FLOOR_FS = `#version 300 es
  precision highp float;

  in vec3 v_world;
  in vec3 v_normal;
  in vec2 v_uv;
  in vec4 v_color;
  in vec4 v_params;

  uniform sampler2D u_tex;
  uniform vec3 u_eye;
  uniform vec3 u_lightDir;
  uniform vec3 u_fogColor;
  uniform float u_fogDensity;

  out vec4 outColor;

  void main() {
    vec4 tex = texture(u_tex, v_uv);
    vec3 N = vec3(0.0, 1.0, 0.0);
    vec3 V = normalize(u_eye - v_world);
    vec3 L = normalize(u_lightDir);
    vec3 H = normalize(L + V);

    float ndl = max(dot(N, L), 0.0);
    vec3 lit = tex.rgb * (0.42 + ndl * 0.72);

    float spec = pow(max(dot(N, H), 0.0), 46.0) * 0.30;
    // Grazing angles catch far more light off a waxed floor.
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0) * 0.22;

    vec3 col = lit + vec3(1.0, 0.95, 0.86) * spec + vec3(0.28, 0.42, 0.62) * fres;

    float dist = length(u_eye - v_world);
    float fog = 1.0 - exp(-dist * u_fogDensity);
    col = mix(col, u_fogColor, clamp(fog, 0.0, 1.0));

    outColor = vec4(col, tex.a);
  }`;

  /* Contact shadow: a soft radial blob laid on the floor. Cheaper and more
   * controllable than a shadow map, and it matches the look the 2D build had. */
  const SHADOW_FS = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  in vec4 v_color;
  in vec3 v_world;
  in vec3 v_normal;
  in vec4 v_params;
  out vec4 outColor;
  void main() {
    float d = length(v_uv - vec2(0.5)) * 2.0;
    float a = smoothstep(1.0, 0.15, d);
    outColor = vec4(0.0, 0.0, 0.0, a * v_color.a);
  }`;

  /* --------------------------------------------------------------- module */

  const S3 = {
    ready: false,
    meshes: null,
    progSolid: null,
    progFloor: null,
    progShadow: null,

    /* Camera state for the current frame. */
    _viewProj: null,
    _eye: new Float32Array(3),
    _time: 0,

    /* Scratch matrices — reused so submission never allocates. */
    _m: null,
    _a: new Float32Array(3),
    _b: new Float32Array(3),
    _r: new Float32Array(3),

    /* Overflow counter, surfaced in the debug overlay. */
    dropped: 0,

    /* ------------------------------------------------------------------ init */
    init() {
      const GLX = BB.GLX;
      this._viewProj = M4.create();
      this._m = M4.create();

      this.progSolid = GLX.program(COMMON_VS, SOLID_FS);
      this.progFloor = GLX.program(COMMON_VS, FLOOR_FS);
      this.progShadow = GLX.program(COMMON_VS, SHADOW_FS);

      const box = Geo.box(), sph = Geo.sphere(16, 12), seg = Geo.segment(12, 12);
      const cyl = Geo.cylinder(18), tor = Geo.torus(0.20, 30, 9);
      const quad = Geo.quad(), panel = Geo.panel();

      // Two buffers per primitive: opaque geometry and blended geometry can't
      // share one instance list because they are drawn in different passes.
      this.meshes = {
        box: GLX.mesh(box, 700),
        boxT: GLX.mesh(box, 200),
        sphere: GLX.mesh(sph, 400),
        sphereT: GLX.mesh(sph, 200),
        seg: GLX.mesh(seg, 900),
        segT: GLX.mesh(seg, 400),
        cyl: GLX.mesh(cyl, 300),
        cylT: GLX.mesh(cyl, 120),
        torus: GLX.mesh(tor, 24),
        panelT: GLX.mesh(panel, 40),
        crowd: GLX.mesh(box, 4400),
        quad: GLX.mesh(quad, 8),
        shadow: GLX.mesh(quad, 200),
        floor: GLX.mesh(quad, 2)
      };

      this.ready = true;
      return this;
    },

    /* ----------------------------------------------------------- frame setup */
    beginFrame(cam, time) {
      this._time = time || 0;
      M4.copy(this._viewProj, cam.viewProj);
      this._eye[0] = cam.eye[0];
      this._eye[1] = cam.eye[1];
      this._eye[2] = cam.eye[2];
      for (const k in this.meshes) this.meshes[k].n = 0;
      this.dropped = 0;
    },

    /* --------------------------------------------------------- raw submission
     * Writes one instance (matrix + colour + params) into a mesh's staging
     * array. Silently drops instances past capacity rather than reallocating
     * mid-frame, and counts the drop for the debug overlay.
     */
    push(mesh, m, color, gloss, emissive, alpha, taper) {
      if (mesh.n >= mesh.capacity) { this.dropped++; return; }
      const d = mesh.data;
      let o = mesh.n * IF;
      for (let i = 0; i < 16; i++) d[o + i] = m[i];
      o += 16;
      d[o] = color[0]; d[o + 1] = color[1]; d[o + 2] = color[2];
      d[o + 3] = alpha == null ? (color[3] == null ? 1 : color[3]) : alpha;
      d[o + 4] = gloss || 0;
      d[o + 5] = emissive || 0;
      d[o + 6] = 0;
      // 1 means "same radius at both ends"; only the tapered-limb pass reads it.
      d[o + 7] = taper == null ? 1 : taper;
      mesh.n++;
    },

    /**
     * Appends a pre-built block of instances in one copy. Used for static
     * geometry with thousands of instances — the crowd — where rebuilding the
     * matrices every frame would be pure waste. The block must already be laid
     * out as `count` runs of 24 floats matching push()'s layout.
     */
    pushBatch(mesh, arr, count) {
      const room = mesh.capacity - mesh.n;
      const n = Math.min(count, room);
      if (n <= 0) { this.dropped += count; return; }
      if (n < count) this.dropped += count - n;
      mesh.data.set(n === count ? arr : arr.subarray(0, n * IF), mesh.n * IF);
      mesh.n += n;
    },

    /* ------------------------------------------------------------- helpers
     * Every helper takes COURT coordinates (x length, y width, z height) and
     * converts to GL space (x, z, y) internally.
     */

    /** Rounded limb/tube from one world point to another. */
    limb(x0, y0, z0, x1, y1, z1, radius, color, gloss, blend) {
      const a = this._a, b = this._b;
      a[0] = x0; a[1] = z0; a[2] = y0;
      b[0] = x1; b[1] = z1; b[2] = y1;
      M4.fromSegment(this._m, a, b, radius);
      this.push(blend ? this.meshes.segT : this.meshes.seg, this._m, color, gloss, 0,
                blend ? color[3] : 1);
    },

    /**
     * Anatomical limb: a tube whose radius walks from `r0` at the first point
     * to `r1` at the second. Real limbs are never uniform — a thigh is widest
     * at the hip and narrowest at the knee, a calf bulges below the knee and
     * collapses into the ankle — and that changing silhouette is most of what
     * separates a body from a stack of pipes.
     */
    bone(x0, y0, z0, x1, y1, z1, r0, r1, color, gloss) {
      const a = this._a, b = this._b;
      a[0] = x0; a[1] = z0; a[2] = y0;
      b[0] = x1; b[1] = z1; b[2] = y1;
      M4.fromSegment(this._m, a, b, r0);
      this.push(this.meshes.seg, this._m, color, gloss, 0, 1, r0 < 1e-5 ? 1 : r1 / r0);
    },

    /**
     * Tapered limb with an elliptical cross-section — the torso, the shorts,
     * the pelvis. A chest is about twice as wide as it is deep, and drawing it
     * as a round tube is what makes a figure read as a snowman.
     *
     * @param {number} r0 half-WIDTH at the first point (across the body)
     * @param {number} r1 half-width at the second point
     * @param {number} depth front-to-back half-thickness as a fraction of the
     *        width, 1 being a circular section
     * @param {number} rx,ry the body's right axis in court space, which is the
     *        direction the wide part of the ellipse points
     */
    trunk(x0, y0, z0, x1, y1, z1, r0, r1, depth, rx, ry, color, gloss) {
      const a = this._a, b = this._b, r = this._r;
      a[0] = x0; a[1] = z0; a[2] = y0;
      b[0] = x1; b[1] = z1; b[2] = y1;
      r[0] = rx; r[1] = 0; r[2] = ry;
      M4.fromSegment(this._m, a, b, r0, r0 * depth, r);
      this.push(this.meshes.seg, this._m, color, gloss, 0, 1, r0 < 1e-5 ? 1 : r1 / r0);
    },

    /** Flat-capped cylinder between two points (poles, stanchions, railings). */
    tube(x0, y0, z0, x1, y1, z1, radius, color, gloss) {
      const a = this._a, b = this._b;
      a[0] = x0; a[1] = z0; a[2] = y0;
      b[0] = x1; b[1] = z1; b[2] = y1;
      M4.fromSegment(this._m, a, b, radius);
      this.push(this.meshes.cyl, this._m, color, gloss, 0, 1);
    },

    /** Sphere centred on a world point. */
    sphere(x, y, z, radius, color, gloss, emissive, blend) {
      M4.fromBox(this._m, x, z, y, radius * 2, radius * 2, radius * 2);
      this.push(blend ? this.meshes.sphereT : this.meshes.sphere, this._m, color,
                gloss, emissive, blend ? color[3] : 1);
    },

    /**
     * Yaw-rotated ellipsoid — same signature as box(), different primitive.
     * A head is taller than it is deep and deeper than it is wide, so a plain
     * sphere is the one shape it should never be.
     *
     * @param {number} sx size across court x, sy across court y, sz in height
     */
    blob(x, y, z, sx, sy, sz, yaw, color, gloss) {
      if (yaw) M4.fromYRot(this._m, x, z, y, -yaw, sx, sz, sy);
      else M4.fromBox(this._m, x, z, y, sx, sz, sy);
      this.push(this.meshes.sphere, this._m, color, gloss, 0, 1);
    },

    /**
     * Axis-aligned or yaw-rotated box.
     * @param {number} sx size along court x, {number} sy along court y,
     *        {number} sz along height
     */
    box(x, y, z, sx, sy, sz, yaw, color, gloss, emissive, blend) {
      if (yaw) M4.fromYRot(this._m, x, z, y, -yaw, sx, sz, sy);
      else M4.fromBox(this._m, x, z, y, sx, sz, sy);
      this.push(blend ? this.meshes.boxT : this.meshes.box, this._m, color,
                gloss, emissive, blend ? color[3] : 1);
    },

    /**
     * Horizontal ring (the rim). Lies flat at height z.
     * @param {number} [flat=1] vertical squash — a rim is round in section, a
     *        marker painted on the floor wants to be nearly flat.
     */
    ring(x, y, z, outerR, color, gloss, flat) {
      const h = outerR * 2 * (flat == null ? 1 : flat);
      M4.fromBox(this._m, x, z, y, outerR * 2, h, outerR * 2);
      this.push(this.meshes.torus, this._m, color, gloss, 0, 1);
    },

    /**
     * Flat panel standing vertically, facing along court x (the backboard).
     * @param {number} halfW half width across court y
     * @param {number} halfH half height
     */
    panel(x, y, z, halfW, halfH, color, alpha) {
      // Geo.panel faces +Z in GL space, which is +y in court space. Rotating
      // 90 degrees about GL Y turns it to face along court x.
      M4.fromYRot(this._m, x, z, y, Math.PI * 0.5, halfW * 2, halfH * 2, 1);
      this.push(this.meshes.panelT, this._m, color, 0.9, 0, alpha == null ? 1 : alpha);
    },

    /** Soft contact shadow on the floor. */
    shadow(x, y, radius, alpha) {
      M4.fromBox(this._m, x, 0.02, y, radius * 2, 1, radius * 2);
      this.push(this.meshes.shadow, this._m, SHADOW_COL, 0, 0, alpha);
    },

    /** The textured court floor. Submitted once per frame by court.js. */
    floor(cx, cy, w, d, tex) {
      M4.fromBox(this._m, cx, 0, cy, w, 1, d);
      this._floorTex = tex;
      this.push(this.meshes.floor, this._m, WHITE, 0, 0, 1);
    },

    /* ------------------------------------------------------------------ draw */
    flush() {
      const GLX = BB.GLX, gl = GLX.gl;
      const m = this.meshes;

      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);

      /* --- floor first: it is the depth foundation everything else sits on */
      if (m.floor.n > 0 && this._floorTex) {
        gl.useProgram(this.progFloor.prog);
        this._setCommon(this.progFloor);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._floorTex);
        gl.uniform1i(this.progFloor.u.u_tex, 0);
        GLX.drawMesh(m.floor);
      }

      /* --- opaque solids */
      gl.useProgram(this.progSolid.prog);
      this._setCommon(this.progSolid);
      GLX.drawMesh(m.box);
      this._setShape(this.progSolid, 1);   // crowd bob
      GLX.drawMesh(m.crowd);
      this._setShape(this.progSolid, 0);
      GLX.drawMesh(m.sphere);
      this._setShape(this.progSolid, 2);   // limb taper
      GLX.drawMesh(m.seg);
      this._setShape(this.progSolid, 0);
      GLX.drawMesh(m.cyl);
      GLX.drawMesh(m.torus);
      GLX.drawMesh(m.quad);

      /* --- contact shadows: blended, depth-tested, no depth write */
      gl.enable(gl.BLEND);
      gl.depthMask(false);
      if (m.shadow.n > 0) {
        gl.useProgram(this.progShadow.prog);
        this._setCommon(this.progShadow);
        GLX.drawMesh(m.shadow);
      }

      /* --- transparent solids (glass, net, ghosted markers) */
      gl.useProgram(this.progSolid.prog);
      this._setCommon(this.progSolid);
      gl.disable(gl.CULL_FACE);
      GLX.drawMesh(m.panelT);
      this._setShape(this.progSolid, 2);
      GLX.drawMesh(m.segT);
      this._setShape(this.progSolid, 0);
      GLX.drawMesh(m.boxT);
      GLX.drawMesh(m.sphereT);
      GLX.drawMesh(m.cylT);
      gl.enable(gl.CULL_FACE);

      gl.depthMask(true);
      gl.disable(gl.BLEND);
    },

    /** Switches what the shared a_params.w attribute means for the next draw. */
    _setShape(p, mode) {
      if (p.u.u_shapeMode) BB.GLX.gl.uniform1f(p.u.u_shapeMode, mode);
    },

    _setCommon(p) {
      const gl = BB.GLX.gl;
      this._setShape(p, 0);
      if (p.u.u_viewProj) gl.uniformMatrix4fv(p.u.u_viewProj, false, this._viewProj);
      if (p.u.u_eye) gl.uniform3fv(p.u.u_eye, this._eye);
      if (p.u.u_time) gl.uniform1f(p.u.u_time, this._time);
      if (p.u.u_lightDir) gl.uniform3fv(p.u.u_lightDir, LIGHT_DIR);
      if (p.u.u_fogColor) gl.uniform3fv(p.u.u_fogColor, FOG_COLOR);
      if (p.u.u_fogDensity) gl.uniform1f(p.u.u_fogDensity, FOG_DENSITY);
    }
  };

  /* Key light comes from high above the far sideline, angled down the court —
   * the same direction the old 2D build implied with its drop shadows. */
  const LIGHT_DIR = new Float32Array([0.32, 0.88, -0.35]);
  const FOG_COLOR = new Float32Array([0.031, 0.043, 0.066]);
  const FOG_DENSITY = 0.0035;
  const SHADOW_COL = [0, 0, 0, 1];
  const WHITE = [1, 1, 1, 1];

  S3.LIGHT_DIR = LIGHT_DIR;
  BB.S3 = S3;
})(typeof window !== 'undefined' ? window : globalThis);
