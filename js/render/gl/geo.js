/* =============================================================================
 * geo.js  —  Procedural primitive geometry.
 * -----------------------------------------------------------------------------
 * There are no model files in this project, so every solid on screen is built
 * from one of five unit primitives placed by a model matrix. All primitives are
 * centred on the origin and normalised so that a scale of (w, h, d) produces a
 * shape exactly that size:
 *
 *   box      1 x 1 x 1 cube
 *   sphere   diameter 1
 *   segment  a rounded-end "limb": diameter 1 across X/Z, length 1 along Y
 *   cylinder flat-capped, diameter 1, height 1 along Y
 *   torus    outer diameter 1, lying in the X/Z plane
 *   quad     1 x 1 in the X/Z plane, facing +Y, uv 0..1
 *
 * Segment is the one that does the heavy lifting — every limb, rim tube, net
 * strand and railing is a segment placed with M4.fromSegment().
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});

  function emptyData() {
    return { positions: [], normals: [], uvs: [], indices: [] };
  }

  /* -------------------------------------------------------------------- box */
  function box() {
    const d = emptyData();
    // face definitions: normal, then the four corners in CCW winding
    const faces = [
      [[0, 0, 1], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
      [[0, 0, -1], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]],
      [[1, 0, 0], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]],
      [[-1, 0, 0], [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]],
      [[0, 1, 0], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]],
      [[0, -1, 0], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]]
    ];
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const f of faces) {
      const base = d.positions.length / 3;
      for (let i = 0; i < 4; i++) {
        d.positions.push(f[i + 1][0], f[i + 1][1], f[i + 1][2]);
        d.normals.push(f[0][0], f[0][1], f[0][2]);
        d.uvs.push(uv[i][0], uv[i][1]);
      }
      d.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return d;
  }

  /* ----------------------------------------------------------------- sphere */
  function sphere(seg, rings) {
    seg = seg || 14; rings = rings || 10;
    const d = emptyData();
    for (let r = 0; r <= rings; r++) {
      const v = r / rings;
      // phi runs from PI to 0 so y increases with the ring index; that keeps
      // the triangle winding counter-clockwise when seen from outside.
      const phi = (1.0 - v) * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let s = 0; s <= seg; s++) {
        const u = s / seg;
        const th = u * Math.PI * 2;
        const nx = sp * Math.cos(th), ny = cp, nz = sp * Math.sin(th);
        d.positions.push(nx * 0.5, ny * 0.5, nz * 0.5);
        d.normals.push(nx, ny, nz);
        d.uvs.push(u, v);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < seg; s++) {
        const a = r * (seg + 1) + s;
        const b = a + seg + 1;
        d.indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return d;
  }

  /* ---------------------------------------------------------------- segment
   * A lathed profile whose radius falls to zero at both ends following a
   * quartic superellipse. That gives a limb with slightly bulged middle and
   * rounded caps in a single closed mesh — no separate end spheres, no seams,
   * and it survives the non-uniform scaling that fromSegment() applies.
   */
  function segment(seg, rings) {
    seg = seg || 12; rings = rings || 10;
    const d = emptyData();
    for (let r = 0; r <= rings; r++) {
      const v = r / rings;
      const y = v - 0.5;
      const t = Math.min(1, Math.abs(y) * 2);
      const rad = 0.5 * Math.pow(Math.max(0, 1 - t * t * t * t), 0.25);
      // Slope of the profile, used to tilt the normal so lighting reads round.
      const dt = 0.001;
      const t2 = Math.min(1, Math.abs(y + dt) * 2);
      const rad2 = 0.5 * Math.pow(Math.max(0, 1 - t2 * t2 * t2 * t2), 0.25);
      const slope = (rad2 - rad) / dt;

      for (let s = 0; s <= seg; s++) {
        const u = s / seg;
        const th = u * Math.PI * 2;
        const cx = Math.cos(th), cz = Math.sin(th);
        d.positions.push(cx * rad, y, cz * rad);
        const nl = Math.hypot(1, slope);
        d.normals.push(cx / nl, -slope / nl, cz / nl);
        d.uvs.push(u, v);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < seg; s++) {
        const a = r * (seg + 1) + s;
        const b = a + seg + 1;
        d.indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return d;
  }

  /* --------------------------------------------------------------- cylinder */
  function cylinder(seg) {
    seg = seg || 16;
    const d = emptyData();
    /* side wall */
    for (let s = 0; s <= seg; s++) {
      const u = s / seg, th = u * Math.PI * 2;
      const cx = Math.cos(th), cz = Math.sin(th);
      d.positions.push(cx * 0.5, -0.5, cz * 0.5);
      d.normals.push(cx, 0, cz);
      d.uvs.push(u, 0);
      d.positions.push(cx * 0.5, 0.5, cz * 0.5);
      d.normals.push(cx, 0, cz);
      d.uvs.push(u, 1);
    }
    for (let s = 0; s < seg; s++) {
      const a = s * 2;
      d.indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    /* caps */
    for (const dir of [1, -1]) {
      const base = d.positions.length / 3;
      d.positions.push(0, dir * 0.5, 0);
      d.normals.push(0, dir, 0);
      d.uvs.push(0.5, 0.5);
      for (let s = 0; s <= seg; s++) {
        const th = (s / seg) * Math.PI * 2;
        const cx = Math.cos(th), cz = Math.sin(th);
        d.positions.push(cx * 0.5, dir * 0.5, cz * 0.5);
        d.normals.push(0, dir, 0);
        d.uvs.push(cx * 0.5 + 0.5, cz * 0.5 + 0.5);
      }
      for (let s = 0; s < seg; s++) {
        if (dir > 0) d.indices.push(base, base + 2 + s, base + 1 + s);
        else d.indices.push(base, base + 1 + s, base + 2 + s);
      }
    }
    return d;
  }

  /* ------------------------------------------------------------------ torus
   * Outer diameter 1 in the X/Z plane. `tube` is the minor radius expressed as
   * a fraction of the outer radius, so the rim's real proportions
   * (RIM_TUBE / RIM_RADIUS) map straight onto it.
   */
  function torus(tube, major, minor) {
    major = major || 28; minor = minor || 8;
    const R = 0.5 - tube * 0.5;
    const r = tube * 0.5;
    const d = emptyData();
    for (let i = 0; i <= major; i++) {
      const u = i / major, th = u * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      for (let j = 0; j <= minor; j++) {
        const v = j / minor, ph = v * Math.PI * 2;
        const cp = Math.cos(ph), sp = Math.sin(ph);
        d.positions.push((R + r * cp) * ct, r * sp, (R + r * cp) * st);
        d.normals.push(cp * ct, sp, cp * st);
        d.uvs.push(u, v);
      }
    }
    for (let i = 0; i < major; i++) {
      for (let j = 0; j < minor; j++) {
        const a = i * (minor + 1) + j;
        const b = a + minor + 1;
        d.indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    return d;
  }

  /* ------------------------------------------------------------------- quad
   * Lies flat in X/Z facing +Y. Used for the floor, blob shadows and any
   * billboard the renderer orients itself.
   */
  function quad() {
    return {
      positions: [-0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, -0.5],
      normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
      uvs: [0, 1, 1, 1, 1, 0, 0, 0],
      indices: [0, 1, 2, 0, 2, 3]
    };
  }

  /* --------------------------------------------------------------- vertical
   * A quad standing in the X/Y plane facing +Z — for the backboard glass and
   * any other flat panel that isn't on the floor.
   */
  function panel() {
    return {
      positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      indices: [0, 1, 2, 0, 2, 3]
    };
  }

  BB.Geo = { box, sphere, segment, cylinder, torus, quad, panel };
})(typeof window !== 'undefined' ? window : globalThis);
