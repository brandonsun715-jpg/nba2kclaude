/* =============================================================================
 * rig_model.js  —  Turns a static OBJ humanoid into a skinned player asset.
 * -----------------------------------------------------------------------------
 * The supplied basketball_player OBJ is a single unrigged A-pose mesh: one
 * group, 49,200 quads, no skeleton, no bone weights, and an empty material
 * library. NBA 1K26 animates its players with a two-bone IK solver that emits
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
const ZONE = { SKIN: 0, JERSEY: 1, SHORTS: 2, SHOE: 3, HAIR: 4, FACE: 5 };

/** Clamp to 0..1. Used wherever a measurement becomes a blend factor. */
const U01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

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
    // Arms own only what lies outboard of the shoulder joint, and nothing at
    // all above it. An A-pose hangs the arm right against the ribs, so a
    // generous gate lets it capture chest and armhole vertices — and those
    // then swing with the arm and tear the jersey open when it moves.
    /* The deltoid has to be SHARED, or the shoulder tears.
     *
     * At 6.0 this gate was a wall standing exactly where the joint bends: a
     * vertex just inboard of the shoulder was pushed onto the torso with
     * effectively all of its weight, its neighbour just outboard onto the
     * upper arm with all of its, and the pair pulled apart the moment the arm
     * rotated. The visible result was a hole at the shoulder in every raised
     * or rolled-arm pose — the defensive stance and the jump shot both.
     *
     * Gentler here so the cap can be genuinely blended between the two bones,
     * which is what lets it deform instead of splitting. The gate still has to
     * exist: without any, the jersey's chest panel joins the arm and swings
     * with it. */
    const inboard = shoulderX * 1.05 - ax;
    if (inboard > 0) pen += inboard * 1.5;
    const above = p[2] - J.shoulderL[2];
    if (above > 0) pen += above * 4.0;
  } else if (/^(thigh|shin|foot)/.test(name)) {
    // Legs own only what lies below the hip. No midline gate here: the inner
    // face of the shorts has to travel with the leg it wraps, and holding it
    // back turns a pair of shorts into a skirt the moment the legs part.
    const above = p[2] - J.hipZ;
    if (above > 0) pen += above * 6.0;
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
  /* Falloff exponent. At 4 the nearer bone takes essentially everything —
   * a vertex 10% closer to one bone gives it 68% of the weight, and one 30%
   * closer gives it 86% — so the skin is rigid right up to a seam and then
   * jumps. At 2 the same two vertices come out 55/45 and 65/35, which is a
   * joint that bends rather than a pair of shells that slide past each
   * other. */
  const w0 = 1 / Math.pow(Math.max(d0, 1e-3), 2);
  const w1 = 1 / Math.pow(Math.max(d1, 1e-3), 2);
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

  /* Hair is the CRANIUM, and nothing but the cranium.
   *
   * The rule here used to hand the hair zone to any vertex the skinning had
   * given to the head bone, provided it sat behind the mid-plane — at any
   * height at all. Skinning gives the head bone the base of the neck and the
   * top of the shoulders as well, so a third of the "hair" (274 of 867
   * vertices) was being painted down the collar. It reached z/H 0.832, which
   * is exactly where the jersey starts, and that is the hair that looked
   * welded to the jersey.
   *
   * Gating on the skull line is what was missing: above 0.90H there is
   * nothing but head, so crown-and-back can be read straight off the
   * geometry. Everything below falls through to the garment rules, where a
   * collar vertex becomes jersey and a neck vertex becomes skin. */
  if (boneName === 'head' && z > H * 0.89) {
    /* The scalp ends on the same slanted hairline the haircuts grow from (see
     * buildHair): high across the brow, dropping away to the nape. It used to
     * be a crown-or-back test, which is a corner in a place a hairline has no
     * corner — it left a visible staircase across the temple that every style
     * inherited, because the shells taper out along one boundary and the
     * scalp's colour changed along a different one. Skull fit, measured:
     * centre y -0.043H, half-depth 0.051H. */
    const t = U01((p[1] + H * 0.094) / (H * 0.102));
    return z > H * (0.960 - 0.062 * t) ? ZONE.HAIR : ZONE.SKIN;
  }

  // The head bone counts as trunk below the skull: that is the collar, and it
  // is wearing the jersey like the shoulders it sits on.
  const trunk = boneName === 'pelvis' || boneName === 'torso' || boneName === 'head';
  const thigh = boneName === 'thighL' || boneName === 'thighR';
  if ((trunk || thigh) && z > H * 0.285 && z < H * 0.545) return ZONE.SHORTS;
  /* The jersey is decided by WHERE a vertex is, not by which bone won it.
   *
   * Bone assignment across the shoulder is deliberately soft now — that is
   * what stopped the deltoid tearing — but the garment boundary was still
   * keyed off which bone came first, so along the shoulder line neighbouring
   * vertices flipped between jersey and skin and the edge came out serrated.
   * A vest does not have a zigzag hem. Inside the shoulder joint's own width
   * is cloth, outside it is arm, and that reads the same however the weights
   * fall. */
  const shoulderSpan = Math.abs(J.shoulderL[0]) * 1.04;
  if (Math.abs(p[0]) < shoulderSpan && z >= H * 0.545 && z < H * 0.855) return ZONE.JERSEY;
  return ZONE.SKIN;
}

