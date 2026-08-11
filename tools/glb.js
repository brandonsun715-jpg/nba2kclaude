/* =============================================================================
 * glb.js  —  Reads a GLB/glTF humanoid into the shape rig_model.js expects.
 * -----------------------------------------------------------------------------
 * rig_model.js was written against a single OBJ, and its parser returns one
 * flat bag of geometry: {positions, normals, uvs, tris}, with tris holding
 * per-corner [posIdx, uvIdx, normalIdx]. Everything downstream — the skeleton
 * fit, the weighting, the zone tagging — reads only that. So supporting a
 * second source format is a matter of producing the same bag, not of teaching
 * the rest of the tool a new vocabulary.
 *
 * Two things have to be reconciled on the way in, and getting either wrong
 * produces a mesh that looks fine in isolation and is wrong the moment a
 * skeleton is fitted to it:
 *
 *  AXES. glTF is Y-up with -Z forward. The rigger measures stature along z,
 *  assumes the figure stands on z=0, and reads -y as forward. That is a swap
 *  of the two non-vertical axes, which flips handedness, so triangle winding
 *  has to be reversed with it or every face ends up inside-out.
 *
 *  TRANSFORMS. An OBJ is a bare vertex soup already in its final place. A glTF
 *  is a scene graph, and exporters routinely leave the figure under a node
 *  carrying a rotation (the Blender Y-up fix) or a scale (centimetres). Those
 *  have to be composed down the hierarchy and applied, or the model arrives
 *  rotated onto its face at a hundred times the size it claims.
 *
 * Only what a static humanoid needs is supported: triangles, indexed or not,
 * POSITION/NORMAL/TEXCOORD_0, and node transforms. Skins and animations are
 * deliberately ignored — the game rigs the mesh itself, and a bind pose baked
 * in from someone else's skeleton is not something it could use.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* glTF accessor component types, and how many bytes each takes. */
const COMPONENT = {
  5120: { bytes: 1, read: (v, o) => v.getInt8(o) },
  5121: { bytes: 1, read: (v, o) => v.getUint8(o) },
  5122: { bytes: 2, read: (v, o) => v.getInt16(o, true) },
  5123: { bytes: 2, read: (v, o) => v.getUint16(o, true) },
  5125: { bytes: 4, read: (v, o) => v.getUint32(o, true) },
  5126: { bytes: 4, read: (v, o) => v.getFloat32(o, true) }
};
const COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/* ------------------------------------------------------------- the container
 * A .glb is a 12-byte header then a run of length-prefixed chunks: the glTF
 * JSON first, then an optional binary blob the accessors index into. A .gltf
 * is that JSON on its own, with buffers pointing at sibling files or at
 * base64 data: URIs.
 */
function readContainer(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x46546c67) {   // 'glTF'
    const total = buf.readUInt32LE(8);
    let json = null, bin = null, o = 12;
    while (o + 8 <= Math.min(total, buf.length)) {
      const len = buf.readUInt32LE(o);
      const type = buf.readUInt32LE(o + 4);
      const body = buf.subarray(o + 8, o + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));       // 'JSON'
      else if (type === 0x004e4942) bin = body;                                 // 'BIN\0'
      o += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (!json) throw new Error('GLB has no JSON chunk');
    return { json, bin, dir: path.dirname(file) };
  }
  return { json: JSON.parse(buf.toString('utf8')), bin: null, dir: path.dirname(file) };
}

/** Resolve buffer i to raw bytes: the GLB blob, a data: URI, or a sibling file. */
function bufferBytes(g, i) {
  const b = g.json.buffers[i];
  if (b.uri == null) {
    if (!g.bin) throw new Error('buffer ' + i + ' wants the GLB blob, which is missing');
    return g.bin;
  }
  const m = /^data:[^;]*;base64,(.*)$/.exec(b.uri);
  if (m) return Buffer.from(m[1], 'base64');
  return fs.readFileSync(path.resolve(g.dir, decodeURIComponent(b.uri)));
}

/**
 * Read accessor `idx` as an array of tuples.
 *
 * Honours byteStride, because interleaved vertex buffers are the norm out of
 * every real exporter and reading them as if they were tightly packed returns
 * position data with normals and UVs mixed through it.
 */
function readAccessor(g, idx) {
  const acc = g.json.accessors[idx];
  const comp = COMPONENT[acc.componentType];
  if (!comp) throw new Error('unsupported componentType ' + acc.componentType);
  const n = COUNTS[acc.type];
  if (!n) throw new Error('unsupported accessor type ' + acc.type);

  const out = new Array(acc.count);
  if (acc.bufferView == null) {
    // A view-less accessor is defined to be all zeroes (before sparse fixups).
    for (let i = 0; i < acc.count; i++) out[i] = new Array(n).fill(0);
  } else {
    const view = g.json.bufferViews[acc.bufferView];
    const bytes = bufferBytes(g, view.buffer);
    const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const stride = view.byteStride || comp.bytes * n;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < acc.count; i++) {
      const t = new Array(n);
      for (let k = 0; k < n; k++) t[k] = comp.read(dv, base + i * stride + k * comp.bytes);
      out[i] = t;
    }
  }

  /* Sparse accessors override a scattered subset of the values. Rare in a
   * static mesh, but cheap to honour and silently wrong to ignore. */
  if (acc.sparse) {
    const s = acc.sparse;
    const iv = g.json.bufferViews[s.indices.bufferView];
    const ib = bufferBytes(g, iv.buffer);
    const ic = COMPONENT[s.indices.componentType];
    const idv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
    const ibase = (iv.byteOffset || 0) + (s.indices.byteOffset || 0);

    const vv = g.json.bufferViews[s.values.bufferView];
    const vb = bufferBytes(g, vv.buffer);
    const vdv = new DataView(vb.buffer, vb.byteOffset, vb.byteLength);
    const vbase = (vv.byteOffset || 0) + (s.values.byteOffset || 0);

    for (let i = 0; i < s.count; i++) {
      const target = ic.read(idv, ibase + i * ic.bytes);
      const t = new Array(n);
      for (let k = 0; k < n; k++) t[k] = comp.read(vdv, vbase + (i * n + k) * comp.bytes);
      out[target] = t;
    }
  }

  /* Normalised integer attributes are stored scaled to their type's range. */
  if (acc.normalized && acc.componentType !== 5126) {
    const d = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[acc.componentType];
    if (d) for (const t of out) for (let k = 0; k < t.length; k++) t[k] = Math.max(-1, t[k] / d);
  }
  return out;
}

