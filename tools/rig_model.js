/* =============================================================================
 * rig_model.js  —  Turns a static OBJ humanoid into a skinned player asset.
 * -----------------------------------------------------------------------------
 * The supplied basketball_player OBJ is a single unrigged A-pose mesh: one
 * group, 49,200 quads, no skeleton, no bone weights, and an empty material
 * library. HARDWOOD animates its players with a two-bone IK solver that emits
 * joint positions every frame, so a mesh can only be used if it can be
 * deformed by those joints. This tool does the offline half of that:
 *
 *   1  parse and triangulate the OBJ
 *   2  fit a skeleton to it, from anatomical proportions of its own height
 *      refined against the mesh's measured limb centrelines
 *   3  weight every vertex to at most two bones, smoothly across the joints
 *   4  tag every vertex with a material zone — skin, jersey, shorts, shoe —
 *      since the model carries no materials but the game needs team colours
 *   5  decimate by vertex clustering, because a player is a hundred pixels
 *      tall on screen and 49k vertices each is a hundred times what that needs
 *   6  emit js/render/playerMesh.js: a plain script that assigns one packed,
 *      quantised, base64 blob to a global
 *
 * Step 6 is a script rather than a data file on purpose. The game has no build
 * step and must keep running straight off the filesystem, where fetch() of a
 * sibling file is blocked as a cross-origin request.
 *
 * Usage: node rig_model.js <model.obj> [--target 9000] [--out <path>]
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ config */

const argv = process.argv.slice(2);
const SRC = argv.find((a) => !a.startsWith('--'));
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const TARGET = +arg('target', 9000);
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'js', 'render', 'playerMesh.js')));

if (!SRC) {
  console.error('usage: node rig_model.js <model.obj> [--target N] [--out path]');
  process.exit(1);
}

/* Bone order is the palette order the shader indexes into. Parent links exist
 * so the runtime can build each bone's matrix from its own segment alone. */
const BONES = [
  'pelvis', 'torso', 'head',
  'upperArmL', 'forearmL', 'handL',
  'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR'
];
const BONE_INDEX = {};
BONES.forEach((b, i) => { BONE_INDEX[b] = i; });

/* Material zones, matched by name at runtime to the player's palette. */
const ZONE = { SKIN: 0, JERSEY: 1, SHORTS: 2, SHOE: 3, HAIR: 4 };

/* ------------------------------------------------------------------- parse */

function parseObj(file) {
  const positions = [], normals = [], uvs = [], tris = [];
  const txt = fs.readFileSync(file, 'utf8');
  let line = '', start = 0;
  for (let i = 0; i <= txt.length; i++) {
    if (i !== txt.length && txt[i] !== '\n') continue;
    line = txt.slice(start, i);
    start = i + 1;
    if (line.length < 2) continue;
    const c0 = line[0], c1 = line[1];
    if (c0 === 'v' && c1 === ' ') {
      const p = line.split(/\s+/);
      positions.push([+p[1], +p[2], +p[3]]);
    } else if (c0 === 'v' && c1 === 'n') {
      const p = line.split(/\s+/);
      normals.push([+p[1], +p[2], +p[3]]);
    } else if (c0 === 'v' && c1 === 't') {
      const p = line.split(/\s+/);
      uvs.push([+p[1], +p[2]]);
    } else if (c0 === 'f' && c1 === ' ') {
      const parts = line.trim().split(/\s+/).slice(1);
      const corner = parts.map((tok) => {
        const s = tok.split('/');
        const res = (v, n) => {
          if (!v) return -1;
          const k = parseInt(v, 10);
          return k > 0 ? k - 1 : n + k;
        };
        return [res(s[0], positions.length), res(s[1], uvs.length), res(s[2], normals.length)];
      });
      // Fan-triangulate; the source is all quads but this handles any n-gon.
      for (let k = 1; k + 1 < corner.length; k++) tris.push([corner[0], corner[k], corner[k + 1]]);
    }
  }
  return { positions, normals, uvs, tris };
}

