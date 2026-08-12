/* =============================================================================
 * pose_sheet.js  —  A contact sheet of every pose the player can be in.
 * -----------------------------------------------------------------------------
 * The verification suite measures the body. It cannot LOOK at it, and the
 * difference matters: the rig once shipped 337/337 green with the shoes on
 * backwards, because every number involved was self-consistent and nothing
 * compared the drawn figure against the mesh it was drawing. A picture caught
 * that in one glance.
 *
 * So this renders the player through the whole motion matrix and writes the
 * frames out for eyeball review. There are eighteen distinct poses, not the
 * eleven in the ACTION enum: METER has three separate branches (jumper, layup,
 * dunk), LAYUP has three sub-styles, and the dribble moves, the guard stance,
 * the airborne tuck and the dribble carry are all driven by state that is not
 * `action` at all.
 *
 * Usage:
 *   node tools/pose_sheet.js                 every pose, side on
 *   node tools/pose_sheet.js --angle front   from the front
 *   node tools/pose_sheet.js --only dunk     one pose (substring match)
 *   node tools/pose_sheet.js --phases 5      samples through each pose
 *
 * Frames land in tools/sheet/<angle>/<pose>_<phase>.png.
 * ========================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CHROME = process.env.CHROME_BIN ||
  '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(__dirname, 'sheet');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ANGLE = argOf('--angle', 'side');
const ONLY = argOf('--only', null);
const PHASES = Math.max(1, +argOf('--phases', 3));

/* Camera. The rig is a broadcast follow camera, so a pose sheet has to park it
 * by hand: `tight` mode plus reset() puts it where we ask and snap() stops it
 * easing away again on the frame we capture. */
const ANGLES = {
  side:  { turn: 0,          zoom: 9 },
  front: { turn: Math.PI / 2, zoom: 9 },
  three: { turn: Math.PI / 4, zoom: 9 }
};

/* -----------------------------------------------------------------------------
 * The motion matrix.
 *
 * Each entry gets `p` (the player), `t` in 0..1 (its phase through the pose)
 * and `BB`. It must leave the player in the state that pose is drawn from;
 * _updatePose is called afterwards, so nothing here should call it itself.
 *
 * `facing` and `moveFacing` are pinned and velocity is set explicitly, because
 * the base layer picks the run cycle or the idle layer off speed alone.
 * -------------------------------------------------------------------------- */