/* --------------------------------------------------------------- decimation
 * Quadric error metric edge collapse, after Garland and Heckbert.
 *
 * The previous pass was vertex clustering: snap to a grid, keep one
 * representative per cell. That is fast, but it moves surviving vertices to
 * positions the surface never had, and two neighbouring triangles whose corners
 * fall in different cells get pulled apart — which is exactly the cracking that
 * showed along the jersey hem and the shorts. Collapsing edges instead only
 * ever merges points that were already joined, so the surface stays closed.
 *
 * Each vertex carries the sum of the squared-distance quadrics of the planes it
 * touches. The cost of collapsing an edge is the error at the position that
 * minimises the pair's combined quadric, so flat regions collapse first and
 * silhouettes survive — the opposite of what a uniform grid does.
 *
 * Simplification runs on POSITION topology, not on the render vertices. The
 * OBJ splits a vertex wherever two faces disagree about the normal, and on that
 * split topology half the edges are not shared and cannot collapse at all.
 */

/** Symmetric 4x4 quadric, packed as the 10 unique terms. */
function quadricFromPlane(a, b, c, d, out) {
  out[0] = a * a; out[1] = a * b; out[2] = a * c; out[3] = a * d;
  out[4] = b * b; out[5] = b * c; out[6] = b * d;
  out[7] = c * c; out[8] = c * d;
  out[9] = d * d;
  return out;
}

function quadricAdd(dst, o, src, so, w) {
  for (let i = 0; i < 10; i++) dst[o + i] += src[so + i] * w;
}

/** v^T Q v for a point, with Q packed as above. */
function quadricError(Q, o, x, y, z) {
  return Q[o] * x * x + 2 * Q[o + 1] * x * y + 2 * Q[o + 2] * x * z + 2 * Q[o + 3] * x
       + Q[o + 4] * y * y + 2 * Q[o + 5] * y * z + 2 * Q[o + 6] * y
       + Q[o + 7] * z * z + 2 * Q[o + 8] * z
       + Q[o + 9];
}

/**
 * @param {number[][]} pos     positions, indexed by position id
 * @param {number[][]} faces   triangles of position ids
 * @param {Int32Array} zone    material zone per position id
 * @param {number} target      vertices to aim for
 */