/* ----------------------------------------------------------------- matrices */

function mul(a, b) {                       // column-major, as glTF stores them
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/** A node's local transform, from either an explicit matrix or its TRS parts. */
function localMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];       // quaternion xyzw
  const s = node.scale || [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ];
}

function xformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
}
/** Directions ignore translation. Not the inverse-transpose — see below. */
function xformDir(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2]
  ];
}

/* ------------------------------------------------------------------ reading */

/**
 * Read a GLB/glTF file into rig_model's geometry bag.
 *
 * @param {string} file
 * @param {object} [opt] { yUp: true } to keep glTF's own axes (for round-trip
 *        testing); omitted, the figure is converted to the rigger's Z-up.
 * @returns {{positions:number[][], normals:number[][], uvs:number[][],
 *            tris:Array<Array<[number,number,number]>>, meshes:number}}
 */
function readGlb(file, opt) {
  const g = readContainer(file);
  const json = g.json;
  const convert = !(opt && opt.yUp);

  const positions = [], normals = [], uvs = [], tris = [];

  /* Walk the scene so node transforms compose. Falling back to "every mesh at
   * the origin" when a file has no scene keeps a bare exporter dump usable. */
  const nodes = json.nodes || [];
  const jobs = [];
  const seen = new Set();
  const visit = (ni, parent) => {
    if (seen.has(ni)) return;              // guards a malformed cyclic graph
    seen.add(ni);
    const node = nodes[ni];
    if (!node) return;
    const world = mul(parent, localMatrix(node));
    if (node.mesh != null) jobs.push({ mesh: node.mesh, m: world });
    for (const c of node.children || []) visit(c, world);
  };
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes && json.scenes[json.scene == null ? 0 : json.scene];
  if (scene && scene.nodes) for (const n of scene.nodes) visit(n, IDENT);
  if (!jobs.length) {
    for (let i = 0; i < (json.meshes || []).length; i++) jobs.push({ mesh: i, m: IDENT });
  }

  /* A mirroring transform (negative determinant) reverses which way a triangle
   * faces, and so does the Y/Z axis swap below. Two flips cancel; one does
   * not. Tracked per primitive rather than assumed, because exporters do emit
   * negatively-scaled nodes. */
  const det3 = (m) =>
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2]);

  for (const job of jobs) {
    const mesh = json.meshes[job.mesh];
    if (!mesh) continue;
    for (const prim of mesh.primitives || []) {
      // 4 = TRIANGLES. Strips and fans are legal but no humanoid export uses
      // them; refusing loudly beats silently reading them as loose triangles.
      const mode = prim.mode == null ? 4 : prim.mode;
      if (mode !== 4) {
        if (mode === 5 || mode === 6) {
          throw new Error('triangle strip/fan primitives are not supported; ' +
                          're-export as plain triangles');
        }
        continue;                                    // points and lines: skip
      }
      if (!prim.attributes || prim.attributes.POSITION == null) continue;

      const pBase = positions.length, nBase = normals.length, tBase = uvs.length;
      const P = readAccessor(g, prim.attributes.POSITION);
      const N = prim.attributes.NORMAL != null ? readAccessor(g, prim.attributes.NORMAL) : null;
      const T = prim.attributes.TEXCOORD_0 != null ? readAccessor(g, prim.attributes.TEXCOORD_0) : null;

      for (const p of P) {
        const w = xformPoint(job.m, p);
        // glTF Y-up/-Z-forward -> the rigger's Z-up/-Y-forward.
        positions.push(convert ? [w[0], w[2], w[1]] : w);
      }
      if (N) {
        for (const n of N) {
          const w = xformDir(job.m, n);
          normals.push(convert ? [w[0], w[2], w[1]] : w);
        }
      }
      if (T) for (const t of T) uvs.push([t[0], t[1]]);

      const idx = prim.indices != null
        ? readAccessor(g, prim.indices).map((t) => t[0])
        : P.map((_, i) => i);

      const flip = (det3(job.m) < 0) !== convert;    // XOR: two flips cancel
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const a = idx[i], b = idx[flip ? i + 2 : i + 1], c = idx[flip ? i + 1 : i + 2];
        const corner = (v) => [pBase + v, T ? tBase + v : -1, N ? nBase + v : -1];
        tris.push([corner(a), corner(b), corner(c)]);
      }
    }
  }

  if (!positions.length) throw new Error('no triangle geometry found in ' + file);
  return { positions, normals, uvs, tris, meshes: jobs.length };
}

module.exports = { readGlb, readContainer, readAccessor };
