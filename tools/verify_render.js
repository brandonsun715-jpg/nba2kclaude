/* =============================================================================
 * verify_render.js  —  Headless render verification for BLACKTOP's 3D build.
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

console.log('\nBLACKTOP — 3D render verification\n');

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

{
  /* Every build starts on 60 — for EVERY roll of the dice, not merely most.
   *
   * The checks above roll the ratings a few dozen times per run, off an RNG
   * seeded from Math.random at boot, so a generator that lands right 99.85% of
   * the time reads as a suite that fails about one run in sixteen for no
   * reason anybody can reproduce. That was section 13's long-standing flake.
   *
   * The cause was structural, not statistical: generateRatings converges by
   * sliding the entire spread until the weighted overall hits the target, and
   * an attribute already pinned against its position cap cannot slide. When
   * enough of them were pinned the average stopped a point short and the loop
   * gave up quietly after six passes.
   *
   * So this sweeps the space hard enough that a regression cannot hide, off
   * FIXED seeds — a check written to catch a flake has no business being one.
   * 7500 rolls against the old code caught 11; the odds of it catching none
   * are about one in seventy thousand.
   */
  const r = runInPage(`
    var BB = window.BB, P = BB.PlayerProfile, U = BB.U;
    var archs = Object.keys(P.ARCHETYPES), poss = ['PG', 'SG', 'SF', 'PF', 'C'];
    var rolls = 0, off = 0, worst = 0, example = null;
    var capBreaks = 0, floorBreaks = 0;

    for (var s = 0; s < 300; s++) {
      for (var a = 0; a < archs.length; a++) {
        for (var p = 0; p < poss.length; p++) {
          U.rng = U.makeRng(s * 7919 + a * 131 + p * 17 + 1);
          var d = P.newDraft();
          d.archetype = archs[a]; d.position = poss[p]; d.ratings = null;
          var ovr = P.overallOf(d);
          rolls++;
          var gap = ovr - P.START_OVERALL;
          if (gap !== 0) {
            off++;
            if (Math.abs(gap) > Math.abs(worst)) worst = gap;
            if (!example) example = archs[a] + '/' + poss[p] + ' rolled ' + ovr;
          }
          // The settle step moves individual ratings, so it must still
          // respect the ceilings the position sets and the floor of 25.
          for (var k = 0; k < BB.Player.RATING_KEYS.length; k++) {
            var key = BB.Player.RATING_KEYS[k];
            var v = d.ratings[key];
            if (v > P.capFor(d.position, d.archetype, key)) capBreaks++;
            if (v < 25) floorBreaks++;
          }
        }
      }
    }

    return {
      rolls: rolls, off: off, worst: worst, example: example,
      capBreaks: capBreaks, floorBreaks: floorBreaks,
      start: P.START_OVERALL, pageErr: window.__pageErr || null
    };
  `, 'starting overall');
  if (r.err) check('starting-overall sweep ran', false, r.err);
  const o = r.out || {};
  check('the sweep actually rolled a full spread of builds', o.rolls === 7500,
        'rolled ' + o.rolls);
  check('every roll of every build lands exactly on the starting overall',
        o.off === 0,
        o.off + ' of ' + o.rolls + ' missed, worst by ' + o.worst +
        (o.example ? ' (' + o.example + ')' : ''));
  check('no rating is nudged above its position cap', o.capBreaks === 0,
        o.capBreaks + ' over cap');
  check('no rating is nudged below the floor', o.floorBreaks === 0,
        o.floorBreaks + ' under 25');
  check('starting-overall sweep raised no errors', !o.pageErr, o.pageErr);
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
      // Both of these leave the floor in the real game — a jump shot starts
      // its jump the instant the meter opens — and the jumper's feet only sit
      // level while it is airborne. Posed on the ground it picks up the run
      // cycle underneath instead, and this would be measuring a stride.
      pl.jumping = true;
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
  // An absolute margin, not a ratio: a jump shot holds its feet level, so the
  // number it is being compared against is around zero and a ratio against it
  // means nothing.
  check('the layup rise drives a knee up', lp.knee > 0.3 && lp.knee > jp.knee + 0.25,
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
  check('the court is painted acrylic, not blacktop', o.courtFrac > 0.2,
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

    /**
     * Drops one through clean from behind the arc.
     *
     * Built rather than shot. Taking a real jumper and hoping for a swish
     * leaves this section at the mercy of the shot solver's error term, which
     * is seeded fresh every page — it will land one most runs and no runs at
     * all on some, and a check that fails a fifth of the time is worse than no
     * check. The ball is put on the exact line a swish takes instead, so the
     * scene's own scoring path, its rating of the play and the replay it arms
     * are all still the real ones.
     */
    var scored = false, seen = null;
    scene.ball.events.on('score', function (e) { scored = true; seen = { three: e.three, clean: e.clean }; });
    function cleanThree() {
      scored = false; seen = null;
      R.reset();
      scene.phase = 'live'; scene.score.you = 0; scene.score.cpu = 0;
      pl.placeAt(hoop.x - 27, hoop.y - 1, 0);
      pl.vx = pl.vy = 0; pl.z = 0; pl.jumping = false; pl.action = null;
      pl.giveBall(scene.ball);
      // Enough live frames behind the moment for the replay to have something
      // to cut back to.
      for (var w = 0; w < 240; w++) frame();

      var ball = scene.ball;
      pl.hasBall = false;
      ball.release(BB.Ball.STATE.SHOT);
      ball.shooter = pl;
      ball.shotWasThree = true;
      ball.touchedRim = false;
      ball.place(hoop.x, hoop.y, C.RIM_HEIGHT + 0.35);
      ball.vx = 0; ball.vy = 0; ball.vz = -9;
      for (var f = 0; f < 60 && !scored; f++) frame();
      return !!(seen && seen.three && seen.clean);
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

console.log('\n[25] the jump shot is a jump shot');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U, C = BB.C;
    var BONE = BB.Player.BONE, A = BB.Player.ACTION;
    var pl = new BB.Player({ height: 79 });
    pl.placeAt(20, 25, 0);
    pl.facing = pl.moveFacing = 0;
    pl.vx = pl.vy = 0;
    pl.hasBall = true;

    var REACH = BONE.upperArm + BONE.forearm;
    var BALL = C.BALL_RADIUS * 2;

    /* Where a wrist ends up in the world, worked out here rather than asked
     * of the player, so this measures the same way on a build that has no
     * notion of drawing the two hands together. Mirrors what draw() does: the
     * pose plane gives forward and up, the lateral offset is a constant per
     * side, and the roll turns the pair about shoulder height. */
    function wristOf(p, side) {
      var w = side * BONE.shoulderW;
      var el = side < 0 ? p.elbowL : p.elbowR;
      var width = w * 1.02 * (1 - (p.armTuck || 0));
      var roll = side * (p.armRoll || 0);
      var rollUp = -p.shoulderY;
      var dUp = -el.ey - rollUp;
      var up = rollUp + dUp * Math.cos(roll);
      var lat = width - dUp * Math.sin(roll);
      var fwd = (el.ex - w) + up * (p.torsoLean * 0.45);
      var s = pl.bodyScale;
      return { fwd: fwd * s, lat: lat * s, up: up * s };
    }

    function sample() {
      var p = pl.pose;
      var a = wristOf(p, 1), b = wristOf(p, -1);
      return {
        elbowFwd: p.elbowR.jx - BONE.shoulderW,
        elbowUp: -(p.elbowR.jy - p.shoulderY),
        wristFwd: p.elbowR.ex - BONE.shoulderW,
        wristUp: -(p.elbowR.ey - p.shoulderY),
        clamp: Math.max(Math.hypot(p.elbowR.ex - p.handR.x, p.elbowR.ey - p.handR.y),
                        Math.hypot(p.elbowL.ex - p.handL.x, p.elbowL.ey - p.handL.y)),
        gap: Math.hypot(a.fwd - b.fwd, a.lat - b.lat, a.up - b.up),
        wristZ: -p.elbowR.ey * pl.bodyScale,
        crown: (-p.headY + BONE.headR) * pl.bodyScale
      };
    }

    var gather = [], meter = [], release = [];
    pl.action = A.GATHER;
    for (var g = 0; g <= 6; g++) { pl.actionT = g / 6 * 0.10; pl._updatePose(1 / 60); gather.push(sample()); }

    pl.action = A.METER; pl.shotType = 'jumper';
    pl.meter.start({ riseTime: 0.4, target: 0.94, greenWindow: 0.2, name: 'x' }, { x: pl.x, y: pl.y, z: 0 });
    for (var m = 0; m <= 20; m++) { pl.meter.value = m / 20; pl._updatePose(1 / 60); meter.push(sample()); }

    pl.action = A.RELEASE;
    for (var k = 0; k <= 12; k++) { pl.actionT = k / 12 * 0.30; pl._updatePose(1 / 60); release.push(sample()); }

    var shot = meter.concat(release);
    function worst(list, f) { return list.reduce(function (w, s) { return Math.max(w, f(s)); }, -1e9); }
    function best(list, f) { return list.reduce(function (w, s) { return Math.min(w, f(s)); }, 1e9); }

    var set = meter[11];                       // meter value 0.55
    var top = meter[meter.length - 1];

    /* Is there a set point at all, or does the ball just travel in a straight
     * line from the waist to the release? Compare the biggest step the wrist
     * takes in a twentieth of the motion against the smallest. */
    var steps = [];
    for (var i = 5; i < 19; i++) steps.push(meter[i + 1].wristUp - meter[i].wristUp);
    var stepHi = Math.max.apply(null, steps), stepLo = Math.min.apply(null, steps);

    return {
      ball: BALL, reach: REACH,
      gapThroughSet: worst(meter.slice(5, 14), function (s) { return s.gap; }),
      setElbowBelowWrist: set.wristUp - set.elbowUp,
      setForearmTilt: Math.atan2(Math.abs(set.wristFwd - set.elbowFwd),
                                 Math.max(1e-6, set.wristUp - set.elbowUp)) * 57.3,
      elbowNeverBack: best(meter.slice(6).concat(release), function (s) { return s.elbowFwd; }),
      worstClamp: worst(gather.concat(shot), function (s) { return s.clamp; }),
      aboveCrown: top.wristZ - top.crown,
      followDrop: top.wristZ - best(release, function (s) { return s.wristZ; }),
      followFwd: worst(release, function (s) { return s.wristFwd; }) - top.wristFwd,
      stepRatio: stepLo > 1e-6 ? stepHi / stepLo : (stepHi > 1e-6 ? 999 : 1),
      pageErr: window.__pageErr || null
    };
  `, 'form');
  if (r.err) check('form probe ran', false, r.err);
  const o = r.out || {};

  /* Two hands on one ball. This is the whole complaint: a guide hand left a
   * foot and a half below the shooting hand for the length of the rise reads
   * as a shoulder out of its socket, not as a jump shot. */
  check('both hands stay on the ball through the set',
        o.gapThroughSet < o.ball * 0.9,
        'hands were ' + (o.gapThroughSet / o.ball).toFixed(2) + ' ball-widths apart at worst');
  /* The one thing every coach says: elbow under the ball. In this rig that is
   * a forearm standing near vertical with the elbow well below the wrist. */
  check('the shooting elbow is under the ball at the set point',
        o.setForearmTilt < 35 && o.setElbowBelowWrist > 0.15,
        'forearm ' + (o.setForearmTilt || 0).toFixed(0) + ' degrees off vertical, elbow ' +
        (o.setElbowBelowWrist || 0).toFixed(3) + ' below the wrist');
  check('the elbow never travels behind the shoulder',
        o.elbowNeverBack > 0,
        'elbow got to ' + (o.elbowNeverBack || 0).toFixed(3) + ' (negative is behind the body)');
  // A target past the arm's reach comes back clamped, which draws a locked
  // poker-straight arm with no elbow in it at all.
  check('nothing the arms are asked to do is out of reach',
        o.worstClamp < 0.002,
        'worst shortfall ' + (o.worstClamp || 0).toFixed(4));

  /* A jump shot has two beats — gather to the set point, then extension. One
   * even sweep from the waist to full stretch is a wave. */
  check('there is a set point, not one long sweep',
        o.stepRatio > 4,
        'fastest part of the rise is ' + (o.stepRatio || 0).toFixed(1) +
        'x the slowest; an even sweep is 1x');

  check('the ball is released above the head',
        o.aboveCrown > 0.3,
        'wrist finishes ' + (o.aboveCrown || 0).toFixed(2) + 'ft above the crown');
  // The arm stays where the ball left it. What comes down on a real follow
  // through is the wrist, not the whole arm.
  check('the follow-through holds high instead of collapsing',
        o.followDrop < 0.12,
        'hand dropped ' + ((o.followDrop || 0) * 12).toFixed(1) + 'in after the release');
  check('and reaches out over the shot',
        o.followFwd > 0.04,
        'wrist pushed ' + (o.followFwd || 0).toFixed(3) + ' forward through the finish');
  check('form probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[26] a jump shot squares up to the basket');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U, C = BB.C;
    BB.Settings.set('cameraMode', 'forward');
    BB.Engine.setState('shootaround'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene, pl = scene.player, hoop = scene.hoop;
    for (var i = 0; i < 200; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }

    /**
     * Takes a shot starting some angle away from the basket while HOLDING a
     * direction the whole time, which is the case that matters: the stick is
     * what used to drag the shoulders round.
     */
    function trial(off, hx, hy, kind) {
      pl.placeAt(hoop.x - (kind === 'layup' ? 9 : 20), hoop.y, 0);
      pl.vx = pl.vy = 0; pl.z = 0; pl.jumping = false;
      pl.action = null; pl.armRaise = 0; pl.sprinting = (kind === 'layup');
      pl.giveBall(scene.ball);
      var toHoop = Math.atan2(hoop.y - pl.y, hoop.x - pl.x);
      pl.facing = pl.moveFacing = toHoop + off;
      if (kind === 'layup') { pl.vx = pl.phys.maxSprint * 0.9; pl.vy = 0; }

      var stick = {
        moveVector: function (o) { o = o || {}; o.x = hx; o.y = hy; o.mag = Math.hypot(hx, hy); return o; },
        down: function (a) { return a === 'sprint' && kind === 'layup'; },
        pressed: function () { return false; },
        released: function () { return false; }
      };

      pl._beginShot();
      var type = pl.shotType;
      var x0 = pl.x, y0 = pl.y, ix = 0, iy = 0;
      var atMeter = null, atRelease = null, worst = 0;
      for (var f = 0; f < 400; f++) {
        pl.readInput(stick);
        if (f === 0) { ix = pl.intentX; iy = pl.intentY; }
        pl.update(1 / 120, scene.ball);
        var err = Math.abs(U.angleDelta(Math.atan2(hoop.y - pl.y, hoop.x - pl.x), pl.facing));
        // The meter opening is the earliest instant a shot can be let go.
        if (atMeter == null && pl.action === BB.Player.ACTION.METER) atMeter = err;
        if (atMeter != null) worst = Math.max(worst, err);
        if (pl.action === BB.Player.ACTION.METER && pl.meter.profile &&
            pl.meter.value >= pl.meter.profile.target) {
          atRelease = err; pl._releaseShot(); break;
        }
      }
      var dx = pl.x - x0, dy = pl.y - y0, dl = Math.hypot(dx, dy), il = Math.hypot(ix, iy);
      return {
        type: type,
        atMeter: atMeter == null ? 999 : atMeter * 57.3,
        atRelease: atRelease == null ? 999 : atRelease * 57.3,
        worst: worst * 57.3,
        moved: dl,
        // 1 means the body went exactly where the stick pointed.
        steered: (dl > 0.05 && il > 0.1) ? (dx * ix + dy * iy) / (dl * il) : null
      };
    }

    return {
      // Back to the basket, and still holding away from it.
      backTurned: trial(Math.PI, 0, 1, 'jumper'),
      // Side on, holding sideways.
      sideOn: trial(Math.PI / 2, 1, 0, 'jumper'),
      // Square to start with, but the stick is pulling away.
      dragged: trial(0, 0, 1, 'jumper'),
      // And a drive, which must NOT be squared up.
      layup: trial(0.7, 1, 0, 'layup'),
      pageErr: window.__pageErr || null
    };
  `, 'square');
  if (r.err) check('square-up probe ran', false, r.err);
  const o = r.out || {};
  const back = o.backTurned || {}, side = o.sideOn || {}, drag = o.dragged || {}, lay = o.layup || {};

  check('a shot taken with your back to the basket turns to face it',
        back.atRelease < 6,
        'released ' + (back.atRelease || 0).toFixed(0) + ' degrees off the rim');
  check('so does one taken side on', side.atRelease < 6,
        'released ' + (side.atRelease || 0).toFixed(0) + ' degrees off');
  // The one that actually bit: holding a direction through the whole shot.
  check('and holding away from the rim cannot drag it back round',
        drag.atRelease < 6,
        'released ' + (drag.atRelease || 0).toFixed(0) + ' degrees off while steering away');

  /* The gather is 0.10s and the meter cannot be released before it ends, so
   * being square by then means there is no way to get a sideways shot off. */
  check('it is square before the shot can even be let go',
        back.atMeter < 8 && side.atMeter < 8 && drag.atMeter < 8,
        'worst at the earliest possible release: ' +
        Math.max(back.atMeter, side.atMeter, drag.atMeter).toFixed(0) + ' degrees');
  check('and stays square for the rest of the motion',
        back.worst < 8 && side.worst < 8 && drag.worst < 8,
        'worst during the shot: ' +
        Math.max(back.worst, side.worst, drag.worst).toFixed(0) + ' degrees');

  /* Only the shoulders are taken over. Where the player GOES is still the
   * stick's business, or a shot would double as a handbrake. */
  check('the body still travels where the stick points',
        back.steered > 0.97 && side.steered > 0.97 && drag.steered > 0.97 &&
        back.moved > 2,
        'travel matched the stick to ' +
        Math.min(back.steered, side.steered, drag.steered).toFixed(2) +
        ' over ' + (back.moved || 0).toFixed(1) + 'ft');

  // A drive finishes at the angle it attacked from; the euro step and the hop
  // step ARE angles, and squaring them up would delete both.
  check('a layup still finishes at the angle it drove in at',
        lay.type === 'layup' && lay.atRelease > 30,
        'layup released ' + (lay.atRelease || 0).toFixed(0) + ' degrees off the rim');
  check('square-up probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[27] the run cycle is a run, not a scurry');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U, C = BB.C;
    var BONE = BB.Player.BONE;
    var pl = new BB.Player({ height: 79 });
    pl.placeAt(20, 25, 0);
    pl.facing = pl.moveFacing = 0;
    var S = pl.bodyScale;                       // pose units -> world feet

    /** Runs the gait at a real speed and reports it in feet and seconds. */
    function gait(frac, sprint) {
      pl.sprinting = !!sprint;
      var top = sprint ? pl.phys.maxSprint : pl.phys.maxSpeed;
      var speed = top * frac;
      pl.vx = speed; pl.vy = 0;
      pl.stridePhase = 0;

      // Cycle length straight off the same call updateMovement makes, so this
      // cannot drift from what the feet are actually doing.
      var dt = 1 / 120, before = pl.stridePhase;
      pl._advanceStride(speed, top, dt);
      var perCycle = (speed * dt) / ((pl.stridePhase - before) / (Math.PI * 2));

      var hx = [], hz = [], clamp = 0, elbowMin = 1e9, elbowMax = -1e9, N = 60;
      for (var i = 0; i < N; i++) {
        pl.stridePhase = i / N * Math.PI * 2;
        pl._updatePose(dt);
        var p = pl.pose;
        hx.push((p.handR.x - BONE.shoulderW) * S);   // in front of the shoulder
        hz.push(-(p.handR.y - p.shoulderY) * S);     // above the shoulder
        // Nothing asked of a leg may be out of its reach; a clamped leg draws
        // as a locked stilt with no knee in it.
        clamp = Math.max(clamp,
          Math.hypot(p.kneeL.ex - p.footL.x, p.kneeL.ey - p.footL.y),
          Math.hypot(p.kneeR.ex - p.footR.x, p.kneeR.ey - p.footR.y),
          Math.hypot(p.elbowL.ex - p.handL.x, p.elbowL.ey - p.handL.y),
          Math.hypot(p.elbowR.ex - p.handR.x, p.elbowR.ey - p.handR.y));
        var d = Math.hypot(p.elbowR.ex - BONE.shoulderW, p.elbowR.ey - p.shoulderY);
        var c = U.clamp((BONE.upperArm * BONE.upperArm + BONE.forearm * BONE.forearm - d * d) /
                        (2 * BONE.upperArm * BONE.forearm), -1, 1);
        var ang = Math.acos(c) * 57.3;
        elbowMin = Math.min(elbowMin, ang); elbowMax = Math.max(elbowMax, ang);
      }
      var iF = hx.indexOf(Math.max.apply(null, hx));
      var iB = hx.indexOf(Math.min.apply(null, hx));
      return {
        speed: speed,
        stepFt: perCycle / 2,
        stepsPerSec: (speed / perCycle) * 2,
        handTravel: Math.max.apply(null, hx) - Math.min.apply(null, hx),
        handRise: hz[iF] - hz[iB],
        backMinusLowest: hz[iB] - Math.min.apply(null, hz),
        clamp: clamp, elbowMin: elbowMin, elbowMax: elbowMax
      };
    }

    return { jog: gait(0.45, false), run: gait(1, false), sprint: gait(1, true),
             pageErr: window.__pageErr || null };
  `, 'gait');
  if (r.err) check('gait probe ran', false, r.err);
  const o = r.out || {};
  const jog = o.jog || {}, run = o.run || {}, spr = o.sprint || {};

  /* Real numbers: a player jogging takes about three steps a second at a bit
   * over two feet, and a full-court sprint is nearer three and a half at five.
   * This used to be five and a half and seven and a half — the legs churning
   * under a body that was barely covering ground with each one. */
  check('a jog is a jog, not a scurry',
        jog.stepsPerSec < 3.8 && jog.stepFt > 1.7,
        (jog.stepsPerSec || 0).toFixed(2) + ' steps a second at ' +
        (jog.stepFt || 0).toFixed(2) + 'ft a step, at ' + (jog.speed || 0).toFixed(1) + 'ft/s');
  check('and a sprint is a sprint',
        spr.stepsPerSec < 4.6 && spr.stepFt > 4.0,
        (spr.stepsPerSec || 0).toFixed(2) + ' steps a second at ' +
        (spr.stepFt || 0).toFixed(2) + 'ft a step, at ' + (spr.speed || 0).toFixed(1) + 'ft/s');
  // Holding sprint used to buy nothing but cadence, because the gait was read
  // off the fraction of top speed rather than off the speed.
  check('sprinting lengthens the stride, not just the cadence',
        spr.stepFt > run.stepFt * 1.08,
        'sprint ' + (spr.stepFt || 0).toFixed(2) + 'ft a step against a run at ' +
        (run.stepFt || 0).toFixed(2) + 'ft');

  /* The arm swing. It used to be a rigid pendulum about the shoulder, so the
   * hand traced a circle: level at both ends of the swing and dipping half a
   * foot through the middle of it. A running arm goes low and back, high and
   * forward, in one straight diagonal. */
  check('the hand climbs as it comes forward',
        run.handRise > 0.5,
        'hand finishes the forward swing ' + (run.handRise || 0).toFixed(2) +
        'ft higher than the back of it');
  check('and its lowest point is behind, not halfway',
        Math.abs(run.backMinusLowest) < 0.05,
        'lowest point sits ' + (run.backMinusLowest || 0).toFixed(2) +
        'ft off the back of the swing');
  check('the hands stay by the body rather than paddling',
        run.handTravel > 1.0 && run.handTravel < 2.2,
        'hands travel ' + (run.handTravel || 0).toFixed(2) + 'ft fore and aft');
  check('the elbow folds tight in front and opens out behind',
        run.elbowMin < 80 && run.elbowMax > 118,
        'elbow works between ' + (run.elbowMin || 0).toFixed(0) + ' and ' +
        (run.elbowMax || 0).toFixed(0) + ' degrees');

  // Longer strides are bought with a deeper crouch; overspend and the foot
  // cannot reach the floor and the solver clamps the leg straight.
  check('no limb is asked to reach further than it can',
        Math.max(jog.clamp, run.clamp, spr.clamp) < 0.005,
        'worst shortfall ' + Math.max(jog.clamp, run.clamp, spr.clamp).toFixed(4));
  check('gait probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[28] holding the defence key actually plays defence');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U;
    var BONE = BB.Player.BONE;
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene, me = scene.player, foe = scene.ai;
    var ball = scene.ball, hoop = scene.hoop;
    var S = me.bodyScale;                        // pose units -> world feet

    /** A stick that holds a direction and optionally the defence key. */
    function stick(hx, hy, guard) {
      return {
        moveVector: function (o) {
          o = o || {}; o.x = hx || 0; o.y = hy || 0;
          o.mag = Math.hypot(o.x, o.y); return o;
        },
        down: function (a) { return a === 'intense' && !!guard; },
        pressed: function () { return false; },
        released: function () { return false; }
      };
    }

    /**
     * Puts the handler somewhere relative to the rim and the defender
     * somewhere relative to the handler, then runs the pair for a while with
     * the defender's stick held as given. The handler is pinned: this is
     * about what the DEFENDER does from a known picture.
     */
    function situation(o) {
      o = o || {};
      foe.placeAt(o.fx == null ? hoop.x - 20 : o.fx, o.fy == null ? hoop.y : o.fy, 0);
      foe.vx = foe.vy = 0; foe.z = 0; foe.jumping = false; foe.action = null;
      foe.facing = foe.moveFacing = Math.atan2(hoop.y - foe.y, hoop.x - foe.x);
      if (o.noBall) { ball.release(); ball.place(foe.x, foe.y - 30, 3); }
      else foe.giveBall(ball);
      if (o.ballZ != null) ball.z = o.ballZ;

      me.placeAt(foe.x + (o.dx == null ? 3.2 : o.dx), foe.y + (o.dy || 0), 0);
      me.vx = me.vy = 0; me.z = 0; me.jumping = false; me.action = null;
      me.hasBall = !!o.meHasBall;
      if (o.meHasBall) me.giveBall(ball);
      me.armRaise = 0; me.sprinting = false;
      me.defenseQuality = 0; me.lockedT = 0; me._lockShown = 0; me._guardBlend = 0;
      me.facing = me.moveFacing = o.facing == null
        ? Math.atan2(foe.y - me.y, foe.x - me.x) : o.facing;

      var sk = stick(o.hx || 0, o.hy || 0, o.guard !== false);
      var fx = foe.x, fy = foe.y, fz = ball.z;
      var locks = 0;
      var onLock = function () { locks++; };
      me.events.on('lockdown', onLock);
      var clamp = 0, jab = [], reach = [], best = 0;
      var secs = o.secs == null ? 1.6 : o.secs;
      for (var i = 0; i < secs * 120; i++) {
        // Pin the handler and the ball: the scene's own AI is not running.
        foe.x = fx; foe.y = fy; foe.vx = foe.vy = 0;
        if (o.ballZ != null) ball.z = fz;
        me.readInput(sk);
        me.update(1 / 120, ball);
        // The stance turns you to face the man; to grade a defender who is
        // NOT square, that has to be defeated deliberately.
        if (o.holdFacing) me.facing = o.facing;
        var p = me.pose;
        clamp = Math.max(clamp,
          Math.hypot(p.elbowL.ex - p.handL.x, p.elbowL.ey - p.handL.y),
          Math.hypot(p.elbowR.ex - p.handR.x, p.elbowR.ey - p.handR.y),
          Math.hypot(p.kneeL.ex - p.footL.x, p.kneeL.ey - p.footL.y),
          Math.hypot(p.kneeR.ex - p.footR.x, p.kneeR.ey - p.footR.y));
        if (i > secs * 60) {
          jab.push((p.handR.x - BONE.shoulderW) * S);
          reach.push(p.handR.y);
        }
        best = Math.max(best, me.defenseQuality);
      }
      me.events.off('lockdown', onLock);
      var p2 = me.pose;
      return {
        guarding: me.isGuarding, blend: me._guardBlend,
        quality: me.defenseQuality, best: best, locked: me.lockedT, locks: locks,
        armRoll: p2.armRoll,
        // Positive is down: the crouch sinks the hips and the shoulders.
        hipY: p2.hipY, shoulderY: p2.shoulderY,
        // How far apart the feet are planted, across the body.
        base: Math.abs(p2.footR.x - p2.footL.x) * S,
        // Lead hand: how far in front of its own shoulder, and how high.
        handOut: (p2.handR.x - BONE.shoulderW) * S,
        handUp: -(p2.handR.y - p2.shoulderY) * S,
        jabRange: jab.length ? Math.max.apply(null, jab) - Math.min.apply(null, jab) : 0,
        // Where the defender ended up pointed, relative to the handler.
        offMan: Math.abs(U.angleDelta(Math.atan2(foe.y - me.y, foe.x - me.x), me.facing)) * 57.3,
        clamp: clamp, x: me.x, y: me.y, speed: Math.hypot(me.vx, me.vy)
      };
    }

    var idle = situation({ guard: false, dx: 3.2 });
    var stance = situation({ guard: true, dx: 3.2 });
    var far = situation({ guard: true, dx: 11.0 });
    var ballHigh = situation({ guard: true, dx: 3.2, ballZ: 7.0 });
    var ballLow = situation({ guard: true, dx: 3.2, ballZ: 2.2 });
    var noHandler = situation({ guard: true, noBall: true });
    var iHaveIt = situation({ guard: true, meHasBall: true });
    // Right place, wrong way round: the stance holds but the grade should not.
    var turned = situation({ guard: true, dx: 3.2, facing: Math.PI * 0.5, holdFacing: true });
    // Beaten — trailing on the wrong side of the man, off the line to the rim.
    var beaten = situation({ guard: true, dx: -3.2, secs: 0.4 });
    // Started with your back to him: the stance has to bring you back round.
    var recovered = situation({ guard: true, dx: 3.2, facing: Math.PI * 0.9 });

    /* Staying in front is won on the change of direction, not the top end.
     * Time a full reversal, guarding against not. */
    function reverse(guard) {
      foe.placeAt(hoop.x - 20, hoop.y, 0); foe.giveBall(ball);
      me.placeAt(foe.x + 3.2, foe.y, 0); me.z = 0; me.action = null;
      me.hasBall = false; me.facing = me.moveFacing = Math.PI;
      var sk = stick(0, 1, guard), t = 0;
      for (var i = 0; i < 300; i++) { me.readInput(sk); me.update(1 / 120, ball); }
      var v0 = me.vy;
      var back = stick(0, -1, guard);
      for (var j = 0; j < 600; j++) {
        me.readInput(back); me.update(1 / 120, ball); t += 1 / 120;
        if (me.vy <= -Math.abs(v0) * 0.9) break;
      }
      return { top: Math.abs(v0), time: t };
    }
    var slideRev = reverse(true), runRev = reverse(false);

    /* No sprinting out of a stance. */
    function topSpeed(guard, sprint) {
      foe.placeAt(hoop.x - 20, hoop.y, 0); foe.giveBall(ball);
      me.placeAt(foe.x + 3.2, foe.y, 0); me.z = 0; me.action = null; me.hasBall = false;
      me.vx = me.vy = 0; me.stamina = 1;
      var sk = {
        moveVector: function (o) { o = o || {}; o.x = 0; o.y = 1; o.mag = 1; return o; },
        down: function (a) { return (a === 'intense' && guard) || (a === 'sprint' && sprint); },
        pressed: function () { return false; },
        released: function () { return false; }
      };
      for (var i = 0; i < 900; i++) { me.readInput(sk); me.update(1 / 120, ball); }
      return Math.hypot(me.vx, me.vy);
    }
    var openSprint = topSpeed(false, true), stanceSprint = topSpeed(true, true);

    /* What the position is worth when they finally shoot over it. */
    function contest(q) {
      foe.placeAt(hoop.x - 20, hoop.y, 0); foe.giveBall(ball);
      me.placeAt(foe.x + 3.2, foe.y, 0);
      foe.opponent = me; me.jumping = false; me.defenseQuality = q;
      return foe._computeContest();
    }
    var loose = contest(0), tight = contest(0.9);

    /* And that the readout is actually drawn, in the right colour. */
    var rings = [];
    var realRing = BB.S3.ring;
    BB.S3.ring = function (x, y, z, rr, col, gl, fl) {
      rings.push({ r: rr, x: x, y: y, col: [col[0], col[1], col[2]] });
      return realRing.apply(BB.S3, arguments);
    };
    /* S3.ring also draws both rims and the selection marker, so the readout
     * cannot be picked out by draw order — it is the one under the defender's
     * own feet, and it is the only ring wider than the marker. */
    function mine() {
      var found = null;
      for (var i = 0; i < rings.length; i++) {
        var g = rings[i];
        if (g.r > 1.05 && Math.hypot(g.x - me.x, g.y - me.y) < 0.5) found = g;
      }
      return found;
    }
    var drawn = { none: 0, good: 0, lockedCol: null, goodCol: null, aiRings: 0 };
    foe.placeAt(hoop.x - 20, hoop.y, 0); foe.giveBall(ball);
    me.placeAt(foe.x + 3.2, foe.y, 0); me.hasBall = false;
    me.isGuarding = false; me.defenseQuality = 0; me.lockedT = 0;
    rings.length = 0; scene.render(0);
    drawn.none = rings.length;
    drawn.noneMine = !!mine();
    me.defenseQuality = 0.85; me.lockedT = 0;
    rings.length = 0; scene.render(0);
    drawn.good = rings.length;
    drawn.goodCol = mine() && mine().col;
    me.lockedT = 2.0;
    rings.length = 0; scene.render(0);
    drawn.lockedCol = mine() && mine().col;
    // The AI holds a quality too — the contest maths reads it — but must not
    // paint the floor with it.
    me.defenseQuality = 0; me.lockedT = 0;
    foe.defenseQuality = 0.9; foe.lockedT = 2.0;
    rings.length = 0; scene.render(0);
    drawn.aiRings = rings.length;
    BB.S3.ring = realRing;
    foe.defenseQuality = 0; foe.lockedT = 0;

    /* And the CPU plays it too. The stance was wired to a key the AI does not
     * press, so left alone the opponent would defend you standing bolt
     * upright while your own ring lit up under your feet. Run the scene for
     * real — the AI brain, not a stick — and watch it come up and go away. */
    var cpu = { onD: 0, onO: 0, dq: 0, held: 0 };
    scene.phase = 'live';
    me.giveBall(ball);
    me.placeAt(hoop.x - 20, hoop.y, 0);
    foe.placeAt(hoop.x - 16, hoop.y, 0);
    // The AI brain runs off the scene's variable-rate update, not its fixed
    // step, so both have to be driven or the opponent just stands there.
    /* Counted against the ticks you actually had the ball, not against the
     * clock: the CPU is perfectly entitled to end the possession by taking it
     * off you, and it does. */
    for (var s = 0; s < 240; s++) {
      scene.fixedUpdate(1 / 120);
      if (s % 2 === 0) scene.update(1 / 60, 1 / 60);
      if (ball.owner === me) {
        cpu.held++;
        if (foe.isGuarding) cpu.onD++;
        cpu.dq = Math.max(cpu.dq, foe.defenseQuality);
      }
    }
    /* Handing it over must also take it off the other man — see giveBall. A
     * defender still flagged as holding the ball reads as being on offence
     * and grades nothing, which is exactly how this was found. */
    cpu.bothHeld = me.hasBall && foe.hasBall;
    foe.giveBall(ball);
    cpu.bothHeld = cpu.bothHeld || (me.hasBall && foe.hasBall);
    for (var s2 = 0; s2 < 240; s2++) {
      scene.fixedUpdate(1 / 120);
      if (s2 % 2 === 0) scene.update(1 / 60, 1 / 60);
      if (foe.isGuarding) cpu.onO++;
    }

    return {
      cpu: cpu,
      idle: idle, stance: stance, far: far, ballHigh: ballHigh, ballLow: ballLow,
      noHandler: noHandler, iHaveIt: iHaveIt, turned: turned, beaten: beaten,
      recovered: recovered, slideRev: slideRev, runRev: runRev,
      openSprint: openSprint, stanceSprint: stanceSprint,
      loose: loose, tight: tight, drawn: drawn,
      pageErr: window.__pageErr || null
    };
  `, 'defence');
  if (r.err) check('defence probe ran', false, r.err);
  const o = r.out || {};
  const idle = o.idle || {}, st = o.stance || {}, far = o.far || {};
  const hi = o.ballHigh || {}, lo = o.ballLow || {};
  const drawn = o.drawn || {};

  /* The key. It is held, not tapped, and it only means anything when there is
   * somebody with the ball in front of you. */
  check('holding the key drops you into a stance',
        st.guarding === true && st.blend > 0.9,
        'stance blended to ' + (st.blend || 0).toFixed(2));
  check('letting go stands you back up',
        idle.guarding === false && idle.blend < 0.05,
        'blend ' + (idle.blend || 0).toFixed(3) + ' with the key up');
  check('there is nothing to guard when nobody has the ball',
        (o.noHandler || {}).guarding === false,
        'stance ' + ((o.noHandler || {}).guarding ? 'came up anyway' : 'stayed down'));
  check('and none when the ball is in your own hands',
        (o.iHaveIt || {}).guarding === false, 'stance up on offence');

  /* It is a stance, not a pose: hips down, feet apart, arms out of the plane. */
  check('the stance sinks the hips and widens the base',
        st.hipY - idle.hipY > 0.08 && st.base > idle.base * 1.15,
        'hips drop ' + ((st.hipY - idle.hipY) * 2.74).toFixed(2) + 'ft, base ' +
        (idle.base || 0).toFixed(2) + 'ft -> ' + (st.base || 0).toFixed(2) + 'ft');
  check('and the arms come out of the pose plane', st.armRoll > 0.3,
        'armRoll ' + (st.armRoll || 0).toFixed(2));

  /* The hands. This is the half the request was actually about: reaching at
   * the ball, not standing there with both arms held out like a scarecrow. */
  check('the lead hand reaches out at the ball',
        st.handOut > far.handOut + 0.6,
        'hand out ' + (st.handOut || 0).toFixed(2) + 'ft at close range against ' +
        (far.handOut || 0).toFixed(2) + 'ft from ten feet away');
  check('it works at the ball rather than hanging there',
        st.jabRange > 0.08,
        'the reach jabs over ' + (st.jabRange || 0).toFixed(2) + 'ft');
  check('and it follows the ball up and down',
        hi.handUp > lo.handUp + 0.4,
        'hand rides ' + (lo.handUp || 0).toFixed(2) + 'ft up to ' +
        (hi.handUp || 0).toFixed(2) + 'ft as the ball goes from 2ft to 7ft');
  check('nothing in the stance is out of reach',
        Math.max(st.clamp || 0, hi.clamp || 0, lo.clamp || 0) < 0.005,
        'worst shortfall ' + Math.max(st.clamp || 0, hi.clamp || 0, lo.clamp || 0).toFixed(4));

  /* Keeping up with the attacker. */
  check('a stance never turns its back on the ball handler',
        (o.recovered || {}).offMan < 12,
        'ended up ' + ((o.recovered || {}).offMan || 0).toFixed(0) +
        ' degrees off the man after starting turned away');
  const sr = o.slideRev || {}, rr = o.runRev || {};
  check('a slide changes direction quicker than a run',
        sr.time < rr.time * 0.85,
        'reversal in ' + (sr.time || 0).toFixed(2) + 's against ' +
        (rr.time || 0).toFixed(2) + 's upright');
  check('but you cannot sprint out of one',
        o.stanceSprint < o.openSprint * 0.95,
        (o.stanceSprint || 0).toFixed(1) + 'ft/s in a stance against ' +
        (o.openSprint || 0).toFixed(1) + 'ft/s open');

  /* The grade. Close, on the line, square, in a stance — all four, or it is
   * not worth anything. */
  check('good position grades higher than being beaten',
        st.best > 0.7 && st.best > (o.beaten || {}).best * 2,
        'graded ' + (st.best || 0).toFixed(2) + ' in front against ' +
        ((o.beaten || {}).best || 0).toFixed(2) + ' trailing');
  check('standing off ten feet is worth nothing', far.best < 0.15,
        'graded ' + (far.best || 0).toFixed(2) + ' from ten feet');
  check('and watching the ball go by is worth less than staying square',
        (o.turned || {}).best < st.best * 0.75,
        'graded ' + ((o.turned || {}).best || 0).toFixed(2) + ' turned around');
  check('the same spot grades lower standing upright than in a stance',
        idle.best < st.best * 0.75,
        'graded ' + (idle.best || 0).toFixed(2) + ' upright against ' +
        (st.best || 0).toFixed(2) + ' in a stance');

  /* Worth something. A stance that did not make the shot harder would be a
   * costume rather than defence. */
  check('real position makes the shot over it harder',
        o.tight > o.loose + 0.12,
        'contest ' + (o.loose || 0).toFixed(2) + ' -> ' + (o.tight || 0).toFixed(2));

  /* And it says so. */
  check('holding it long enough earns the call',
        st.locked > 1.2 && st.locks === 1,
        'held for ' + (st.locked || 0).toFixed(2) + 's and called it ' +
        (st.locks || 0) + ' time(s)');
  check('being beaten never earns it',
        (o.beaten || {}).locks === 0 && (o.far || {}).locks === 0,
        'called ' + (((o.beaten || {}).locks || 0) + ((o.far || {}).locks || 0)) + ' times');
  check('good defence draws a ring under the defender',
        drawn.good === drawn.none + 1 && drawn.noneMine === false && !!drawn.goodCol,
        drawn.none + ' rings at rest, ' + drawn.good + ' while guarding');
  check('which goes gold once the position has been held',
        drawn.goodCol && drawn.lockedCol &&
        drawn.lockedCol[0] > drawn.goodCol[0] && drawn.lockedCol[2] < drawn.goodCol[2],
        'blue ' + (drawn.goodCol || []).map((c) => c.toFixed(2)).join('/') +
        ' -> gold ' + (drawn.lockedCol || []).map((c) => c.toFixed(2)).join('/'));
  check('the AI does not paint the floor with its own',
        drawn.aiRings === drawn.none,
        drawn.aiRings + ' rings with the AI locked in against ' + drawn.none + ' at rest');

  /* The opponent defends the same way, off its own brain. */
  const cpu = o.cpu || {};
  check('the CPU gets into a stance when you have the ball',
        cpu.held > 60 && cpu.onD >= cpu.held - 4 && cpu.dq > 0.35,
        'in a stance for ' + (cpu.onD || 0) + ' of the ' + (cpu.held || 0) +
        ' ticks you had it, grading up to ' + (cpu.dq || 0).toFixed(2));
  check('and stands out of it once the ball is theirs',
        cpu.onO === 0, 'still crouched for ' + (cpu.onO || 0) + ' ticks on offence');
  check('the ball is never in two pairs of hands at once',
        cpu.bothHeld === false, 'both players held it at once');
  check('defence probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[29] the stance locks on, and walls the drive off');
{
  const r = runInPage(`
    var BB = window.BB, U = BB.U;
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene, me = scene.player, foe = scene.ai;
    var ball = scene.ball, hoop = scene.hoop;
    me.opponent = foe; foe.opponent = me;

    function stick(guard) {
      return {
        moveVector: function (o) { o = o || {}; o.x = 0; o.y = 0; o.mag = 0; return o; },
        down: function (a) { return a === 'intense' && !!guard; },
        pressed: function () { return false; },
        released: function () { return false; }
      };
    }

    /* ---- shift lock ---------------------------------------------------
     * Walks the handler right round the defender while the defender slides
     * off in a fixed direction of their own, and reports the worst the
     * shoulders ever came off the man. Intent is written straight past
     * readInput so the answer does not depend on where the camera is
     * pointing. */
    function lock(guard, ix, iy) {
      me.placeAt(0, 25, 0); me.vx = me.vy = 0; me.z = 0;
      me.hasBall = false; me.action = null;
      me.facing = me.moveFacing = 0;
      me.defenseQuality = 0; me.lockedT = 0; me._guardBlend = guard ? 1 : 0;
      var sk = stick(guard), worst = 0, ang = 0, samples = 0;
      for (var i = 0; i < 480; i++) {
        // The man circles at a rate no turn rate could ever hold.
        ang += (1 / 120) * 3.4;
        foe.placeAt(me.x + Math.cos(ang) * 3.2, me.y + Math.sin(ang) * 3.2, 0);
        foe.giveBall(ball);
        me.readInput(sk);
        me.intentX = ix; me.intentY = iy;
        me.intentMag = Math.hypot(ix, iy);
        me.update(1 / 120, ball);
        if (i > 60) {
          worst = Math.max(worst, Math.abs(U.angleDelta(
            Math.atan2(foe.y - me.y, foe.x - me.x), me.facing)));
          samples++;
        }
      }
      return { worst: worst * 57.3, samples: samples };
    }
    var lockedStill = lock(true, 0, 0);
    var lockedSliding = lock(true, 0, 1);
    var unlocked = lock(false, 0, 1);

    /* ---- the slide gait -----------------------------------------------
     * Facing one way and travelling another has to shuffle the feet across
     * the body, not scissor them fore and aft. Both are measured off the
     * same pose: x is the forward axis of the solver's flat plane, side is
     * the lateral offset that only exists at draw time. */
    function gait(ix, iy) {
      me.placeAt(0, 25, 0); me.vx = me.vy = 0; me.z = 0; me.hasBall = false;
      me.action = null; me.facing = me.moveFacing = 0; me._guardBlend = 1;
      foe.placeAt(me.x + 3.2, me.y, 0); foe.giveBall(ball);
      var sk = stick(true);
      // The man rides alongside, so the defender is genuinely strafing the
      // whole way rather than drifting into a back-pedal as he slides off.
      for (var w = 0; w < 240; w++) {
        foe.placeAt(me.x + 3.2, me.y, 0);
        me.readInput(sk);
        me.intentX = ix; me.intentY = iy; me.intentMag = 1;
        me.update(1 / 120, ball);
      }
      var sx = [], sd = [], cross = 0;
      for (var i = 0; i < 90; i++) {
        foe.placeAt(me.x + 3.2, me.y, 0);
        me.readInput(sk);
        me.intentX = ix; me.intentY = iy; me.intentMag = 1;
        me.update(1 / 120, ball);
        var p = me.pose;
        sx.push(p.footR.x - p.footL.x);
        sd.push((p.footR.side || 0) - (p.footL.side || 0));
        // Total across-the-body separation, base stance included. Negative
        // means the feet have crossed over, which is how you get beaten.
        var sep = 2 * BB.Player.BONE.stance + (p.footR.side || 0) - (p.footL.side || 0);
        if (sep < 0.02) cross++;
      }
      function range(a) { return Math.max.apply(null, a) - Math.min.apply(null, a); }
      return { scissor: range(sx), shuffle: range(sd), cross: cross,
               meanX: sx.reduce(function (a, b) { return a + b; }, 0) / sx.length };
    }
    // Straight at the man, straight across him, and backing away from him.
    var atMan = gait(1, 0), across = gait(0, 1), backing = gait(-1, 0);

    /* ---- pressure ------------------------------------------------------ */
    function drive(q, behind) {
      me.placeAt(hoop.x - 22, hoop.y, 0);
      me.vx = me.vy = 0; me.z = 0; me.action = null; me.sprinting = false;
      me.stamina = 1; me.giveBall(ball);
      var off = behind ? -2.6 : 2.6;
      var top = 0, x0 = me.x;
      // Short enough that the half-court bound never truncates the run and
      // makes both cases look identical.
      for (var i = 0; i < 150; i++) {
        // Walled off means walled off the whole way, not passed after a
        // second: a defender who keeps up is the case being measured.
        foe.placeAt(me.x + off, me.y, 0); foe.vx = foe.vy = 0;
        foe.defenseQuality = q; foe.isGuarding = q > 0;
        me.intentX = 1; me.intentY = 0; me.intentMag = 1;
        me.update(1 / 120, ball);
        top = Math.max(top, Math.hypot(me.vx, me.vy));
      }
      return { top: top, gained: me.x - x0,
               pressure: me.pressure ? me.pressure() : 0 };
    }
    var open = drive(0, false), walled = drive(0.9, false), trailed = drive(0.9, true);

    /* ---- and the CPU stops running into it -----------------------------
     * The real scene, the real brain. The defender is held on the goal-side
     * shoulder every tick, which is what "defending well" means, and the
     * question is what the ball handler does about it. */
    function possession(defend) {
      foe.placeAt(hoop.x - 24, hoop.y, 0);
      foe.vx = foe.vy = 0; foe.z = 0; foe.action = null;
      foe.giveBall(ball);
      // After giveBall, which sets its own patience -- otherwise the shot
      // clock runs out mid-probe and the handler is forced into a shot for
      // reasons that have nothing to do with who is guarding him.
      foe.aiPatience = 999;
      me.placeAt(hoop.x - 21.4, hoop.y, 0);
      me.vx = me.vy = 0; me.z = 0; me.action = null;
      me.defenseQuality = 0; me.lockedT = 0;
      scene.phase = 'live';
      var sk = stick(defend);
      var closest = 1e9, sprint = 0, backOut = 0, moves = 0, held = 0;
      var maxP = 0, maxQ = 0, wasMove = null;
      for (var i = 0; i < 600; i++) {
        /* Glued to the goal-side shoulder in BOTH runs. The control is the
         * same defender standing in the same place with the key up, so what
         * is being measured is the stance itself rather than the presence of
         * a body in the lane. */
        var a = Math.atan2(hoop.y - foe.y, hoop.x - foe.x);
        // No facing argument: placeAt would reset the shoulders square to the
        // court every tick, and _updateDefense grades the stance before
        // updateMovement re-aims it -- so the man would read as turned around
        // for reasons that have nothing to do with the game.
        me.placeAt(foe.x + Math.cos(a) * 2.6, foe.y + Math.sin(a) * 2.6);
        me.readInput(sk);
        me.intentX = 0; me.intentY = 0; me.intentMag = 0;
        scene.fixedUpdate(1 / 120);
        if (i % 2 === 0) scene.update(1 / 60, 1 / 60);
        if (ball.owner !== foe) break;
        held++;
        closest = Math.min(closest, U.dist(foe.x, foe.y, hoop.x, hoop.y));
        if (foe.sprinting) sprint++;
        // Intent pointing away from the rim is a handler resetting the angle.
        var toRim = Math.atan2(hoop.y - foe.y, hoop.x - foe.x);
        if (foe.intentMag > 0.1 &&
            Math.abs(U.angleDelta(toRim, Math.atan2(foe.intentY, foe.intentX))) > 1.9) backOut++;
        if (foe.moveState && foe.moveState !== wasMove) moves++;
        wasMove = foe.moveState;
        maxP = Math.max(maxP, foe.pressure ? foe.pressure() : 0);
        maxQ = Math.max(maxQ, me.defenseQuality);
      }
      return { closest: closest, sprint: sprint, backOut: backOut, moves: moves,
               held: held, maxP: maxP, maxQ: maxQ };
    }
    var pressed = possession(true), free = possession(false);

    /* ---- and it is a read, not just a speed cap ------------------------
     * Same picture every tick -- handler twenty feet out, defender goal-side
     * two and a half feet off -- with only the quality of that defender's
     * position changing. Calls the brain directly so the statistics are not
     * diluted by where the possession happened to wander. */
    function brain(q) {
      var back = 0, sprint = 0, moves = 0, wasMove = null, N = 600;
      foe.giveBall(ball); foe.aiPatience = 999; foe.moveState = null;
      me.isGuarding = q > 0;
      for (var i = 0; i < N; i++) {
        foe.placeAt(hoop.x - 20, hoop.y, 0);
        /* Goal-side and three and a half feet off. Closer than about 2.8ft
         * and the handler reads a charge risk and refuses to sprint whoever
         * is guarding him, which would make the sprint comparison below true
         * for a reason that has nothing to do with the stance. */
        me.placeAt(hoop.x - 16.6, hoop.y, 0);
        me.defenseQuality = q;
        foe.intentX = 0; foe.intentY = 0; foe.intentMag = 0; foe.sprinting = false;
        foe.moveState = null; foe.moveCooldown = 0;
        BB.AI.offense(foe, me, hoop, 1 / 120, 1);
        var toRim = Math.atan2(hoop.y - foe.y, hoop.x - foe.x);
        if (foe.intentMag > 0.1 &&
            Math.abs(U.angleDelta(toRim, Math.atan2(foe.intentY, foe.intentX))) > 1.9) back++;
        if (foe.sprinting) sprint++;
        if (foe.moveState && foe.moveState !== wasMove) moves++;
        wasMove = foe.moveState;
      }
      return { back: back, sprint: sprint, moves: moves, n: N };
    }
    var brainOn = brain(0.95), brainOff = brain(0);

    return {
      brainOn: brainOn, brainOff: brainOff,
      lockedStill: lockedStill, lockedSliding: lockedSliding, unlocked: unlocked,
      atMan: atMan, across: across, backing: backing,
      open: open, walled: walled, trailed: trailed,
      pressed: pressed, free: free,
      pageErr: window.__pageErr || null
    };
  `, 'lockdrive');
  if (r.err) check('lock/drive probe ran', false, r.err);
  const o = r.out || {};
  const still = o.lockedStill || {}, sliding = o.lockedSliding || {}, free1 = o.unlocked || {};
  const atMan = o.atMan || {}, across = o.across || {}, backing = o.backing || {};
  const open = o.open || {}, walled = o.walled || {}, trailed = o.trailed || {};
  const pressed = o.pressed || {}, unguarded = o.free || {};

  /* Shift lock. Not "turns towards" — locked, against a man moving faster
   * than any turn rate could follow. */
  check('the stance stays pointed at the man, not merely turns towards him',
        still.worst < 1.0 && still.samples > 300,
        'worst ' + (still.worst || 0).toFixed(2) + ' degrees off over ' +
        (still.samples || 0) + ' ticks against a man circling at 3.4 rad/s');
  check('and it holds while you are sliding somewhere else',
        sliding.worst < 1.0,
        'worst ' + (sliding.worst || 0).toFixed(2) + ' degrees off while sliding');
  check('with the key up you face where you are going instead',
        free1.worst > 45,
        'ended ' + (free1.worst || 0).toFixed(0) + ' degrees off the man');

  /* The gait that has to come with it, or the figure moonwalks. */
  check('sliding across the man shuffles the feet sideways',
        across.shuffle > 0.10 && across.shuffle > across.scissor * 4,
        'shuffle ' + (across.shuffle || 0).toFixed(3) + ' against a fore/aft scissor of ' +
        (across.scissor || 0).toFixed(3));
  check('going straight at him still scissors them fore and aft',
        atMan.scissor > 0.10 && atMan.scissor > atMan.shuffle * 4,
        'scissor ' + (atMan.scissor || 0).toFixed(3) + ' against a shuffle of ' +
        (atMan.shuffle || 0).toFixed(3));
  check('and backing off back-pedals rather than running on the spot',
        backing.scissor > 0.10,
        'scissor ' + (backing.scissor || 0).toFixed(3) + ' backing away');
  check('the feet never cross in a slide',
        across.cross === 0 && atMan.cross === 0,
        (across.cross || 0) + ' crossed frames');

  /* Pressure. Position has to cost the handler something on the floor. */
  check('driving into a set defender is slower than driving into nobody',
        walled.top < open.top * 0.75,
        (open.top || 0).toFixed(1) + 'ft/s open against ' +
        (walled.top || 0).toFixed(1) + 'ft/s walled off');
  check('and it costs them ground, not just speed',
        walled.gained < open.gained * 0.8,
        (open.gained || 0).toFixed(1) + 'ft gained open against ' +
        (walled.gained || 0).toFixed(1) + 'ft guarded');
  /* Directional, or beating somebody would feel worse than being stuck in
   * front of them: a defender you have already gone past is not guarding. */
  check('a defender you have beaten does not slow you down',
        trailed.top > open.top * 0.98 && trailed.pressure < 0.02,
        'trailing defender left ' + (trailed.top || 0).toFixed(1) +
        'ft/s against ' + (open.top || 0).toFixed(1) + 'ft/s open');
  /* The defender only gives up 8% of their own top end to hold the stance,
   * so a third off the handler is the margin that makes staying in front
   * possible at all rather than a coin flip on reaction time. */
  check('a defender in a stance is faster than the man they are walling off',
        walled.top < open.top * 0.92,
        'handler down to ' + (walled.top || 0).toFixed(1) +
        'ft/s against a stance that keeps ' + (open.top * 0.92).toFixed(1) + 'ft/s');

  /* And the CPU plays it as a read, not just a speed cap. */
  check('the CPU cannot drive through good position',
        pressed.held > 200 && pressed.closest > unguarded.closest + 5,
        'got within ' + (pressed.closest || 0).toFixed(1) + 'ft of the rim against a stance, ' +
        (unguarded.closest || 0).toFixed(1) + 'ft against the same man standing up' +
        ' [p=' + (pressed.maxP || 0).toFixed(2) + '/' + (unguarded.maxP || 0).toFixed(2) +
        ' q=' + (pressed.maxQ || 0).toFixed(2) + '/' + (unguarded.maxQ || 0).toFixed(2) +
        ' held=' + pressed.held + '/' + unguarded.held +
        ' back=' + pressed.backOut + '/' + unguarded.backOut + ']');
  const bOn = o.brainOn || {}, bOff = o.brainOff || {};
  check('it backs the ball out and works a new angle instead',
        bOn.back > bOn.n * 0.9 && bOff.back === 0,
        'reset the angle on ' + (bOn.back || 0) + ' of ' + (bOn.n || 0) +
        ' ticks against a stance, ' + (bOff.back || 0) + ' against nobody');
  check('and never sprints into somebody who is set',
        bOn.sprint === 0 && bOff.sprint > 0,
        (bOn.sprint || 0) + ' sprinting ticks against a stance, ' +
        (bOff.sprint || 0) + ' without one');
  check('it tries harder to shake the man off the dribble',
        bOn.moves > bOff.moves * 1.6 && bOff.moves > 0,
        (bOn.moves || 0) + ' dribble moves in ' + (bOn.n || 0) +
        ' ticks against a stance, ' + (bOff.moves || 0) + ' without one');
  check('lock/drive probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[30] the hair is hair, and there is more than one of it');
{
  /* The complaint that started this was that the hair looked welded to the
   * jersey, so the check is the literal thing: how far apart are they. Zones
   * are per-vertex and the mesh is quantised, so both are read back off the
   * asset the runtime actually loaded rather than off the rigger's log. */
  const r = runInPage(`
    var BB = window.BB, M = BB.PLAYER_MESH, Skin = BB.Skin;
    var lo = M.bounds.lo, ext = M.bounds.ext, H = M.height;
    var qp = atob(M.buffers.pos), qs = atob(M.buffers.skin);
    var n = M.vertexCount;
    var hairLow = 1e9, hairHigh = -1e9, jerseyHigh = -1e9, hairN = 0;
    var bodyHairLow = 1e9;
    for (var i = 0; i < n; i++) {
      var q = qp.charCodeAt(i * 6 + 4) | (qp.charCodeAt(i * 6 + 5) << 8);
      var z = (lo[2] + (q / 65535) * ext[2]) / H;
      var zone = qs.charCodeAt(i * 4 + 3);
      if (zone === 4) {
        hairN++;
        if (z < hairLow) hairLow = z;
        if (z > hairHigh) hairHigh = z;
      } else if (zone === 1 && z > jerseyHigh) jerseyHigh = z;
    }

    // Every style has to be a real block of triangles, and they must not all
    // be the same block — that is what a silently culled shell looks like.
    var styles = Object.keys(Skin.hairStyles || {});
    var starts = {}, dupes = 0, empty = 0;
    for (var k = 0; k < styles.length; k++) {
      var cut = Skin.hairStyles[styles[k]];
      if (!cut.count) empty++;
      if (starts[cut.start]) dupes++;
      starts[cut.start] = 1;
    }
    return {
      hairN: hairN, hairLow: hairLow, hairHigh: hairHigh, jerseyHigh: jerseyHigh,
      gap: hairLow - jerseyHigh,
      styles: styles, empty: empty, dupes: dupes,
      bodyIndexCount: Skin.bodyIndexCount, indexCount: Skin.indexCount,
      profileStyles: BB.PlayerProfile.HAIR_STYLES.map(function (h) { return h[0]; }),
      pageErr: window.__pageErr || null
    };
  `, 'hair');
  if (r.err) check('hair probe ran', false, r.err);
  const o = r.out || {};
  check('the mesh still has hair on it', o.hairN > 200, o.hairN + ' vertices');
  // The old zoner reached z/H 0.832 against a jersey that starts at 0.832 —
  // hair and clothing were the same vertices.
  check('no hair vertex reaches the jersey', o.gap > 0.01,
        'hair bottoms at ' + (o.hairLow || 0).toFixed(3) +
        'H, jersey tops at ' + (o.jerseyHigh || 0).toFixed(3) + 'H, gap ' +
        ((o.gap || 0) * 100).toFixed(1) + '%');
  check('the hair sits on the skull, not the shoulders', o.hairLow > 0.87,
        'lowest hair at ' + (o.hairLow || 0).toFixed(3) + 'H');
  check('there are eight haircuts baked in', o.styles.length === 8,
        (o.styles || []).join(', '));
  check('every haircut has geometry of its own', o.empty === 0 && o.dupes === 0,
        o.empty + ' empty, ' + o.dupes + ' sharing a range');
  check('the haircuts live past the end of the body',
        o.bodyIndexCount > 0 && o.bodyIndexCount < o.indexCount,
        o.bodyIndexCount + ' of ' + o.indexCount);
  check('the creator offers every baked style plus a shaved head',
        o.profileStyles.length === o.styles.length + 1 &&
        o.profileStyles.indexOf('bald') >= 0,
        (o.profileStyles || []).join(', '));
  check('hair probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[31] a haircut is a choice that reaches the floor');
{
  const r = runInPage(`
    var BB = window.BB, P = BB.PlayerProfile;
    BB.Engine.setState('oneVone'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene;
    for (var i = 0; i < 30; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }
    var pl = scene.player;

    // A style set on the player has to arrive at the draw call, which reads it
    // off the pose rather than off the player.
    var seen = [];
    var names = ['afro', 'cornrows', 'bald'];
    for (var s = 0; s < names.length; s++) {
      pl.hairStyle = names[s];
      scene.render(0);
      var poses = BB.S3._poses.slice(0, BB.S3._poseCount);
      seen.push(poses.length ? poses[0].hairStyle : null);
    }

    // Shaved is the one with no shell, so it has to be done in colour: the
    // scalp goes to a skin tone instead of the hair colour.
    pl.skin = '#C99268'; pl.hair = '#1B1310';
    pl.hairStyle = 'afro'; scene.render(0);
    var withHair = Array.prototype.slice.call(BB.S3._poses[0].zc.slice(16, 19));
    pl.hairStyle = 'bald'; scene.render(0);
    var shaved = Array.prototype.slice.call(BB.S3._poses[0].zc.slice(16, 19));

    // And a saved player has to carry their haircut into a game.
    P.clear();
    var d = P.newDraft();
    d.hairStyle = 'locs';
    P.save(d);
    var cfg = P.toPlayerConfig(P.newDraft());
    P.clear();

    return {
      seen: seen, withHair: withHair, shaved: shaved,
      carried: cfg.hairStyle,
      dflt: P.newDraft().hairStyle,
      pageErr: window.__pageErr || null
    };
  `, 'haircut');
  if (r.err) check('haircut probe ran', false, r.err);
  const o = r.out || {};
  check('the style set on a player reaches the draw call',
        JSON.stringify(o.seen) === JSON.stringify(['afro', 'cornrows', 'bald']),
        JSON.stringify(o.seen));
  const wh = o.withHair || [], sh = o.shaved || [];
  const moved = wh.length === 3 && sh.length === 3 &&
    (Math.abs(wh[0] - sh[0]) + Math.abs(wh[1] - sh[1]) + Math.abs(wh[2] - sh[2])) > 0.15;
  check('a shaved head repaints the scalp instead of drawing hair', moved,
        'hair zone ' + JSON.stringify(wh) + ' -> ' + JSON.stringify(sh));
  check('a saved player carries their haircut into a game', o.carried === 'locs',
        String(o.carried));
  check('a brand new player still gets a haircut', !!o.dflt, String(o.dflt));
  check('haircut probe raised no errors', !o.pageErr, o.pageErr);
}

console.log('\n[32] the tutorial teaches the keys you actually have');
{
  const r = runInPage(`
    var BB = window.BB;
    BB.Engine.setState('menu'); BB.Engine._applyPending(); BB.Engine.stop();
    var scene = BB.Engine.scene;
    for (var i = 0; i < 20; i++) { scene.fixedUpdate(1 / 120); if (i % 2 === 0) scene.update(1 / 60, 1 / 60); }

    // The front page has to carry it, or nobody finds it.
    var tabs = Array.prototype.map.call(
      document.querySelectorAll('.screen--main .menu-tab'),
      function (t) { return t.textContent.trim(); });

    /* pop() takes the old screen out on a timer, so a synchronous probe that
     * pushes twice has two .screen--tutorial nodes in the DOM at once and
     * querySelector hands back the stale one. Read the live entry instead. */
    BB.Menus.push('tutorial');
    var el = BB.Menus.top.el;
    var chapters = el.querySelectorAll('.tut__ch').length;
    var lessons = el.querySelectorAll('.tut__lesson').length;
    var practice = el.querySelectorAll('[data-play]').length;
    var caps = Array.prototype.map.call(el.querySelectorAll('.tut__keys kbd'),
      function (k) { return k.textContent.trim(); });
    var modes = Array.prototype.map.call(el.querySelectorAll('[data-play]'),
      function (b) { return b.dataset.play; });
    BB.Menus.pop();

    // Rebind, reopen, and the page has to be telling the new truth.
    BB.Input.rebind('sprint', ['KeyZ']);
    BB.Menus.push('tutorial');
    var el2 = BB.Menus.top.el;
    var afterCaps = Array.prototype.map.call(el2.querySelectorAll('.tut__keys kbd'),
      function (k) { return k.textContent.trim(); });
    BB.Menus.pop();
    BB.Input.resetBindings();

    return {
      tabs: tabs, chapters: chapters, lessons: lessons, practice: practice,
      caps: caps, afterCaps: afterCaps, modes: modes,
      pageErr: window.__pageErr || null
    };
  `, 'tutorial');
  if (r.err) check('tutorial probe ran', false, r.err);
  const o = r.out || {};
  check('the front page carries the tutorial',
        (o.tabs || []).some((t) => /HOW TO PLAY/i.test(t)), (o.tabs || []).join(' | '));
  check('it covers the whole game in chapters', o.chapters >= 7, o.chapters + ' chapters');
  check('and teaches a real number of things', o.lessons >= 20, o.lessons + ' lessons');
  check('every practice link points at a mode that exists',
        (o.modes || []).length > 0 &&
        (o.modes || []).every((m) => ['oneVone', 'fiveVfive', 'shootaround'].indexOf(m) >= 0),
        (o.modes || []).join(', '));
  check('the keys it prints are real bound keys',
        (o.caps || []).indexOf('SHIFT') >= 0 && (o.caps || []).indexOf('W') >= 0,
        (o.caps || []).slice(0, 8).join(' '));
  /* The whole point of reading Input.label at build time: a manual that can go
   * stale teaches the default instead of the truth, and the player has no way
   * to tell which half is lying. */
  check('rebinding a control rewrites the lesson',
        (o.afterCaps || []).indexOf('Z') >= 0 && (o.afterCaps || []).indexOf('SHIFT') < 0,
        (o.afterCaps || []).slice(0, 8).join(' '));
  check('tutorial probe raised no errors', !o.pageErr, o.pageErr);
}

if (process.argv.includes('--shots')) {
  console.log('\n[33] screenshots');
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