function simplify(pos, faces, zone, target) {
  const nv = pos.length;
  const Q = new Float64Array(nv * 10);
  const tmp = new Float64Array(10);

  /* Face planes -> vertex quadrics, weighted by area so big flat panels are
   * not out-voted by a dense cluster of tiny triangles. */
  const faceAlive = new Uint8Array(faces.length).fill(1);
  for (let f = 0; f < faces.length; f++) {
    const [i0, i1, i2] = faces[f];
    const p0 = pos[i0], p1 = pos[i1], p2 = pos[i2];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) { faceAlive[f] = 0; continue; }
    const area = len * 0.5;
    nx /= len; ny /= len; nz /= len;
    const d = -(nx * p0[0] + ny * p0[1] + nz * p0[2]);
    quadricFromPlane(nx, ny, nz, d, tmp);
    quadricAdd(Q, i0 * 10, tmp, 0, area);
    quadricAdd(Q, i1 * 10, tmp, 0, area);
    quadricAdd(Q, i2 * 10, tmp, 0, area);
  }

  /* Which faces touch each vertex, and which vertices each vertex shares an
   * edge with. Kept as plain Sets: the mesh is tens of thousands of vertices,
   * not millions, and clarity is worth more here than packing. */
  const vFaces = [], vAdj = [];
  for (let i = 0; i < nv; i++) { vFaces.push(new Set()); vAdj.push(new Set()); }
  for (let f = 0; f < faces.length; f++) {
    if (!faceAlive[f]) continue;
    const t = faces[f];
    for (let k = 0; k < 3; k++) {
      vFaces[t[k]].add(f);
      vAdj[t[k]].add(t[(k + 1) % 3]);
      vAdj[t[k]].add(t[(k + 2) % 3]);
    }
  }

  /* Open boundaries and zone borders are the silhouette of the kit. Loading
   * their quadrics with a plane perpendicular to the surface pins them, so a
   * sleeve opening or a shorts hem keeps its outline. */
  const edgeFaces = new Map();
  const ekey = (a, b) => (a < b ? a * nv + b : b * nv + a);
  for (let f = 0; f < faces.length; f++) {
    if (!faceAlive[f]) continue;
    const t = faces[f];
    for (let k = 0; k < 3; k++) {
      const k2 = ekey(t[k], t[(k + 1) % 3]);
      edgeFaces.set(k2, (edgeFaces.get(k2) || 0) + 1);
    }
  }
  for (const [k, count] of edgeFaces) {
    const a = Math.floor(k / nv), b = k % nv;
    if (count === 1 || zone[a] !== zone[b]) {
      const ex = pos[b][0] - pos[a][0], ey = pos[b][1] - pos[a][1], ez = pos[b][2] - pos[a][2];
      // Any plane containing the edge works; take one perpendicular to it.
      let nx = -ey, ny = ex, nz = 0;
      if (Math.hypot(nx, ny, nz) < 1e-9) { nx = 0; ny = -ez; nz = ey; }
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
      const d = -(nx * pos[a][0] + ny * pos[a][1] + nz * pos[a][2]);
      quadricFromPlane(nx, ny, nz, d, tmp);
      quadricAdd(Q, a * 10, tmp, 0, 400);
      quadricAdd(Q, b * 10, tmp, 0, 400);
    }
  }

  const alive = new Uint8Array(nv).fill(1);
  const P = pos.map((p) => [p[0], p[1], p[2]]);

  /** Best position to collapse an edge to, and what it costs. */
  function evaluate(a, b) {
    const oa = a * 10, ob = b * 10;
    for (let i = 0; i < 10; i++) tmp[i] = Q[oa + i] + Q[ob + i];
    // Solve the 3x3 system for the quadric's minimum; fall back to the
    // endpoints and the midpoint when it is singular, which is what happens on
    // a perfectly flat or perfectly symmetric neighbourhood.
    const m = [tmp[0], tmp[1], tmp[2], tmp[1], tmp[4], tmp[5], tmp[2], tmp[5], tmp[7]];
    const det = m[0] * (m[4] * m[8] - m[5] * m[7])
              - m[1] * (m[3] * m[8] - m[5] * m[6])
              + m[2] * (m[3] * m[7] - m[4] * m[6]);
    let best = null, bestErr = Infinity;
    if (Math.abs(det) > 1e-10) {
      const rx = -tmp[3], ry = -tmp[6], rz = -tmp[8];
      const x = (rx * (m[4] * m[8] - m[5] * m[7]) - m[1] * (ry * m[8] - m[5] * rz)
                + m[2] * (ry * m[7] - m[4] * rz)) / det;
      const y = (m[0] * (ry * m[8] - m[5] * rz) - rx * (m[3] * m[8] - m[5] * m[6])
                + m[2] * (m[3] * rz - ry * m[6])) / det;
      const z = (m[0] * (m[4] * rz - ry * m[7]) - m[1] * (m[3] * rz - ry * m[6])
                + rx * (m[3] * m[7] - m[4] * m[6])) / det;
      best = [x, y, z];
      bestErr = quadricError(tmp, 0, x, y, z);
    }
    const cand = [P[a], P[b], [(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2, (P[a][2] + P[b][2]) / 2]];
    for (const c of cand) {
      const e = quadricError(tmp, 0, c[0], c[1], c[2]);
      if (e < bestErr) { bestErr = e; best = [c[0], c[1], c[2]]; }
    }
    return { pos: best, cost: Math.max(0, bestErr) };
  }

  /* A binary heap of candidate collapses. Entries go stale as their endpoints
   * move, so each pop re-checks the cost it was queued with and re-queues
   * rather than trusting it. */
  const heap = [];
  const push = (e) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].cost <= heap[i].cost) break;
      const t2 = heap[p]; heap[p] = heap[i]; heap[i] = t2; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m2 = i;
        if (l < heap.length && heap[l].cost < heap[m2].cost) m2 = l;
        if (r < heap.length && heap[r].cost < heap[m2].cost) m2 = r;
        if (m2 === i) break;
        const t2 = heap[m2]; heap[m2] = heap[i]; heap[i] = t2; i = m2;
      }
    }
    return top;
  };

  const queueEdge = (a, b) => {
    if (a === b || !alive[a] || !alive[b]) return;
    // Never merge across a material zone: that is what smears a jersey into
    // the skin beside it.
    if (zone[a] !== zone[b]) return;
    const r = evaluate(a, b);
    push({ a, b, cost: r.cost, pos: r.pos });
  };

  for (let a = 0; a < nv; a++) for (const b of vAdj[a]) if (a < b) queueEdge(a, b);

  /** Would moving `v` to `np` turn any of its triangles inside out? */
  function flips(v, other, np) {
    for (const f of vFaces[v]) {
      if (!faceAlive[f]) continue;
      const t = faces[f];
      if (t[0] === other || t[1] === other || t[2] === other) continue;
      const q = t.map((i) => (i === v ? np : P[i]));
      const ux = q[1][0] - q[0][0], uy = q[1][1] - q[0][1], uz = q[1][2] - q[0][2];
      const vx = q[2][0] - q[0][0], vy = q[2][1] - q[0][1], vz = q[2][2] - q[0][2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const o = t.map((i) => (i === v ? P[v] : P[i]));
      const ox = o[1][0] - o[0][0], oy = o[1][1] - o[0][1], oz = o[1][2] - o[0][2];
      const wx = o[2][0] - o[0][0], wy = o[2][1] - o[0][1], wz = o[2][2] - o[0][2];
      const mx = oy * wz - oz * wy, my = oz * wx - ox * wz, mz = ox * wy - oy * wx;
      if (nx * mx + ny * my + nz * mz <= 0) return true;
    }
    return false;
  }

  let count = nv;
  while (count > target && heap.length) {
    const e = pop();
    const { a, b } = e;
    if (!alive[a] || !alive[b]) continue;
    if (!vAdj[a].has(b)) continue;
    const cur = evaluate(a, b);
    if (cur.cost > e.cost * 1.0001 + 1e-9) { push({ a, b, cost: cur.cost, pos: cur.pos }); continue; }
    if (flips(a, b, cur.pos) || flips(b, a, cur.pos)) continue;

    // Collapse b into a at the optimal position.
    P[a][0] = cur.pos[0]; P[a][1] = cur.pos[1]; P[a][2] = cur.pos[2];
    for (let i = 0; i < 10; i++) Q[a * 10 + i] += Q[b * 10 + i];
    alive[b] = 0;
    count--;

    for (const f of vFaces[b]) {
      if (!faceAlive[f]) continue;
      const t = faces[f];
      if (t[0] === a || t[1] === a || t[2] === a) { faceAlive[f] = 0; continue; }
      for (let k = 0; k < 3; k++) if (t[k] === b) t[k] = a;
      vFaces[a].add(f);
    }
    for (const n of vAdj[b]) {
      if (n === a || !alive[n]) continue;
      vAdj[n].delete(b); vAdj[n].add(a);
      vAdj[a].add(n);
    }
    vAdj[a].delete(b);
    for (const n of vAdj[a]) queueEdge(a, n);
  }

  /* Compact. */
  const remap = new Int32Array(nv).fill(-1);
  const outPos = [], outSrc = [];
  for (let i = 0; i < nv; i++) {
    if (!alive[i]) continue;
    remap[i] = outPos.length;
    outPos.push(P[i]);
    outSrc.push(i);
  }
  const outTris = [];
  for (let f = 0; f < faces.length; f++) {
    if (!faceAlive[f]) continue;
    const t = faces[f];
    const a = remap[t[0]], b = remap[t[1]], c = remap[t[2]];
    if (a < 0 || b < 0 || c < 0) continue;
    if (a === b || b === c || a === c) continue;
    outTris.push([a, b, c]);
  }
  return { pos: outPos, tris: outTris, src: outSrc };
}