/* ------------------------------------------------------------- skeleton fit
 * The model is a symmetric A-pose standing on z=0 with -y forward. Landmark
 * heights come from standard proportions of its own measured stature; the arm
 * chain is refined against the mesh, because an A-pose arm runs diagonally and
 * proportions alone cannot say how far out it is held.
 */

function fitSkeleton(positions) {
  let hi = -1e9, lo = 1e9;
  for (const p of positions) { hi = Math.max(hi, p[2]); lo = Math.min(lo, p[2]); }
  const H = hi - lo;

  /* Fit the arm's axis by PCA over the arm's own vertices.
   *
   * An A-pose arm runs diagonally, and a straight line drawn from the shoulder
   * to the widest vertex misses it: the widest vertex is a splayed fingertip,
   * not a point on the arm's centreline, and aiming at it walks the elbow and
   * wrist several units outboard of the mesh they are supposed to bend. The
   * limb is straight in this pose, so its longest principal axis is its bone
   * axis, and the extent of the vertices along it is the arm's reach. */
  const arm = [];
  for (const p of positions) {
    if (p[0] > H * 0.105 && p[2] > H * 0.40 && p[2] < H * 0.86) arm.push(p);
  }
  const c = [0, 0, 0];
  for (const p of arm) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  for (let i = 0; i < 3; i++) c[i] /= Math.max(1, arm.length);

  const cov = new Float64Array(9);
  for (const p of arm) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] += d[i] * d[j];
  }
  // Power iteration for the dominant eigenvector — the direction the arm runs.
  let axis = [0.3, 0, -0.95];
  for (let it = 0; it < 64; it++) {
    const n = [
      cov[0] * axis[0] + cov[1] * axis[1] + cov[2] * axis[2],
      cov[3] * axis[0] + cov[4] * axis[1] + cov[5] * axis[2],
      cov[6] * axis[0] + cov[7] * axis[1] + cov[8] * axis[2]
    ];
    const L = Math.hypot(n[0], n[1], n[2]) || 1;
    axis = [n[0] / L, n[1] / L, n[2] / L];
  }
  if (axis[2] > 0) axis = [-axis[0], -axis[1], -axis[2]]; // point it down the arm
  let tMin = 1e9, tMax = -1e9;
  for (const p of arm) {
    const t = (p[0] - c[0]) * axis[0] + (p[1] - c[1]) * axis[1] + (p[2] - c[2]) * axis[2];
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
  }
  const at = (t) => [c[0] + axis[0] * t, 0, c[2] + axis[2] * t];
  const shoulderPt = at(tMin);
  const armLen = tMax - tMin;
  const along = (t) => at(tMin + t);
  const sx = shoulderPt[0], sz = shoulderPt[2];
  const tip = at(tMax);
  const tipX = tip[0], tipZ = tip[2];
  // Upper arm : forearm : hand as fractions of a whole arm's reach.
  const upper = armLen * 0.423, wristAt = armLen * 0.756;

  /* The traced side is +x, and that is the model's LEFT: it faces -y, so
   * forward x up puts its right hand on -x. Getting this backwards names every
   * limb for the wrong side, and each bone then drags its mesh across the body
   * to the opposite hip or shoulder. */
  const J = {
    pelvis: [0, 0, H * 0.480],
    torso: [0, 0, H * 0.660],
    neck: [0, 0, H * 0.832],
    head: [0, 0, H * 0.938],
    crown: [0, 0, H],
    shoulderL: [sx, 0, sz],
    elbowL: along(upper),
    wristL: along(wristAt),
    tipL: [tipX, 0, tipZ],
    hipL: [H * 0.053, 0, H * 0.480],
    kneeL: [H * 0.062, 0, H * 0.281],
    ankleL: [H * 0.070, 0, H * 0.050],
    toeL: [H * 0.070, -H * 0.085, H * 0.012]
  };
  for (const k of ['shoulder', 'elbow', 'wrist', 'tip', 'hip', 'knee', 'ankle', 'toe']) {
    const l = J[k + 'L'];
    J[k + 'R'] = [-l[0], l[1], l[2]];
  }
  // Scalars the weighting gates compare against, kept side-agnostic.
  J.shoulderX = Math.abs(J.shoulderL[0]);
  J.hipZ = J.hipL[2];
  J.height = H;
  return J;
}

