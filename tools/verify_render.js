/* =============================================================================
 * verify_render.js  —  Headless render verification for HARDWOOD's 3D build.
 * -----------------------------------------------------------------------------
 * Runs the real game in headless Chrome with WebGL2 (SwiftShader), boots each
 * scene, and checks the things that silently break a 3D renderer:
 *
 *   - shaders compile and programs link
 *   - the GL context never raises an error during a frame
 *   - the framebuffer is not a flat colour (i.e. something actually rendered)
 *   - instance buffers are populated and never overflow their capacity
 *   - camera projection round-trips: project(unproject(p)) == p
 *   - the ball's projected screen position tracks its world position
 *
 * Screenshots are written to shots/ for eyeball review.
 *
 * Usage: node verify_render.js [--shots]
 * ========================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_BIN ||
  '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(__dirname, 'shots');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

/* ------------------------------------------------------------------ harness */

/**
 * Runs a snippet of JS inside the loaded game and returns its JSON result.
 * The page is driven through Chrome's --dump-dom, with the payload writing its
 * result into document.title — crude, but it needs no DevTools protocol client
 * and no network access, both of which are unavailable in this sandbox.
 */
function runInPage(payload, label) {
  const file = path.join(ROOT, '__probe.html');
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // The probe is appended AFTER main.js, so its DOMContentLoaded listener is
  // registered after the game's and therefore runs once boot() has completed.
  // Everything is then done before the load event, which is the moment
  // --dump-dom captures the DOM — no timers, no waiting on real frames.
  const probe = src.replace('</body>', `
  <script>
  window.__pageErr = null;
  window.addEventListener('error', function (e) {
    window.__pageErr = (window.__pageErr || '') + '\\n' + (e.message || e);
  });
  document.addEventListener('DOMContentLoaded', function () {
    var out = null, err = null;
    try { out = (function () { ${payload} })(); }
    catch (e) { err = (e && e.stack) || String(e); }
    var el = document.createElement('pre');
    el.id = 'probe-result';
    el.textContent = JSON.stringify({ out: out, err: err, pageErr: window.__pageErr });
    document.body.appendChild(el);
  });
  </script>
</body>`);
  fs.writeFileSync(file, probe);

  let dom;
  try {
    dom = execFileSync(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--allow-file-access-from-files',
      '--window-size=1280,720',
      '--dump-dom', 'file://' + file
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90000 });
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  const m = dom.match(/<pre id="probe-result">([\s\S]*?)<\/pre>/);
  if (!m) throw new Error('probe "' + label + '" produced no result (page failed to load)');
  const decoded = m[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  return JSON.parse(decoded);
}

/** Captures a PNG of a scene after letting it run for a moment. */
function screenshot(name, setup, ticks) {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(ROOT, '__shot.html');
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // Drive the simulation forward deterministically, then render, so the shot
  // captures live action rather than whatever frame happened to land first.
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
      if (menu && '${name}' !== 'menu') menu.innerHTML = '';
      ${setup}
      // Stop the animation loop so the frame rendered below is the frame the
      // screenshot captures; otherwise a later live frame overwrites it.
      BB.Engine.stop();
      var scene = BB.Engine.scene;
      for (var i = 0; i < ${ticks}; i++) {
        if (scene.fixedUpdate) scene.fixedUpdate(1 / 120);
        if (i % 2 === 0 && scene.update) scene.update(1 / 60, 1 / 60);
      }
      if (scene.render) scene.render(0);
    } catch (e) { document.title = 'ERR ' + e.message; }
  });
  </script>