/**
 * Laplacian smoothing of the skin weights over the mesh's own topology.
 *
 * Weights come from gated inverse distance, which is sharp by design — but the
 * jersey is a separate shell sitting a few millimetres off the body, and two
 * vertices that close together can land on different sides of a gate and come
 * out weighted to different bones. Posed, the shell and the body beneath it
 * then move apart, and the garment tears open across the chest and hips.
 *
 * Averaging each vertex's weights with its neighbours a few times makes the
 * field continuous, so anything sharing a neighbourhood deforms together.
 */
function smoothWeights(nv, tris, boneCount, weights, iterations) {
  const adj = [];
  for (let i = 0; i < nv; i++) adj.push([]);
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      adj[t[k]].push(t[(k + 1) % 3]);
      adj[t[k]].push(t[(k + 2) % 3]);
    }
  }
  let cur = weights, next = new Float32Array(weights.length);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < nv; v++) {
      const o = v * boneCount, n = adj[v].length;
      if (!n) { for (let b = 0; b < boneCount; b++) next[o + b] = cur[o + b]; continue; }
      for (let b = 0; b < boneCount; b++) next[o + b] = cur[o + b] * 0.45;
      const share = 0.55 / n;
      for (const m of adj[v]) {
        const om = m * boneCount;
        for (let b = 0; b < boneCount; b++) next[o + b] += cur[om + b] * share;
      }
    }
    const swap = cur; cur = next; next = swap;
  }
  return cur;
}

