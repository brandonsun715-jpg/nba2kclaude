/* =============================================================================
 * glx.js  —  Thin WebGL2 wrapper.
 * -----------------------------------------------------------------------------
 * Deliberately small: program compilation, static meshes, instanced draw
 * buffers and canvas-sourced textures. No scene graph, no material system, no
 * abstraction that hides what the GPU is actually doing.
 *
 * Attribute layout is fixed across every shader in the project so a single
 * vertex array object can be reused by any program:
 *   0  vec3  a_pos       per vertex
 *   1  vec3  a_normal    per vertex
 *   2  vec2  a_uv        per vertex
 *   3  vec4  a_model0    per instance  (model matrix column 0)
 *   4  vec4  a_model1    per instance
 *   5  vec4  a_model2    per instance
 *   6  vec4  a_model3    per instance
 *   7  vec4  a_color     per instance  (rgb + alpha)
 *   8  vec4  a_params    per instance  (gloss, emissive, seed, spare)
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});

  /* Instance stride in floats: 16 matrix + 4 colour + 4 params. */
  const INSTANCE_FLOATS = 24;

  /* This module loads before core/utils.js, so it cannot reach BB.U. */
  function U_clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  const GLX = {
    gl: null,
    canvas: null,
    INSTANCE_FLOATS,

    /** @returns {boolean} false when WebGL2 is unavailable. */
    init(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: true,
        depth: true,
        stencil: false,
        powerPreference: 'high-performance',
        // Normally false: letting the browser discard the buffer after
        // compositing is faster. Headless capture tooling sets __HW_CAPTURE so
        // a frame rendered outside the animation loop survives long enough to
        // be screenshotted.
        preserveDrawingBuffer: !!global.__HW_CAPTURE
      });
      if (!gl) return false;
      this.gl = gl;

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(gl.CCW);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0.031, 0.043, 0.066, 1);
      return true;
    },

    /* -------------------------------------------------------------- shaders */
    compile(type, src) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('shader compile failed: ' + log + '\n' + src);
      }
      return sh;
    },

    /**
     * Links a program and caches every active uniform location on it, so call
     * sites can do `prog.u.u_view` with no per-frame lookups.
     */
    program(vsSrc, fsSrc) {
      const gl = this.gl;
      const vs = this.compile(gl.VERTEX_SHADER, vsSrc);
      const fs = this.compile(gl.FRAGMENT_SHADER, fsSrc);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error('program link failed: ' + log);
      }

      const u = Object.create(null);
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        // Array uniforms report as "name[0]"; store under the bare name too.
        const name = info.name.replace(/\[0\]$/, '');
        u[name] = gl.getUniformLocation(p, info.name);
      }
      return { prog: p, u };
    },

    /* --------------------------------------------------------------- meshes */
    /**
     * Uploads interleaved vertex data (pos3, normal3, uv2) plus indices and
     * builds a VAO wired for instanced drawing.
     *
     * @param {object} data {positions: number[], normals: number[], uvs: number[], indices: number[]}
     * @param {number} capacity max simultaneous instances of this mesh
     */
    mesh(data, capacity) {
      const gl = this.gl;
      const count = data.positions.length / 3;
      const inter = new Float32Array(count * 8);
      for (let i = 0; i < count; i++) {
        inter[i * 8]     = data.positions[i * 3];
        inter[i * 8 + 1] = data.positions[i * 3 + 1];
        inter[i * 8 + 2] = data.positions[i * 3 + 2];
        inter[i * 8 + 3] = data.normals[i * 3];
        inter[i * 8 + 4] = data.normals[i * 3 + 1];
        inter[i * 8 + 5] = data.normals[i * 3 + 2];
        inter[i * 8 + 6] = data.uvs ? data.uvs[i * 2] : 0;
        inter[i * 8 + 7] = data.uvs ? data.uvs[i * 2 + 1] : 0;
      }

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
      const stride = 8 * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);

      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(data.indices), gl.STATIC_DRAW);

      const cap = capacity || 256;
      const ibuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
      gl.bufferData(gl.ARRAY_BUFFER, cap * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
      const istride = INSTANCE_FLOATS * 4;
      for (let i = 0; i < 6; i++) {
        const loc = 3 + i;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, istride, i * 16);
        gl.vertexAttribDivisor(loc, 1);
      }

      gl.bindVertexArray(null);

      return {
        vao,
        ibuf,
        indexCount: data.indices.length,
        capacity: cap,
        /* CPU-side staging array, refilled every frame by scene3d.js. */
        data: new Float32Array(cap * INSTANCE_FLOATS),
        n: 0
      };
    },

    /** Uploads `mesh.n` instances and issues one instanced draw. */
    drawMesh(mesh) {
      if (mesh.n === 0) return;
      const gl = this.gl;
      gl.bindVertexArray(mesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.ibuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.data, 0, mesh.n * INSTANCE_FLOATS);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0, mesh.n);
      gl.bindVertexArray(null);
    },

    /* ------------------------------------------------------------- textures */
    /**
     * Uploads a 2D canvas as a mipmapped texture. Used for the baked hardwood
     * floor, which is drawn once with the existing Canvas2D court art and then
     * lives on the GPU for the rest of the session.
     */
    textureFromCanvas(src, tex) {
      const gl = this.gl;
      tex = tex || gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Anisotropy matters enormously here: the floor is viewed at a very
      // shallow angle, and without it the court lines dissolve into mush a
      // third of the way up the screen.
      const ext = gl.getExtension('EXT_texture_filter_anisotropic');
      if (ext) {
        const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max));
      }

      // Cap the mip chain — always, not just when anisotropy is missing.
      //
      // A grazing view of a 94-foot floor produces a texture-footprint ratio
      // far past the 16:1 anisotropy hardware actually delivers, and past that
      // limit it falls back to a high mip level anyway. The top of this chain
      // is the average of the whole image, which is mostly the near-black
      // apron, so the floor turns into a flat dark sheet with a hard edge
      // where the ratio crosses the limit — and that edge sweeps across the
      // court as the camera moves, which reads as the floor flickering.
      //
      // Capping so the smallest level still has a few hundred pixels along its
      // long edge keeps the maple looking like maple at any angle. This has to
      // apply on every GPU: the extension is present almost everywhere, which
      // is exactly why guarding it behind a missing-extension fallback meant
      // the cap never ran.
      const longEdge = Math.max(src.width || 0, src.height || 0);
      const level = U_clamp(Math.floor(Math.log2(Math.max(1, longEdge) / 256)), 2, 6);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level);

      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    },

    /** Parses '#rrggbb' or 'rgba(r,g,b,a)' into a 4-float array 0..1. */
    color(css, out) {
      out = out || [0, 0, 0, 1];
      if (typeof css !== 'string') { out[0] = out[1] = out[2] = 1; out[3] = 1; return out; }
      if (css.charCodeAt(0) === 35) {
        let hex = css.slice(1);
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        const n = parseInt(hex, 16);
        out[0] = ((n >> 16) & 255) / 255;
        out[1] = ((n >> 8) & 255) / 255;
        out[2] = (n & 255) / 255;
        out[3] = 1;
        return out;
      }
      const m = css.match(/-?[\d.]+/g);
      if (m && m.length >= 3) {
        out[0] = +m[0] / 255; out[1] = +m[1] / 255; out[2] = +m[2] / 255;
        out[3] = m.length > 3 ? +m[3] : 1;
      }
      return out;
    }
  };

  BB.GLX = GLX;
})(typeof window !== 'undefined' ? window : globalThis);
