/* =============================================================================
 * inspect_mesh.js  —  Look at the baked mesh, painted by the bone that moves it.
 * -----------------------------------------------------------------------------
 * The suite can tell you a bone's numbers are self-consistent. It cannot tell
 * you the bone is running backwards through the mesh it carries — that shipped
 * once, at 337/337 green, and what caught it was a picture: the shoe came out
 * half red and half blue, so the shin plainly owned half the foot.
 *
 * So this draws the bind-pose mesh with each vertex coloured by the bone with
 * the greater weight, and the bind skeleton laid over the top. No GL, no
 * browser — it rasterises straight out of the baked buffers, which means it
 * also works on a mesh the game cannot yet load.
 *
 * Usage:
 *   node tools/inspect_mesh.js out.png [mesh.js] [--region legs|arms|torso|head|all]
 *
 * Red/blue/green cycle per limb chain so neighbouring bones always contrast.
 * Left view is the side (model faces LEFT, -y), right view is the front.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = process.argv[2] || 'mesh.png';
const MESH = process.argv[3] && !process.argv[3].startsWith('--')
  ? process.argv[3]
  : path.resolve(__dirname, '../js/render/playerMesh.js');
const ri = process.argv.indexOf('--region');
const REGION = ri >= 0 && process.argv[ri + 1] ? process.argv[ri + 1] : 'all';

/* Which slice of the figure to frame, as fractions of stature. */
const REGIONS = {
  all:   [0.00, 1.00],
  legs:  [0.00, 0.55],
  feet:  [0.00, 0.20],
  torso: [0.35, 0.90],
  arms:  [0.35, 0.90],
  head:  [0.80, 1.05]
};

global.window = global;
global.BB = {};
require(MESH);
const M = global.BB.PLAYER_MESH;
if (!M) { console.error('no BB.PLAYER_MESH in ' + MESH); process.exit(1); }

const qp = Buffer.from(M.buffers.pos, 'base64');
const qs = Buffer.from(M.buffers.skin, 'base64');
const idx = Buffer.from(M.buffers.idx, 'base64');
const lo = M.bounds.lo, ext = M.bounds.ext, H = M.height;
const n = M.vertexCount;

const P = new Float64Array(n * 3);
const B0 = new Uint8Array(n), B1 = new Uint8Array(n);
const W0 = new Float64Array(n);
for (let i = 0; i < n; i++) {
  for (let k = 0; k < 3; k++) {
    const q = qp[i * 6 + k * 2] | (qp[i * 6 + k * 2 + 1] << 8);
    P[i * 3 + k] = lo[k] + (q / 65535) * ext[k];
  }
  B0[i] = qs[i * 4]; B1[i] = qs[i * 4 + 1]; W0[i] = qs[i * 4 + 2] / 255;
}

/* Colour per bone. Adjacent bones in a chain must contrast, or a bone running
 * into its neighbour's territory is invisible — which is the whole point. */
const HUE = {
  pelvis: [230, 200, 70], torso: [150, 150, 165], head: [220, 220, 230],
  upperArmL: [255, 70, 60], forearmL: [70, 160, 255], handL: [255, 210, 60],
  upperArmR: [200, 60, 120], forearmR: [60, 210, 220], handR: [255, 150, 40],
  thighL: [90, 220, 130], shinL: [70, 160, 255], footL: [255, 70, 60],
  thighR: [140, 230, 90], shinR: [60, 210, 220], footR: [200, 60, 120]
};
const COL = M.bones.map((b) => HUE[b] || [255, 0, 255]);

/* ------------------------------------------------------------------ raster */
const [zLo, zHi] = REGIONS[REGION] || REGIONS.all;
const PAD = 24, VIEW_W = 520, IMG_H = 980;
const IMG_W = VIEW_W * 2;
const px = Buffer.alloc(IMG_W * IMG_H * 3, 22);
const zb = new Float64Array(IMG_W * IMG_H).fill(-1e30);
const span = (zHi - zLo) * H;
const scale = (IMG_H - PAD * 2) / span;

function project(p, view) {
  // view 0: side, looking down +x — the model faces -y, so forward is LEFT.
  // view 1: front, looking down +y.
  const sx = view === 0 ? p[1] : p[0];
  const depth = view === 0 ? p[0] : -p[1];
  return [
    VIEW_W * view + VIEW_W * 0.5 + sx * scale,
    IMG_H - PAD - (p[2] - zLo * H) * scale,
    depth
  ];
}

function tri(t, c) {
  return M.wideIndex ? idx.readUInt32LE((t * 3 + c) * 4) : idx.readUInt16LE((t * 3 + c) * 2);
}