/**
 * Area-weighted smooth normals, split wherever two incident faces disagree by
 * more than `angle`. Simplification moves vertices, so the OBJ's own normals no
 * longer describe the surface that is left; recomputing keeps the shading
 * honest while the split preserves the hard edges of a shoe sole or a hem.
 */
function rebuildNormals(pos, tris, angleDeg) {
  const cosLimit = Math.cos(angleDeg * Math.PI / 180);
  const faceN = [];
  const vFaces = pos.map(() => []);
  for (let f = 0; f < tris.length; f++) {
    const [a, b, c] = tris[f];
    const ux = pos[b][0] - pos[a][0], uy = pos[b][1] - pos[a][1], uz = pos[b][2] - pos[a][2];
    const vx = pos[c][0] - pos[a][0], vy = pos[c][1] - pos[a][1], vz = pos[c][2] - pos[a][2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    faceN.push([nx / L, ny / L, nz / L, L * 0.5]);
    vFaces[a].push(f); vFaces[b].push(f); vFaces[c].push(f);
  }

  const outPos = [], outNrm = [], outSrc = [];
  const outTris = tris.map((t) => t.slice());
  for (let v = 0; v < pos.length; v++) {
    // Group this vertex's faces into smoothing clusters.
    const groups = [];
    for (const f of vFaces[v]) {
      const n = faceN[f];
      let hit = null;
      for (const g of groups) {
        const L = Math.hypot(g.n[0], g.n[1], g.n[2]) || 1;
        if ((n[0] * g.n[0] + n[1] * g.n[1] + n[2] * g.n[2]) / L >= cosLimit) { hit = g; break; }
      }
      if (!hit) { hit = { n: [0, 0, 0], faces: [] }; groups.push(hit); }
      hit.n[0] += n[0] * n[3]; hit.n[1] += n[1] * n[3]; hit.n[2] += n[2] * n[3];
      hit.faces.push(f);
    }
    if (!groups.length) continue;
    groups.forEach((g, gi) => {
      const L = Math.hypot(g.n[0], g.n[1], g.n[2]) || 1;
      const id = outPos.length;
      outPos.push(pos[v]);
      outNrm.push([g.n[0] / L, g.n[1] / L, g.n[2] / L]);
      outSrc.push(v);
      if (gi === 0) {
        for (const f of g.faces) for (let k = 0; k < 3; k++) if (tris[f][k] === v) outTris[f][k] = id;
      } else {
        for (const f of g.faces) for (let k = 0; k < 3; k++) if (tris[f][k] === v) outTris[f][k] = id;
      }
    });
  }
  return { pos: outPos, normals: outNrm, tris: outTris, src: outSrc };
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

console.log('\nNBA 1K26 — rigging ' + path.basename(SRC) + '\n');

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

/* Simplification runs on POSITION topology — the OBJ's own `v` indices — not
 * on render vertices. Splitting a vertex per unique (position, normal) pair is
 * what a GPU wants, but on that split topology the two sides of every hard edge
 * are separate points, so those edges cannot collapse and the surface tears
 * along them. Weld first, simplify, then split for the GPU at the end. */
const segs = boneSegments(J);
const skinOf = raw.positions.map((p) => skinVertex(p, segs, J));
const zoneAt = new Int32Array(raw.positions.length);
raw.positions.forEach((p, i) => { zoneAt[i] = zoneOf(p, BONES[skinOf[i][0]], J); });

const posTris = raw.tris.map((t) => [t[0][0], t[1][0], t[2][0]]);
console.log('  welded      ' + raw.positions.length + ' positions, ' + posTris.length + ' triangles');

const zoneCount0 = [0, 0, 0, 0, 0];
for (let i = 0; i < zoneAt.length; i++) zoneCount0[zoneAt[i]]++;
console.log('  zones       skin ' + zoneCount0[0] + '  jersey ' + zoneCount0[1] +
            '  shorts ' + zoneCount0[2] + '  shoe ' + zoneCount0[3] + '  hair ' + zoneCount0[4]);

const t0 = Date.now();
const simplified = simplify(raw.positions, posTris, zoneAt, TARGET);
console.log('  simplified  ' + simplified.pos.length + ' positions, ' +
            simplified.tris.length + ' triangles  (' +
            ((Date.now() - t0) / 1000).toFixed(1) + 's)');

/* Recompute normals on the surface that actually survived, then split the few
 * vertices that sit on a genuine crease. */
const shaded = rebuildNormals(simplified.pos, simplified.tris, 52);

/* Re-derive skinning and zones from the final positions, so weights describe
 * the mesh being drawn rather than the one it was decimated from. */
// The zone is a hard classification, so it rides through both passes rather
// than being re-derived from the new positions. Simplification moves vertices,
// and a vertex that drifts across a garment's height threshold would flip to
// the wrong kit — which shows up as navy blotches out in the middle of an arm.
// Collapses never cross a zone, so every survivor's zone is unambiguous.
const nb = BONES.length;
const dense = new Float32Array(shaded.pos.length * nb);
shaded.pos.forEach((p, i) => {
  const sk = skinVertex(p, segs, J);
  dense[i * nb + sk[0]] = sk[2];
  dense[i * nb + sk[1]] = sk[3];
});
const smoothed = smoothWeights(shaded.pos.length, shaded.tris, nb, dense, 26);

const verts = shaded.pos.map((p, i) => {
  // Back to two bones: take the strongest pair from the smoothed field.
  const o = i * nb;
  let b0 = 0, w0 = -1, b1 = 0, w1 = -1;
  for (let b = 0; b < nb; b++) {
    const w = smoothed[o + b];
    if (w > w0) { b1 = b0; w1 = w0; b0 = b; w0 = w; }
    else if (w > w1) { b1 = b; w1 = w; }
  }
  const sum = w0 + w1;
  return {
    p,
    n: shaded.normals[i],
    b0, b1, w0: sum > 1e-6 ? w0 / sum : 1,
    zone: zoneAt[simplified.src[shaded.src[i]]]
  };
});
const best = { verts, tris: shaded.tris };
console.log('  shaded      ' + verts.length + ' vertices, ' + best.tris.length + ' triangles');

/* ------------------------------------------------------------------ hair
 * The OBJ ships exactly one haircut, fused into the same surface as the head.
 * Everything above is about getting that surface labelled correctly; this is
 * about giving the player a choice.
 *
 * Each style is baked as its own block of triangles APPENDED AFTER the body,
 * so the runtime can draw the body and then whichever style it wants out of
 * the same buffer — no rebuilds, no second mesh, one extra draw call.
 *
 * The styles are shells grown off the skull. The scalp underneath is already
 * zoned as hair and already the right colour, which is what makes this cheap:
 * a shell only has to add VOLUME, and it can taper its thickness to nothing at
 * the hairline instead of needing a rim to close it off. A shell that reaches
 * zero exactly where the scalp takes over has no seam to hide.
 */
function buildHair(bodyVerts, J) {
  const H = J.height;
  const scalp = bodyVerts.filter((v) => v.zone === ZONE.HAIR);
  if (!scalp.length) return { styles: {}, order: [] };

  // Fit the skull as a box, and work in the ellipsoid inscribed in it.
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const v of scalp) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], v.p[i]);
      hi[i] = Math.max(hi[i], v.p[i]);
    }
  }
  // The scalp is a cap, not a ball: it has no underside, so its own box would
  // put the centre far too high. Drop the origin to the skull's mid-height.
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, H * 0.938];
  const r = [
    Math.max((hi[0] - lo[0]) / 2, H * 0.03),
    Math.max((hi[1] - lo[1]) / 2, H * 0.03),
    Math.max(hi[2] - c[2], H * 0.03)
  ];

  /* How much of the skull a haircut is allowed to cover, smoothed.
   *
   * The same crown-or-back rule the zoner uses, but as a 0..1 ramp rather than
   * a yes/no: 1 well inside the hair, falling to 0 at the hairline. Every
   * style multiplies its thickness by this, so none of them creep down over
   * an ear or a forehead, and all of them land flush on the scalp. */
  /* Where the hairline sits, as a 0..1 ramp rather than a yes/no.
   *
   * A real hairline is not a height, it is a slope: high across the brow and
   * dropping away to the nape. Reading it off the crown-or-back rule the zoner
   * uses left the temples bare, because that rule was written to answer a
   * different question — which existing vertices are hair — not where a
   * haircut is allowed to grow.
   *
   * Every style multiplies its thickness by this, so all of them taper to
   * nothing exactly at the hairline and meet the scalp with no rim and no
   * seam. */
  const cover = (p) => {
    const t = U01((p[1] - (c[1] - r[1])) / Math.max(2 * r[1], 1e-6)); // 0 brow, 1 nape
    const line = H * (0.960 - 0.062 * t);
    return U01((p[2] - line) / (H * 0.028));
  };

  /* Thickness profiles, as a fraction of skull radius. Each gets the point on
   * the unit sphere it is being asked about, so a style can be tall on top and
   * tight at the sides — which is the whole difference between a fade and an
   * afro. `az` is 0 at the back of the head and grows around the side. */
  const STYLES = {
    buzz:     { amp: 0.045, f: () => 1 },
    fade:     { amp: 0.130, f: (d) => 0.35 + 0.65 * Math.pow(U01(d[2]), 1.5) },
    afro:     { amp: 0.850, f: () => 1 },
    highTop:  { amp: 0.980, f: (d) => Math.pow(U01(d[2]), 0.30) },
    waves:    { amp: 0.100, f: (d, az) => 1 + 0.30 * Math.cos(az * 16) },
    cornrows: { amp: 0.230, f: (d, az) => 0.35 + 0.65 * Math.pow(Math.abs(Math.cos(az * 5)), 0.8) },
    locs:     { amp: 0.560, f: (d, az, po) => 0.70 + 0.50 * Math.cos(az * 9) * Math.cos(po * 8) },
    puff:     { amp: 0.720, f: (d) => Math.pow(U01(d[2]), 0.7) * (0.65 + 0.65 * U01(d[1])) }
  };

  console.log('  SKULL FIT   c=[' + c.map((v) => (v / H).toFixed(3)).join(', ') +
              ']H  r=[' + r.map((v) => (v / H).toFixed(3)).join(', ') + ']H');

  const AZ = 40, PO = 26;   // grid resolution around and over the skull
  const out = { styles: {}, order: [] };

  for (const name of Object.keys(STYLES)) {
    const spec = STYLES[name];
    const first = shaded.tris.length;
    const grid = [];

    for (let i = 0; i <= PO; i++) {
      const po = (i / PO) * (Math.PI * 0.80);      // pole down past the nape
      const row = [];
      for (let k = 0; k <= AZ; k++) {
        const az = (k / AZ) * Math.PI * 2;
        const d = [
          Math.sin(po) * Math.sin(az),
          Math.sin(po) * Math.cos(az),
          Math.cos(po)
        ];
        const base = [c[0] + d[0] * r[0], c[1] + d[1] * r[1], c[2] + d[2] * r[2]];
        const t = cover(base) * spec.amp * Math.max(0, spec.f(d, az, po));
        const p = [
          c[0] + d[0] * r[0] * (1 + t),
          c[1] + d[1] * r[1] * (1 + t),
          c[2] + d[2] * r[2] * (1 + t)
        ];
        const L = Math.hypot(d[0] / r[0], d[1] / r[1], d[2] / r[2]) || 1;
        row.push(bodyVerts.push({
          p,
          n: [d[0] / r[0] / L, d[1] / r[1] / L, d[2] / r[2] / L],
          b0: BONE_INDEX.head, b1: BONE_INDEX.head, w0: 1,
          zone: ZONE.HAIR
        }) - 1);
      }
      grid.push(row);
    }

    // Only emit a quad where the style actually has substance, so a fade does
    // not pay for the polygons an afro needs down the back of the neck.
    for (let i = 0; i < PO; i++) {
      for (let k = 0; k < AZ; k++) {
        const a = grid[i][k], b = grid[i][k + 1], d2 = grid[i + 1][k], e = grid[i + 1][k + 1];
        const live = [a, b, d2, e].some((ix) => cover(bodyVerts[ix].p) > 0.02);
        if (!live) continue;
        /* Wound to match the body. Every bone matrix carries the court-to-GL
         * axis swap, which is a reflection, so the runtime draws the figure
         * with frontFace(CW) — see Skin.draw. A shell wound the other way is
         * not subtly wrong, it is invisible: back-face culling eats it whole
         * and every haircut silently renders as the bare scalp. */
        shaded.tris.push([a, b, d2], [b, e, d2]);
      }
    }

    out.styles[name] = { start: first * 3, count: (shaded.tris.length - first) * 3 };
    out.order.push(name);
  }
  return out;
}

