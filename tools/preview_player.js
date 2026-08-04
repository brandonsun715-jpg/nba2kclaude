/* =============================================================================
 * preview_player.js  —  Close-up renders of the player model.
 * -----------------------------------------------------------------------------
 * The scene checks in verify_render.js prove the frame draws; they say nothing
 * about whether the figure on it looks like a basketball player. This pushes
 * the camera in tight on a single athlete, drives them into a named pose, and
 * writes a PNG per pose so proportions, jersey fit and posture can be judged by
 * eye instead of guessed at from a 40-pixel-tall silhouette.
 *
 * It also prints the figure's measured proportions as a fraction of standing
 * height, which is the part that can be checked without looking at anything:
 * an eight-heads-tall build puts the head at 12.5% of stature, the shoulder
 * line at 81%, and the hip at 49%.
 *
 * Usage: node preview_player.js [pose ...]     (default: every pose)
 * ========================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_BIN ||
  '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(__dirname, 'shots');

/* Each pose is a snippet run against `pl`, the player under the lens, after the
 * scene has settled. They cover the states the body reads differently in:
 * standing, moving, defending, and at full overhead extension. */
const POSES = {
  idle: '',
  run: 'pl.vx = 0; pl.vy = -13; pl.facing = -Math.PI / 2; pl.stridePhase = 1.1; pl.sprinting = true;',
  guard: 'pl.isGuarding = true; pl._guardBlend = 1;',
  dribble: 'pl.hasBall = true; pl.dribblePhase = 0.5;',
  shoot: 'pl.action = "meter"; pl.actionT = 0.2; pl.meter.value = 0.85; pl.armRaise = 1;'
};

/* The broadcast rig is bolted to the sideline — its closest approach to a
 * player at centre court is about 25 feet, which is a whole basketball court
 * too far away to judge a jersey seam. Rather than bend the real camera into a
 * shape the game never uses, the preview swaps in its own _rebuild(): a plain
 * lookAt from eleven feet away at chest height, three-quarter view. */
const CAM = `
  var cam = BB.Camera, M4 = BB.M4;
  cam._rebuild = function () {
    var eye = [pl.x + 3.2, 3.6, pl.y + 11.0];
    var at = [pl.x, 2.7, pl.y];
    this.eye[0] = eye[0]; this.eye[1] = eye[1]; this.eye[2] = eye[2];
    this.target[0] = at[0]; this.target[1] = at[1]; this.target[2] = at[2];
    M4.perspective(this.proj, 40 * Math.PI / 180,
                   this.vw / Math.max(1, this.vh), 0.6, 420);
    M4.lookAt(this.view, this.eye, this.target, [0, 1, 0]);
    M4.multiply(this.viewProj, this.proj, this.view);
  };
  cam._rebuild();
`;

function shot(name, poseSrc) {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(ROOT, '__preview.html');
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const withCapture = src.replace('<script src="js/core/constants.js"></script>',
    '<script>window.__HW_CAPTURE = true;</script>\n  <script src="js/core/constants.js"></script>');

  fs.writeFileSync(file, withCapture.replace('</body>', `
  <script>
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var BB = window.BB;
      var boot = document.getElementById('boot');
      if (boot) boot.parentNode.removeChild(boot);
      var menu = document.getElementById('screens');
      if (menu) menu.innerHTML = '';
      var hud = document.getElementById('hud'); if (hud) hud.innerHTML = '';
      var ph = document.getElementById('practice-hud'); if (ph) ph.innerHTML = '';

      BB.Engine.setState('oneVone'); BB.Engine._applyPending();
      BB.Engine.stop();
      var scene = BB.Engine.scene;
      for (var i = 0; i < 200; i++) {
        scene.fixedUpdate(1 / 120);
        if (i % 2 === 0) scene.update(1 / 60, 1 / 60);
      }

      var pl = (scene.entities || [])[0] || scene.player;
      // Square the figure up to the camera side so the build reads, then hold
      // it still: this is a model sheet, not an action shot.
      pl.x = 47; pl.y = 25; pl.z = 0;
      pl.vx = pl.vy = pl.vz = 0;
      pl.facing = pl.moveFacing = Math.PI * 0.34;
      pl.jumping = false; pl.hasBall = false; pl.isGuarding = false;
      pl.action = null; pl.moveState = null; pl.armRaise = 0;
      ${poseSrc}
      pl._updatePose(1 / 60);
      // Everyone else off camera, so nothing overlaps the subject.
      (scene.entities || []).forEach(function (e) { if (e !== pl) { e.x = -80; e.y = -80; } });
      if (scene.ball) {
        // Keep the ball only when the pose is about holding one, and put it
        // where the player's hand actually is so the two can be compared.
        if (pl.hasBall) {
          scene.ball.owner = pl;
          var hp = pl.handPosition(null);
          scene.ball.place(hp.x, hp.y, hp.z);
        } else { scene.ball.x = -80; scene.ball.y = -80; }
      }
      ${CAM}
      scene.render(0);
    } catch (e) { document.title = 'ERR ' + e.message; }
  });
  </script>
</body>`));

  const png = path.join(OUT, 'player_' + name + '.png');
  try {
    execFileSync(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--allow-file-access-from-files', '--hide-scrollbars',
      '--window-size=560,760',
      '--screenshot=' + png, 'file://' + file
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 120000 });
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return png;
}