const POSES = [
  ['idle', `
    p.vx = 0; p.vy = 0; p.hasBall = false;
    p._animClock = t * 4;`],

  ['walk', `
    p.vx = p.phys.maxSpeed * 0.35; p.vy = 0;
    p.stridePhase = t * Math.PI * 2;`],

  ['run', `
    p.vx = p.phys.maxSpeed; p.vy = 0;
    p.stridePhase = t * Math.PI * 2;`],

  ['sprint', `
    p.sprinting = true; p.vx = p.phys.maxSprint; p.vy = 0;
    p.stridePhase = t * Math.PI * 2;`],

  ['dribble_carry', `
    p.vx = 0; p.vy = 0; p.hasBall = true;
    p.dribblePhase = t * Math.PI * 2;`],

  ['guard', `
    p.vx = 0; p.vy = 0; p.hasBall = false;
    p.isGuarding = true; p._guardBlend = 1;`],

  ['guard_jab', `
    p.vx = 0; p.vy = 0; p.hasBall = false;
    p.isGuarding = true; p._guardBlend = 1;
    p._animClock = t * 2;`],

  ['airborne', `
    p.jumping = true; p.z = 1.2; p.vx = 0; p.vy = 0;`],

  ['crossover', `
    p.hasBall = true; p.moveState = 'crossover';
    p.moveT = t * 0.30;`],

  ['behind_back', `
    p.hasBall = true; p.moveState = 'behindBack';
    p.moveT = t * 0.36;`],

  ['spin', `
    p.hasBall = true; p.moveState = 'spin';
    p.moveT = t * 0.46;`],

  ['hesitation', `
    p.hasBall = true; p.moveState = 'hesitation';
    p.moveT = t * 0.42;`],

  ['gather', `
    p.hasBall = true; p.action = A.GATHER;
    p.actionT = t * 0.10;`],

  ['meter_jumper', `
    p.hasBall = true; p.action = A.METER; p.shotType = 'jumper';
    p.meter.start({ riseTime: 0.4, target: 0.94, greenWindow: 0.2, name: 'x' },
                  { x: p.x, y: p.y, z: 0 });
    p.meter.value = t;`],

  ['meter_layup', `
    p.hasBall = true; p.action = A.METER; p.shotType = 'layup';
    p.driving = true;
    p.meter.start({ riseTime: 0.4, target: 0.94, greenWindow: 0.2, name: 'x' },
                  { x: p.x, y: p.y, z: 0 });
    p.meter.value = t;`],

  ['meter_dunk', `
    p.hasBall = true; p.action = A.METER; p.shotType = 'dunk';
    p.driving = true;
    p.meter.start({ riseTime: 0.4, target: 0.94, greenWindow: 0.2, name: 'x' },
                  { x: p.x, y: p.y, z: 0 });
    p.meter.value = t;`],

  ['release', `
    p.action = A.RELEASE; p.actionT = t * 0.30;`],

  ['layup_driving', `
    p.action = A.LAYUP; p.layupStyle = null; p.driving = true;
    p.jumping = true; p.z = 1.1;
    p.actionT = t * 0.60;`],

  ['layup_euro', `
    p.action = A.LAYUP; p.layupStyle = 'euro'; p.driving = true;
    p.jumping = true; p.z = 1.0;
    p.actionT = t * 0.60;`],

  ['layup_hop', `
    p.action = A.LAYUP; p.layupStyle = 'hop'; p.driving = true;
    p.jumping = true; p.z = 1.0;
    p.actionT = t * 0.60;`],

  ['dunk', `
    p.action = A.DUNK; p.jumping = true; p.z = 2.4;
    p.actionT = t * 0.45;`],

  ['block', `
    p.action = A.BLOCK; p.jumping = true; p.z = 1.8;
    p.actionT = t * 0.45;`],

  ['steal', `
    p.action = A.STEAL; p.actionT = t * 0.30;`]
];

/* ------------------------------------------------------------------ framing
 * The game's camera is a broadcast follow rig with its own idea of how close is
 * close enough, and at its tightest the figure is still a couple of hundred
 * pixels tall — fine for judging a play, useless for judging a shoulder. So the
 * frame is rendered at four times the pixels and cropped down to the player
 * afterwards. Cropping rather than zooming keeps the pose identical to the one
 * the game actually draws; only the framing changes.
 */
const SHOT_W = 2560, SHOT_H = 1440;
// The rig centres on the player, so the figure lands in a predictable box. Tall
// enough to keep a dunker's hands and a planted foot in the same frame.
const CROP = { x: 940, y: 250, w: 680, h: 900 };

function readPng(file) {
  const buf = fs.readFileSync(file);
  let o = 8, idat = [], w = 0, h = 0, bpp = 3;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') {
      w = buf.readUInt32BE(o + 8); h = buf.readUInt32BE(o + 12);
      bpp = buf[o + 17] === 6 ? 4 : buf[o + 17] === 2 ? 3 : 1;
    }
    if (type === 'IDAT') idat.push(buf.slice(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const img = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const row = raw.slice(p, p + stride); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? img[y * stride + i - bpp] : 0;
      const b = y > 0 ? img[(y - 1) * stride + i] : 0;
      const c = (i >= bpp && y > 0) ? img[(y - 1) * stride + i - bpp] : 0;
      let v = row[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      img[y * stride + i] = v & 255;
    }
  }
  return { w, h, bpp, img };
}

let CRC = null;
function crc32(b) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return c ^ -1;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, cr]);
}

/** Crops in place to the player's box, so the written file is the useful one. */
function cropToPlayer(file) {
  const src = readPng(file);
  const x0 = Math.min(CROP.x, Math.max(0, src.w - CROP.w));
  const y0 = Math.min(CROP.y, Math.max(0, src.h - CROP.h));
  const w = Math.min(CROP.w, src.w), h = Math.min(CROP.h, src.h);
  const out = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    out[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const si = (y0 + y) * src.w * src.bpp + (x0 + x) * src.bpp;
      const di = y * (w * 3 + 1) + 1 + x * 3;
      out[di] = src.img[si]; out[di + 1] = src.img[si + 1]; out[di + 2] = src.img[si + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))
  ]));
}