/* --------------------------------------------------------------- the face
 * The model ships a blank head: a smooth ovoid with nothing on the front of
 * it. At the distance the game is usually played that reads as a mannequin,
 * and in any close shot — the creator, a replay, the standby camera on the
 * front page — it is the first thing the eye goes to and the last thing it
 * forgives.
 *
 * Features are added the same way the haircuts were: small patches of extra
 * geometry laid on the surface the head already has, in a zone of their own so
 * the runtime can colour them. They sit in the BODY range rather than in a
 * style range, because everybody has a face.
 *
 * Deliberately restrained. Brows, eyes and a mouth are enough for a head to
 * read as a head at any distance this game draws one; a nose and lips modelled
 * in a couple of hundred triangles look worse than none, because the eye knows
 * exactly what a face should look like and notices every way it does not.
 */
function buildFace(bodyVerts, J) {
  const H = J.height;
  const head = bodyVerts.filter((v) =>
    (v.b0 === BONE_INDEX.head || v.b1 === BONE_INDEX.head) && v.p[2] > H * 0.885);
  if (head.length < 30) return 0;

  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const v of head) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], v.p[i]);
      hi[i] = Math.max(hi[i], v.p[i]);
    }
  }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const r = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];

  /* The front of the skull at a given (x, z), from the ellipsoid the head
   * fits. Laying the patches on the real surface rather than on a flat plane
   * in front of it is what stops an eye floating off the cheek when the head
   * turns. */
  const frontY = (x, z) => {
    const ex = (x - c[0]) / r[0], ez = (z - c[2]) / r[2];
    const k = 1 - ex * ex - ez * ez;
    return c[1] - r[1] * Math.sqrt(k > 0.04 ? k : 0.04);
  };

  const startTris = shaded.tris.length;
  const SEG = 14;

  /* One feature: an ellipse of `seg` segments laid on the face, pushed a
   * hair's breadth proud of it so it cannot z-fight with the skin under it. */
  function patch(cx, cz, rx, rz, proud) {
    const centre = bodyVerts.push({
      p: [cx, frontY(cx, cz) - proud, cz],
      n: [0, -1, 0],
      b0: BONE_INDEX.head, b1: BONE_INDEX.head, w0: 1,
      zone: ZONE.FACE
    }) - 1;
    const ring = [];
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const x = cx + Math.cos(a) * rx, z = cz + Math.sin(a) * rz;
      ring.push(bodyVerts.push({
        p: [x, frontY(x, z) - proud * 0.55, z],
        n: [0, -1, 0],
        b0: BONE_INDEX.head, b1: BONE_INDEX.head, w0: 1,
        zone: ZONE.FACE
      }) - 1);
    }
    for (let i = 0; i < SEG; i++) {
      // Wound to match the body — the bone matrices carry the court-to-GL
      // reflection, so the figure draws with frontFace(CW).
      shaded.tris.push([centre, ring[i], ring[(i + 1) % SEG]]);
    }
  }

  /* Sized small on purpose. The first pass used eyes twice this wide and they
   * read as empty sockets rather than eyes — at this polygon count a feature
   * that is too big stops being a shape and becomes a hole. The brows sat
   * higher too, and disappeared under the hairline, which starts at 0.960H. */
  const eyeX = H * 0.0150, proud = H * 0.0016;
  patch(+eyeX, H * 0.9370, H * 0.0070, H * 0.0036, proud);   // eyes
  patch(-eyeX, H * 0.9370, H * 0.0070, H * 0.0036, proud);
  patch(+eyeX, H * 0.9468, H * 0.0106, H * 0.0021, proud);   // brows, clear of the hair
  patch(-eyeX, H * 0.9468, H * 0.0106, H * 0.0021, proud);
  patch(0, H * 0.9105, H * 0.0112, H * 0.0025, proud);       // mouth

  return shaded.tris.length - startTris;
}