/* Each bone as the segment it deforms: [head, tail]. */
function boneSegments(J) {
  return {
    pelvis: [J.pelvis, [0, 0, J.height * 0.560]],
    torso: [[0, 0, J.height * 0.545], J.neck],
    head: [J.neck, J.crown],
    upperArmL: [J.shoulderL, J.elbowL], forearmL: [J.elbowL, J.wristL], handL: [J.wristL, J.tipL],
    upperArmR: [J.shoulderR, J.elbowR], forearmR: [J.elbowR, J.wristR], handR: [J.wristR, J.tipR],
    thighL: [J.hipL, J.kneeL], shinL: [J.kneeL, J.ankleL], footL: [J.ankleL, J.toeL],
    thighR: [J.hipR, J.kneeR], shinR: [J.kneeR, J.ankleR], footR: [J.ankleR, J.toeR]
  };
}

function dist3(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L2 = dx * dx + dy * dy + dz * dz;
  let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / L2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t), p[2] - (a[2] + dz * t));
}

/* ------------------------------------------------------------------ weights
 * Inverse-distance to each bone segment, keeping the best two. Vertices deep
 * inside one limb come out fully weighted to it; only those near a joint end
 * up genuinely blended, which is exactly where a bend needs to be smooth.
 */
/**
 * Extra distance charged to a bone for reaching somewhere it has no business.
 *
 * Raw proximity is not enough on a figure standing in an A-pose. A bone is a
 * line down the middle of a limb, so a vertex on the side of the chest is
 * further from the spine than it is from the upper arm hanging beside it, and
 * naive weighting hands half the ribcage to that arm — which then tears the
 * torso apart the moment the arm swings. These are anatomical gates. Each one
 * grows smoothly with how far into the wrong region a vertex sits, so weights
 * still blend across a joint instead of snapping at a boundary.
 */
function gatePenalty(name, p, J, seg) {
  const H = J.height;
  const ax = Math.abs(p[0]);
  const shoulderX = J.shoulderX;
  // Which side a bone is on is read off the bone itself rather than from the
  // letter on the end of its name. The model faces -y, so its right limbs sit
  // at negative x, and a hardcoded letter-to-sign rule silently inverts the
  // moment the naming is corrected — penalising the one bone that should win.
  const mid = (seg[0][0] + seg[1][0]) * 0.5;
  const side = Math.abs(mid) > H * 0.012 ? Math.sign(mid) : 0;
  let pen = 0;

  // No limb owns anything across the body's midline.
  if (side && Math.sign(p[0]) !== side && ax > H * 0.012) pen += H * 0.30;

  if (/^(upperArm|forearm|hand)/.test(name)) {
    // Arms own only what lies outboard of the shoulder joint.
    const inboard = shoulderX * 0.80 - ax;
    if (inboard > 0) pen += inboard * 3.0;
  } else if (/^(thigh|shin|foot)/.test(name)) {
    // Legs own only what lies below the hip.
    const above = p[2] - J.hipZ;
    if (above > 0) pen += above * 3.0;
  } else if (name === 'torso' || name === 'pelvis') {
    // The trunk owns none of the limbs.
    const out = ax - shoulderX * 0.95;
    if (out > 0) pen += out * 3.0;
    if (name === 'torso') {
      const below = J.hipZ - p[2];
      if (below > 0) pen += below * 2.0;
    } else {
      const above = p[2] - J.torso[2];
      if (above > 0) pen += above * 2.0;
    }
  } else if (name === 'head') {
    const below = J.neck[2] - p[2];
    if (below > 0) pen += below * 4.0;
  }
  return pen;
}

