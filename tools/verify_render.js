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
  /* Keep the drawing buffer around after a frame. Checks that read pixels back
   * (see the facing check) render outside the animation loop, and without this
   * the buffer's contents are undefined by the time readPixels runs. */
  const withCapture = src.replace('<script src="js/core/constants.js"></script>',
    '<script>window.__HW_CAPTURE = true;</script>\n  <script src="js/core/constants.js"></script>');

  const probe = withCapture.replace('</body>', `
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
    var restSpreadX = Math.abs(pl.pose.handR.x - pl.pose.handL.x);
    // Hands hang the same distance in front of their own shoulder, or the
    // figure stands mid-stumble with one arm forward and one arm back.
    var restFore = Math.abs((pl.pose.handL.x + BB.Player.BONE.shoulderW)
                          - (pl.pose.handR.x - BB.Player.BONE.shoulderW));

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
      restSpreadX: restSpreadX,
      restFore: restFore
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
        'guarding=' + (o.handSpreadX || 0).toFixed(3) +
        ' rest=' + (o.restSpreadX || 0).toFixed(3));
  check('a standing player hangs both hands level with each other',
        o.restFore < 0.001, 'fore/aft mismatch ' + (o.restFore || 0).toFixed(3));
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

console.log('\n[8] the floor does not fight the arena deck');
{
  const r = runInPage(`
    var BB = window.BB;
    BB.Engine.setState('shootaround'); BB.Engine._applyPending();
    var sc = BB.Engine.scene, gl = BB.GLX.gl, M4 = BB.M4, cam = BB.Camera;
    for (var w = 0; w < 200; w++) { sc.fixedUpdate(1/120); if (w % 2 === 0) sc.update(1/60, 1/60); }

    // Nudge the rig by inches and re-render. Two coplanar surfaces cannot be
    // separated by the depth buffer at broadcast distance, so which one wins
    // flips with sub-pixel camera movement — whole stretches of hardwood turn
    // into dark deck and back, which is what reads on screen as the court
    // glitching. A scene with real depth separation barely moves at all.
    var W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    var buf = new Uint8Array(W * H * 4), nudge = 0;
    cam._rebuild = function () {
      this.eye[0] = 47 + nudge * 0.31; this.eye[1] = 15.5; this.eye[2] = 83;
      this.target[0] = 47; this.target[1] = 2.2; this.target[2] = 36;
      M4.perspective(this.proj, 40 * Math.PI / 180, this.vw / Math.max(1, this.vh), 0.6, 420);
      M4.lookAt(this.view, this.eye, this.target, [0, 1, 0]);
      M4.multiply(this.viewProj, this.proj, this.view);
    };
    var cov = [];
    for (var i = 0; i < 16; i++) {
      nudge = i; cam._rebuild(); sc.render(0);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      var warm = 0, n = 0;
      for (var o = 0; o < buf.length; o += 4) {
        if (buf[o] - buf[o + 2] > 30 && buf[o] > 70) warm++;
        n++;
      }
      cov.push(warm / n);
    }
    var mn = Math.min.apply(null, cov), mx = Math.max.apply(null, cov);
    // The mip chain is capped so the smallest level the hardware may fall back
    // to is still a legible court rather than a one-pixel average.
    gl.bindTexture(gl.TEXTURE_2D, BB.Court.tex);
    var maxLevel = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { min: mn, max: mx, spread: mx - mn, maxLevel: maxLevel, glError: gl.getError() };
  `, 'probe');
  if (r.err) check('floor probe ran', false, r.err);
  const o = r.out || {};
  check('court floor is visible at broadcast distance', o.min > 0.2,
        'min coverage=' + ((o.min || 0) * 100).toFixed(1) + '%');
  check('floor does not flicker as the camera moves', o.spread < 0.03,
        'spread=' + ((o.spread || 0) * 100).toFixed(1) + ' points');
  check('court mip chain is capped on every GPU', o.maxLevel > 0 && o.maxLevel <= 6,
        'TEXTURE_MAX_LEVEL=' + o.maxLevel);
  check('gl clean after the sweep', o.glError === 0, 'code=' + o.glError);
}

console.log('\n[9] a running player plants their feet');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U;
    var pl = new BB.Player({ height: 79 });
    pl.placeAt(20, 25, 0);
    pl.facing = pl.moveFacing = 0;
    var dt = 1 / 60, speed = 14;

    var prevLow = null, footMove = 0, bodyMove = 0, n = 0;
    var a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
    for (var i = 0; i < 240; i++) {
      pl.vx = speed; pl.vy = 0;
      pl.x += speed * dt;
      // Drive the stride through the same call updateMovement makes, so this
      // cannot drift out of step with the gait the pose is built from.
      pl._advanceStride(speed, Math.max(pl.phys.maxSpeed, 1), dt);
      pl._updatePose(dt);

      pl.footAt(-1, a); pl.footAt(1, b);
      // The lower foot is the one taking the player's weight.
      var low = a.z <= b.z ? { x: a.x, y: a.y, z: a.z } : { x: b.x, y: b.y, z: b.z };
      if (i > 20 && prevLow) {
        var same = Math.hypot(low.x - prevLow.x, low.y - prevLow.y) < speed * dt * 3;
        if (same) { footMove += Math.hypot(low.x - prevLow.x, low.y - prevLow.y); bodyMove += speed * dt; n++; }
      }
      prevLow = low;
    }

    /* Walk the cycle again, this time reading the joints themselves.
     *
     * The solver works in a flat plane whose x becomes the player's FORWARD
     * axis, so a joint's x relative to its own limb root IS how far in front
     * of that root it sits — which makes every claim below a number rather
     * than something to squint at. */
    var B = BB.Player.BONE, STEPS = 24;
    /** Which side of its own root-to-tip line a middle joint sits on. */
    function bendSide(o, j, e) {
      return (j[0] - o[0]) * (e[1] - j[1]) - (j[1] - o[1]) * (e[0] - j[0]);
    }
    var kneeBend = 1e9, elbowBend = -1e9, clamp = 0, contra = 0;
    var handSwing = 0, hipHi = -1e9, hipLo = 1e9;
    var hLs = [], hRs = [];
    for (var s = 0; s < STEPS; s++) {
      pl.vx = speed; pl.vy = 0;
      pl.stridePhase = s * Math.PI * 2 / STEPS;
      pl._updatePose(dt);
      var p = pl.pose;
      // A knee bends one way and an elbow the other, and each pair agrees with
      // itself: this is the sign the IK's bend flag picks, read back off the
      // solved joints.
      kneeBend = Math.min(kneeBend,
        bendSide([-B.hipW, p.hipY], [p.kneeL.jx, p.kneeL.jy], [p.kneeL.ex, p.kneeL.ey]),
        bendSide([B.hipW, p.hipY], [p.kneeR.jx, p.kneeR.jy], [p.kneeR.ex, p.kneeR.ey]));
      elbowBend = Math.max(elbowBend,
        bendSide([-B.shoulderW, p.shoulderY], [p.elbowL.jx, p.elbowL.jy], [p.elbowL.ex, p.elbowL.ey]),
        bendSide([B.shoulderW, p.shoulderY], [p.elbowR.jx, p.elbowR.jy], [p.elbowR.ex, p.elbowR.ey]));
      // Nothing asked for is out of reach: a clamped target freezes the limb.
      clamp = Math.max(clamp,
        Math.hypot(p.kneeL.ex - p.footL.x, p.kneeL.ey - p.footL.y),
        Math.hypot(p.kneeR.ex - p.footR.x, p.kneeR.ey - p.footR.y),
        Math.hypot(p.elbowL.ex - p.handL.x, p.elbowL.ey - p.handL.y),
        Math.hypot(p.elbowR.ex - p.handR.x, p.elbowR.ey - p.handR.y));
      var hL = p.handL.x + B.shoulderW, hR = p.handR.x - B.shoulderW;
      var fL = p.footL.x + B.hipW, fR = p.footR.x - B.hipW;
      hLs.push(hL); hRs.push(hR);
      handSwing = Math.max(handSwing, Math.abs(hL));
      // Correlated over the whole cycle, not merely at one lucky frame: a hand
      // and the OPPOSITE foot reach forward together.
      contra += hL * fR + hR * fL;
      hipHi = Math.max(hipHi, -p.hipY); hipLo = Math.min(hipLo, -p.hipY);
    }
    // The two arms run the same swing, half a cycle apart.
    var anti = 0;
    for (var q = 0; q < STEPS; q++) {
      anti = Math.max(anti, Math.abs(hLs[q] - hRs[(q + STEPS / 2) % STEPS]));
    }
    return {
      slideRatio: bodyMove > 0 ? footMove / bodyMove : 1, samples: n,
      kneeBend: kneeBend, elbowBend: elbowBend, clamp: clamp,
      anti: anti, handSwing: handSwing, contra: contra / STEPS,
      bob: hipHi - hipLo
    };
  `, 'probe');
  if (r.err) check('stride probe ran', false, r.err);
  const o = r.out || {};
  // A foot driven on a timer slides at very nearly the body's own speed.
  check('planted foot does not skate under the player', o.slideRatio < 0.55,
        'foot travels ' + ((o.slideRatio || 1) * 100).toFixed(0) + '% of body speed');
  // A knee only bends one way, and it is the same way on both legs. Mirroring
  // the IK bend flag left-to-right reverses one of them, which is a leg that
  // folds backwards at the knee.
  check('both knees fold forward, all cycle long', o.kneeBend > 0,
        'worst bend ' + (o.kneeBend || 0).toFixed(4) + ' (negative = a reversed knee)');
  check('both elbows fold the other way', o.elbowBend < 0,
        'worst bend ' + (o.elbowBend || 0).toFixed(4) + ' (positive = a reversed elbow)');
  check('no limb target is out of reach mid-stride', o.clamp < 0.005,
        'largest shortfall ' + (o.clamp || 0).toFixed(4));
  check('the arms swing, half a cycle apart from each other',
        o.handSwing > 0.15 && o.anti < 0.001,
        'swing ' + (o.handSwing || 0).toFixed(3) + ', mismatch ' + (o.anti || 0).toFixed(4));
  // Contralateral: the left arm reaches forward with the RIGHT leg. Same-side
  // arm and leg swinging together is the toy-soldier walk.
  check('each arm swings forward with the opposite leg', o.contra > 0,
        'mean opposite-side product ' + (o.contra || 0).toFixed(4));
  check('the body rises and falls through the cycle', o.bob > 0.005,
        'hip travels ' + (o.bob || 0).toFixed(3) + ' vertically');
}