const FACE_TRIS = buildFace(best.verts, J);
console.log('  face        ' + FACE_TRIS + ' triangles');

const bodyTris = shaded.tris.length;
const bodyVertCount = best.verts.length;
const HAIR = buildHair(best.verts, J);
console.log('  hair        ' + HAIR.order.length + ' styles, ' +
            (shaded.tris.length - bodyTris) + ' triangles, ' +
            (best.verts.length - bodyVertCount) + ' vertices');

const zoneCount = [0, 0, 0, 0, 0];
for (const v of verts) zoneCount[v.zone]++;
{
  const H = J.height;
  const hair = verts.filter((v) => v.zone === 4);
  const zs = hair.map((v) => v.p[2] / H).sort((a, b) => a - b);
  const jerseyTop = verts.filter((v) => v.zone === 1).reduce((m, v) => Math.max(m, v.p[2]), 0);
  console.log('  HAIR DIAG   n=' + hair.length +
    '  z/H lowest=' + zs[0].toFixed(3) +
    ' med=' + zs[Math.floor(zs.length * 0.5)].toFixed(3) +
    ' top=' + zs[zs.length - 1].toFixed(3) +
    '  jersey top=' + (jerseyTop / H).toFixed(3) +
    '  gap=' + ((zs[0] - jerseyTop / H) * 100).toFixed(1) + '% of stature');
}
console.log('  final zones skin ' + zoneCount[0] + '  jersey ' + zoneCount[1] +
            '  shorts ' + zoneCount[2] + '  shoe ' + zoneCount[3] + '  hair ' + zoneCount[4]);

const asset = pack(best.verts, best.tris, J);
/* Where the body stops and the haircuts start. The runtime draws
 * [0, bodyIndexCount) for the figure, then one style's range on top. */
asset.bodyIndexCount = bodyTris * 3;
asset.hairStyles = HAIR.styles;
asset.hairOrder = HAIR.order;
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