function skinVertex(p, segs, J) {
  const scored = [];
  for (const name of BONES) {
    const s = segs[name];
    scored.push([name, distToSegment(p, s[0], s[1]) + gatePenalty(name, p, J, s)]);
  }
  scored.sort((a, b) => a[1] - b[1]);
  const [n0, d0] = scored[0], [n1, d1] = scored[1];
  const w0 = 1 / Math.pow(Math.max(d0, 1e-3), 4);
  const w1 = 1 / Math.pow(Math.max(d1, 1e-3), 4);
  const sum = w0 + w1;
  return [BONE_INDEX[n0], BONE_INDEX[n1], w0 / sum, w1 / sum];
}

/* ------------------------------------------------------------------- zones
 * The OBJ ships an empty .mtl, so the kit has to be recovered from geometry.
 * The garments sit at known heights on a standing figure and the tool already
 * knows which bone owns each vertex, which together separate a jersey from the
 * bare arm passing beside it.
 */
function zoneOf(p, boneName, J) {
  const H = J.height, z = p[2];
  if (z < H * 0.082) return ZONE.SHOE;
  if (boneName === 'head') return z > H * 0.945 || p[1] > -H * 0.01 ? ZONE.HAIR : ZONE.SKIN;
  const trunk = boneName === 'pelvis' || boneName === 'torso';
  const thigh = boneName === 'thighL' || boneName === 'thighR';
  if ((trunk || thigh) && z > H * 0.285 && z < H * 0.545) return ZONE.SHORTS;
  if (trunk && z >= H * 0.545 && z < H * 0.855) return ZONE.JERSEY;
  return ZONE.SKIN;
}

/* --------------------------------------------------------------- decimation
 * Vertex clustering: snap to a grid, keep the vertex nearest each cell's
 * centre as its representative, and drop triangles that collapse. Crude next
 * to quadric simplification, but on a dense organic mesh reduced to a few
 * thousand vertices the silhouette survives, and a player is never more than
 * a couple of hundred pixels tall.
 */
function cluster(verts, tris, cell) {
  // The bone and the material zone are part of the cell key, not just position.
  // In an A-pose the hands hang against the thighs and the arms rest on the
  // ribs, so a purely spatial cell welds a hand vertex to a shorts vertex —
  // and the triangle between them then stretches across the court the moment
  // that arm moves. Keying on the owning bone keeps every weld inside one
  // body part; keying on the zone keeps a jersey hem from bleeding into skin.
  const key = (v) => v.b0 + '|' + v.zone + '|' +
    Math.floor(v.p[0] / cell) + ',' + Math.floor(v.p[1] / cell) + ',' + Math.floor(v.p[2] / cell);
  const cells = new Map();
  for (let i = 0; i < verts.length; i++) {
    const k = key(verts[i]);
    let c = cells.get(k);
    if (!c) { c = []; cells.set(k, c); }
    c.push(i);
  }
  const remap = new Int32Array(verts.length);
  const kept = [];
  for (const group of cells.values()) {
    // Average the cell, then keep the real vertex closest to that average so
    // positions stay on the original surface.
    const c = [0, 0, 0];
    for (const i of group) { c[0] += verts[i].p[0]; c[1] += verts[i].p[1]; c[2] += verts[i].p[2]; }
    c[0] /= group.length; c[1] /= group.length; c[2] /= group.length;
    let best = group[0], bestD = 1e18;
    for (const i of group) {
      const d = Math.hypot(verts[i].p[0] - c[0], verts[i].p[1] - c[1], verts[i].p[2] - c[2]);
      if (d < bestD) { bestD = d; best = i; }
    }
    const idx = kept.length;
    kept.push(verts[best]);
    for (const i of group) remap[i] = idx;
  }
  const out = [];
  for (const t of tris) {
    const a = remap[t[0]], b = remap[t[1]], c = remap[t[2]];
    if (a !== b && b !== c && a !== c) out.push([a, b, c]);
  }
  return { verts: kept, tris: out };
}