console.log('\n[10] player creator preview');
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

console.log('\n[11] the shot meter clears the scorebug');
{
  const r = runInPage(`
    var BB = window.BB;
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene;
    for (var i = 0; i < 60; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }
    var cam = BB.Camera, dpr = cam.dpr || 1;
    var safe = BB.HUD.safeTop();

    /* Measure what the meter actually paints rather than re-deriving it: wrap
     * the context and walk every arc it strokes. A clamp that is right in the
     * arithmetic and wrong in the drawing call would pass any check written
     * the other way round. */
    var ctx = BB.Renderer.ctx, realArc = ctx.arc, realStroke = ctx.stroke;
    var minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, pending = null;
    ctx.arc = function (x, y, r, a0, a1) {
      pending = { x: x, y: y, r: r, a0: a0, a1: a1 };
      return realArc.apply(this, arguments);
    };
    ctx.stroke = function () {
      if (pending) {
        var half = (this.lineWidth || 1) / 2;
        for (var a = pending.a0; a <= pending.a1 + 1e-6; a += 0.02) {
          var px = pending.x + Math.cos(a) * pending.r;
          var py = pending.y + Math.sin(a) * pending.r;
          minY = Math.min(minY, py - half); maxY = Math.max(maxY, py + half);
          minX = Math.min(minX, px - half); maxX = Math.max(maxX, px + half);
        }
        pending = null;
      }
      return realStroke.apply(this, arguments);
    };

    // A shooter whose anchor projects way above the top of the frame: without
    // a clamp the whole green end of the bar lands under the scorebug.
    var pl = scene.player;
    pl.placeAt(scene.hoop.x - 20, 25, 0);
    pl.meter.start(pl.releaseProfileJumper, { x: pl.x, y: pl.y, z: 26 });
    pl.meter.value = 0.9;
    pl.meter.draw(ctx, cam);
    var high = { minY: minY, maxY: maxY, minX: minX, maxX: maxX };

    // And one at the near baseline, where it would fall off the bottom.
    minY = 1e9; maxY = -1e9; minX = 1e9; maxX = -1e9;
    pl.meter.setAnchor({ x: pl.x, y: pl.y, z: -30 });
    pl.meter.draw(ctx, cam);
    var low = { minY: minY, maxY: maxY, minX: minX, maxX: maxX };

    ctx.arc = realArc; ctx.stroke = realStroke;
    return { safe: safe, dpr: dpr, vw: cam.vw, vh: cam.vh, high: high, low: low };
  `, 'probe');
  if (r.err) check('meter probe ran', false, r.err);
  const o = r.out || {};
  const hi = o.high || {}, lo = o.low || {};
  // The bug is DOM over canvas, so anything the meter paints above its bottom
  // edge is simply gone — and the meter fills upward, so what is lost is the
  // green window.
  check('the scorebug stays a thin strip', o.safe > 0 && o.safe < 46,
        'bug ends ' + Math.round(o.safe || 0) + 'px down the screen');
  check('meter stays clear of the scorebug', hi.minY >= o.safe * o.dpr,
        'meter top at ' + Math.round(hi.minY) + 'px, bug ends at ' +
        Math.round((o.safe || 0) * (o.dpr || 1)) + 'px');
  check('meter stays on screen at the near baseline', lo.maxY <= o.vh,
        'meter bottom at ' + Math.round(lo.maxY) + 'px of ' + o.vh);
  check('meter stays inside the frame sideways',
        hi.minX >= 0 && hi.maxX <= o.vw,
        'meter spans ' + Math.round(hi.minX) + '..' + Math.round(hi.maxX) + ' of ' + o.vw);
}

