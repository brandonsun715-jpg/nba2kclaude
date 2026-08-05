/* =============================================================================
 * skin.js  —  The skinned player mesh.
 * -----------------------------------------------------------------------------
 * Everything else in this renderer is an instanced primitive placed by a model
 * matrix. A character mesh cannot work that way: its vertices have to follow a
 * skeleton, so it needs its own vertex format (bone indices and a weight), its
 * own program (a bone-matrix palette per draw) and its own draw call per
 * player. That is what this module is.
 *
 * The mesh and its bind-pose skeleton are baked by tools/rig_model.js and
 * arrive as BB.PLAYER_MESH. Nothing here knows how a player moves — player.js
 * fills a palette from the same IK solve that used to place primitives, and
 * hands it over.
 *
 * Bone matrices are built from segment to segment. Each bone knows where it
 * lies in the bind pose and where the solver has put it now; the transform
 * between those two segments is a rotation, a stretch along the bone's own
 * length and a translation. Orientation around the bone is pinned by a
 * reference direction rather than taken as the shortest rotation, because the
 * shortest rotation is undefined exactly when an arm swings from hanging at
 * the hip to reaching overhead — which is every jump shot.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});

  const MAX_BONES = 24;

  const SKIN_VS = `#version 300 es
  layout(location=0) in vec3 a_pos;
  layout(location=1) in vec3 a_normal;
  layout(location=2) in vec2 a_bone;    // two bone indices
  layout(location=3) in vec2 a_weight;  // weight of the first, material zone

  uniform mat4 u_viewProj;
  uniform mat4 u_bones[${MAX_BONES}];
  uniform mat3 u_boneNormals[${MAX_BONES}];
  uniform vec4 u_zoneColor[6];
  uniform vec2 u_zoneSurface[6];   // gloss, emissive

  out vec3 v_world;
  out vec3 v_normal;
  out vec2 v_uv;
  out vec4 v_color;
  out vec4 v_params;

  void main() {
    int b0 = int(a_bone.x + 0.5);
    int b1 = int(a_bone.y + 0.5);
    float w0 = a_weight.x;

    // Linear blend skinning across two bones. Two is enough for a figure this
    // size: only vertices actually near a joint carry a second weight at all.
    vec4 p = vec4(a_pos, 1.0);
    vec3 world = (u_bones[b0] * p).xyz * w0 + (u_bones[b1] * p).xyz * (1.0 - w0);
    vec3 nrm = normalize(u_boneNormals[b0] * a_normal * w0
                       + u_boneNormals[b1] * a_normal * (1.0 - w0));

    int zone = int(a_weight.y + 0.5);
    v_world = world;
    v_normal = nrm;
    v_uv = vec2(0.0);
    v_color = u_zoneColor[zone];
    v_params = vec4(u_zoneSurface[zone], 0.0, 0.0);
    gl_Position = u_viewProj * vec4(world, 1.0);
  }`;

  const Skin = {
    ready: false,
    prog: null,
    vao: null,
    indexCount: 0,
    indexType: 0,
    bones: null,          // bone name -> palette slot
    bind: null,           // bone name -> [head, tail] in model units
    height: 1,            // model stature, in model units

    /** A pose is one player's worth of palette. Callers pool these. */
    newPose() {
      return {
        pal: new Float32Array(MAX_BONES * 16),
        nrm: new Float32Array(MAX_BONES * 9),
        zc: new Float32Array(6 * 4),
        zs: new Float32Array(6 * 2)
      };
    },

    /**
     * @param {string} fragSrc the scene's solid fragment shader, reused verbatim
     *        so a skinned player lights identically to everything around it.
     * @returns {boolean} false when no baked mesh is present.
     */
    init(fragSrc) {
      const GLX = BB.GLX, gl = GLX.gl;
      const M = BB.PLAYER_MESH;
      if (!M) return false;

      this.prog = GLX.program(SKIN_VS, fragSrc);

      const n = M.vertexCount;
      const qp = bytes(M.buffers.pos);
      const qn = bytes(M.buffers.nrm);
      const qs = bytes(M.buffers.skin);
      const lo = M.bounds.lo, ext = M.bounds.ext;

      // Interleave into one buffer: pos3, normal3, bone2, weight+zone2.
      const inter = new Float32Array(n * 10);
      for (let i = 0; i < n; i++) {
        const o = i * 10;
        for (let k = 0; k < 3; k++) {
          const q = qp[i * 6 + k * 2] | (qp[i * 6 + k * 2 + 1] << 8);
          inter[o + k] = lo[k] + (q / 65535) * ext[k];
        }
        for (let k = 0; k < 3; k++) {
          const b = qn[i * 3 + k];
          inter[o + 3 + k] = (b > 127 ? b - 256 : b) / 127;
        }
        inter[o + 6] = qs[i * 4];
        inter[o + 7] = qs[i * 4 + 1];
        inter[o + 8] = qs[i * 4 + 2] / 255;
        inter[o + 9] = qs[i * 4 + 3];
      }

      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);

      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
      const stride = 10 * 4;
      const attr = [[0, 3, 0], [1, 3, 12], [2, 2, 24], [3, 2, 32]];
      for (const [loc, size, off] of attr) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
      }

      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      const raw = bytes(M.buffers.idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, raw, gl.STATIC_DRAW);
      this.indexType = M.wideIndex ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      this.indexCount = M.triCount * 3;

      gl.bindVertexArray(null);

      this.bones = {};
      M.bones.forEach((b, i) => { this.bones[b] = i; });
      this.bind = M.bind;
      this.height = M.height;
      this.boneCount = M.bones.length;
      this.ready = true;
      return true;
    },

    /* ------------------------------------------------------------ palette */

    /** Clears the palette to identity so an unset bone cannot fling geometry. */
    beginPose(pose) {
      const p = pose.pal, q = pose.nrm;
      for (let i = 0; i < this.boneCount; i++) {
        const o = i * 16;
        for (let k = 0; k < 16; k++) p[o + k] = 0;
        p[o] = p[o + 5] = p[o + 10] = p[o + 15] = 1;
        const m = i * 9;
        for (let k = 0; k < 9; k++) q[m + k] = 0;
        q[m] = q[m + 4] = q[m + 8] = 1;
      }
    },

    /**
     * Sets one bone from where it is in the bind pose to where it is now.
     *
     * @param {object} pose palette from newPose()
     * @param {string} name bone name from the baked skeleton
     * @param {number[]} ca current head, COURT feet (x length, y width, z up)
     * @param {number[]} cb current tail
     * @param {number[]} ref current reference direction — the player's forward
     *        axis — which pins rotation about the bone's own length
     * @param {number} g model units to world feet
     */
    setBone(pose, name, ca, cb, ref, g) {
      const slot = this.bones[name];
      if (slot === undefined) return;
      const seg = this.bind[name];
      const ba = seg[0], bb = seg[1];

      // Bind frame. The model stands with -y forward, so that is its reference.
      const ub = unit(bb[0] - ba[0], bb[1] - ba[1], bb[2] - ba[2], V0);
      const bindLen = V0.len;
      const xb = ortho(0, -1, 0, ub, V1);
      const zb = cross(ub, xb, V2);

      // Current frame, in court space.
      const uc = unit(cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2], V3);
      const curLen = V3.len;
      const xc = ortho(ref[0], ref[1], ref[2], uc, V4);
      const zc = cross(uc, xc, V5);

      // Stretch along the bone so the mesh spans exactly what the solver asked
      // for, while girth keeps the uniform body scale.
      const r = bindLen > 1e-9 ? curLen / (bindLen * g) : 1;

      // A = g * (xc(x)xb) + g*r * (uc(x)ub) + g * (zc(x)zb)
      const A = MAT;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          A[i * 3 + j] = g * (xc[i] * xb[j] + r * uc[i] * ub[j] + zc[i] * zb[j]);
        }
      }
      // Normals ignore the along-bone stretch: with that removed the transform
      // is a rotation and a uniform scale, whose inverse-transpose is itself.
      const N = NMAT;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          N[i * 3 + j] = xc[i] * xb[j] + uc[i] * ub[j] + zc[i] * zb[j];
        }
      }

      const tx = ca[0] - (A[0] * ba[0] + A[1] * ba[1] + A[2] * ba[2]);
      const ty = ca[1] - (A[3] * ba[0] + A[4] * ba[1] + A[5] * ba[2]);
      const tz = ca[2] - (A[6] * ba[0] + A[7] * ba[1] + A[8] * ba[2]);

      /* Write column-major, swizzling court (x, y, z-up) into GL (x, y-up, z),
       * which is the space every other matrix in this renderer already ends in.
       * Court row 2 becomes GL row 1 and court row 1 becomes GL row 2. */
      const p = pose.pal, o = slot * 16;
      p[o] = A[0]; p[o + 1] = A[6]; p[o + 2] = A[3]; p[o + 3] = 0;
      p[o + 4] = A[1]; p[o + 5] = A[7]; p[o + 6] = A[4]; p[o + 7] = 0;
      p[o + 8] = A[2]; p[o + 9] = A[8]; p[o + 10] = A[5]; p[o + 11] = 0;
      p[o + 12] = tx; p[o + 13] = tz; p[o + 14] = ty; p[o + 15] = 1;

      const q = pose.nrm, m = slot * 9;
      q[m] = N[0]; q[m + 1] = N[6]; q[m + 2] = N[3];
      q[m + 3] = N[1]; q[m + 4] = N[7]; q[m + 5] = N[4];
      q[m + 6] = N[2]; q[m + 7] = N[8]; q[m + 8] = N[5];
    },

    /** @param {number[][]} zones six [r,g,b,a,gloss,emissive] rows */
    setZones(pose, zones) {
      const zc = pose.zc, zs = pose.zs;
      for (let i = 0; i < 6; i++) {
        const z = zones[i] || zones[0];
        zc[i * 4] = z[0]; zc[i * 4 + 1] = z[1]; zc[i * 4 + 2] = z[2];
        zc[i * 4 + 3] = z[3] == null ? 1 : z[3];
        zs[i * 2] = z[4] || 0;
        zs[i * 2 + 1] = z[5] || 0;
      }
    },

    /** One player, one draw call. Assumes the program is already bound. */
    draw(pose) {
      const gl = BB.GLX.gl, u = this.prog.u;
      gl.uniformMatrix4fv(u.u_bones, false, pose.pal.subarray(0, this.boneCount * 16));
      gl.uniformMatrix3fv(u.u_boneNormals, false, pose.nrm.subarray(0, this.boneCount * 9));
      gl.uniform4fv(u.u_zoneColor, pose.zc);
      gl.uniform2fv(u.u_zoneSurface, pose.zs);
      gl.bindVertexArray(this.vao);
      /* Wind the other way for this one draw.
       *
       * Court space is (x length, y width, z up) and GL space is (x, y up, z),
       * and the palette write at the end of setBone moves between them by
       * swapping two axes. Swapping two axes is a REFLECTION, so every bone
       * matrix here carries one, and a reflection reverses the winding of
       * every triangle it moves. Against the renderer's global CCW/cull-back
       * the figure therefore drew INSIDE OUT: the surface facing the camera
       * was culled and what you saw was the inner face of the model's far
       * side.
       *
       * That is one bug wearing three costumes. The player looked like he had
       * his back turned while walking toward you — you were looking at the
       * inside of the back of his head. His shading was dark and blotchy —
       * those normals point away from the light. His shoulders and hips looked
       * torn — that is the inside of a limb seen through the inside of a
       * torso. None of it was the animation, and none of it was the mesh. */
      gl.frontFace(gl.CW);
      gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
      gl.frontFace(gl.CCW);
      gl.bindVertexArray(null);
    }
  };

  /* ------------------------------------------------------------- utilities */

  function bytes(b64) {
    if (typeof global.atob === 'function') {
      const bin = global.atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  function unit(x, y, z, out) {
    const l = Math.hypot(x, y, z) || 1e-9;
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
    out.len = l;
    return out;
  }

  /** Component of (x,y,z) perpendicular to `u`, normalised. */
  function ortho(x, y, z, u, out) {
    const d = x * u[0] + y * u[1] + z * u[2];
    let ax = x - u[0] * d, ay = y - u[1] * d, az = z - u[2] * d;
    if (Math.hypot(ax, ay, az) < 1e-5) {
      // Reference ran along the bone. Any perpendicular will do; pick the one
      // seeded from the axis the bone is least aligned with.
      const bx = Math.abs(u[0]) < 0.9 ? 1 : 0;
      const by = Math.abs(u[0]) < 0.9 ? 0 : 1;
      const d2 = bx * u[0] + by * u[1];
      ax = bx - u[0] * d2; ay = by - u[1] * d2; az = -u[2] * d2;
    }
    return unit(ax, ay, az, out);
  }

  function cross(a, b, out) {
    out[0] = a[1] * b[2] - a[2] * b[1];
    out[1] = a[2] * b[0] - a[0] * b[2];
    out[2] = a[0] * b[1] - a[1] * b[0];
    return out;
  }

  const V0 = new Float64Array(3), V1 = new Float64Array(3), V2 = new Float64Array(3);
  const V3 = new Float64Array(3), V4 = new Float64Array(3), V5 = new Float64Array(3);
  const MAT = new Float64Array(9), NMAT = new Float64Array(9);

  BB.Skin = Skin;
})(typeof window !== 'undefined' ? window : globalThis);