</body>`));

  const png = path.join(OUT, name + '.png');
  try {
    execFileSync(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--allow-file-access-from-files', '--hide-scrollbars',
      '--window-size=1280,720',
      '--screenshot=' + png, 'file://' + file
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 120000 });
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return png;
}

/* -------------------------------------------------------------------- tests */

console.log('\nHARDWOOD — 3D render verification\n');

console.log('[1] boot + GL health');
{
  const r = runInPage(`
    var BB = window.BB;
    var gl = BB.GLX.gl;
    var res = {
      hasGL: !!gl,
      version: gl ? gl.getParameter(gl.VERSION) : null,
      s3ready: !!(BB.S3 && BB.S3.ready),
      glErrorAfterBoot: gl ? gl.getError() : -1,
      programs: !!(BB.S3.progSolid && BB.S3.progFloor && BB.S3.progShadow),
      meshKeys: Object.keys(BB.S3.meshes).length,
      engineState: BB.Engine.state,
      pageErr: window.__pageErr || null
    };
    return res;
  `, 'probe');
  if (r.err) { check('probe ran', false, r.err); }
  const o = r.out || {};
  check('WebGL2 context created', !!o.hasGL, o.version);
  check('no page-level JS errors', !o.pageErr && !r.pageErr, o.pageErr || r.pageErr);
  check('scene3d initialised', o.s3ready === true);
  check('all three programs linked', o.programs === true);
  check('primitive meshes built', o.meshKeys >= 12, 'meshes=' + o.meshKeys);
  check('gl.getError() clean after boot', o.glErrorAfterBoot === 0, 'code=' + o.glErrorAfterBoot);
}

console.log('\n[2] 1v1 scene renders real geometry');
{
  const r = runInPage(`
    var BB = window.BB;
    BB.Engine.setState('oneVone'); BB.Engine._applyPending();
    var scene = BB.Engine.scene;
    for (var j = 0; j < 300; j++) { scene.fixedUpdate(1/120); if (j % 2 === 0) scene.update(1/60, 1/60); }
    scene.render(0);
    var S3 = BB.S3, gl = BB.GLX.gl;
    var counts = {};
    var total = 0;
    for (var k in S3.meshes) { counts[k] = S3.meshes[k].n; total += S3.meshes[k].n; }
    var skinned = S3._poseCount;
    var over = [];
    for (var k2 in S3.meshes) if (S3.meshes[k2].n > S3.meshes[k2].capacity) over.push(k2);

    // Read back the centre of the framebuffer and a spread of sample points to
    // confirm the image is not a single flat colour.
    var px = new Uint8Array(4 * 9), uniq = {};
    var W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    var pts = [[0.5,0.5],[0.5,0.75],[0.3,0.6],[0.7,0.6],[0.5,0.35],[0.2,0.8],[0.8,0.8],[0.5,0.9],[0.15,0.5]];
    var samples = [];
    for (var s = 0; s < pts.length; s++) {
      var one = new Uint8Array(4);
      gl.readPixels(Math.floor(pts[s][0]*W), Math.floor(pts[s][1]*H), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
      var key = one[0] + ',' + one[1] + ',' + one[2];
      uniq[key] = 1;
      samples.push(key);
    }
    void px;
    return {
      total: total, counts: counts, over: over, skinned: skinned,
      meshVerts: BB.PLAYER_MESH ? BB.PLAYER_MESH.vertexCount : 0,
      bones: BB.PLAYER_MESH ? BB.PLAYER_MESH.bones.length : 0,
      skinReady: !!(BB.Skin && BB.Skin.ready),
      dropped: S3.dropped,
      distinctColors: Object.keys(uniq).length,
      samples: samples,
      glError: gl.getError(),
      pageErr: window.__pageErr || null
    };
  `, 'probe');
  if (r.err) check('1v1 probe ran', false, r.err);
  const o = r.out || {};
  check('no page errors during play', !o.pageErr, o.pageErr);
  check('instances submitted', o.total > 500, 'total=' + o.total);
  check('skinned player mesh loaded', o.skinReady === true &&
        o.meshVerts > 1000 && o.bones >= 12,
        'verts=' + o.meshVerts + ' bones=' + o.bones);
  check('both players submitted a skinned pose', o.skinned === 2, 'poses=' + o.skinned);
  check('crowd submitted', (o.counts && o.counts.crowd) > 500, 'crowd=' + (o.counts && o.counts.crowd));
  check('floor submitted', (o.counts && o.counts.floor) === 1, 'floor=' + (o.counts && o.counts.floor));
  check('net/glass submitted', (o.counts && (o.counts.segT + o.counts.panelT)) > 50,
        'segT=' + (o.counts && o.counts.segT) + ' panelT=' + (o.counts && o.counts.panelT));
  check('no instance-buffer overflow', o.dropped === 0, 'dropped=' + o.dropped);
  check('no mesh exceeded capacity', (o.over || []).length === 0, (o.over || []).join(','));
  check('framebuffer is not flat', o.distinctColors >= 4,
        'distinct=' + o.distinctColors + ' ' + JSON.stringify(o.samples));
  check('gl.getError() clean after frame', o.glError === 0, 'code=' + o.glError);
}

console.log('\n[3] camera projection round-trip');
{
  const r = runInPage(`
    var BB = window.BB, cam = BB.Camera;
    BB.Engine.setState('oneVone'); BB.Engine._applyPending();
    cam.reset(47, 25, 1);
    cam.setMode(cam.MODES.BROADCAST);
    cam.update(0.016, { x: 47, y: 25 }, null);

    var worst = 0, offCourt = 0;
    var pts = [[10,10],[47,25],[80,40],[5.25,25],[88.75,25],[47,4],[47,46]];
    for (var i = 0; i < pts.length; i++) {
      var p = cam.project(pts[i][0], pts[i][1], 0, null);
      if (p.behind) { offCourt++; continue; }
      var u = cam.unproject(p.x, p.y, null);
      worst = Math.max(worst, Math.hypot(u.x - pts[i][0], u.y - pts[i][1]));
    }

    // A point higher off the floor must project further UP the screen.
    var low = cam.project(47, 25, 0, null);
    var high = cam.project(47, 25, 10, null);
    // The rig sits outside the +y sideline, so a large y is NEAR the camera.
    var near = cam.project(47, 48, 0, null);
    var far = cam.project(47, 2, 0, null);

    return {
      worst: worst, offCourt: offCourt,
      heightGoesUp: high.y < low.y,
      farIsSmaller: far.s < near.s,
      farIsHigher: far.y < near.y,
      scale: cam.scale(),
      pan: [cam.panFor(5), cam.panFor(47), cam.panFor(89)]
    };
  `, 'probe');
  if (r.err) check('camera probe ran', false, r.err);
  const o = r.out || {};
  check('project/unproject round-trips', o.worst < 0.05, 'worst error=' + (o.worst || 0).toFixed(5) + 'ft');
  check('all court points in front of camera', o.offCourt === 0);
  check('height projects upward', o.heightGoesUp === true);
  check('distance shrinks scale', o.farIsSmaller === true);
  check('far side sits higher on screen', o.farIsHigher === true);
  check('audio pan spans left to right',
        o.pan && o.pan[0] < -0.1 && Math.abs(o.pan[1]) < 0.05 && o.pan[2] > 0.1,
        JSON.stringify(o.pan));
}

console.log('\n[4] ball and players track their world positions');
{
  const r = runInPage(`
    var BB = window.BB, cam = BB.Camera;
    BB.Engine.setState('oneVone'); BB.Engine._applyPending();
    var scene = BB.Engine.scene;
    for (var j = 0; j < 120; j++) { scene.fixedUpdate(1/120); if (j % 2 === 0) scene.update(1/60, 1/60); }
    cam.update(0.016, { x: scene.ball.x, y: scene.ball.y }, null);

    var a = cam.project(scene.ball.x, scene.ball.y, scene.ball.z, null);
    var b = cam.project(scene.ball.x + 10, scene.ball.y, scene.ball.z, null);
    var pl = (scene.entities && scene.entities[0]) || scene.player;
    var pp = cam.project(pl.x, pl.y, pl.z, null);
    var head = cam.project(pl.x, pl.y, pl.z + 6.5, null);

    return {
      ballOnScreen: a.x > 0 && a.x < cam.vw && a.y > 0 && a.y < cam.vh,
      movingRightIncreasesX: b.x > a.x,
      playerOnScreen: pp.x > 0 && pp.x < cam.vw,
      headAbovePlayerFeet: head.y < pp.y,
      headFeetGapPx: pp.y - head.y,
      vh: cam.vh
    };
  `, 'probe');
  if (r.err) check('tracking probe ran', false, r.err);
  const o = r.out || {};
  check('ball projects on screen', o.ballOnScreen === true);
  check('+x moves right on screen', o.movingRightIncreasesX === true);
  check('player projects on screen', o.playerOnScreen === true);
  check('player head above feet', o.headAbovePlayerFeet === true);
  check('player occupies a sane share of frame',
        o.headFeetGapPx > o.vh * 0.04 && o.headFeetGapPx < o.vh * 0.60,
        'gap=' + Math.round(o.headFeetGapPx) + 'px of ' + o.vh);
}

console.log('\n[5] 5v5 scene');
{
  const r = runInPage(`
    var BB = window.BB;
    BB.Engine.setState('fiveVfive'); BB.Engine._applyPending();
    var scene = BB.Engine.scene;
    for (var j = 0; j < 600; j++) { scene.fixedUpdate(1/120); if (j % 2 === 0) scene.update(1/60, 1/60); }
    scene.render(0);
    var S3 = BB.S3;
    var counts = {}; var total = 0;
    for (var k in S3.meshes) { counts[k] = S3.meshes[k].n; total += S3.meshes[k].n; }
    return {
      entities: (scene.all || scene.entities || []).length,
      total: total, seg: counts.seg, skinned: S3._poseCount, dropped: S3.dropped,
      glError: BB.GLX.gl.getError(),
      pageErr: window.__pageErr || null
    };
  `, 'probe');
  if (r.err) check('5v5 probe ran', false, r.err);
  const o = r.out || {};
  check('ten players on court', o.entities === 10, 'entities=' + o.entities);
  check('no page errors in 5v5', !o.pageErr, o.pageErr);
  check('one skinned pose per player on court', o.skinned === 10, 'poses=' + o.skinned);
  check('no drops with a full roster', o.dropped === 0, 'dropped=' + o.dropped);
  check('gl clean in 5v5', o.glError === 0, 'code=' + o.glError);
}

console.log('\n[6] defensive stance spreads sideways');
{
  const r = runInPage(`
    var BB = window.BB;
    var pl = new BB.Player({ height: 79 });
    // The pose solver works in one flat plane, and draw() sends anything past
    // an IK origin's own x down the FORWARD axis. Spreading a defender's arms
    // through the hand targets therefore puts one arm in front and one behind;
    // the spread has to arrive as a roll angle out of that plane instead.
    for (var i = 0; i < 60; i++) pl._updatePose(1 / 60);
    var rest = pl.pose.armRoll;

    pl.isGuarding = true;
    for (var j = 0; j < 60; j++) pl._updatePose(1 / 60);
    var guarding = pl.pose.armRoll;
    var handSpreadX = Math.abs(pl.pose.handR.x - pl.pose.handL.x);

    pl.isGuarding = false;
    for (var k = 0; k < 60; k++) pl._updatePose(1 / 60);
    var released = pl.pose.armRoll;

    // A guarding player who then gathers for a shot must drop the stance.
    pl.isGuarding = true;
    pl.action = BB.Player.ACTION.GATHER;
    for (var m = 0; m < 60; m++) pl._updatePose(1 / 60);
    var shooting = pl.pose.armRoll;

    return {
      rest: rest, guarding: guarding, released: released, shooting: shooting,
      handSpreadX: handSpreadX,
      restSpreadX: Math.abs(0.30 * 2)
    };
  `, 'probe');
  if (r.err) check('stance probe ran', false, r.err);
  const o = r.out || {};
  check('arms hang flat when not guarding', o.rest === 0, 'armRoll=' + o.rest);
  check('guarding rolls both arms out of the pose plane', o.guarding > 0.4,
        'armRoll=' + (o.guarding || 0).toFixed(3));
  check('stance releases when guarding stops', o.released < 0.01,
        'armRoll=' + (o.released || 0).toFixed(4));
  check('shooting overrides the stance', o.shooting < 0.01,
        'armRoll=' + (o.shooting || 0).toFixed(4));
  check('spread does not leak into fore/aft hand targets',
        Math.abs(o.handSpreadX - o.restSpreadX) < 0.02,
        'guarding=' + (o.handSpreadX || 0).toFixed(3) + ' rest=' + o.restSpreadX);
}

console.log('\n[7] the dribbled ball sits in the drawn hand');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U;
    var pl = new BB.Player({ height: 79 });
    pl.hasBall = true;
    pl._updatePose(1 / 60);

    // Standing height of the FIGURE, in world feet. The court, rim and ball are
    // true scale but the body is deliberately compressed, so a hand position
    // derived from heightIn instead of from the skeleton floats above the head.
    var B = BB.Player.BONE;
    var crown = (-pl.pose.headY + B.headR) * pl.bodyScale;

    var maxZ = 0, minZ = 1e9, worstGap = 0, topGap = 0;
    for (var i = 0; i <= 40; i++) {
      pl.dribblePhase = i / 40;
      pl._updatePose(1 / 60);
      var ball = pl.handPosition(null);
      var hand = pl.handAt(null);
      maxZ = Math.max(maxZ, ball.z);
      minZ = Math.min(minZ, ball.z);
      // Horizontal distance from the hand: the ball drops straight down under
      // the palm through the bounce, so this should stay small all cycle.
      worstGap = Math.max(worstGap, U.dist(ball.x, ball.y, hand.x, hand.y));
      if (Math.abs(pl.dribblePhase) < 0.02) topGap = Math.abs(ball.z - hand.z);
    }
    return {
      crown: crown, maxZ: maxZ, minZ: minZ,
      worstGap: worstGap, topGap: topGap,
      travel: maxZ - minZ
    };
  `, 'probe');
  if (r.err) check('dribble probe ran', false, r.err);
  const o = r.out || {};
  check('ball never rises above the player', o.maxZ < o.crown,
        'peak=' + (o.maxZ || 0).toFixed(2) + 'ft, crown=' + (o.crown || 0).toFixed(2) + 'ft');
  check('ball peaks around the waist, not the chest', o.maxZ < o.crown * 0.62,
        'peak=' + (o.maxZ || 0).toFixed(2) + 'ft of ' + (o.crown || 0).toFixed(2) + 'ft');
  check('ball reaches the floor at the bounce', o.minZ < 0.5,
        'low=' + (o.minZ || 0).toFixed(2) + 'ft');
  check('ball actually travels over a bounce', o.travel > 1.0,
        'travel=' + (o.travel || 0).toFixed(2) + 'ft');
  check('ball tracks the hand horizontally', o.worstGap < 0.35,
        'worst=' + (o.worstGap || 0).toFixed(3) + 'ft');
  check('ball meets the palm at the top of the bounce', o.topGap < 0.35,
        'gap=' + (o.topGap || 0).toFixed(3) + 'ft');
}