function shade(a, b, c, col) {
  for (let v = 0; v < 2; v++) {
    const A = project(a, v), B = project(b, v), C = project(c, v);
    const d = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
    if (Math.abs(d) < 1e-9) continue;
    const x0 = Math.max(VIEW_W * v, Math.floor(Math.min(A[0], B[0], C[0])));
    const x1 = Math.min(VIEW_W * (v + 1) - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1])));
    const y1 = Math.min(IMG_H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w0 = ((B[0] - x) * (C[1] - y) - (C[0] - x) * (B[1] - y)) / d;
        const w1 = ((C[0] - x) * (A[1] - y) - (A[0] - x) * (C[1] - y)) / d;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
        const o = y * IMG_W + x;
        if (z <= zb[o]) continue;
        zb[o] = z;
        px[o * 3] = col[0]; px[o * 3 + 1] = col[1]; px[o * 3 + 2] = col[2];
      }
    }
  }
}

function mixBone(i) {
  const a = COL[B0[i]] || [255, 0, 255];
  const b = COL[B1[i]] || [255, 0, 255];
  const w = W0[i];
  return [a[0] * w + b[0] * (1 - w), a[1] * w + b[1] * (1 - w), a[2] * w + b[2] * (1 - w)];
}

const bodyTris = M.bodyIndexCount ? M.bodyIndexCount / 3 : M.triCount;
let drawn = 0;
for (let t = 0; t < bodyTris; t++) {
  const i0 = tri(t, 0), i1 = tri(t, 1), i2 = tri(t, 2);
  const a = [P[i0 * 3], P[i0 * 3 + 1], P[i0 * 3 + 2]];
  const b = [P[i1 * 3], P[i1 * 3 + 1], P[i1 * 3 + 2]];
  const c = [P[i2 * 3], P[i2 * 3 + 1], P[i2 * 3 + 2]];
  const mid = (a[2] + b[2] + c[2]) / 3;
  if (mid < zLo * H || mid > zHi * H) continue;
  if (REGION === 'arms' && Math.abs((a[0] + b[0] + c[0]) / 3) < H * 0.06) continue;
  drawn++;
  /* Blend the two bones' colours by their weights rather than painting the
   * stronger one outright.
   *
   * Picking a winner is what a "which bone owns this" view wants to do, and it
   * lies exactly where it matters most: across a joint the weights pass through
   * 50/50, so the winner flips from vertex to vertex and a perfectly smooth
   * blend renders as a violent sawtooth. That reads as a tear in a mesh that
   * has none. Blending shows the real thing — a gradient where the weights are
   * graded, a hard line only where they genuinely jump. */
  const col = mixBone(i0);
  // Cheap lambert so the form reads instead of coming out as a flat silhouette.
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const L = Math.hypot(nx, ny, nz) || 1;
  const lam = 0.45 + 0.55 * Math.abs((nx * 0.4 - ny * 0.7 + nz * 0.55) / L);
  shade(a, b, c, col.map((v) => Math.min(255, v * lam) | 0));
}

/* The bind skeleton over the top, in white, so a bone that misses its own mesh
 * is visible as a line running outside the colour it is supposed to own. */
function line(a, b, col) {
  for (let v = 0; v < 2; v++) {
    const A = project(a, v), B = project(b, v);
    const steps = Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1])) + 1;
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(A[0] + (B[0] - A[0]) * s / steps);
      const y = Math.round(A[1] + (B[1] - A[1]) * s / steps);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < VIEW_W * v || xx >= VIEW_W * (v + 1) || yy < 0 || yy >= IMG_H) continue;
          const o = yy * IMG_W + xx;
          px[o * 3] = col[0]; px[o * 3 + 1] = col[1]; px[o * 3 + 2] = col[2];
        }
      }
    }
  }
}
for (const name of M.bones) {
  const s = M.bind[name];
  if (!s) continue;
  const mid = (s[0][2] + s[1][2]) / 2;
  if (mid < zLo * H - H * 0.05 || mid > zHi * H + H * 0.05) continue;
  line(s[0], s[1], [255, 255, 255]);
}
line([-H, -H, 0], [H, H, 0], [110, 110, 110]);           // the floor

/* -------------------------------------------------------------------- PNG */
const raw = Buffer.alloc((IMG_W * 3 + 1) * IMG_H);
for (let y = 0; y < IMG_H; y++) {
  raw[y * (IMG_W * 3 + 1)] = 0;
  px.copy(raw, y * (IMG_W * 3 + 1) + 1, y * IMG_W * 3, (y + 1) * IMG_W * 3);
}
let TBL = null;
function crc32(buf) {
  if (!TBL) {
    TBL = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TBL[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return c ^ -1;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(IMG_W, 0); ihdr.writeUInt32BE(IMG_H, 4);
ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(OUT, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
]));

console.log('wrote ' + OUT + '  (' + REGION + ', ' + drawn + ' triangles)');
console.log('  left = side view, model faces LEFT   |   right = front view');
console.log('  each vertex is painted by the bone that moves it; white = bind skeleton');
