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

/* Court dimensions, mirrored from js/core/constants.js so checks can talk
 * about "past the baseline" without booting a page to ask. */
const C_LEN = 94, C_WID = 50;

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
  // A park draws a crowd in the dozens, not an arena bowl in the thousands.
  check('crowd submitted', (o.counts && o.counts.crowd) > 120, 'crowd=' + (o.counts && o.counts.crowd));
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

console.log('\n[8] the court does not fight the ground under it');
{
  const r = runInPage(`
    var BB = window.BB;
    BB.Engine.setState('shootaround'); BB.Engine._applyPending();
    var sc = BB.Engine.scene, gl = BB.GLX.gl, M4 = BB.M4, cam = BB.Camera;
    for (var w = 0; w < 200; w++) { sc.fixedUpdate(1/120); if (w % 2 === 0) sc.update(1/60, 1/60); }

    // Nudge the rig by inches and re-render. Two coplanar surfaces cannot be
    // separated by the depth buffer at broadcast distance, so which one wins
    // flips with sub-pixel camera movement — whole stretches of court turn
    // into the ground underneath and back, which is what reads on screen as
    // the court glitching. A scene with real depth separation barely moves at
    // all. There are three stacked surfaces to keep apart now (grass, then
    // the blacktop pad, then the painted court), not two.
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
      /* Count the painted surface specifically. Teal acrylic is the only thing
       * in the park that is this far green-of-red: the grass past the fence is
       * darker and much less blue, and the sky is barely green-biased at all,
       * so neither can stand in for the court if the court stops drawing. */
      var court = 0, n = 0;
      for (var o = 0; o < buf.length; o += 4) {
        if (buf[o + 1] - buf[o] > 80 && buf[o + 1] > 90) court++;
        n++;
      }
      cov.push(court / n);
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
  check('the painted court is visible at broadcast distance', o.min > 0.2,
        'min coverage=' + ((o.min || 0) * 100).toFixed(1) + '%');
  check('court does not flicker as the camera moves', o.spread < 0.03,
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

console.log('\n[11] the shot meter hangs on the shooter, and clears the scorebug');
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
    /* The green window specifically, picked out by the colour it is painted in
     * — it is the one part of the bar the player is actually timing against,
     * and the only one whose position on screen matters to them. */
    // Canvas normalises a colour string when it is read back ("rgba(34, 228,
    // 160, 0.55)"), so compare with the spaces taken out of both.
    var mint = BB.U.rgba(BB.C.PAL.mint, 0.55).split(' ').join('');
    var green = null;
    ctx.arc = function (x, y, r, a0, a1) {
      pending = { x: x, y: y, r: r, a0: a0, a1: a1 };
      return realArc.apply(this, arguments);
    };
    ctx.stroke = function () {
      if (pending) {
        var half = (this.lineWidth || 1) / 2;
        var gy0 = 1e9, gy1 = -1e9;
        for (var a = pending.a0; a <= pending.a1 + 1e-6; a += 0.02) {
          var px = pending.x + Math.cos(a) * pending.r;
          var py = pending.y + Math.sin(a) * pending.r;
          minY = Math.min(minY, py - half); maxY = Math.max(maxY, py + half);
          minX = Math.min(minX, px - half); maxX = Math.max(maxX, px + half);
          gy0 = Math.min(gy0, py); gy1 = Math.max(gy1, py);
        }
        if (String(this.strokeStyle).split(' ').join('') === mint) green = (gy0 + gy1) * 0.5;
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

    /* And now an ordinary shot from an ordinary spot, which is what the player
     * spends the whole game looking at. Measured against the figure itself:
     * where the green window sits relative to the head, and whether the bar
     * runs down beside the body or straight across it. */
    pl.meter.cancel();
    scene.ai.x = -90; scene.ai.y = -90;          // nobody to shove the shooter
    pl.placeAt(scene.hoop.x - 18, 25, 0);
    pl.vx = pl.vy = 0;
    // Let the rig settle onto them first: the bar is placed by projecting a
    // point in the world, so it is only where the player sees it once the
    // camera is actually looking at the player.
    for (var s = 0; s < 240; s++) {
      scene.fixedUpdate(1 / 120);
      if (s % 2 === 0) scene.update(1 / 60, 1 / 60);
    }
    /* A real shot, taken the way the game takes one — so this measures where
     * the shot code ANCHORS the bar as well as where draw() puts it. Setting
     * an anchor by hand here would pass just as happily with the bar strung
     * off the shooting hand nine feet in the air. */
    pl.giveBall(scene.ball);
    pl._beginShot();
    for (var m = 0; m < 60 && pl.action !== BB.Player.ACTION.METER; m++) {
      scene.fixedUpdate(1 / 120);
      if (m % 2 === 0) scene.update(1 / 60, 1 / 60);
    }
    for (var m2 = 0; m2 < 24; m2++) {
      scene.fixedUpdate(1 / 120);
      if (m2 % 2 === 0) scene.update(1 / 60, 1 / 60);
    }
    minY = 1e9; maxY = -1e9; minX = 1e9; maxX = -1e9; green = null;
    pl.meter.draw(ctx, cam);
    var live = { minY: minY, maxY: maxY, minX: minX, maxX: maxX, green: green,
                 action: pl.action };

    var crownZ = pl.z + (-pl.pose.headY + BB.Player.BONE.headR) * pl.bodyScale;
    var head = cam.project(pl.x, pl.y, crownZ, null);
    var feet = cam.project(pl.x, pl.y, pl.z, null);
    // Half the figure's on-screen width, taken at chest height off the same
    // radius the physics uses, so "beside them" is measured, not eyeballed.
    var chest = cam.project(pl.x, pl.y, crownZ * 0.55, null);
    var side = cam.project(pl.x, pl.y + pl.radius, crownZ * 0.55, null);

    ctx.arc = realArc; ctx.stroke = realStroke;
    return {
      safe: safe, dpr: dpr, vw: cam.vw, vh: cam.vh, high: high, low: low,
      live: live, headY: head.y, headX: head.x, feetY: feet.y,
      halfW: Math.abs(side.x - chest.x)
    };
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
  /* Where the bar hangs on an ordinary shot. The bar is screen-space, the
   * player is not, so everything here is in units of the figure's own
   * on-screen height — that holds at any resolution and any camera distance. */
  const live = o.live || {};
  const bodyPx = (o.feetY || 0) - (o.headY || 0);
  const aboveHead = ((o.headY || 0) - (live.green || 0)) / Math.max(1, bodyPx);
  check('the meter is up for a real shot', live.action === 'meter',
        'shooter was in action "' + live.action + '"');
  check('the green window sits at the shooter, not floating above them',
        live.green != null && aboveHead > -0.35 && aboveHead < 0.25,
        'green window is ' + (aboveHead * 100).toFixed(0) +
        '% of a body-height above the head');
  // Brought down to head height, a bar centred over the shooter would be drawn
  // across their chest for the whole shot.
  check('the bar hangs beside the shooter, not across them',
        (o.headX || 0) - live.maxX > o.halfW * 0.5,
        'bar ends ' + ((o.headX || 0) - live.maxX).toFixed(0) +
        'px clear of a figure ' + (o.halfW || 0).toFixed(0) + 'px half-wide');

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

    // Walk out to each wing and measure whether the arena turned underneath
    // the play. Project a 20ft line running along the court's length: if the
    // rig is square to the floor that line runs straight up the screen, and
    // if the rig has yawed to chase the basket it comes out slanted.
    var sign = hoop.x >= pl.x ? 1 : -1;
    function wing(offY) {
      pl.placeAt(hoop.x - 24, hoop.y + offY, 0);
      cam.setAim(hoop.x, hoop.y);
      for (var n = 0; n < 240; n++) cam.update(1 / 60, { x: pl.x, y: pl.y }, null);
      var a = cam.project(pl.x, pl.y, 0, null);
      var b = cam.project(pl.x + 20 * sign, pl.y, 0, null);
      return {
        tilt: Math.abs(b.x - a.x) / Math.max(1, Math.abs(b.y - a.y)),
        heading: Math.atan2(cam._dy, cam._dx),
        follow: cam.eye[2] - pl.y
      };
    }
    var wingL = wing(-20), wingR = wing(20);
    pl.placeAt(hoop.x - 20, hoop.y, 0);
    for (var m = 0; m < 120; m++) cam.update(1 / 60, { x: pl.x, y: pl.y }, null);

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
      wingL: wingL, wingR: wingR,
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
  /* Drifting off centre must not rotate the world. The heading is pinned to
   * the court's length axis, so both wings look down the same line and the
   * court's length still runs straight up the screen. */
  const wl = o.wingL || {}, wr = o.wingR || {};
  check('the floor does not turn under you on the wing',
        wl.tilt < 0.06 && wr.tilt < 0.06,
        'length axis slants ' + ((wl.tilt || 0) * 100).toFixed(0) + '% / ' +
        ((wr.tilt || 0) * 100).toFixed(0) + '% off vertical');
  check('both wings share one heading',
        Math.abs((wl.heading || 0) - (wr.heading || 0)) < 0.02,
        'headings ' + ((wl.heading || 0) * 57.3).toFixed(1) + ' vs ' +
        ((wr.heading || 0) * 57.3).toFixed(1) + ' degrees');
  // Locked heading, but the rig still slides across to keep the play in shot.
  check('the rig still dollies across to follow',
        Math.abs(wl.follow) < 1 && Math.abs(wr.follow) < 1,
        'rig sits ' + (wl.follow || 0).toFixed(1) + 'ft / ' +
        (wr.follow || 0).toFixed(1) + 'ft off the player');
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

console.log('\n[19] the camera is pinned to the player, and glides');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U;
    BB.Settings.set('cameraMode', 'forward');
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene, cam = BB.Camera, pl = scene.player;
    var hoop = scene.hoop, ball = scene.ball, dt = 1 / 60;
    scene.ai.x = -90; scene.ai.y = -90; scene.ai.hasBall = false;

    /* ---- A. a real shot, watched from where it was taken ----------------
     * The rig used to switch its focus to the ball the moment it left the
     * hand, which flies the frame down to the rim and leaves the player — the
     * thing the user is steering — somewhere off behind the shot. */
    pl.placeAt(hoop.x - 26, hoop.y, 0);
    pl.vx = pl.vy = 0;
    cam.reset(pl.x, pl.y, 1);
    for (var i = 0; i < 180; i++) scene.update(dt, dt);
    pl.giveBall(ball);
    pl._beginShot();
    var fired = false, flightFrames = 0, offPlayer = 0, ballRan = 0;
    for (var f = 0; f < 500; f++) {
      scene.fixedUpdate(1 / 120);
      if (f % 2 === 0) scene.update(dt, dt);
      if (!fired && pl.action === BB.Player.ACTION.METER && pl.meter.value > 0.9) {
        pl._releaseShot(); fired = true;
      }
      if (fired && ball.inFlight) {
        flightFrames++;
        offPlayer = Math.max(offPlayer, Math.hypot(cam.x - pl.x, cam.y - pl.y));
        ballRan = Math.max(ballRan, Math.hypot(ball.x - pl.x, ball.y - pl.y));
      } else if (fired) break;
    }
    var shot = { off: offPlayer, ballRan: ballRan, frames: flightFrames };

    /* ---- B. the other guy has the ball ---------------------------------- */
    ball.owner = null; pl.hasBall = false;
    pl.placeAt(hoop.x - 26, hoop.y, 0); pl.vx = pl.vy = 0;
    cam.reset(pl.x, pl.y, 1);
    for (var b = 0; b < 60; b++) scene.update(dt, dt);
    scene.ai.placeAt(hoop.x - 6, hoop.y + 20, 0);
    scene.ai.giveBall(ball);
    for (var b2 = 0; b2 < 90; b2++) scene.update(dt, dt);
    var theirs = { off: Math.hypot(cam.x - pl.x, cam.y - pl.y),
                   away: Math.hypot(scene.ai.x - pl.x, scene.ai.y - pl.y) };
    ball.owner = null; scene.ai.hasBall = false;
    scene.ai.x = -90; scene.ai.y = -90;

    /* ---- C. how the rig moves over a sprint, a hold and a hard stop -----
     * Driven straight at the camera on the player's own acceleration curve,
     * so the numbers describe the rig and nothing else. */
    var top = pl.phys.maxSprint, accel = pl.phys.accel, decel = pl.phys.decel;
    pl.placeAt(hoop.x - 60, hoop.y, 0); pl.vx = pl.vy = 0;
    cam.reset(pl.x, pl.y, 1);
    for (var s = 0; s < 240; s++) cam.update(dt, { x: pl.x, y: pl.y }, { x: 0, y: 0 });

    var es = [], px = [], v = 0;
    for (var k = 0; k < 300; k++) {
      var want = (k * dt < 2.2) ? top : 0;
      v = U.moveToward(v, want, (want > v ? accel : decel) * dt);
      pl.x += v * dt;
      cam.update(dt, { x: pl.x, y: pl.y }, { x: v, y: 0 });
      es.push(cam.eye[0]); px.push(pl.x);
    }
    var vs = [], as = [];
    for (var q = 1; q < es.length; q++) vs.push((es[q] - es[q - 1]) / dt);
    for (var w = 1; w < vs.length; w++) as.push((vs[w] - vs[w - 1]) / dt);
    var maxSpd = 0, back = 0, maxAcc = 0, maxJerk = 0, maxLag = 0;
    for (var a = 0; a < vs.length; a++) { maxSpd = Math.max(maxSpd, vs[a]); back = Math.min(back, vs[a]); }
    for (var c = 0; c < as.length; c++) maxAcc = Math.max(maxAcc, Math.abs(as[c]));
    for (var d = 1; d < as.length; d++) maxJerk = Math.max(maxJerk, Math.abs(as[d] - as[d - 1]) / dt);
    // Lag is measured against the standoff the rig started at, so it is how
    // far the player slid through the frame, not where the rig sits.
    var base = px[0] - es[0];
    for (var e = 0; e < es.length; e++) maxLag = Math.max(maxLag, Math.abs((px[e] - es[e]) - base));
    var settled = Math.abs((px[px.length - 1] - es[es.length - 1]) - base);

    /* ---- D. a teleport is an edit, not a move --------------------------- */
    pl.placeAt(20, 25, 0); pl.vx = pl.vy = 0;
    cam.reset(pl.x, pl.y, 1);
    for (var g = 0; g < 120; g++) cam.update(dt, { x: pl.x, y: pl.y }, { x: 0, y: 0 });
    pl.placeAt(70, 25, 0);
    cam.update(dt, { x: pl.x, y: pl.y }, { x: 0, y: 0 });
    var cutErr = Math.hypot(cam._x - pl.x, cam._y - pl.y);

    // And an ordinary stride is still smoothed, not cut — from its own settled
    // start, so this stands up whatever the line above did.
    pl.placeAt(20, 25, 0);
    cam.reset(pl.x, pl.y, 1);
    for (var g2 = 0; g2 < 120; g2++) cam.update(dt, { x: pl.x, y: pl.y }, { x: 0, y: 0 });
    pl.placeAt(20.4, 25, 0);
    cam.update(dt, { x: pl.x, y: pl.y }, { x: 0, y: 0 });
    var strideErr = Math.hypot(cam._x - pl.x, cam._y - pl.y);

    return {
      shot: shot, theirs: theirs,
      top: top, accel: accel, decel: decel,
      maxSpd: maxSpd, back: back, maxAcc: maxAcc, maxJerk: maxJerk,
      maxLag: maxLag, settled: settled,
      cutErr: cutErr, strideErr: strideErr,
      pageErr: window.__pageErr || null
    };
  `, 'follow');
  if (r.err) check('follow probe ran', false, r.err);
  const o = r.out || {};
  const sh = o.shot || {}, th = o.theirs || {};

  check('the rig stays on the player while the shot is in the air',
        sh.frames > 20 && sh.ballRan > 12 && sh.off < 1.5,
        'ball ran ' + (sh.ballRan || 0).toFixed(1) + 'ft, rig wandered ' +
        (sh.off || 0).toFixed(1) + 'ft off the player over ' + sh.frames + ' frames');
  check('the other guy having the ball does not steal the camera',
        th.away > 15 && th.off < 1.5,
        'they are ' + (th.away || 0).toFixed(1) + 'ft away, rig sits ' +
        (th.off || 0).toFixed(1) + 'ft off the player');

  // A rig that has to outrun its subject to keep up is a rig that is chasing
  // something else — or throwing itself at a lead it will have to give back.
  check('the rig never outruns the player it is following',
        o.maxSpd < o.top * 1.15,
        'rig peaked at ' + (o.maxSpd || 0).toFixed(1) + 'ft/s, player at ' +
        (o.top || 0).toFixed(1) + 'ft/s');
  check('the rig pulls no harder than the player does',
        o.maxAcc < o.accel * 1.5,
        'rig ' + (o.maxAcc || 0).toFixed(0) + 'ft/s^2 against a player at ' +
        (o.accel || 0).toFixed(0));
  // Jerk is where "not smooth" actually lives: a step in the rig's
  // acceleration is a frame that visibly snaps.
  check('the follow has no kinks in it', o.maxJerk < 600,
        'peak jerk ' + (o.maxJerk || 0).toFixed(0) + 'ft/s^3');
  check('the frame does not slide backwards when the player pulls up',
        o.back > -2.5,
        'rig ran backwards at ' + (-(o.back || 0)).toFixed(1) + 'ft/s');
  check('the player never slides out of the shot', o.maxLag < 5,
        'player drifted ' + (o.maxLag || 0).toFixed(1) + 'ft through the frame');
  check('the rig settles exactly on the player', o.settled < 0.15,
        'left ' + (o.settled || 0).toFixed(2) + 'ft of error');

  // An inbound, a new quarter, a switch to another defender: the focus moves
  // further than anyone could run, and smoothing it flies the rig across the
  // arena with the play already underway at the other end.
  check('a teleport cuts instead of flying across the floor', o.cutErr < 0.6,
        'rig was ' + (o.cutErr || 0).toFixed(1) + 'ft out one frame after a 50ft jump');
  check('an ordinary stride is still smoothed, not cut',
        o.strideErr > 0.1 && o.strideErr < 0.45,
        'rig was ' + (o.strideErr || 0).toFixed(2) + 'ft behind after a 0.4ft step');
  check('follow probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[20] the court is outdoors, in a park, in daylight');
{
  const r = runInPage(`
    var BB = window.BB;
    BB.Settings.set('cameraMode', 'forward');
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene, gl = BB.GLX.gl, cam = BB.Camera;
    for (var i = 0; i < 300; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }
    scene.render(0);

    var W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    var buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    /* readPixels puts row 0 at the BOTTOM of the image. Sample the top band
     * of the frame — the part that used to be arena roof and black void, and
     * out here has to be open sky. */
    var lum = 0, dark = 0, court = 0, n = 0;
    var skyR = 0, skyG = 0, skyB = 0, skyN = 0;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var o = (y * W + x) * 4;
        var l = (buf[o] + buf[o + 1] + buf[o + 2]) / 3;
        lum += l;
        if (l < 30) dark++;
        if (buf[o + 1] - buf[o] > 80 && buf[o + 1] > 90) court++;
        if (y > H * 0.86) { skyR += buf[o]; skyG += buf[o + 1]; skyB += buf[o + 2]; skyN++; }
        n++;
      }
    }

    /* Where the crowd actually is. Instance layout is 16 matrix floats then
     * colour then params; matrix column 3 is the translation, and in GL space
     * its second component is height. A seated bowl puts fans twenty feet up
     * the back of a stand; a park puts them on the ground at the fence. */
    /* Guarded, so that a build with no Park in it still reports what it put on
     * the screen instead of throwing and taking the pixel checks with it. */
    var P = BB.Park || { _crowd: [], _crowdCount: 0, _structure: [], _structureCount: 0,
                         _foliageCount: 0 };
    var hi = -1e9, lo = 1e9;
    for (var c = 0; c < P._crowdCount; c++) {
      var t = P._crowd[c * 24 + 13];
      if (t > hi) hi = t;
      if (t < lo) lo = t;
    }

    /* And how far out the fence stands from the court on each side. The blocks
     * are laid out as 16 matrix floats first: [0] is the footprint along court
     * x, [5] the height, [10] the footprint along court y, and [12]/[14] the
     * position. A fence post is the only thing in the park with a footprint
     * under half a foot square and more than ten feet of height. */
    var bounds = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, posts: 0 };
    for (var s = 0; s < P._structureCount; s++) {
      var b = s * 24;
      if (P._structure[b] > 0.5 || P._structure[b + 10] > 0.5) continue;
      var sz = P._structure[b + 5];
      if (sz < 10 || sz > 25) continue;
      var px = P._structure[b + 12], py = P._structure[b + 14];
      bounds.x0 = Math.min(bounds.x0, px); bounds.x1 = Math.max(bounds.x1, px);
      bounds.y0 = Math.min(bounds.y0, py); bounds.y1 = Math.max(bounds.y1, py);
      bounds.posts++;
    }

    return {
      meanLum: lum / n, darkFrac: dark / n, courtFrac: court / n,
      sky: [Math.round(skyR / skyN), Math.round(skyG / skyN), Math.round(skyB / skyN)],
      crowdHi: hi, crowdLo: lo,
      crowd: P._crowdCount, foliage: P._foliageCount, structure: P._structureCount,
      fence: bounds,
      hasArena: typeof BB.Arena !== 'undefined',
      hasSky: !!BB.S3.progSky,
      glError: gl.getError(),
      pageErr: window.__pageErr || null
    };
  `, 'park');
  if (r.err) check('park probe ran', false, r.err);
  const o = r.out || {};
  const sky = o.sky || [0, 0, 0];

  check('the arena is gone', o.hasArena === false);
  // The single loudest signal that there is no building: you can see the sky.
  check('open sky over the top of the frame',
        sky[2] > 150 && sky[2] > sky[0] + 25 && sky[2] >= sky[1],
        'top band reads rgb(' + sky.join(',') + ')');
  check('the sky is drawn as its own pass', o.hasSky === true);
  // "Court at Night" put a bright island of floor inside a black room. In the
  // park nothing falls away: the whole frame is lit.
  check('the frame is bright edge to edge', o.meanLum > 95,
        'mean luminance ' + (o.meanLum || 0).toFixed(0) + ' of 255');
  check('almost nothing in frame falls to black', o.darkFrac < 0.16,
        ((o.darkFrac || 0) * 100).toFixed(1) + '% of the frame is near-black');
  check('the court is painted acrylic, not hardwood', o.courtFrac > 0.2,
        'painted surface covers ' + ((o.courtFrac || 0) * 100).toFixed(1) + '% of frame');

  /* The crowd stands on the ground behind a fence. In the bowl they were
   * stacked up fifteen rows of risers, the top row twenty-odd feet in the
   * air — which is the one thing a park can never have. */
  check('the crowd stands on the ground, not up a stand',
        o.crowd > 60 && o.crowdHi < 8 && o.crowdLo > -3,
        o.crowd + ' instances between ' + (o.crowdLo || 0).toFixed(1) +
        'ft and ' + (o.crowdHi || 0).toFixed(1) + 'ft up');
  const f = o.fence || {};
  check('a fence rings the court, well clear of the floor',
        f.posts > 30 &&
        f.x0 < -30 && f.x1 > C_LEN + 30 && f.y0 < -20 && f.y1 > C_WID + 40,
        f.posts + ' posts spanning x ' + Math.round(f.x0) + '..' + Math.round(f.x1) +
        ', y ' + Math.round(f.y0) + '..' + Math.round(f.y1));
  check('there are trees', o.foliage >= 30, 'foliage instances=' + o.foliage);
  check('gl clean in the park', o.glError === 0, 'code=' + o.glError);
  check('park raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[21] the ball is the right size and comes back to the hand');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U, C = BB.C;
    BB.Engine.setState('shootaround'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene, pl = scene.player, ball = scene.ball, hoop = scene.hoop;
    for (var i = 0; i < 120; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }

    /* ---- what the renderer actually submits -------------------------- */
    pl.placeAt(hoop.x - 14, hoop.y, 0); pl.vx = pl.vy = 0;
    pl.giveBall(ball);
    scene.update(1 / 60, 1 / 60);
    scene.render(0);
    /* Find the ball in the submitted instance data by its position rather than
     * by asking any particular mesh for it — the point of this section is to
     * measure what the renderer was told to draw, whichever primitive it chose
     * to draw it with. Instance layout is 16 matrix floats first: [0] is the
     * scale across, and the translation is at [12..14] in GL order (court x,
     * height, court y). */
    var S3 = BB.S3;
    var drawnR = -1, ballMesh = null, ballVerts = 0;
    var sphereVerts = S3.meshes.sphere.indexCount;
    var names = ['ball', 'sphere'];
    for (var mi = 0; mi < names.length; mi++) {
      var mesh = S3.meshes[names[mi]];
      if (!mesh) continue;
      for (var k = 0; k < mesh.n; k++) {
        var b = k * 24;
        if (Math.abs(mesh.data[b + 12] - ball.x) < 0.01 &&
            Math.abs(mesh.data[b + 13] - ball.z) < 0.01 &&
            Math.abs(mesh.data[b + 14] - ball.y) < 0.01) {
          drawnR = mesh.data[b] / 2;
          ballMesh = names[mi];
          ballVerts = mesh.indexCount;
        }
      }
    }

    // Against the figure carrying it, both measured at the same spot so the
    // perspective cancels and this is purely a statement about proportion.
    var crown = (-pl.pose.headY + BB.Player.BONE.headR) * pl.bodyScale;
    var vsPlayer = (drawnR * 2) / crown;

    /* ---- take a shot, make it, and watch what comes back ------------- */
    var scored = false;
    ball.events.on('score', function () { scored = true; });
    var stateAtScore = null;
    var wasScored = false;
    pl._beginShot();
    var fired = false, armDuringFlight = [];
    for (var f = 0; f < 1400; f++) {
      scene.fixedUpdate(1 / 120);
      if (f % 2 === 0) scene.update(1 / 60, 1 / 60);
      if (!fired && pl.action === BB.Player.ACTION.METER && pl.meter.value > 0.9) {
        pl._releaseShot(); fired = true;
      }
      if (scored && !wasScored) { stateAtScore = ball.state; wasScored = true; }
      if (fired) armDuringFlight.push(pl.armRaise);
      if (wasScored && pl.hasBall) break;
    }

    var armAfter = pl.armRaise;
    var headZ = -pl.pose.headY * pl.bodyScale;

    /* One full dribble cycle, once the ball is back. */
    var lo = 1e9, hi = -1e9, hand = { x: 0, y: 0, z: 0 };
    for (var q = 0; q < 140; q++) {
      scene.fixedUpdate(1 / 120);
      if (q % 2 === 0) scene.update(1 / 60, 1 / 60);
      if (ball.owner === pl) { lo = Math.min(lo, ball.z); hi = Math.max(hi, ball.z); }
    }
    pl.handAt(hand);

    /* And the bottom of a bounce measured straight off the carry, with the
     * arms forced down. Asked this way it is a statement about the drawn ball
     * alone, and cannot be answered by a ball that is not being dribbled. */
    var bottom = 1e9;
    pl.armRaise = 0;
    for (var s = 0; s <= 40; s++) {
      pl.dribblePhase = s / 40;
      pl._updatePose(1 / 60);
      bottom = Math.min(bottom, pl.handPosition(null).z);
    }

    return {
      drawnR: drawnR, trueR: C.BALL_RADIUS, rimR: C.RIM_RADIUS,
      ballMesh: ballMesh, ballVerts: ballVerts, sphereVerts: sphereVerts,
      vsPlayer: vsPlayer, crown: crown,
      scored: scored, stateAtScore: stateAtScore,
      armAfter: armAfter, held: ball.owner === pl,
      ballZ: ball.z, headZ: headZ, drawnHandZ: hand.z,
      dribbleLo: lo, dribbleHi: hi, bottom: bottom,
      pageErr: window.__pageErr || null
    };
  `, 'ball');
  if (r.err) check('ball probe ran', false, r.err);
  const o = r.out || {};

  /* --- size ---------------------------------------------------------- */
  check('the ball is drawn at its true physical size',
        Math.abs(o.drawnR - o.trueR) < 0.005,
        'drawn radius ' + (o.drawnR || 0).toFixed(3) + 'ft against a real ' +
        (o.trueR || 0).toFixed(3) + 'ft');
  // A size 7 ball is about 9.4in across and the ring is 18in: over four inches
  // of clearance all the way round. Inflate the ball and it starts to look
  // like it could not physically go in.
  check('it clears the ring the way a real ball does',
        o.rimR - o.drawnR > 0.30 && o.rimR - o.drawnR < 0.42,
        ((o.rimR - o.drawnR) * 12).toFixed(1) + 'in of clearance each side');
  // And against the man holding it. A real ball is about an eighth of a
  // player's height; the figure here is deliberately compressed, so a sixth is
  // right and a quarter is a beach ball.
  check('the ball is a ball next to the player, not a beach ball',
        o.vsPlayer > 0.10 && o.vsPlayer < 0.20,
        'ball is ' + ((o.vsPlayer || 0) * 100).toFixed(0) + '% of a ' +
        (o.crown || 0).toFixed(1) + 'ft figure');
  // Held at the bottom of the bounce the ball touches the floor; drawn any
  // bigger it goes straight through it.
  check('the ball never sinks through the floor at the bounce',
        o.bottom - o.drawnR > -0.02,
        'lowest point ' + ((o.bottom - o.drawnR) * 12).toFixed(1) + 'in above the floor');
  check('the ball has a mesh of its own, and a finer one',
        o.ballMesh === 'ball' && o.ballVerts > o.sphereVerts * 2,
        'drawn from "' + o.ballMesh + '" at ' + o.ballVerts +
        ' indices, against the shared sphere at ' + o.sphereVerts);

  /* --- coming back after a make -------------------------------------- */
  check('the shot went in', o.scored === true);
  // The one that used to strand the ball over the shooter's head forever.
  check('the arm comes all the way down after a shot', o.armAfter === 0,
        'armRaise settled at ' + (o.armAfter || 0).toFixed(4));
  check('the ball is back in the hand, not floating over the head',
        o.held === true && o.ballZ < o.headZ,
        'ball at ' + (o.ballZ || 0).toFixed(2) + 'ft, head at ' + (o.headZ || 0).toFixed(2) + 'ft');
  check('and it is being dribbled, not carried',
        o.dribbleHi - o.dribbleLo > 1.2 && o.dribbleLo < 0.9,
        'travels ' + (o.dribbleHi - o.dribbleLo).toFixed(2) + 'ft, down to ' +
        (o.dribbleLo || 0).toFixed(2) + 'ft');
  // Through the net it is a live ball; it used to stay "in flight" for the
  // whole time it spent bouncing afterwards, which no rebound could touch.
  check('a made basket leaves a live ball, not a shot in flight',
        o.stateAtScore === 'loose', 'ball state on the score was ' + o.stateAtScore);
  check('ball probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[22] a highlight gets a slow-motion replay');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U, C = BB.C;
    if (!BB.Replay) return { missing: true };

    BB.Settings.set('cameraMode', 'forward');
    BB.Settings.set('instantReplay', true);
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene, pl = scene.player, hoop = scene.hoop, R = BB.Replay;
    // A pure shooter, so a perfect release reliably swishes and this section is
    // about the replay rather than about the shot solver's error term.
    pl.ratings.threePoint = 99; pl.ratings.midRange = 99;

    var DT = 1 / 60;
    /* The engine's own frame, by hand: the replay hooks into it, so a probe
     * that called fixedUpdate directly would never exercise the freeze.
     *
     * The defender is held off the floor only while the shot is being set up.
     * Left held there it would keep being shoved back between the snapshot of
     * the live world and the frame the replay parks it on, and the hand-back
     * check would be measuring the probe rather than the replay. */
    var parkAI = true;
    function frame() {
      if (parkAI) { scene.ai.x = -95; scene.ai.y = -95; scene.ai.hasBall = false; }
      BB.Input.beginFrame();
      var frozen = R.beginFrame(DT, scene);
      if (!frozen) {
        scene.fixedUpdate(1 / 120); scene.fixedUpdate(1 / 120);
        scene.update(DT, DT);
      }
      BB.Input.endFrame();
      return frozen;
    }

    for (var i = 0; i < 120; i++) frame();

    /** Shoots until one drops clean from behind the arc. */
    var scored = false, seen = null;
    scene.ball.events.on('score', function (e) { scored = true; seen = { three: e.three, clean: e.clean }; });
    function cleanThree() {
      for (var tries = 0; tries < 20; tries++) {
        scored = false; seen = null;
        R.reset();
        scene.phase = 'live'; scene.score.you = 0; scene.score.cpu = 0;
        pl.placeAt(hoop.x - 27, hoop.y - 1, 0);
        pl.vx = pl.vy = 0; pl.z = 0; pl.jumping = false; pl.action = null;
        pl.giveBall(scene.ball);
        for (var w = 0; w < 220; w++) frame();
        pl._beginShot();
        var fired = false;
        for (var f = 0; f < 500 && !scored; f++) {
          frame();
          if (!fired && pl.action === BB.Player.ACTION.METER &&
              pl.meter.profile && pl.meter.value >= pl.meter.profile.target) {
            pl._releaseShot(); fired = true;
          }
        }
        if (seen && seen.three && seen.clean) return true;
      }
      return false;
    }

    var got = cleanThree();
    var armed = R.phase;

    /* Everything about the live world at the moment of the cut. This is what
     * has to come back untouched. */
    function snap() {
      return [pl.x, pl.y, pl.z, pl.facing, pl.pose.hipY, pl.pose.handR.x,
              scene.ai.x, scene.ai.y, scene.ai.pose.hipY,
              scene.ball.x, scene.ball.y, scene.ball.z];
    }
    parkAI = false;
    var live = snap();
    var scoreAtCut = scene.score.you;
    var camMode = BB.Camera.mode;

    frame();                                     // armed -> playing
    var playing = R.playing, cine = BB.Camera.cine;
    var atStart = snap();
    var eye0 = [BB.Camera.eye[0], BB.Camera.eye[1], BB.Camera.eye[2]];

    var frames = 1, steps = [], zeros = 0, eyeTravel = 0, moved = 0;
    var prevZ = scene.ball.z, prevEye = eye0.slice();
    var restored = null, scoreAfter = scene.score.you;
    /* The engine's frame, opened up: the state has to be read the instant the
     * replay hands back and BEFORE the simulation gets a tick, or what is
     * measured is one frame of live play rather than the hand-back. */
    while (frames < 3000) {
      BB.Input.beginFrame();
      var frozen = R.beginFrame(DT, scene);
      if (!frozen) { restored = snap(); scoreAfter = scene.score.you; BB.Input.endFrame(); break; }
      var d = Math.abs(scene.ball.z - prevZ);
      // Only while the ball is actually travelling: the tail is a deliberate
      // freeze-frame and would read as a stall.
      if (R._playT < R.PRE_ROLL * 0.9) { steps.push(d); if (d < 1e-5) zeros++; }
      prevZ = scene.ball.z;
      eyeTravel += Math.hypot(BB.Camera.eye[0] - prevEye[0], BB.Camera.eye[2] - prevEye[2]);
      prevEye = [BB.Camera.eye[0], BB.Camera.eye[1], BB.Camera.eye[2]];
      moved = Math.max(moved, Math.abs(pl.x - live[0]));
      BB.Input.endFrame();
      frames++;
    }
    var realSeconds = frames * DT;
    if (!restored) restored = snap();
    for (var k = 0; k < 30; k++) frame();        // and back to live play

    var worstDrift = 0;
    for (var s = 0; s < live.length; s++) worstDrift = Math.max(worstDrift, Math.abs(live[s] - restored[s]));

    var maxStep = 0, sum = 0;
    for (var q = 0; q < steps.length; q++) { maxStep = Math.max(maxStep, steps[q]); sum += steps[q]; }
    var meanStep = steps.length ? sum / steps.length : 0;
    var zeroFrac = steps.length ? zeros / steps.length : 1;

    /* Rating, without needing a shot to land: a three that rattles in is a
     * good shot and not a picture worth stopping the game for. */
    var rateClean = R.rateShot({ three: true, clean: true }, pl);
    var rateRattle = R.rateShot({ three: true, clean: false }, { stats: { streak: 0 } });
    var rateTwo = R.rateShot({ three: false, clean: true }, { stats: { streak: 0 } });

    /* And with the setting off, nothing fires at all. */
    R.reset();
    BB.Settings.set('instantReplay', false);
    for (var z = 0; z < 200; z++) frame();
    var offTook = R.highlight({ weight: 1, label: 'X', x: pl.x, y: pl.y, hoopX: hoop.x, hoopY: hoop.y });
    BB.Settings.set('instantReplay', true);

    return {
      got: got, seen: seen, armed: armed, playing: playing, cine: cine,
      label: R.label, frames: frames, realSeconds: realSeconds,
      span: R.PRE_ROLL + R.HOLD_TAIL, playRate: R.PLAY_RATE,
      rewindBall: Math.hypot(atStart[9] - live[9], atStart[11] - live[11]),
      rewindPlayer: Math.hypot(atStart[0] - live[0], atStart[1] - live[1]),
      playersMoved: moved,
      eyeTravel: eyeTravel,
      worstDrift: worstDrift,
      scoreAtCut: scoreAtCut, scoreAfter: scoreAfter,
      maxStep: maxStep, meanStep: meanStep, stepCount: steps.length, zeroFrac: zeroFrac,
      cineAfter: BB.Camera.cine, phaseAfter: R.phase, playingAfter: R.playing,
      camMode: camMode, camModeAfter: BB.Camera.mode,
      rateClean: rateClean, rateRattle: rateRattle, rateTwo: rateTwo,
      threshold: R.THRESHOLD,
      offTook: offTook,
      bufferFloats: R._buf.length,
      pageErr: window.__pageErr || null
    };
  `, 'replay');
  if (r.err) check('replay probe ran', false, r.err);
  const o = r.out || {};
  if (o.missing) check('the replay system exists', false, 'BB.Replay is not defined');

  check('a clean three from deep triggers a replay',
        o.got === true && o.playing === true && o.label === 'SWISH FROM DEEP',
        'phase after the make was "' + o.armed + '", label "' + o.label + '"');
  // Not every bucket. A three that rattles in is a good shot and an ugly
  // picture, and stopping the game for one would wear out fast.
  check('a rattled three and a plain two do not',
        (o.rateRattle || {}).weight < o.threshold && !o.rateTwo,
        'rattled three rates ' + JSON.stringify(o.rateRattle) +
        ' against a threshold of ' + o.threshold);

  check('it rewinds to before the shot',
        o.rewindBall > 6 && o.rewindPlayer > 6,
        'ball jumped back ' + (o.rewindBall || 0).toFixed(1) + 'ft and the shooter ' +
        (o.rewindPlayer || 0).toFixed(1) + 'ft');
  // The whole point: it is SLOW. The footage is played over noticeably more
  // real time than it was recorded in.
  check('it plays in slow motion',
        o.realSeconds > o.span * 1.4 &&
        Math.abs(o.realSeconds - o.span / o.playRate) < 0.6,
        (o.span || 0).toFixed(2) + 's of play took ' + (o.realSeconds || 0).toFixed(2) + 's to watch');
  check('the players are replayed too, not only the ball',
        o.playersMoved > 6,
        'the shooter was drawn up to ' + (o.playersMoved || 0).toFixed(1) +
        'ft from where the live game had him');
  /* Sampled BETWEEN recorded frames rather than snapped to the nearest one.
   * Played at 0.55x, a sampler that snapped would hold each captured frame for
   * getting on for two real ones, so about half the frames on screen would be
   * identical to the one before — which is what a replay looks like when it
   * reads as a flip-book rather than as slow motion. */
  check('it is smooth, not a slideshow',
        o.stepCount > 40 && o.zeroFrac < 0.12,
        ((o.zeroFrac || 0) * 100).toFixed(0) + '% of ' + o.stepCount +
        ' frames were identical to the one before');
  check('the camera flies a path of its own',
        o.cine === true && o.eyeTravel > 15,
        'rig travelled ' + (o.eyeTravel || 0).toFixed(1) + 'ft, cinematic=' + o.cine);

  /* The replay scrubs recorded state over the live entities, so the one thing
   * it must never do is leave any of it behind. */
  check('the game does not move while a replay runs',
        o.scoreAtCut === o.scoreAfter,
        'score went ' + o.scoreAtCut + ' -> ' + o.scoreAfter);
  check('it hands the live world back exactly as it found it',
        o.worstDrift < 1e-4,
        'worst field drifted by ' + (o.worstDrift || 0).toExponential(2));
  check('and hands the camera back',
        o.cineAfter === false && o.camModeAfter === o.camMode && o.playingAfter === false,
        'cinematic=' + o.cineAfter + ', mode ' + o.camMode + ' -> ' + o.camModeAfter);

  check('turning it off in settings turns it off', o.offTook === false);
  // Preallocated once: a recorder that grows is a recorder that stutters.
  check('the recording buffer is fixed size',
        o.bufferFloats === 60 * 6 * (6 + 10 * 40),
        'buffer is ' + o.bufferFloats + ' floats');
  check('replay probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[23] a ball out of bounds comes straight back');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U, C = BB.C;

    /* --- when a ball counts as out ------------------------------------- */
    var probe = new BB.Ball([]);
    // High over the sideline and still climbing: over the line is not out.
    probe.place(C.HALF_L, C.COURT_W + 6, 9);
    probe.launch(0, 4, 6, BB.Ball.STATE.LOOSE);
    for (var a = 0; a < 6; a++) probe.update(1 / 120);
    var flyingOver = probe.outOfPlay;
    // Now let it come down out there.
    for (var b = 0; b < 400 && !probe.outOfPlay; b++) probe.update(1 / 120);
    var landedOut = probe.outOfPlay;
    var speedWhenCalled = probe.speed;
    // And a ball rolling around inside the lines is never out.
    var inside = new BB.Ball([]);
    inside.place(C.HALF_L, C.HALF_W, 3);
    inside.launch(6, 0, 0, BB.Ball.STATE.LOOSE);
    for (var c = 0; c < 600; c++) inside.update(1 / 120);
    var falsePositive = inside.outOfPlay;

    /* --- the shootaround ------------------------------------------------ */
    BB.Engine.setState('shootaround'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene, pl = scene.player, ball = scene.ball;
    for (var i = 0; i < 120; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }

    pl.placeAt(C.HALF_L, C.HALF_W, 0); pl.vx = pl.vy = 0;
    pl.giveBall(ball); pl.hasBall = false;
    ball.place(C.HALF_L, C.COURT_W - 3, 5);
    ball.launch(2, 26, 5, BB.Ball.STATE.LOOSE);

    /* The landing is caught from inside the physics: by the time the scene's
     * fixedUpdate has returned, a fast hand-back has already put the ball in a
     * hand and there is nothing left outside the lines to measure. */
    var landedAt = -1, heldAt = -1, landSpeed = -1, t = 0;
    ball.events.on('bounce', function () {
      if (landedAt < 0 && ball.isOutOfBounds()) { landedAt = t; landSpeed = ball.speed; }
    });
    for (var k = 0; k < 4000; k++) {
      t++;
      scene.fixedUpdate(1 / 120);
      if (landedAt >= 0 && heldAt < 0 && ball.owner === pl) { heldAt = t; break; }
      if (k % 2 === 0) scene.update(1 / 60, 1 / 60);
    }
    var hand = pl.handPosition(null);
    var shoot = {
      ticks: heldAt >= 0 ? heldAt - landedAt : -1,
      landSpeed: landSpeed,
      inHand: ball.owner === pl && pl.hasBall,
      offHand: U.dist3(ball.x, ball.y, ball.z, hand.x, hand.y, hand.z)
    };

    /* --- 1v1 ------------------------------------------------------------- */
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var g = BB.Engine.scene, p2 = g.player, b2 = g.ball;
    for (var j = 0; j < 240; j++) { g.fixedUpdate(1 / 120); if (j % 2 === 0) g.update(1 / 60, 1 / 60); }
    g.phase = 'live'; g.score.you = 0; g.score.cpu = 0;
    p2.hasBall = false; b2.owner = null;
    b2.place(g.hoop.x - 10, C.COURT_W - 3, 5);
    b2.lastToucher = p2;
    b2.launch(4, 24, 5, BB.Ball.STATE.LOOSE);

    var land2 = -1, called2 = -1, t2 = 0;
    b2.events.on('bounce', function () {
      if (land2 < 0 && b2.isOutOfBounds()) land2 = t2;
    });
    for (var m = 0; m < 4000; m++) {
      t2++;
      g.fixedUpdate(1 / 120);
      if (land2 >= 0 && called2 < 0 && g.phase === 'check') { called2 = t2; break; }
      if (m % 2 === 0) g.update(1 / 60, 1 / 60);
    }

    /* Carrying it over the line is still a turnover, and still instant. */
    for (var n = 0; n < 200; n++) { g.fixedUpdate(1 / 120); if (n % 2 === 0) g.update(1 / 60, 1 / 60); }
    g.phase = 'live';
    p2.giveBall(b2);
    p2.placeAt(g.hoop.x - 10, C.COURT_W + 2, 0);
    p2._updatePose(1 / 120);
    var carriedTicks = -1;
    for (var q = 0; q < 400; q++) {
      g.fixedUpdate(1 / 120);
      g.update(1 / 60, 1 / 60);
      if (g.phase === 'check') { carriedTicks = q; break; }
    }

    return {
      flyingOver: flyingOver, landedOut: landedOut, falsePositive: falsePositive,
      speedWhenCalled: speedWhenCalled,
      shoot: shoot,
      oneVone: { ticks: called2 >= 0 ? called2 - land2 : -1 },
      carriedTicks: carriedTicks,
      pageErr: window.__pageErr || null
    };
  `, 'oob');
  if (r.err) check('out-of-bounds probe ran', false, r.err);
  const o = r.out || {}, sa = o.shoot || {}, ov = o.oneVone || {};

  check('a ball is out the moment it lands outside the lines', o.landedOut === true);
  // Real rule, and it matters: a rebound that arcs over the baseline and comes
  // back down in bounds is still live.
  check('but not while it is merely flying over one', o.flyingOver === false);
  check('and a ball rolling around inside them never is', o.falsePositive === false);
  // The old rule waited for the ball to decay to under 0.2 ft/s first.
  check('the call does not wait for it to stop rolling',
        o.landedOut === true && o.speedWhenCalled > 5,
        'called while still travelling at ' + (o.speedWhenCalled || 0).toFixed(1) + 'ft/s');

  check('the shootaround puts it straight back in the hand',
        sa.ticks === 0 && sa.inHand === true,
        'took ' + (sa.ticks / 120).toFixed(2) + 's, in hand=' + sa.inHand);
  check('and it is IN the hand, not dropped on the floor nearby',
        sa.offHand < 0.01,
        'ball sits ' + (sa.offHand || 0).toFixed(2) + 'ft from the hand');

  check('1v1 whistles it the moment it lands',
        ov.ticks >= 0 && ov.ticks <= 2,
        'took ' + (ov.ticks / 120).toFixed(2) + 's from the touch-down');
  check('carrying it over the line is still a turnover',
        o.carriedTicks >= 0 && o.carriedTicks <= 2,
        'took ' + o.carriedTicks + ' ticks');
  check('out-of-bounds probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[24] settings can wipe your progress, and asks first');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U;
    BB.Engine.setState('menu'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene;
    for (var i = 0; i < 40; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }

    /* Build up a career and a player worth losing. */
    BB.Career.reset(); BB.PlayerProfile.clear();
    var c = BB.Career.load();
    c.level = 7; c.points = 12; c.xp = 400;
    c.gamesPlayed = 9; c.wins = 6; c.losses = 3; c.totalPoints = 84;
    c.fgMade = 30; c.fgAtt = 60; c.bestStreak = 5;
    BB.Career.save(c);
    var draft = BB.PlayerProfile.newDraft();
    draft.name = 'RAINMAKER'; draft.number = 7; draft.position = 'PG'; draft.height = 74;
    draft.jerseyMain = BB.PlayerProfile.JERSEY_COLORS[4];
    BB.PlayerProfile.save(draft);
    // Guarded so a build without any of this still reports what it HAS got
    // rather than dying on the first line and taking every check with it.
    if (scene.refreshHero) scene.refreshHero();

    // Preferences, which are not progress and must survive.
    BB.Settings.set('cameraMode', 'tight');
    U.store.set('bindings', { probe: 'kept' });

    var heroBefore = { h: scene.hero.heightIn, j: scene.hero.jerseyMain };
    var before = BB.Career.record();

    /* Walk the real interface, click by click. */
    BB.Menus.replace('main');
    document.querySelector('[data-tab="settings"]').click();
    document.querySelector('.menu-hero [data-go]').click();
    var settingsEl = document.querySelector('.screen--settings');
    var wipe = settingsEl && settingsEl.querySelector('[data-act="wipe"]');
    var label = wipe ? wipe.textContent.trim() : null;
    if (!wipe) return { label: label, missing: true, pageErr: window.__pageErr || null };

    wipe.click();
    var confirmEl = document.querySelector('.screen--resetProgress');
    if (!confirmEl) return { label: label, noConfirm: true, pageErr: window.__pageErr || null };
    var text = confirmEl ? confirmEl.textContent.replace(/\\s+/g, ' ').trim() : '';
    var erasedOnOpening = BB.PlayerProfile.load() == null;

    // Back out. Nothing may have moved.
    confirmEl.querySelector('[data-act="back"]').click();
    var afterCancel = BB.Career.record();
    var draftAfterCancel = BB.PlayerProfile.load();

    // And now go through with it.
    document.querySelector('.screen--settings [data-act="wipe"]').click();
    document.querySelector('.screen--resetProgress [data-act="erase"]').click();

    var doneEl = document.querySelector('.screen--resetProgress');
    var doneText = doneEl ? doneEl.textContent.replace(/\\s+/g, ' ').trim() : '';
    doneEl.querySelector('[data-act="done"]').click();

    var after = BB.Career.record();
    for (var j = 0; j < 20; j++) { scene.fixedUpdate(1 / 120); if (j % 2 === 0) scene.update(1 / 60, 1 / 60); }

    return {
      label: label,
      says: {
        name: text.indexOf('RAINMAKER') >= 0,
        level: text.indexOf('7') >= 0,
        record: text.indexOf('6 won, 3 lost') >= 0,
        undo: text.toLowerCase().indexOf('cannot be undone') >= 0
      },
      erasedOnOpening: erasedOnOpening,
      cancelLevel: afterCancel.level,
      cancelName: draftAfterCancel && draftAfterCancel.name,
      before: before, after: after,
      draftAfter: BB.PlayerProfile.load(),
      doneShown: doneText.indexOf('Progress erased') >= 0,
      backOnSettings: !!document.querySelector('.screen--settings'),
      frontPageAlive: !!document.querySelector('.screen--main'),
      cameraKept: BB.Settings.get('cameraMode'),
      bindingsKept: U.store.get('bindings', null),
      heroBefore: heroBefore,
      heroAfter: { h: scene.hero.heightIn, j: scene.hero.jerseyMain },
      fresh: BB.PlayerProfile.newDraft(),
      pageErr: window.__pageErr || null
    };
  `, 'reset');
  if (r.err) check('reset probe ran', false, r.err);
  const o = r.out || {}, says = o.says || {}, before = o.before || {}, after = o.after || {};

  check('settings carries a reset-all-progress button',
        o.label === 'Reset all progress', 'button reads "' + o.label + '"');
  // One click cannot erase a career.
  check('it asks before it erases anything',
        o.erasedOnOpening === false && says.undo === true,
        'confirmation warns it cannot be undone: ' + says.undo);
  check('the confirmation says what is about to be lost',
        says.name && says.level && says.record,
        'names the player: ' + says.name + ', the level: ' + says.level +
        ', the record: ' + says.record);
  check('backing out changes nothing',
        o.cancelLevel === 7 && o.cancelName === 'RAINMAKER',
        'after cancelling: level ' + o.cancelLevel + ', player ' + o.cancelName);

  check('erasing clears the career',
        after.level === 1 && after.points === 0 && after.gamesPlayed === 0 &&
        after.wins === 0 && after.bestStreak === 0,
        'level ' + before.level + '->' + after.level + ', ' +
        before.gamesPlayed + ' games -> ' + after.gamesPlayed);
  check('and the created player', o.draftAfter == null);
  // Preferences are not progress, and there is a separate button for those.
  check('but leaves settings and key bindings alone',
        o.cameraKept === 'tight' && o.bindingsKept && o.bindingsKept.probe === 'kept',
        'camera stayed "' + o.cameraKept + '", bindings ' + JSON.stringify(o.bindingsKept));

  const hb = o.heroBefore || {}, ha = o.heroAfter || {}, fresh = o.fresh || {};
  check('the front page stops showing a player who no longer exists',
        hb.h !== ha.h && ha.h === fresh.height,
        'standby figure went from ' + hb.h + '" to ' + ha.h + '"');
  check('it says so, and leaves a menu to come back to',
        o.doneShown === true && o.backOnSettings === true && o.frontPageAlive === true,
        'acknowledged=' + o.doneShown + ', settings=' + o.backOnSettings +
        ', front page=' + o.frontPageAlive);
  check('reset probe raised no errors', !o.pageErr, o.pageErr);
}

if (process.argv.includes('--shots')) {
  console.log('\n[25] screenshots');
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