/* ------------------------------------------------------------------ harness */

function shoot(name, phase, t) {
  const file = path.join(ROOT, '__sheet.html');
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const cam = ANGLES[ANGLE] || ANGLES.side;

  const withCapture = src.replace('<script src="js/core/constants.js"></script>',
    '<script>window.__HW_CAPTURE = true;</script>\n  <script src="js/core/constants.js"></script>');

  const setup = POSES.find((e) => e[0] === name)[1];

  fs.writeFileSync(file, withCapture.replace('</body>', `
  <script>
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var BB = window.BB, A = BB.Player.ACTION;
      var boot = document.getElementById('boot');
      if (boot) boot.parentNode.removeChild(boot);
      var menu = document.getElementById('screens');
      if (menu) menu.innerHTML = '';

      BB.Engine.setState('shootaround');
      BB.Engine._applyPending();
      BB.Engine.stop();
      var scene = BB.Engine.scene;

      /* Let the scene settle, then take it over. Stepping first means the
       * court, lighting and camera are live; everything after this line is
       * this tool driving one figure by hand. */
      for (var i = 0; i < 20; i++) {
        if (scene.fixedUpdate) scene.fixedUpdate(1 / 120);
        if (i % 2 === 0 && scene.update) scene.update(1 / 60, 1 / 60);
      }

      var p = scene.player || (scene.players && scene.players[0]);
      var t = ${t};
      p.placeAt(47, 25, 0);
      p.facing = p.moveFacing = 0;
      p.vx = 0; p.vy = 0;
      p.sprinting = false; p.jumping = false; p.hasBall = false;
      p.action = null; p.actionT = 0; p.moveState = null; p.moveT = 0;
      p.isGuarding = false; p._guardBlend = 0; p.driving = false;
      p.stridePhase = 0; p.z = 0;

      ${setup}

      p._updatePose(1 / 60);

      BB.Camera.setMode('tight');
      BB.Camera.reset(p.x, p.y, ${cam.zoom});
      BB.Camera.snap();
      /* The camera orbits by moving the player's facing instead of the rig,
       * because the broadcast rig has no orbit of its own. Facing is set after
       * the pose is solved, so the pose itself is identical at every angle. */
      p.facing = ${cam.turn};

      if (scene.render) scene.render(0);
      document.title = 'OK';
    } catch (e) { document.title = 'ERR ' + (e.stack || e.message); }
  });
  </script>
</body>`));

  const dir = path.join(OUT, ANGLE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const png = path.join(dir, name + '_' + phase + '.png');
  try {
    execFileSync(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--allow-file-access-from-files', '--hide-scrollbars',
      '--window-size=' + SHOT_W + ',' + SHOT_H,
      '--screenshot=' + png, 'file://' + file
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 180000 });
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  if (fs.existsSync(png)) cropToPlayer(png);
  return png;
}

/* ---------------------------------------------------------------------- run */

const list = POSES.filter((e) => !ONLY || e[0].indexOf(ONLY) >= 0);
if (!list.length) {
  console.error('no pose matches "' + ONLY + '"');
  console.error('poses: ' + POSES.map((e) => e[0]).join(', '));
  process.exit(1);
}

console.log('\nNBA 1K26 — pose sheet (' + ANGLE + ', ' + PHASES + ' phase(s) each)\n');
let n = 0;
for (const [name] of list) {
  const cells = [];
  for (let i = 0; i < PHASES; i++) {
    // Phases span the pose without ever sampling t=1 exactly, which on a timed
    // action is the frame after it has already ended.
    const t = PHASES === 1 ? 0.5 : (i / PHASES) + (0.5 / PHASES);
    const f = shoot(name, i, t);
    cells.push(fs.existsSync(f) ? (fs.statSync(f).size / 1024).toFixed(0) + 'K' : 'FAILED');
    n++;
  }
  console.log('  ' + name.padEnd(16) + cells.join('  '));
}
console.log('\n  ' + n + ' frames -> ' + path.join(OUT, ANGLE) + '\n');