/* ------------------------------------------------------- measured proportions
 * Read straight off the solved skeleton, so the numbers describe the figure
 * that actually renders rather than the constants it was built from.
 */
function measure() {
  const file = path.join(ROOT, '__measure.html');
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(file, src.replace('</body>', `
  <script>
  document.addEventListener('DOMContentLoaded', function () {
    var out = null, err = null;
    try {
      var BB = window.BB;
      BB.Engine.setState('oneVone'); BB.Engine._applyPending();
      var scene = BB.Engine.scene;
      var pl = (scene.entities || [])[0] || scene.player;
      pl.vx = pl.vy = 0; pl.action = null; pl.hasBall = false;
      pl._updatePose(1 / 60);
      var p = pl.pose;
      // Pose space has the foot at 0 and up as negative, so a joint's height
      // above the floor is just -y. Stature is the crown of the head.
      var crown = -p.headY + (BB.Player.BONE ? BB.Player.BONE.headR : 0);
      out = {
        stature: crown,
        headPct: (BB.Player.BONE ? BB.Player.BONE.headR * 2 : 0) / crown,
        shoulderPct: -p.shoulderY / crown,
        hipPct: -p.hipY / crown,
        kneePct: -p.kneeL.jy / crown,
        shoulderSpanPct: (BB.Player.BONE ? BB.Player.BONE.shoulderW * 2 : 0) / crown,
        hipSpanPct: (BB.Player.BONE ? BB.Player.BONE.hipW * 2 : 0) / crown,
        kneeBendDeg: (function () {
          // Interior angle at the knee between thigh and shin.
          var k = p.kneeL, hipX = -BB.Player.BONE.hipW;
          var ax = hipX - k.jx, ay = p.hipY - k.jy;
          var bx = k.ex - k.jx, by = k.ey - k.jy;
          var d = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
          return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
        })()
      };
    } catch (e) { err = (e && e.stack) || String(e); }
    var el = document.createElement('pre');
    el.id = 'probe-result';
    el.textContent = JSON.stringify({ out: out, err: err });
    document.body.appendChild(el);
  });
  </script>
</body>`));

  let dom;
  try {
    dom = execFileSync(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--allow-file-access-from-files', '--window-size=1280,720',
      '--dump-dom', 'file://' + file
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90000 });
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const m = dom.match(/<pre id="probe-result">([\s\S]*?)<\/pre>/);
  if (!m) throw new Error('measurement probe produced no result');
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
}

/* -------------------------------------------------------------------- run it */

const want = process.argv.slice(2).filter((a) => POSES[a] != null);
const list = want.length ? want : Object.keys(POSES);

console.log('\nHARDWOOD — player model preview\n');

const r = measure();
if (r.err) {
  console.log('  measurement failed: ' + r.err);
} else {
  const o = r.out;
  const pct = (v) => (v * 100).toFixed(1) + '%';
  console.log('  proportions, as a fraction of standing height');
  console.log('    head height     ' + pct(o.headPct) + '   (8-heads-tall figure: 12.5%)');
  console.log('    shoulder line   ' + pct(o.shoulderPct) + '   (reference: 81%)');
  console.log('    hip line        ' + pct(o.hipPct) + '   (reference: 49%)');
  console.log('    knee line       ' + pct(o.kneePct) + '   (reference: 25%)');
  console.log('    shoulder span   ' + pct(o.shoulderSpanPct) + '   joint to joint');
  console.log('    hip span        ' + pct(o.hipSpanPct));
  console.log('    shoulder : hip  ' + (o.shoulderSpanPct / o.hipSpanPct).toFixed(2) + ' : 1');
  console.log('    knee angle      ' + o.kneeBendDeg.toFixed(1) + ' deg at rest  (180 = locked out)');
}

console.log('\n  renders');
for (const name of list) {
  const f = shot(name, POSES[name]);
  console.log('    ' + name.padEnd(9) + ' ' + (fs.statSync(f).size / 1024).toFixed(0) + ' KB');
}
console.log('  -> ' + OUT + '\n');
