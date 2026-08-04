/* =============================================================================
 * mat4.js  —  Column-major 4x4 matrix and vec3 math.
 * -----------------------------------------------------------------------------
 * WebGL expects column-major matrices, so every matrix here is a Float32Array
 * of 16 laid out as m[col * 4 + row]. Every function writes into a caller
 * supplied `out` so the render loop never allocates.
 *
 * Coordinate convention for HARDWOOD's 3D renderer:
 *   world  x = baseline to baseline (0..94 ft)
 *   world  y = sideline to sideline (0..50 ft)
 *   world  z = height off the floor
 * GL space uses a right-handed system with +Y up, so the world -> GL swizzle
 * is (x, z, y). That conversion lives in camera.js; everything in this file is
 * pure math and knows nothing about basketball.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});

  /* ------------------------------------------------------------------ vec3 */
  const V3 = {
    create(x, y, z) { return new Float32Array([x || 0, y || 0, z || 0]); },

    set(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; },

    copy(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; },

    add(out, a, b) {
      out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
      return out;
    },

    sub(out, a, b) {
      out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
      return out;
    },

    scale(out, a, s) {
      out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
      return out;
    },

    /** out = a + b * s — the workhorse for building skeleton joint positions. */
    scaleAndAdd(out, a, b, s) {
      out[0] = a[0] + b[0] * s;
      out[1] = a[1] + b[1] * s;
      out[2] = a[2] + b[2] * s;
      return out;
    },

    len(a) { return Math.hypot(a[0], a[1], a[2]); },

    normalize(out, a) {
      const l = Math.hypot(a[0], a[1], a[2]);
      if (l < 1e-8) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
      const inv = 1 / l;
      out[0] = a[0] * inv; out[1] = a[1] * inv; out[2] = a[2] * inv;
      return out;
    },

    cross(out, a, b) {
      const ax = a[0], ay = a[1], az = a[2];
      const bx = b[0], by = b[1], bz = b[2];
      out[0] = ay * bz - az * by;
      out[1] = az * bx - ax * bz;
      out[2] = ax * by - ay * bx;
      return out;
    },

    dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  };

  /* ------------------------------------------------------------------ mat4 */
  const M4 = {
    create() {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },

    identity(out) {
      out.fill(0);
      out[0] = out[5] = out[10] = out[15] = 1;
      return out;
    },

    copy(out, a) { out.set(a); return out; },

    /** out = a * b (apply b first, then a — standard matrix composition). */
    multiply(out, a, b) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

      for (let i = 0; i < 4; i++) {
        const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
        out[i * 4]     = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      }
      return out;
    },

    /**
     * Right-handed perspective projection with a reversed-depth-free, standard
     * [-1, 1] clip range (what WebGL expects).
     * @param {number} fovY vertical field of view in radians
     */
    perspective(out, fovY, aspect, near, far) {
      const f = 1 / Math.tan(fovY * 0.5);
      const nf = 1 / (near - far);
      out.fill(0);
      out[0] = f / aspect;
      out[5] = f;
      out[10] = (far + near) * nf;
      out[11] = -1;
      out[14] = 2 * far * near * nf;
      return out;
    },

    /** Right-handed look-at view matrix. */
    lookAt(out, eye, center, up) {
      let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
      let l = Math.hypot(zx, zy, zz);
      if (l < 1e-8) { zx = 0; zy = 0; zz = 1; l = 1; }
      zx /= l; zy /= l; zz /= l;

      let xx = up[1] * zz - up[2] * zy;
      let xy = up[2] * zx - up[0] * zz;
      let xz = up[0] * zy - up[1] * zx;
      l = Math.hypot(xx, xy, xz);
      if (l < 1e-8) { xx = 1; xy = 0; xz = 0; } else { xx /= l; xy /= l; xz /= l; }

      const yx = zy * xz - zz * xy;
      const yy = zz * xx - zx * xz;
      const yz = zx * xy - zy * xx;

      out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
      out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
      out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
      out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
      out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
      out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
      out[15] = 1;
      return out;
    },

    /**
     * Builds a model matrix that maps the unit primitive (centred at origin,
     * 1 unit across, +Y up) onto a segment running from `a` to `b` with the
     * given radius. This is how every limb, rim tube and net strand is placed:
     * one primitive, one matrix, no per-frame geometry rebuilds.
     *
     * @param {Float32Array} out
     * @param {Float32Array} a start point (GL space)
     * @param {Float32Array} b end point (GL space)
     * @param {number} radius half-thickness across X and Z
     */
    fromSegment(out, a, b, radius) {
      let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      let len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) { dx = 0; dy = 1; dz = 0; len = 1e-6; }
      const uy = [dx / len, dy / len, dz / len];

      // Any vector not parallel to the segment works as the seed for the
      // orthonormal basis; picking the world axis the segment is least
      // aligned with keeps the cross products numerically stable.
      const ax = Math.abs(uy[0]), ay = Math.abs(uy[1]), az = Math.abs(uy[2]);
      let sx = 0, sy = 0, sz = 0;
      if (ax <= ay && ax <= az) sx = 1; else if (ay <= az) sy = 1; else sz = 1;

      let ux = [
        sy * uy[2] - sz * uy[1],
        sz * uy[0] - sx * uy[2],
        sx * uy[1] - sy * uy[0]
      ];
      let l = Math.hypot(ux[0], ux[1], ux[2]);
      ux = [ux[0] / l, ux[1] / l, ux[2] / l];

      const uz = [
        ux[1] * uy[2] - ux[2] * uy[1],
        ux[2] * uy[0] - ux[0] * uy[2],
        ux[0] * uy[1] - ux[1] * uy[0]
      ];

      out[0] = ux[0] * radius * 2; out[1] = ux[1] * radius * 2; out[2] = ux[2] * radius * 2; out[3] = 0;
      out[4] = uy[0] * len;        out[5] = uy[1] * len;        out[6] = uy[2] * len;        out[7] = 0;
      out[8] = uz[0] * radius * 2; out[9] = uz[1] * radius * 2; out[10] = uz[2] * radius * 2; out[11] = 0;
      out[12] = (a[0] + b[0]) * 0.5;
      out[13] = (a[1] + b[1]) * 0.5;
      out[14] = (a[2] + b[2]) * 0.5;
      out[15] = 1;
      return out;
    },

    /** Axis-aligned translate + non-uniform scale. Cheapest common case. */
    fromBox(out, cx, cy, cz, sx, sy, sz) {
      out.fill(0);
      out[0] = sx; out[5] = sy; out[10] = sz;
      out[12] = cx; out[13] = cy; out[14] = cz; out[15] = 1;
      return out;
    },

    /** Translate + uniform scale + rotation about the GL Y axis. */
    fromYRot(out, cx, cy, cz, angle, sx, sy, sz) {
      const c = Math.cos(angle), s = Math.sin(angle);
      out[0] = c * sx;  out[1] = 0;  out[2] = -s * sx; out[3] = 0;
      out[4] = 0;       out[5] = sy; out[6] = 0;       out[7] = 0;
      out[8] = s * sz;  out[9] = 0;  out[10] = c * sz; out[11] = 0;
      out[12] = cx; out[13] = cy; out[14] = cz; out[15] = 1;
      return out;
    },

    /** Transforms a point (w = 1) and returns the clip-space w for divides. */
    transformPoint(out, m, x, y, z) {
      out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      out[3] = m[3] * x + m[7] * y + m[11] * z + m[15];
      return out;
    }
  };

  BB.M4 = M4;
  BB.V3 = V3;
})(typeof window !== 'undefined' ? window : globalThis);