console.log('\n[12] the front page carries every mode');
{
  const r = runInPage(`
    var BB = window.BB;
    BB.Engine.setState('menu'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene;
    for (var i = 0; i < 40; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }

    var tabs = [].slice.call(document.querySelectorAll('[data-tab]'));
    var ids = tabs.map(function (t) { return t.dataset.tab; });

    // Every mode the build can actually enter, and where it is reachable from.
    var states = Object.keys(BB.Engine.states || {});
    var screens = Object.keys(BB.Menus.screens || {});

    // Each tab has to produce a complete hero: tags, title, body, button.
    var incomplete = [], poses = {};
    for (var k = 0; k < tabs.length; k++) {
      tabs[k].click();
      var h = document.getElementById('menu-hero');
      if (!h.querySelector('.menu-hero__tags') || !h.querySelector('.menu-hero__title') ||
          !h.querySelector('.menu-hero__body') || !h.querySelector('[data-go]') ||
          !h.querySelector('.menu-hero__title').textContent.trim()) {
        incomplete.push(tabs[k].dataset.tab);
      }
      poses[tabs[k].dataset.tab] = scene.pose;
    }

    // Exactly one tab reads as selected at a time.
    var onCount = document.querySelectorAll('[data-tab].is-on').length;

    /* The keyboard path all the way through: focus the button, walk the row
     * with the arrow keys, and check the focus is still somewhere this
     * screen can hear. Rebuilding the panel under a focused button is exactly
     * how that gets lost. */
    tabs[0].click();                       // known starting point
    document.querySelector('[data-go]').focus();
    var screenEl = document.querySelector('.screen--main');
    for (var a = 0; a < 3; a++) {
      screenEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    }
    var focusHeld = screenEl.contains(document.activeElement);
    var afterArrows = document.querySelector('[data-tab].is-on').dataset.tab;

    return {
      ids: ids, incomplete: incomplete, onCount: onCount,
      focusHeld: focusHeld, afterArrows: afterArrows,
      poses: poses, states: states, screens: screens,
      heroOnCourt: !!(scene.hero && scene.hero.x > 0),
      pageErr: window.__pageErr || null
    };
  `, 'probe');
  if (r.err) check('front page probe ran', false, r.err);
  const o = r.out || {};
  const ids = o.ids || [];
  // Everything this build can do is on the front page: the three playable
  // scenes plus every screen the menu can open, minus the ones that only make
  // sense from inside a game.
  const want = ['oneVone', 'fiveVfive', 'shootaround', 'createPlayer', 'career', 'settings', 'controls'];
  const missing = want.filter((w) => ids.indexOf(w) < 0);
  check('every mode has a tab', missing.length === 0, 'missing: ' + missing.join(', '));
  check('no tab is a dead end', (o.incomplete || []).length === 0,
        'incomplete: ' + (o.incomplete || []).join(', '));
  check('exactly one tab reads as selected', o.onCount === 1, 'selected=' + o.onCount);
  check('arrows walk the row', o.afterArrows === ids[3], 'landed on ' + o.afterArrows);
  check('focus survives a mode change', o.focusHeld === true,
        'focus left the screen after arrowing');
  // The standby figure is the point of the layout: no player, no front page.
  check('a live player stands in the frame', o.heroOnCourt === true);
  check('modes drive different standby poses',
        Object.keys(o.poses || {}).map((k) => o.poses[k])
          .filter((v, i, all) => all.indexOf(v) === i).length >= 3,
        'poses=' + JSON.stringify(o.poses));
  check('front page raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[13] a created player starts at 60 and climbs');
{
  const r = runInPage(`
    var BB = window.BB, P = BB.PlayerProfile;
    BB.Engine.setState('menu'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene;
    for (var i = 0; i < 40; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }

    // Every build lands on the same starting overall — an archetype is a
    // shape, not a head start, and a position is a set of ceilings.
    var starts = [];
    var archs = Object.keys(P.ARCHETYPES), poss = ['PG', 'SG', 'SF', 'PF', 'C'];
    for (var a = 0; a < archs.length; a++) {
      for (var p = 0; p < poss.length; p++) {
        var d = P.newDraft();
        d.archetype = archs[a]; d.position = poss[p]; d.ratings = null;
        starts.push(P.overallOf(d));
      }
    }

    // Spending a career point has to move the number the player sees.
    BB.Career.reset();
    P.clear();
    var before = P.overallOf(P.newDraft());
    var c = BB.Career.load(); c.points = 40; BB.Career.save(c);
    var spent = 0;
    for (var s = 0; s < 40; s++) if (BB.Career.spendPoint('midRange')) spent++;
    var after = P.overallOf(P.newDraft());
    BB.Career.reset(); P.clear();

    BB.Menus.push('createPlayer');
    var el = document.querySelector('.screen--createPlayer');
    var hasOverallInput = !!el.querySelector('[data-key="overall"], #cp-overall');
    var shownOvr = parseInt(el.querySelector('#cp-ovr').textContent, 10);
    var usesModel = !!(scene.hero && scene.preview);
    // Editing has to reach the live model, not a picture of it.
    var sw = el.querySelectorAll('[data-key="jerseyMain"] [data-swatch]')[4];
    sw.click();
    var modelTookColour = scene.hero.jerseyMain === sw.dataset.swatch;
    var h = el.querySelector('#cp-height');
    h.value = 84; h.dispatchEvent(new Event('input', { bubbles: true }));
    var modelTookHeight = scene.hero.heightIn === 84;
    BB.Menus.pop();

    return {
      startMin: Math.min.apply(null, starts), startMax: Math.max.apply(null, starts),
      before: before, after: after, spent: spent,
      hasOverallInput: hasOverallInput, shownOvr: shownOvr, usesModel: usesModel,
      modelTookColour: modelTookColour, modelTookHeight: modelTookHeight,
      start: P.START_OVERALL, pageErr: window.__pageErr || null
    };
  `, 'probe');
  if (r.err) check('creator probe ran', false, r.err);
  const o = r.out || {};
  check('every build starts on the same overall',
        o.startMin === o.start && o.startMax === o.start,
        'range ' + o.startMin + '..' + o.startMax + ', expected ' + o.start);
  check('the overall slider is gone', o.hasOverallInput === false);
  check('the creator shows the starting overall', o.shownOvr === o.start,
        'shows ' + o.shownOvr);
  // The whole point of removing the slider: the number is earned, not set.
  check('spending career points raises the overall', o.spent > 0 && o.after > o.before,
        o.before + ' -> ' + o.after + ' after ' + o.spent + ' points');
  check('the creator edits the live 3D player', o.usesModel === true);
  check('a colour change reaches the model', o.modelTookColour === true);
  check('a height change reaches the model', o.modelTookHeight === true);
  check('creator raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[14] the figure faces the way it is facing, and wears its own colours');
{
  /* Read the head back off the framebuffer.
   *
   * Painting the skin pure green and the hair pure red turns "which way is
   * this figure looking" into something countable. The rigger puts hair on the
   * crown and the BACK of the head, so a figure looking at the camera reads
   * green and one looking away reads red. That catches a reversed facing AND a
   * model drawing inside out, which from out here are the same pixel.
   *
   * One page per look: reading pixels back is only reliable for the frame the
   * page rendered, so each case gets its own run rather than sharing one.
   */
  const look = (facing, skin, hair) => runInPage(`
    var BB = window.BB;
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene;
    for (var i = 0; i < 60; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }
    var pl = scene.player, cam = BB.Camera, gl = BB.GLX.gl, M4 = BB.M4;
    scene.ai.x = -80; scene.ai.y = -80;
    if (scene.ball) { scene.ball.owner = null; scene.ball.x = -80; scene.ball.y = -80; }
    pl.placeAt(47, 25, 0);
    pl.vx = pl.vy = 0; pl.hasBall = false; pl.action = null; pl.armRaise = 0;
    pl.skin = '${skin}'; pl.hair = '${hair}';
    pl.facing = ${facing};
    pl._updatePose(1 / 60);

    // A tight head shot from the camera side: the broadcast rig is 25 feet
    // out, where the head is a dozen pixels and the crowd behind it votes.
    var headZ = -pl.pose.headY * pl.bodyScale;
    cam._rebuild = function () {
      this.eye[0] = pl.x; this.eye[1] = headZ; this.eye[2] = pl.y + 5;
      this.target[0] = pl.x; this.target[1] = headZ; this.target[2] = pl.y;
      M4.perspective(this.proj, 20 * Math.PI / 180, this.vw / Math.max(1, this.vh), 0.3, 420);
      M4.lookAt(this.view, this.eye, this.target, [0, 1, 0]);
      M4.multiply(this.viewProj, this.proj, this.view);
    };
    cam._rebuild();
    scene.render(0);

    var n = Math.round(Math.min(cam.vw, cam.vh) * 0.13);
    var buf = new Uint8Array(n * n * 4);
    gl.readPixels(Math.round(cam.vw / 2 - n / 2), Math.round(cam.vh / 2 - n / 2), n, n,
                  gl.RGBA, gl.UNSIGNED_BYTE, buf);
    var green = 0, red = 0;
    for (var p = 0; p < buf.length; p += 4) {
      /* Classify by RATIO, not brightness. The back of a head is lit from the
       * front, so its hair comes back at a third the value the face does —
       * a threshold on absolute brightness reads "unlit" as "not there". */
      var rr = buf[p], gg = buf[p + 1], bb2 = buf[p + 2];
      if (gg > 24 && gg > rr * 2 && gg > bb2 * 2) green++;
      else if (rr > 24 && rr > gg * 2 && rr > bb2 * 2) red++;
    }
    var mr=0,mg=0,mb=0;
    for (var q = 0; q < buf.length; q += 4) { mr+=buf[q]; mg+=buf[q+1]; mb+=buf[q+2]; }
    var np = buf.length/4;
    return { green: green, red: red, total: n * n,
             mean: [Math.round(mr/np), Math.round(mg/np), Math.round(mb/np)],
             headZ: +headZ.toFixed(2), n: n, vw: cam.vw, vh: cam.vh,
             pageErr: window.__pageErr || null };
  `, 'facing');

  // The rig sits outside the +y sideline, so +PI/2 looks straight at it.
  const toward = (look(Math.PI / 2, '#00FF00', '#FF0000').out) || {};
  const away = (look(-Math.PI / 2, '#00FF00', '#FF0000').out) || {};
  const repaint = (look(Math.PI / 2, '#0000FF', '#0000FF').out) || {};

  // The crown is hair from either side, so neither look is pure; what matters
  // is which one wins, and that it wins clearly.
  check('a player looking at the camera shows their face',
        toward.green > toward.red * 1.3,
        'facing camera: ' + toward.green + ' skin px vs ' + toward.red + ' hair px');
  check('a player looking away shows the back of their head',
        away.red > away.green * 1.3,
        'facing away: ' + away.red + ' hair px vs ' + away.green + ' skin px');
  // Inside-out geometry shows the far surface, which flips both of those.
  check('the head is drawn solid, not inside out',
        toward.green > 40 && away.red > 40,
        'front ' + toward.green + ' skin px, back ' + away.red + ' hair px');
  check('skin and hair colours reach the screen',
        repaint.green < 10 && repaint.red < 10,
        'after repainting blue: ' + repaint.green + ' green px, ' + repaint.red + ' red px');
}

console.log('\n[15] a sprinting drive finishes with a layup');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U, S = BB.Shooting;
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene;
    for (var i = 0; i < 60; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }
    var pl = scene.player, hoop = scene.hoop;
    scene.ai.x = -80; scene.ai.y = -80; scene.ai.hasBall = false;

    /** Sets up a drive from N feet out and asks what kind of shot it is. */
    function attempt(dist, sprint, speedFrac) {
      pl.placeAt(hoop.x - dist, hoop.y, 0);
      pl.sprinting = sprint;
      pl.vx = (sprint ? pl.phys.maxSprint : pl.phys.maxSpeed) * speedFrac;
      pl.vy = 0; pl.z = 0; pl.jumping = false;
      pl.action = null; pl.armRaise = 0; pl.hasBall = true;
      pl._beginShot();
      return pl.shotType;
    }

    var kinds = {
      sprintNine: attempt(9, true, 0.9),
      sprintSix: attempt(6, true, 0.9),
      standingNine: attempt(9, false, 0),
      standingLong: attempt(20, false, 0),
      sprintTooFar: attempt(16, true, 0.9)
    };

    // Windows, for the same player, at the same rating scale.
    var rt = pl.ratings;
    var win = {
      layup: S.greenWindowFor(rt.layup, 5, 'layup', 0),
      layupContested: S.greenWindowFor(rt.layup, 5, 'layup', 1),
      jumper: S.greenWindowFor(rt.midRange, 15, 'jumper', 0)
    };

    // Grade a spread of release timings: everything past a flick of the
    // button should read green, which is what "just hold it" means.
    var prof = { riseTime: 0.30, target: 0.94, greenWindow: win.layup, name: 'Layup' };
    var green = ['PERFECT', 'EXCELLENT', 'SLIGHTLY_EARLY', 'SLIGHTLY_LATE'];
    var timings = [0.25, 0.45, 0.7, 0.94, 1.15, 1.34];
    var missed = timings.filter(function (v) {
      return green.indexOf(S.grade(v, prof).tier.key) < 0;
    });

    /* The rise pose. A layup is asymmetric — one knee driven up, the trailing
     * leg extended, the ball up on one side — and a jump shot is not, so the
     * two poses have to measure differently or the layup is still a jumper
     * wearing a different name. */
    function poseOf(type) {
      attempt(9, true, 0.9);
      pl.action = BB.Player.ACTION.METER; pl.shotType = type; pl.driving = true;
      pl.meter.start({ riseTime: 0.3, target: 0.94, greenWindow: 0.3, name: 'x' },
                     { x: pl.x, y: pl.y, z: 0 });
      pl.meter.value = 0.8;
      pl._updatePose(1 / 60);
      return {
        knee: -pl.pose.footL.y,
        split: Math.abs(pl.pose.footL.y - pl.pose.footR.y),
        hands: Math.abs(pl.pose.handL.y - pl.pose.handR.y)
      };
    }
    var layupPose = poseOf('layup'), jumperPose = poseOf('jumper');

    /* End to end: drive, shoot, release mid-meter, and watch the ball. */
    var made = 0, tries = 0;
    for (var t = 0; t < 6; t++) {
      var ball = scene.ball;
      pl.placeAt(hoop.x - 9, hoop.y, 0);
      pl.sprinting = true; pl.vx = pl.phys.maxSprint * 0.9; pl.vy = 0;
      pl.z = 0; pl.jumping = false; pl.action = null; pl.armRaise = 0;
      pl.giveBall(ball);
      pl._beginShot();
      var scored = false;
      var off = ball.events.on('score', function () { scored = true; });
      var fired = false;
      for (var f = 0; f < 420; f++) {
        scene.fixedUpdate(1 / 120);
        if (!fired && pl.action === BB.Player.ACTION.METER && pl.meter.value > 0.35 + t * 0.12) {
          pl._releaseShot(); fired = true;
        }
        if (scored) break;
      }
      if (typeof off === 'function') off();
      ball.events.off && ball.events.off('score');
      tries++; if (scored) made++;
    }

    return {
      kinds: kinds,
      win: { layup: +win.layup.toFixed(3), contested: +win.layupContested.toFixed(3),
             jumper: +win.jumper.toFixed(3) },
      missedTimings: missed,
      layupPose: layupPose, jumperPose: jumperPose,
      made: made, tries: tries,
      pageErr: window.__pageErr || null
    };
  `, 'layup');
  if (r.err) check('layup probe ran', false, r.err);
  const o = r.out || {}, k = o.kinds || {}, w = o.win || {};
  check('sprinting at the rim gives a layup, not a jumper',
        k.sprintNine === 'layup' && k.sprintSix === 'layup',
        'from 9ft: ' + k.sprintNine + ', from 6ft: ' + k.sprintSix);
  check('standing in the same spot still gives a jump shot',
        k.standingNine === 'jumper' && k.standingLong === 'jumper',
        'from 9ft: ' + k.standingNine + ', from 20ft: ' + k.standingLong);
  check('a drive from out of takeoff range is still a jumper',
        k.sprintTooFar === 'jumper', 'from 16ft: ' + k.sprintTooFar);
  check('the layup window is enormous next to a jumper', w.layup > w.jumper * 4,
        'layup ' + w.layup + ' vs jumper ' + w.jumper);
  check('a contest still tightens it', w.contested < w.layup * 0.7 && w.contested > w.jumper,
        'contested ' + w.contested);
  check('any real release on a layup reads green',
        (o.missedTimings || []).length === 0,
        'these timings did not: ' + JSON.stringify(o.missedTimings));
  const lp = o.layupPose || {}, jp = o.jumperPose || {};
  check('the layup rise drives a knee up', lp.knee > 0.3 && lp.knee > jp.knee * 3,
        'layup knee ' + (lp.knee || 0).toFixed(2) + ' vs jumper ' + (jp.knee || 0).toFixed(2));
  check('the layup rise is asymmetric, a jump shot is not',
        lp.split > 0.4 && lp.hands > jp.hands,
        'legs ' + (lp.split || 0).toFixed(2) + ' apart, hands ' + (lp.hands || 0).toFixed(2));
  check('driving layups go in', o.made === o.tries,
        o.made + ' of ' + o.tries + ' released across the meter');
  check('layup probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[16] the forward camera looks down the floor');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U;
    BB.Settings.set('cameraMode', 'forward');
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene, cam = BB.Camera, hoop = scene.hoop;
    for (var i = 0; i < 240; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }
    var pl = scene.player;
    pl.placeAt(hoop.x - 20, hoop.y, 0);
    for (var j = 0; j < 120; j++) { scene.fixedUpdate(1 / 120); if (j % 2 === 0) scene.update(1 / 60, 1 / 60); }
    scene.render(0);

    // GL space: [0] is court x, [2] is court y.
    var eyeToHoop = Math.hypot(hoop.x - cam.eye[0], hoop.y - cam.eye[2]);
    var focusToHoop = Math.hypot(hoop.x - cam.x, hoop.y - cam.y);
    var rim = cam.project(hoop.x, hoop.y, 10, null);
    var player = cam.project(pl.x, pl.y, 3, null);

    // Aim at the OTHER basket: the rig has to swing around behind the play.
    var other = BB.C.HOOPS[0].x === hoop.x ? BB.C.HOOPS[1] : BB.C.HOOPS[0];
    cam.setAim(other.x, other.y);
    for (var k = 0; k < 180; k++) cam.update(1 / 60, { x: pl.x, y: pl.y }, null);
    var flippedEyeToOther = Math.hypot(other.x - cam.eye[0], other.y - cam.eye[2]);
    var flippedFocusToOther = Math.hypot(other.x - cam.x, other.y - cam.y);

    return {
      mode: cam.mode,
      behind: eyeToHoop - focusToHoop,
      rimX: rim.x / cam.vw, rimY: rim.y / cam.vh, rimBehind: rim.behind,
      playerX: player.x / cam.vw,
      flippedBehind: flippedEyeToOther - flippedFocusToOther,
      pageErr: window.__pageErr || null
    };
  `, 'forward');
  if (r.err) check('forward camera probe ran', false, r.err);
  const o = r.out || {};
  check('forward mode is what the scene selected', o.mode === 'forward', 'mode=' + o.mode);
  // The whole point: the rig stands off on the far side of the player FROM the
  // basket, so the basket is downrange rather than off a shoulder.
  check('the rig sits behind the play', o.behind > 12,
        'camera is ' + (o.behind || 0).toFixed(1) + 'ft further from the rim than the player');
  check('the rim is dead ahead, not off to one side',
        !o.rimBehind && Math.abs(o.rimX - 0.5) < 0.14,
        'rim at ' + ((o.rimX || 0) * 100).toFixed(0) + '% across the frame');
  check('the rim sits in the upper half of the frame', o.rimY < 0.5,
        'rim at ' + ((o.rimY || 0) * 100).toFixed(0) + '% down the frame');
  check('the player is centred too', Math.abs(o.playerX - 0.5) < 0.14,
        'player at ' + ((o.playerX || 0) * 100).toFixed(0) + '% across');
  // Possession changes have to turn the camera around, not leave it backwards.
  check('it swings around on a change of possession', o.flippedBehind > 12,
        'after flipping aim: ' + (o.flippedBehind || 0).toFixed(1) + 'ft behind');
  check('forward camera raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[17] WASD moves the way the screen looks');
{
  const r = runInPage(`
    var BB = window.BB;
    function press(dx, dy) {
      return { moveVector: function (out) { out.x = dx; out.y = dy; out.mag = 1; return out; },
               down: function () { return false; }, pressed: function () { return false; },
               released: function () { return false; } };
    }
    function run(mode) {
      BB.Settings.set('cameraMode', mode);
      BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
      var scene = BB.Engine.scene, pl = scene.player, cam = BB.Camera, hoop = scene.hoop;
      for (var i = 0; i < 240; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }
      pl.placeAt(hoop.x - 25, hoop.y, 0);
      for (var j = 0; j < 60; j++) { scene.fixedUpdate(1 / 120); if (j % 2 === 0) scene.update(1 / 60, 1 / 60); }

      var keys = { w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] }, out = {};
      Object.keys(keys).forEach(function (k) {
        pl.readInput(press(keys[k][0], keys[k][1]));
        var here = cam.project(pl.x, pl.y, 3, null);
        var step = cam.project(pl.x + pl.intentX * 5, pl.y + pl.intentY * 5, 3, null);
        out[k] = { sx: step.x - here.x, sy: step.y - here.y,
                   toHoop: Math.hypot(hoop.x - (pl.x + pl.intentX * 5), hoop.y - (pl.y + pl.intentY * 5))
                         - Math.hypot(hoop.x - pl.x, hoop.y - pl.y) };
      });
      return out;
    }
    return { forward: run('forward'), broadcast: run('broadcast'), pageErr: window.__pageErr || null };
  `, 'wasd');
  if (r.err) check('wasd probe ran', false, r.err);
  const o = r.out || {};
  /* Every rig has to agree with the screen: W up, S down, A left, D right.
   * The court's axes are not the screen's, and the forward rig runs the
   * court's length INTO the screen — bound to world axes, W walked sideways. */
  ['forward', 'broadcast'].forEach((mode) => {
    const m = o[mode] || {}, w = m.w || {}, s2 = m.s || {}, a = m.a || {}, d = m.d || {};
    check(mode + ': W goes up the screen, S goes down', w.sy < -4 && s2.sy > 4,
          'W ' + (w.sy || 0).toFixed(0) + 'px, S ' + (s2.sy || 0).toFixed(0) + 'px');
    check(mode + ': A goes left, D goes right', a.sx < -10 && d.sx > 10,
          'A ' + (a.sx || 0).toFixed(0) + 'px, D ' + (d.sx || 0).toFixed(0) + 'px');
  });
  // Under the forward rig, up the screen is also toward the basket.
  const fw = (o.forward || {}).w || {};
  check('forward: W drives toward the basket', fw.toHoop < -3,
        'W closes ' + (-(fw.toHoop || 0)).toFixed(1) + 'ft');
  check('wasd probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[18] shooting works while moving');
{
  const r = runInPage(`
    var BB = window.BB;
    function trial(withSprint) {
      BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
      var scene = BB.Engine.scene, pl = scene.player, hoop = scene.hoop;
      for (var i = 0; i < 400; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }
      scene.ai.x = -80; scene.ai.y = -80;
      pl.placeAt(hoop.x - 14, hoop.y, 0);
      pl.giveBall(scene.ball);
      var att0 = pl.stats.att;

      // Stand in for the keyboard: run forward the whole time, tap shoot.
      var held = {}, pressedNow = {}, releasedNow = {}, real = BB.Input;
      BB.Input = Object.create(real);
      BB.Input.down = function (a) { return !!held[a]; };
      BB.Input.pressed = function (a) { return !!pressedNow[a]; };
      BB.Input.released = function (a) { return !!releasedNow[a]; };
      BB.Input.moveVector = function (out) {
        out = out || { x: 0, y: 0, mag: 0 };
        out.x = 0; out.y = held.up ? -1 : 0; out.mag = held.up ? 1 : 0; return out;
      };
      held.up = true; held.sprint = !!withSprint;

      var sawMeter = false;
      for (var f = 0; f < 400; f++) {
        pressedNow = {}; releasedNow = {};
        if (f === 120) { pressedNow.shoot = true; held.shoot = true; }
        if (f === 160) { held.shoot = false; releasedNow.shoot = true; }
        scene.fixedUpdate(1 / 120);
        if (f % 2 === 0) scene.update(1 / 60, 1 / 60);
        if (pl.action === BB.Player.ACTION.METER) sawMeter = true;
      }
      BB.Input = real;
      return { attempts: pl.stats.att - att0, sawMeter: sawMeter };
    }
    return { running: trial(false), sprinting: trial(true), pageErr: window.__pageErr || null };
  `, 'moveshoot');
  if (r.err) check('move-and-shoot probe ran', false, r.err);
  const o = r.out || {}, run = o.running || {}, spr = o.sprinting || {};
  /* Movement intent used to overwrite the shot action every tick, so a shot
   * begun while running was cancelled before the meter ticked once. */
  check('a shot taken while running actually fires',
        run.attempts === 1 && run.sawMeter, 'attempts=' + run.attempts);
  check('holding sprint does not cancel the shot',
        spr.attempts === 1 && spr.sawMeter, 'attempts=' + spr.attempts);
  check('move-and-shoot probe raised no errors', !o.pageErr, o.pageErr);
}

if (process.argv.includes('--shots')) {
  console.log('\n[19] screenshots');
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