console.log('\n[8] player creator preview');
{
  const r = runInPage(`
    var BB = window.BB;
    // The creator panel draws the figure into its own 2D canvas, outside the
    // single WebGL context, so nothing else in this file exercises it.
    var cv = document.createElement('canvas');
    cv.width = 240; cv.height = 360;
    var ctx = cv.getContext('2d');
    var pl = new BB.Player({ height: 79, jerseyMain: '#2E5BFF', jerseyTrim: '#FF6A2E' });
    pl._updatePose(1 / 60);

    ctx.save();
    ctx.translate(120, 330);
    ctx.scale(150, 150);
    pl.drawPreview(ctx);
    ctx.restore();

    // Count how much of the panel the figure covers and how many distinct
    // colours it used: a silhouette that vanished or collapsed to one flat
    // shape fails both, which is what a broken taper or a bad transform looks
    // like from outside.
    var d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    var painted = 0, cols = {};
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 12) {
        painted++;
        cols[(d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4)] = 1;
      }
    }
    // Vertical extent of the drawing, as a fraction of the panel.
    var top = -1, bot = -1;
    for (var y = 0; y < cv.height; y++) {
      for (var x = 0; x < cv.width; x++) {
        if (d[(y * cv.width + x) * 4 + 3] > 12) { if (top < 0) top = y; bot = y; break; }
      }
    }
    return {
      coverage: painted / (cv.width * cv.height),
      colors: Object.keys(cols).length,
      spanFrac: top < 0 ? 0 : (bot - top) / cv.height,
      pageErr: window.__pageErr || null
    };
  `, 'probe');
  if (r.err) check('creator preview probe ran', false, r.err);
  const o = r.out || {};
  check('preview draws without errors', !o.pageErr, o.pageErr);
  check('preview paints a figure', o.coverage > 0.04 && o.coverage < 0.6,
        'coverage=' + (o.coverage || 0).toFixed(3));
  check('preview uses skin, jersey, shorts and trim', o.colors >= 4, 'colors=' + o.colors);
  check('preview figure spans the panel', o.spanFrac > 0.5,
        'span=' + (o.spanFrac || 0).toFixed(2));
}

if (process.argv.includes('--shots')) {
  console.log('\n[9] screenshots');
  const shots = [
    ['menu', "BB.Engine.setState('menu'); BB.Engine._applyPending();", 120],
    ['play_1v1', "BB.Engine.setState('oneVone'); BB.Engine._applyPending();", 420],
    ['play_5v5', "BB.Engine.setState('fiveVfive'); BB.Engine._applyPending();", 900],
    ['shootaround', "BB.Engine.setState('shootaround'); BB.Engine._applyPending();", 420]
  ];
  for (const [name, setup, ticks] of shots) {
    const f = screenshot(name, setup, ticks);
    const size = fs.statSync(f).size;
    check('shot ' + name + ' rendered', size > 20000, size + ' bytes');
  }
  console.log('  -> ' + OUT);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