/* ------------------------------------------------------------------- packing
 * Positions quantise to 16-bit over the model's own bounds, normals to signed
 * bytes, weights to a single byte (the pair sums to one, so only the first is
 * stored). UVs are dropped: the model has no texture to sample.
 */
function pack(verts, tris, J) {
  const n = verts.length;
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const v of verts) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], v.p[i]);
      hi[i] = Math.max(hi[i], v.p[i]);
    }
  }
  const ext = [0, 1, 2].map((i) => Math.max(hi[i] - lo[i], 1e-6));

  const pos = Buffer.alloc(n * 6);
  const nrm = Buffer.alloc(n * 3);
  const skin = Buffer.alloc(n * 4);   // bone0, bone1, weight0, zone
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    for (let k = 0; k < 3; k++) {
      const q = Math.round(((v.p[k] - lo[k]) / ext[k]) * 65535);
      pos.writeUInt16LE(Math.max(0, Math.min(65535, q)), i * 6 + k * 2);
    }
    const L = Math.hypot(v.n[0], v.n[1], v.n[2]) || 1;
    for (let k = 0; k < 3; k++) {
      nrm.writeInt8(Math.max(-127, Math.min(127, Math.round((v.n[k] / L) * 127))), i * 3 + k);
    }
    skin[i * 4] = v.b0;
    skin[i * 4 + 1] = v.b1;
    skin[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(v.w0 * 255)));
    skin[i * 4 + 3] = v.zone;
  }

  const wide = n > 65535;
  const idx = Buffer.alloc(tris.length * 3 * (wide ? 4 : 2));
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const o = (i * 3 + k) * (wide ? 4 : 2);
      if (wide) idx.writeUInt32LE(t[k], o); else idx.writeUInt16LE(t[k], o);
    }
  });

  return {
    vertexCount: n,
    triCount: tris.length,
    wideIndex: wide,
    bounds: { lo, ext },
    bones: BONES,
    // Bind-pose bone segments, in the model's own units. The runtime needs
    // these to build the transform from bind to posed for each bone.
    bind: (() => {
      const segs = boneSegments(J);
      const o = {};
      for (const b of BONES) o[b] = segs[b];
      return o;
    })(),
    height: J.height,
    /* Landmark heights and half-spans, as fractions of stature. The IK solver
     * adopts these so it works in the model's own build: matching the skeleton
     * to the mesh means the skinning barely has to stretch any bone, and a
     * bone stretched 30 percent is exactly what makes a limb look wrong. */
    landmarks: {
      ankle: J.ankleL[2] / J.height,
      knee: J.kneeL[2] / J.height,
      hip: J.hipL[2] / J.height,
      shoulder: J.shoulderL[2] / J.height,
      headCenter: J.head[2] / J.height,
      crown: 1,
      hipW: Math.abs(J.hipL[0]) / J.height,
      shoulderW: Math.abs(J.shoulderL[0]) / J.height,
      upperArm: dist3(J.shoulderL, J.elbowL) / J.height,
      forearm: dist3(J.elbowL, J.wristL) / J.height
    },
    buffers: {
      pos: pos.toString('base64'),
      nrm: nrm.toString('base64'),
      skin: skin.toString('base64'),
      idx: idx.toString('base64')
    }
  };
}

/* --------------------------------------------------------------------- run */

console.log('\nHARDWOOD — rigging ' + path.basename(SRC) + '\n');

const raw = parseObj(SRC);
console.log('  parsed      ' + raw.positions.length + ' vertices, ' +
            raw.tris.length + ' triangles' + (raw.normals.length ? ', with normals' : ''));

