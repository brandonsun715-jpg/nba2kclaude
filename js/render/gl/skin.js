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

  /* Dual-quaternion skinning.
   *
   * Linear blend skinning averages two bone MATRICES, and the average of two
   * rotations is not a rotation — it is a rotation that has shrunk. At a joint
   * carrying a large relative twist the two matrices partially cancel and the
   * surface collapses toward the bone: the "candy-wrapper" pinch, worst exactly
   * where this game twists hardest, at the shoulder and the hip. Averaging unit
   * dual quaternions instead interpolates a rigid motion as a rigid motion, so
   * the limb sweeps round instead of deflating.
   *
   * Two things do not fit inside a dual quaternion, and both are handled either
   * side of it:
   *
   *   THE STRETCH. setBone scales each bone along its own length so the mesh
   *   spans exactly what the IK asked for. A dual quaternion is rigid and
   *   cannot carry that, so the stretch is applied FIRST, in bind space, and
   *   blended linearly — which is harmless, because scale is not what collapses.
   *
   *   THE AXIS SWAP. Court space is (x, y, z-up) and GL is (x, y-up, z).
   *   Swapping two axes is a REFLECTION, and a quaternion cannot represent one
   *   at all. It stays outside, applied to the finished position, which is also
   *   why the figure still has to be drawn with the winding flipped.
   */
  const SKIN_VS = `#version 300 es
  layout(location=0) in vec3 a_pos;
  layout(location=1) in vec3 a_normal;
  layout(location=2) in vec2 a_bone;    // two bone indices
  layout(location=3) in vec2 a_weight;  // weight of the first, material zone

  uniform mat4 u_viewProj;
  uniform vec4 u_dqReal[${MAX_BONES}];   // rotation, as a unit quaternion
  uniform vec4 u_dqDual[${MAX_BONES}];   // translation, encoded against it
  uniform vec4 u_bindHead[${MAX_BONES}]; // bind head (xyz), stretch factor (w)
  uniform vec4 u_bindAxis[${MAX_BONES}]; // bind bone direction (xyz)
  uniform float u_gscale;                // model units to world feet
  uniform vec4 u_zoneColor[6];
  uniform vec2 u_zoneSurface[6];   // gloss, emissive

  out vec3 v_world;
  out vec3 v_normal;
  out vec2 v_uv;
  out vec4 v_color;
  out vec4 v_params;

  /** Rotate v by the unit quaternion q. */
  vec3 qrot(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  /** One bone's stretch, applied to a bind-space point about that bone's head. */
  vec3 stretched(int b, vec3 p) {
    vec3 head = u_bindHead[b].xyz;
    vec3 axis = u_bindAxis[b].xyz;
    return p + (u_bindHead[b].w - 1.0) * dot(p - head, axis) * axis;
  }

  void main() {
    int b0 = int(a_bone.x + 0.5);
    int b1 = int(a_bone.y + 0.5);
    float w0 = a_weight.x, w1 = 1.0 - w0;

    // 1. The stretch, blended linearly in bind space.
    vec3 y = stretched(b0, a_pos) * w0 + stretched(b1, a_pos) * w1;

    /* 2. The rigid part, blended as dual quaternions.
     *
     * The sign flip is not optional. A rotation and its negation are the same
     * rotation but opposite quaternions, so when the two bones' quaternions
     * land in opposite hemispheres their average passes near zero and the limb
     * turns itself inside out on the way through. Flipping one onto the other's
     * hemisphere first takes the short way round, which is the one a joint
     * actually goes. */
    vec4 r0 = u_dqReal[b0], d0 = u_dqDual[b0];
    vec4 r1 = u_dqReal[b1], d1 = u_dqDual[b1];
    float sign = dot(r0, r1) < 0.0 ? -1.0 : 1.0;
    vec4 qr = r0 * w0 + r1 * (w1 * sign);
    vec4 qd = d0 * w0 + d1 * (w1 * sign);
    float len = length(qr);
    qr /= len; qd /= len;

    vec3 rotated = qrot(qr, y);
    vec3 trans = 2.0 * (qr.w * qd.xyz - qd.w * qr.xyz + cross(qr.xyz, qd.xyz));
    vec3 court = (rotated + trans) * u_gscale;
    vec3 nrm = normalize(qrot(qr, a_normal));

    // 3. Court (x, y, z-up) into GL (x, y-up, z).
    vec3 world = vec3(court.x, court.z, court.y);

    int zone = int(a_weight.y + 0.5);
    v_world = world;
    v_normal = vec3(nrm.x, nrm.z, nrm.y);
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
        real: new Float32Array(MAX_BONES * 4),
        dual: new Float32Array(MAX_BONES * 4),
        // The along-bone stretch, one per bone, paired with the static bind
        // head in the shader's u_bindHead.w.
        str: new Float32Array(MAX_BONES),
        gscale: 1,
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
      this.indexBytes = M.wideIndex ? 4 : 2;

      /* The haircuts live in the same buffer, past the end of the body (see
       * buildHair in tools/rig_model.js). Drawing a figure is therefore the
       * body's index range plus, optionally, one style's. */
      this.bodyIndexCount = M.bodyIndexCount == null ? this.indexCount : M.bodyIndexCount;
      this.hairStyles = M.hairStyles || {};
      this.hairOrder = M.hairOrder || [];
      this.numberGlyphs = M.numberGlyphs || {};

      gl.bindVertexArray(null);

      this.bones = {};
      M.bones.forEach((b, i) => { this.bones[b] = i; });
      this.bind = M.bind;
      this.height = M.height;
      this.boneCount = M.bones.length;

      /* Each bone's bind head and direction. These are properties of the baked
       * mesh and never change, so they are uploaded once here rather than
       * re-sent with every player on every frame. The head's w slot carries the
       * per-frame stretch, which is why this is a vec4. */
      this.bindHead = new Float32Array(MAX_BONES * 4);
      this.bindAxis = new Float32Array(MAX_BONES * 4);
      M.bones.forEach((name, i) => {
        const seg = M.bind[name];
        if (!seg) { this.bindAxis[i * 4 + 2] = 1; return; }
        const a = seg[0], b = seg[1];
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const L = Math.hypot(dx, dy, dz) || 1;
        this.bindHead[i * 4] = a[0]; this.bindHead[i * 4 + 1] = a[1];
        this.bindHead[i * 4 + 2] = a[2]; this.bindHead[i * 4 + 3] = 1;
        this.bindAxis[i * 4] = dx / L; this.bindAxis[i * 4 + 1] = dy / L;
        this.bindAxis[i * 4 + 2] = dz / L;
      });

      this.ready = true;
      return true;
    },

    /* ------------------------------------------------------------ palette */

    /** Clears the palette to identity so an unset bone cannot fling geometry. */
    beginPose(pose) {
      const re = pose.real, du = pose.dual;
      for (let i = 0; i < this.boneCount; i++) {
        const o = i * 4;
        re[o] = re[o + 1] = re[o + 2] = 0; re[o + 3] = 1;   // no rotation
        du[o] = du[o + 1] = du[o + 2] = du[o + 3] = 0;      // no translation
        pose.str[i] = 1;                                    // no stretch
      }
      pose.gscale = 1;
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
      // for, while girth keeps the uniform body scale. Carried separately from
      // the rotation, because a dual quaternion is rigid and cannot hold it.
      const r = bindLen > 1e-9 ? curLen / (bindLen * g) : 1;

      /* The rotation alone, model space to COURT space: R = M_cur * M_bind^T.
       * Both frames are orthonormal triples of the same handedness, so their
       * product is a proper rotation and does have a quaternion. (The court to
       * GL axis swap is the reflection, and the shader keeps it separate.) */
      const N = NMAT;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          N[i * 3 + j] = xc[i] * xb[j] + uc[i] * ub[j] + zc[i] * zb[j];
        }
      }

      // Quaternion from the rotation, via whichever diagonal term is largest —
      // the others lose precision as their own denominator goes to zero.
      let qx, qy, qz, qw;
      const tr = N[0] + N[4] + N[8];
      if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        qw = 0.25 * s; qx = (N[7] - N[5]) / s; qy = (N[2] - N[6]) / s; qz = (N[3] - N[1]) / s;
      } else if (N[0] > N[4] && N[0] > N[8]) {
        const s = Math.sqrt(1 + N[0] - N[4] - N[8]) * 2;
        qw = (N[7] - N[5]) / s; qx = 0.25 * s; qy = (N[1] + N[3]) / s; qz = (N[2] + N[6]) / s;
      } else if (N[4] > N[8]) {
        const s = Math.sqrt(1 + N[4] - N[0] - N[8]) * 2;
        qw = (N[2] - N[6]) / s; qx = (N[1] + N[3]) / s; qy = 0.25 * s; qz = (N[5] + N[7]) / s;
      } else {
        const s = Math.sqrt(1 + N[8] - N[0] - N[4]) * 2;
        qw = (N[3] - N[1]) / s; qx = (N[2] + N[6]) / s; qy = (N[5] + N[7]) / s; qz = 0.25 * s;
      }

      /* The translation that carries the bind head onto the current one, in
       * model-scaled units so the uniform scale can stay out of the palette:
       *   world/g = R*(y - ba) + ca/g   =>   t = ca/g - R*ba
       */
      const tx = ca[0] / g - (N[0] * ba[0] + N[1] * ba[1] + N[2] * ba[2]);
      const ty = ca[1] / g - (N[3] * ba[0] + N[4] * ba[1] + N[5] * ba[2]);
      const tz = ca[2] / g - (N[6] * ba[0] + N[7] * ba[1] + N[8] * ba[2]);

      // Dual part = 0.5 * (0, t) * real.
      const re = pose.real, du = pose.dual, o = slot * 4;
      re[o] = qx; re[o + 1] = qy; re[o + 2] = qz; re[o + 3] = qw;
      du[o] = 0.5 * (tx * qw + ty * qz - tz * qy);
      du[o + 1] = 0.5 * (-tx * qz + ty * qw + tz * qx);
      du[o + 2] = 0.5 * (tx * qy - ty * qx + tz * qw);
      du[o + 3] = 0.5 * (-(tx * qx + ty * qy + tz * qz));
      pose.str[slot] = r;
      pose.gscale = g;
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

    /** One player. Assumes the program is already bound.
     * @param {string} [hairStyle] a key of hairStyles; anything unrecognised
     *   (including 'bald') draws the body alone, leaving the bare scalp. */
    draw(pose, hairStyle) {
      const gl = BB.GLX.gl, u = this.prog.u;
      const n = this.boneCount;
      // The stretch rides in the bind head's spare w slot, so it costs no extra
      // uniform and cannot get out of step with the bone it belongs to.
      for (let i = 0; i < n; i++) this.bindHead[i * 4 + 3] = pose.str[i];
      gl.uniform4fv(u.u_dqReal, pose.real.subarray(0, n * 4));
      gl.uniform4fv(u.u_dqDual, pose.dual.subarray(0, n * 4));
      gl.uniform4fv(u.u_bindHead, this.bindHead.subarray(0, n * 4));
      gl.uniform4fv(u.u_bindAxis, this.bindAxis.subarray(0, n * 4));
      gl.uniform1f(u.u_gscale, pose.gscale);
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
      gl.drawElements(gl.TRIANGLES, this.bodyIndexCount, this.indexType, 0);
      const cut = hairStyle && this.hairStyles[hairStyle];
      if (cut && cut.count) {
        gl.drawElements(gl.TRIANGLES, cut.count, this.indexType, cut.start * this.indexBytes);
      }
      /* The wearer's number, one glyph range per digit. A single-digit number
       * draws only the units slot, so 7 is centred rather than sitting as 07. */
      const num = pose.number;
      if (num != null) {
        const g = this.numberGlyphs;
        const tens = num >= 10 ? g['tens' + Math.floor(num / 10)] : null;
        const units = num >= 10 ? g['units' + (num % 10)] : g['units' + num];
        if (tens && tens.count) {
          gl.drawElements(gl.TRIANGLES, tens.count, this.indexType, tens.start * this.indexBytes);
        }
        if (units && units.count) {
          gl.drawElements(gl.TRIANGLES, units.count, this.indexType, units.start * this.indexBytes);
        }
      }
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