const J = fitSkeleton(raw.positions);
console.log('  stature     ' + J.height.toFixed(1) + ' model units');
const pct = (p) => (p[2] / J.height * 100).toFixed(1) + '%';
console.log('  shoulder    ' + pct(J.shoulderL) + '  x=' + J.shoulderL[0].toFixed(1));
console.log('  elbow       ' + pct(J.elbowL) + '  x=' + J.elbowL[0].toFixed(1));
console.log('  wrist       ' + pct(J.wristL) + '  x=' + J.wristL[0].toFixed(1));
console.log('  hip         ' + pct(J.hipL) + '   knee ' + pct(J.kneeL) +
            '   ankle ' + pct(J.ankleL));

/* Expand the OBJ's shared-position / per-corner-normal indexing into one
 * vertex per unique (position, normal) pair, which is what a GPU wants. */
const segs = boneSegments(J);
const seen = new Map();
const verts = [];
const tris = [];
const skinCache = new Map();
for (const t of raw.tris) {
  const tri = [];
  for (const [pi, , ni] of t) {
    const k = pi * 131071 + (ni + 1);
    let vi = seen.get(k);
    if (vi === undefined) {
      const p = raw.positions[pi];
      let s = skinCache.get(pi);
      if (!s) { s = skinVertex(p, segs, J); skinCache.set(pi, s); }
      vi = verts.length;
      verts.push({
        p,
        n: ni >= 0 && raw.normals[ni] ? raw.normals[ni] : [0, 0, 1],
        b0: s[0], b1: s[1], w0: s[2],
        zone: zoneOf(p, BONES[s[0]], J)
      });
      seen.set(k, vi);
    }
    tri.push(vi);
  }
  tris.push(tri);
}
console.log('  expanded    ' + verts.length + ' vertices');

const zoneCount = [0, 0, 0, 0, 0];
for (const v of verts) zoneCount[v.zone]++;
console.log('  zones       skin ' + zoneCount[0] + '  jersey ' + zoneCount[1] +
            '  shorts ' + zoneCount[2] + '  shoe ' + zoneCount[3] + '  hair ' + zoneCount[4]);

/* Search for the cell size that lands nearest the requested vertex budget. */
let best = null;
for (let cell = J.height * 0.004; cell <= J.height * 0.06; cell *= 1.12) {
  const r = cluster(verts, tris, cell);
  if (!best || Math.abs(r.verts.length - TARGET) < Math.abs(best.verts.length - TARGET)) {
    best = r; best.cell = cell;
  }
  if (r.verts.length < TARGET * 0.5) break;
}
console.log('  decimated   ' + best.verts.length + ' vertices, ' + best.tris.length +
            ' triangles  (cell ' + best.cell.toFixed(2) + ')');

const asset = pack(best.verts, best.tris, J);
const json = JSON.stringify(asset);
const body = '/* Generated by tools/rig_model.js from ' + path.basename(SRC) + '.\n' +
  ' * A skinned player mesh: quantised positions and normals, two bone weights\n' +
  ' * and a material zone per vertex, plus the bind-pose skeleton the runtime\n' +
  ' * poses it with. Regenerate rather than editing by hand.\n' +
  ' *\n' +
  ' * Shipped as a script, not a data file, because the game has no build step\n' +
  ' * and must load straight off the filesystem, where fetch() of a sibling\n' +
  ' * file counts as cross-origin and is refused. */\n' +
  '(function (global) {\n' +
  "  'use strict';\n" +
  '  var BB = global.BB || (global.BB = {});\n' +
  '  BB.PLAYER_MESH = ' + json + ';\n' +
  '})(typeof window !== \'undefined\' ? window : globalThis);\n';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, body);
console.log('  wrote       ' + path.relative(path.join(__dirname, '..'), OUT) +
            '  (' + (body.length / 1024).toFixed(0) + ' KB)\n');
