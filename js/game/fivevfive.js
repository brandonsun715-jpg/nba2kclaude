/* =============================================================================
 * fivevfive.js  —  Scene: full-court 5-on-5.
 * -----------------------------------------------------------------------------
 * A complete game rather than a skeleton:
 *   - Two 5-man rosters; your Player Creator character starts at their own
 *     position. Fixed attacking hoop per team for the whole game.
 *   - 4 quarters on a real game clock, a 24-second shot clock, and a winner.
 *   - Passing (human and AI), with catches, interceptions and bad-pass
 *     turnovers.
 *   - Fouls, free throws, travels and out-of-bounds, reusing the same
 *     officiating.js rules layer 1v1 uses.
 *   - Team AI from teamai.js: shot selection, passing reads, off-ball spacing
 *     and cuts, and help defense. ai.js (the 1v1 brain) is untouched.
 *   - Control auto-switches to whoever is closest to the ball on defense;
 *     `switchMan` cycles manually and briefly locks out the auto-switch.
 *   - Per-player box score.
 *
 * Coordinates, projection and draw order all belong to the shared renderer —
 * nothing here touches them.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  const QUARTERS = 4;
  const QUARTER_SECONDS = 120;
  const SHOT_CLOCK = 24;
  const CATCH_RADIUS = 2.2;      // how close a pass must get to be caught
  const INTERCEPT_RADIUS = 1.5;  // how close a defender must be to pick it off

  const POS_RANK = { PG: 0, SG: 1, SF: 2, PF: 3, C: 4 };
  function sortByPosition(arr) {
    return arr.slice().sort((a, b) => (POS_RANK[a.position] ?? 2) - (POS_RANK[b.position] ?? 2));
  }

  /** Five spots for the team attacking `hoop`: handler up top, two wings,
   *  two bigs on the blocks. */
  function formationSlots(hoop) {
    const sign = hoop.dir > 0 ? 1 : -1; // dir: +1 = left basket (faces right)
    const hx = hoop.x, hy = C.HALF_W;
    return [
      { x: hx + sign * 24, y: hy },
      { x: hx + sign * 20, y: hy + 14 },
      { x: hx + sign * 20, y: hy - 14 },
      { x: hx + sign * 9, y: hy + 8 },
      { x: hx + sign * 9, y: hy - 8 }
    ];
  }

  function blankStats() {
    return { pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0 };
  }

  const FiveVFiveScene = {
    /* =================================================================== */
    enter() {
      const World = BB.Game.ensureWorld();

      /* ---------------------------------------------------------- rosters */
      this.teamA = new BB.Team({ name: 'Hardwood', abbr: 'HWD', primary: PAL.paint, secondary: PAL.chalk });
      BB.Team.generateRoster(this.teamA, (Math.random() * 1e9) | 0);
      const startersA = this.teamA.startingFive();

      const draft = BB.PlayerProfile.newDraft();
      const human = new BB.Player(BB.PlayerProfile.toPlayerConfig(draft));
      this.teamA.add(human);

      let idx = startersA.findIndex((p) => p.position === human.position);
      if (idx === -1) idx = startersA.reduce((lo, p, i, arr) => (p.overall < arr[lo].overall ? i : lo), 0);
      startersA[idx] = human;

      this.teamB = new BB.Team({ name: 'Visitors', abbr: 'VIS', primary: PAL.orange, secondary: PAL.ink });
      BB.Team.generateRoster(this.teamB, (Math.random() * 1e9) | 0);
      const startersB = this.teamB.startingFive();

      this.teamA.hoop = World.hoops[1];
      this.teamB.hoop = World.hoops[0];

      this.startersA = sortByPosition(startersA);
      this.startersB = sortByPosition(startersB);
      this.all = this.startersA.concat(this.startersB);

      for (let i = 0; i < 5; i++) {
        this.startersA[i].opponent = this.startersB[i];
        this.startersB[i].opponent = this.startersA[i];
      }

      for (const p of this.all) {
        p.boundX = null;
        p.fixedHoop = p.team.hoop;
        p.targetHoop = p.team.hoop;
        p.human = false;
        p.isGuarding = false;
        p.stealCooldown = 0; p.blockCooldown = 0;
        p.box = blankStats();
        p._cutting = false; p._cutTimer = 0;
      }

      this.human = human;
      this.controlled = human;
      human.human = true;
      this._manualSwitchLock = 0;

      this.ball = new BB.Ball(World.hoops);
      this.score = { away: 0, home: 0 };
      this.difficulty = BB.Settings.get('difficulty') === 'rookie' ? 0.75
        : BB.Settings.get('difficulty') === 'allstar' ? 1.2 : 1;
      this.dim = 0;

      /* Clocks and game state. */
      this.quarter = 1;
      this.gameClock = QUARTER_SECONDS;
      this.shotClock = SHOT_CLOCK;
      this.phase = 'check';
      this.checkTimer = 1.0;

      /* Officiating state. */
      this._foulCooldown = 0;
      this._pendingAndOne = null;
      this.ft = null;
      this.ftTimer = 0;
      this._lastPasser = null;
      this._passTarget = null;
      this._staminaWarned = false;

      this._wireEvents();
      this._formUp(U.rng.chance(0.5) ? this.teamA : this.teamB);

      BB.Camera.reset(C.HALF_L, C.HALF_W, 1);
      BB.Camera.setMode(BB.Settings.get('cameraMode') || BB.Camera.MODES.BROADCAST);

      BB.HUD.setTeams(
        { abbr: this.teamA.abbr, primary: this.teamA.primary, secondary: this.teamA.secondary },
        { abbr: this.teamB.abbr, primary: this.teamB.primary, secondary: this.teamB.secondary }
      );
      BB.HUD.show();
      this._updateHud();
      BB.HUD.toast(BB.Input.label('pass') + ': pass  ·  ' + BB.Input.label('switchMan') + ': switch player', 3600);
      BB.Audio.setCrowdIntensity(0.22, 1.5);
      BB.Commentary.gameStart({ you: human.name });
    },

    exit() {
      BB.HUD.hide();
      BB.Engine.setTimeScale(1, true);
    },

    /* ============================================================== events */
    _wireEvents() {
      const ball = this.ball;
      const pan = (x) => BB.Camera.panFor(x);

      ball.events.on('bounce', (e) => {
        BB.Audio.play('dribble', { pan: pan(e.x), gain: 0.35 + e.force * 0.65 });
        if (e.force > 0.30) BB.FX.dust(e.x, e.y, Math.round(e.force * 5), e.force);
      });
      ball.events.on('rim', (e) => {
        e.hoop.hitRim(e.force);
        BB.Audio.play('rim', { pan: pan(e.x) });
        BB.FX.burst(e.x, e.y, e.z, 5 + Math.round(e.force * 6), PAL.gold, e.force);
      });
      ball.events.on('board', (e) => { e.hoop.hitBoard(e.force); BB.Audio.play('board', { pan: pan(e.x) }); });
      ball.events.on('score', (e) => this._onScore(e));
      ball.events.on('miss', (e) => this._onMiss(e));

      for (const p of this.all) {
        p.events.on('steal', (e) => this._onSteal(e));
        p.events.on('block', (e) => this._onBlock(e));
        p.events.on('fumble', (pl) => this._onFumble(pl));
        p.events.on('violation', (e) => this._onViolation(e));
        p.events.on('foul', (e) => this._onFoul({ type: e.type, foulOn: e.by, against: e.victim }));
      }
    },

    /* ============================================================ helpers */
    _isTeamA(p) { return p && p.team === this.teamA; },
    _sideOf(p) { return this._isTeamA(p) ? 'away' : 'home'; },
    _mates(p) { return this._isTeamA(p) ? this.startersA : this.startersB; },
    _foes(p) { return this._isTeamA(p) ? this.startersB : this.startersA; },

    /** Which hoop matters to this player's current decision. */
    _hoopFor(p) {
      const owner = this.ball.owner;
      if (!owner || owner.team === p.team) return p.fixedHoop;
      return (p.opponent && p.opponent.fixedHoop) || p.fixedHoop;
    },

    _addScore(team, pts) {
      if (team === this.teamA) this.score.away += pts; else this.score.home += pts;
    },

    /* ============================================================ formation */
    /** Reset both fives for `offenseTeam` and hand them the ball. */
    _formUp(offenseTeam) {
      const defenseTeam = offenseTeam === this.teamA ? this.teamB : this.teamA;
      const offenseList = offenseTeam === this.teamA ? this.startersA : this.startersB;
      const defenseList = defenseTeam === this.teamA ? this.startersA : this.startersB;
      const hoop = offenseTeam.hoop;
      const slots = formationSlots(hoop);

      this.ball.release(BB.Ball.STATE.LOOSE);
      this.ball.owner = null;
      this._passTarget = null;
      this._lastPasser = null;

      for (let i = 0; i < 5; i++) {
        const p = offenseList[i], s = slots[i];
        p.placeAt(s.x, s.y, Math.atan2(hoop.y - s.y, hoop.x - s.x));
        p.vx = 0; p.vy = 0; p.vz = 0; p.z = 0;
        p.hasBall = false;
        p.action = BB.Player.ACTION.IDLE;
        p.isGuarding = false;
        p._cutting = false;
        p._homeX = s.x; p._homeY = s.y;
      }
      for (let i = 0; i < 5; i++) {
        const d = defenseList[i], atk = offenseList[i];
        const toHoop = Math.atan2(hoop.y - atk.y, hoop.x - atk.x);
        const dx = atk.x + Math.cos(toHoop) * 3.4, dy = atk.y + Math.sin(toHoop) * 3.4;
        d.placeAt(dx, dy, toHoop + Math.PI);
        d.vx = 0; d.vy = 0; d.vz = 0; d.z = 0;
        d.action = BB.Player.ACTION.IDLE;
        d._cutting = false;
        d._beliefX = atk.x; d._beliefY = atk.y;
        d._homeX = dx; d._homeY = dy;
      }

      offenseList[0].giveBall(this.ball);
      this._offenseTeam = offenseTeam;
      this.shotClock = SHOT_CLOCK;
    },

    /** Reassign every player's off-ball anchor for the current possession.
     * Without this, a live turnover leaves the new offense anchored at the
     * positions they held while defending — i.e. at the wrong end of the
     * floor — so the ball handler advances alone with nobody to pass to and
     * the possession dies on the shot clock. */
    _updateHomeSlots(offenseTeam) {
      const offenseList = offenseTeam === this.teamA ? this.startersA : this.startersB;
      const defenseList = offenseTeam === this.teamA ? this.startersB : this.startersA;
      const slots = formationSlots(offenseTeam.hoop);
      for (let i = 0; i < offenseList.length; i++) {
        offenseList[i]._homeX = slots[i].x;
        offenseList[i]._homeY = slots[i].y;
      }
      // Defenders track their man, but keep a sane anchor for the moments
      // they have no assignment to follow (loose balls, dead time).
      for (const d of defenseList) {
        const man = d.opponent;
        if (man) { d._homeX = man.x; d._homeY = man.y; }
      }
    },

    /** Possession change without repositioning everyone — a live turnover. */
    _turnover(toTeam) {
      this._offenseTeam = toTeam;
      this.shotClock = SHOT_CLOCK;
      this._updateHomeSlots(toTeam);
    },

    /* ============================================================== passing */
    /**
     * Throw the ball from `from` to `to`. Accuracy comes from the passer's
     * rating and the distance, so long cross-court passes really can be
     * turned over. Sets _passTarget so the catch logic knows who it is for.
     */
    _throwPass(from, to, lob) {
      if (!from || !to || from === to || !from.hasBall) return false;
      const ball = this.ball;
      const dist = U.dist(from.x, from.y, to.x, to.y);

      // Lead the receiver a little so a moving target isn't thrown behind.
      const lead = U.clamp(dist / 26, 0, 1) * 0.42;
      const tx = to.x + to.vx * lead;
      const ty = to.y + to.vy * lead;

      // Accuracy error grows with distance, shrinks with passAccuracy.
      const acc = U.remap(from.ratings.passAccuracy, 25, 99, 1.0, 0.28);
      const spread = U.clamp(dist * 0.035, 0.1, 2.2) * acc;
      const ex = U.rng.f(-spread, spread), ey = U.rng.f(-spread, spread);

      const apex = lob ? 6.5 : U.clamp(1.1 + dist * 0.03, 1.1, 3.0);
      const sol = ball.solveArc(tx + ex, ty + ey, 4.2, apex);

      from.hasBall = false;
      from._dribbleLive = false;
      if (sol) {
        ball.launch(sol.vx, sol.vy, sol.vz, BB.Ball.STATE.PASS);
      } else {
        // Degenerate geometry (essentially on top of each other): shove it
        // there flat rather than leaving the ball stuck in hand.
        const a = Math.atan2(ty - from.y, tx - from.x);
        ball.launch(Math.cos(a) * 18, Math.sin(a) * 18, 1.5, BB.Ball.STATE.PASS);
      }
      ball.lastToucher = from;
      this._passTarget = to;
      this._lastPasser = from;
      this._passAssistTimer = 2.6; // window in which a made basket counts as an assist
      BB.Audio.play('dribble', { pan: BB.Camera.panFor(from.x), gain: 0.5, rate: 1.25 });
      return true;
    },

    /** Human pass: pick the teammate best matching the stick direction. */
    _humanPass(p, lob) {
      const mates = this._mates(p).filter((t) => t !== p);
      if (!mates.length) return;
      const foes = this._foes(p);

      const wantX = p.intentX, wantY = p.intentY;
      const aiming = Math.hypot(wantX, wantY) > 0.2;
      const aimAngle = Math.atan2(wantY, wantX);

      let best = null, bestScore = -Infinity;
      for (const t of mates) {
        const d = U.dist(p.x, p.y, t.x, t.y);
        if (d < 2) continue;
        let score = -d * 0.05; // mild preference for the shorter, safer pass
        if (aiming) {
          const a = Math.atan2(t.y - p.y, t.x - p.x);
          const off = Math.abs(U.angleDelta(aimAngle, a));
          if (off > 1.15) continue;          // not in the direction being aimed
          score += (1.15 - off) * 3.2;       // strongly prefer who you're pointing at
        }
        if (BB.TeamAI.laneClear(p, t, foes)) score += 1.4;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      // Aiming at nobody in particular: fall back to the safest open teammate.
      if (!best) {
        for (const t of mates) {
          const d = U.dist(p.x, p.y, t.x, t.y);
          const score = (BB.TeamAI.laneClear(p, t, foes) ? 2 : 0) - d * 0.05;
          if (score > bestScore) { bestScore = score; best = t; }
        }
      }
      if (best) this._throwPass(p, best, lob);
    },

    /**
     * Resolve a ball in flight toward a receiver: catch, interception, or
     * (if it sails past everyone) it simply becomes loose via ball physics.
     */
    _updatePass() {
      const ball = this.ball;
      if (ball.state !== BB.Ball.STATE.PASS) return;
      if (ball.z > 9) return; // still too high for anyone to take it

      // Interception first — a defender in the lane beats the intended target.
      for (const d of this.all) {
        if (this._passTarget && d.team === this._passTarget.team) continue;
        if (d === this._lastPasser) continue;
        const inLane = !this._lastPasser || !this._passTarget ||
          BB.TeamAI.distToSegment(d.x, d.y, this._lastPasser.x, this._lastPasser.y,
            this._passTarget.x, this._passTarget.y) < 2.0;
        if (inLane && U.dist(d.x, d.y, ball.x, ball.y) < INTERCEPT_RADIUS + (d.jumping ? 0.8 : 0)) {
          const chance = U.remap(d.ratings.steal, 25, 99, 0.04, 0.16);
          if (U.rng.chance(chance)) {
            d.giveBall(ball);
            d.box.stl++;
            if (this._lastPasser) this._lastPasser.box.to++;
            this._turnover(d.team);
            BB.HUD.toast('INTERCEPTED', 1200);
            BB.Commentary.steal(d.name);
            BB.Audio.crowdBurst(0.35);
            BB.FX.popup({ x: d.x, y: d.y, z: 7.5, text: 'PICKED OFF!', colour: PAL.red, size: 1.1, life: 1.1 });
            this._passTarget = null;
            return;
          }
        }
      }

      const t = this._passTarget;
      if (t && U.dist(t.x, t.y, ball.x, ball.y) < CATCH_RADIUS) {
        t.giveBall(ball);
        t.action = BB.Player.ACTION.CATCH;
        t.actionT = 0;
        // Assist credit is tracked on the RECEIVER from the moment they
        // actually catch it — timing it from the throw instead always
        // expired before the catch/gather/release/flight cycle finished.
        t._assistFrom = this._lastPasser;
        t._assistTimer = 4.5;
        this._passTarget = null;
      }
    },

    /* ================================================================ AI */
    _think(p, dt) {
      if (p.isBusyShooting) { p.intentX = 0; p.intentY = 0; p.intentMag = 0; return; }
      const owner = this.ball.owner;
      const mates = this._mates(p), foes = this._foes(p);
      const ctx = {
        hoop: this._hoopFor(p),
        teammates: mates,
        defenders: foes,
        ball: this.ball,
        ballHandler: owner,
        dt: dt,
        difficulty: this.difficulty,
        shotClock: this.shotClock,
        onPass: (target) => this._throwPass(p, target, false)
      };

      if (owner === p) {
        p.isGuarding = false;
        BB.TeamAI.onBall(p, ctx);
      } else if (owner && owner.team === p.team) {
        p.isGuarding = false;
        BB.TeamAI.offBall(p, ctx);
      } else if (owner) {
        p.isGuarding = true;
        BB.TeamAI.defend(p, ctx);
      } else {
        p.isGuarding = false;
        this._looseBallReaction(p, ctx);
      }
    },

    /** Genuinely loose ball: only the closest player on each team commits to
     *  it. Letting everyone nearby converge is what turns every rebound into
     *  a ten-man scrum; the rest keep their shape and box out where they are. */
    _looseBallReaction(p, ctx) {
      const ball = this.ball;
      const mates = this._mates(p);
      let closest = mates[0], cd = Infinity;
      for (const t of mates) {
        const d = U.dist(t.x, t.y, ball.x, ball.y);
        if (d < cd) { cd = d; closest = t; }
      }
      const myDist = U.dist(p.x, p.y, ball.x, ball.y);
      // Chase if you're your team's nearest, or the ball is basically on you.
      if ((closest === p || myDist < 3.5) && ball.z < 10) {
        const dx = ball.x - p.x, dy = ball.y - p.y;
        const m = Math.hypot(dx, dy) || 1;
        p.intentX = dx / m; p.intentY = dy / m; p.intentMag = 1; p.sprinting = true;
      } else {
        BB.TeamAI.offBall(p, ctx);
      }
    },

    /* ========================================================== switching */
    /** Auto-hand control to whoever on your team is closest to the ball,
     *  while your team is defending or the ball is loose. */
    _autoSwitchDefense(dt) {
      if (this._manualSwitchLock > 0) { this._manualSwitchLock -= dt; return; }
      const owner = this.ball.owner;
      if (owner && owner.team === this.teamA) return;
      if (this.phase !== 'live') return;

      const ball = this.ball;
      let best = this.controlled;
      let bestDist = U.dist(this.controlled.x, this.controlled.y, ball.x, ball.y);
      for (const p of this.startersA) {
        if (p === this.controlled) continue;
        const d = U.dist(p.x, p.y, ball.x, ball.y);
        if (d < bestDist - 2) { bestDist = d; best = p; }  // clear margin avoids flicker
      }
      if (best !== this.controlled) this._setControlled(best);
    },

    _setControlled(next) {
      if (!next || next === this.controlled) return;
      this.controlled.human = false;
      this.controlled.intentX = 0; this.controlled.intentY = 0;
      this.controlled.intentMag = 0; this.controlled.sprinting = false;
      next.human = true;
      this.controlled = next;
    },

    _switchControl() {
      const list = this.startersA;
      const i = list.indexOf(this.controlled);
      const next = list[(i + 1) % list.length];
      if (next === this.controlled) return;
      this._setControlled(next);
      this._manualSwitchLock = 1.2;
      BB.HUD.toast('#' + next.number + ' ' + (next.position || ''), 900);
    },

    /* ========================================================== collisions */
    _resolveCollisions(dt) {
      const all = this.all, n = all.length;
      const ball = this.ball;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const contact = BB.Collision.resolvePlayers(all[i], all[j], dt);
          if (!contact || !ball.owner || this._foulCooldown > 0 || this.phase !== 'live') continue;
          // Only contact actually involving the ball handler can be a foul.
          const a = all[i], b = all[j];
          if (a !== ball.owner && b !== ball.owner) continue;
          const mover = ball.owner;
          const defender = mover === a ? b : a;
          if (defender.team === mover.team) continue; // teammates bumping isn't a foul
          const decision = BB.Rules.classifyContact(mover, defender, contact, { hoop: mover.fixedHoop });
          if (!decision) continue;
          const three = mover.isBusyShooting && U.isThree(mover.x, mover.y, mover.fixedHoop);
          if (decision.on === 'offense') {
            this._onFoul({ type: decision.type, foulOn: mover, against: defender, three });
          } else {
            this._onFoul({ type: decision.type, foulOn: defender, against: mover, three });
          }
          return; // one whistle per tick
        }
      }
    },

    /** Whoever is in reach grabs a live loose ball; several in reach contest.
     *  The reach widens the longer the ball has gone unclaimed, so a ball that
     *  settles just outside everyone's radius can never sit there untouched. */
    _tryPickups(dt) {
      const ball = this.ball;
      if (ball.owner != null) { this._looseFor = 0; return; }
      if (ball.state === BB.Ball.STATE.PASS) return; // handled by _updatePass
      const reboundable = ball.state === BB.Ball.STATE.LOOSE ||
        (ball.state === BB.Ball.STATE.SHOT && ball.touchedRim && ball.z < 8 && ball.vz < 0);
      if (!reboundable) return;

      this._looseFor = (this._looseFor || 0) + (dt || 0);
      // After ~1.5s unclaimed, start extending everyone's reach; by ~4s a
      // settled ball is guaranteed to be collected by whoever is nearest.
      const grace = U.clamp(U.remap(this._looseFor, 1.5, 4.0, 0, 3.5), 0, 3.5);

      const cands = [];
      let total = 0;
      for (const p of this.all) {
        const dist = U.dist(p.x, p.y, ball.x, ball.y);
        const reach = p.radius + 1.4 + (p.jumping ? 1.2 : 0) + grace;
        if (dist >= reach) continue;
        const score = (p.ratings.offensiveRebound + p.ratings.defensiveRebound) * 0.5 / (dist + 0.5);
        cands.push({ p, score });
        total += score;
      }
      if (!cands.length) return;
      let r = U.rng.f(0, total), winner = cands[0].p;
      for (const c of cands) { r -= c.score; if (r <= 0) { winner = c.p; break; } }

      const wasShot = ball.shooter != null && ball.touchedRim;
      const changedHands = winner.team !== this._offenseTeam;
      winner.giveBall(ball);
      winner._assistFrom = null; // a rebound is not an assisted catch
      if (wasShot) winner.box.reb++;
      if (changedHands) this._turnover(winner.team);
      else this.shotClock = Math.max(this.shotClock, 14); // offensive board resets to 14
      ball.shooter = null;
      this._looseFor = 0;
    },

    /* =============================================================== events */
    _onScore(e) {
      if (this.phase === 'over') return;
      if (this.phase === 'freethrow') { this._resolveFreeThrow(true, e); return; }

      const scorer = e.shooter;
      if (!scorer) return;
      const pts = e.three ? 3 : 2;
      this._addScore(scorer.team, pts);
      scorer.onMade();
      scorer.box.pts += pts;
      scorer.box.fgm++; scorer.box.fga++;
      if (e.three) { scorer.box.tpm++; scorer.box.tpa++; }

      // Assist: credited to whoever passed to the scorer, tracked from the
      // catch (see _updatePass) so a normal catch-and-shoot still counts.
      if (scorer._assistFrom && scorer._assistFrom !== scorer &&
          scorer._assistFrom.team === scorer.team && (scorer._assistTimer || 0) > 0) {
        scorer._assistFrom.box.ast++;
      }
      scorer._assistFrom = null;
      this._lastPasser = null;

      BB.Commentary.make(scorer.name, !!e.three, !!e.clean);
      BB.Commentary.streak(scorer.stats.streak, scorer.name);

      e.hoop.swish(e.clean ? 1 : 0.6);
      BB.Audio.play('swish', { pan: BB.Camera.panFor(e.x) });
      BB.Audio.crowdBurst(scorer.team === this.teamA ? 0.6 : 0.3);
      BB.Camera.addTrauma(0.08 * (BB.Settings.get('screenShake') || 1));
      BB.FX.popup({
        x: e.hoop.x, y: e.hoop.y, z: C.RIM_HEIGHT + 1.5,
        text: e.clean ? 'SWISH!' : 'GOOD!',
        sub: (scorer.team === this.teamA ? this.teamA.abbr : this.teamB.abbr) + ' +' + pts,
        colour: e.three ? PAL.mint : PAL.gold, size: e.three ? 1.15 : 1.0, life: 1.2
      });
      this._updateHud();

      const andOne = this._pendingAndOne && this._pendingAndOne.shooter === scorer;
      this._pendingAndOne = null;
      if (andOne) {
        BB.Commentary.andOne(scorer.name);
        BB.HUD.banner('AND ONE!', 'ONE SHOT', 1300);
        this._awardFreeThrows(scorer, 1);
        return;
      }

      this.phase = 'check';
      this.checkTimer = 0.9;
      this._formUp(scorer.team === this.teamA ? this.teamB : this.teamA);
    },

    _onMiss(e) {
      if (this.phase === 'freethrow') { this._resolveFreeThrow(false, e); return; }
      const shooter = e.shooter || this.ball.shooter;
      if (shooter) {
        shooter.box.fga++;
        // The miss event carries no three flag — read it off the ball, where
        // it was recorded at release. Without this, 3PA only ever counted on
        // makes and the box score showed zero attempts from deep.
        if (this.ball.shotWasThree) shooter.box.tpa++;
        shooter.onMiss();
      }
      BB.Commentary.miss(shooter ? shooter.name : '');
    },

    _onSteal(e) {
      e.by.box.stl++;
      e.from.box.to++;
      this._turnover(e.by.team);
      BB.Commentary.steal(e.by.name);
      BB.Audio.play('rim', { pan: BB.Camera.panFor(e.by.x) });
      BB.FX.popup({ x: e.by.x, y: e.by.y, z: 7.5, text: 'STEAL!', colour: PAL.red, size: 1.1, life: 1.1 });
    },

    _onBlock(e) {
      e.by.box.blk++;
      BB.Commentary.block(e.by.name);
      BB.Audio.crowdBurst(0.5);
      BB.FX.popup({ x: e.by.x, y: e.by.y, z: 9.5, text: 'BLOCKED!', colour: PAL.mint, size: 1.25, life: 1.2 });
    },

    _onFumble(p) {
      BB.Audio.play('dribble', { pan: BB.Camera.panFor(p.x), gain: 0.5, rate: 0.8 });
      BB.FX.popup({ x: p.x, y: p.y, z: 5.5, text: 'FUMBLED!', colour: PAL.chalkDim, size: 0.8, life: 0.85 });
    },

    _onViolation(e) {
      if (this.phase !== 'live') return;
      const by = e.by;
      const label = e.type === BB.Rules.VIOLATION.TRAVEL ? 'TRAVELING' : 'DOUBLE DRIBBLE';
      by.box.to++;
      BB.Commentary.violation(label, by.name);
      BB.Audio.play('whistle', { pan: BB.Camera.panFor(by.x) });
      BB.HUD.banner(label, this._isTeamA(by) ? this.teamB.abbr + ' BALL' : this.teamA.abbr + ' BALL', 1400);
      BB.FX.popup({ x: by.x, y: by.y, z: 6.5, text: label, colour: PAL.orange, size: 0.95, life: 1.0 });
      this.phase = 'check';
      this.checkTimer = 0.9;
      this._formUp(by.team === this.teamA ? this.teamB : this.teamA);
    },

    _onFoul(e) {
      if (this.phase !== 'live' || this._foulCooldown > 0) return;
      this._foulCooldown = C.FOUL_COOLDOWN;
      const offender = e.foulOn, victim = e.against;
      offender.box.pf++;
      BB.Audio.play('whistle', { pan: BB.Camera.panFor(offender.x) });
      BB.Commentary.foul(e.type, offender.name);

      if (e.type === BB.Rules.FOUL.CHARGE) {
        victim.box.to = victim.box.to; // charge is on the offense: they lose it
        offender.box.to++;
        BB.HUD.banner('OFFENSIVE FOUL', 'CHARGE', 1400);
        BB.FX.popup({ x: offender.x, y: offender.y, z: 6.5, text: 'CHARGE', colour: PAL.orange, size: 1.0, life: 1.0 });
        this.phase = 'check';
        this.checkTimer = 0.9;
        this._formUp(offender.team === this.teamA ? this.teamB : this.teamA);
        return;
      }

      if (e.type === BB.Rules.FOUL.SHOOTING) {
        // If the shot is still live, wait for it: a make becomes an and-1.
        if (victim.isBusyShooting || this.ball.state === BB.Ball.STATE.SHOT) {
          this._pendingAndOne = { shooter: victim, shots: e.three ? 3 : 2 };
          victim._shotFouled = true;
          BB.HUD.toast('SHOOTING FOUL', 1200);
          return;
        }
        this._awardFreeThrows(victim, e.three ? 3 : 2);
        return;
      }

      // Reach-in / illegal contact: dead ball, possession to the fouled team.
      BB.HUD.banner('FOUL', (this._isTeamA(victim) ? this.teamA.abbr : this.teamB.abbr) + ' BALL', 1300);
      BB.FX.popup({ x: offender.x, y: offender.y, z: 6.5, text: 'FOUL', colour: PAL.gold, size: 0.95, life: 1.0 });
      this.phase = 'check';
      this.checkTimer = 0.9;
      this._formUp(victim.team);
    },

    /* =========================================================== free throws */
    _awardFreeThrows(shooter, count) {
      this.phase = 'freethrow';
      const hoop = shooter.fixedHoop;
      this.ft = { shooter, hoop, remaining: count, made: 0, total: count };
      this.ball.release(BB.Ball.STATE.LOOSE);
      this.ball.owner = null;
      this._passTarget = null;

      // Everyone stops and lines up: shooter at the stripe, the rest spread
      // along the lane and behind the arc so nobody is standing in the way.
      const ftX = hoop.x + hoop.dir * C.FT_LINE_DIST;
      shooter.placeAt(ftX, C.HALF_W, Math.atan2(hoop.y - C.HALF_W, hoop.x - ftX));
      shooter.vx = 0; shooter.vy = 0; shooter.vz = 0; shooter.z = 0;
      shooter.hasBall = false;
      shooter.action = BB.Player.ACTION.IDLE;
      shooter.intentX = 0; shooter.intentY = 0; shooter.intentMag = 0;

      let lane = 0;
      for (const p of this.all) {
        if (p === shooter) continue;
        p.vx = 0; p.vy = 0; p.vz = 0; p.z = 0;
        p.hasBall = false;
        p.action = BB.Player.ACTION.IDLE;
        p.isGuarding = false;
        p.intentX = 0; p.intentY = 0; p.intentMag = 0; p.sprinting = false;
        const side = lane % 2 === 0 ? 1 : -1;
        const step = Math.floor(lane / 2);
        const px = hoop.x + hoop.dir * (5.5 + step * 4.0);
        const py = C.HALF_W + side * (C.PAINT_HALF_W + 0.9);
        p.placeAt(px, py, Math.atan2(C.HALF_W - py, hoop.x - px));
        p._homeX = px; p._homeY = py;
        lane++;
      }
      this.ftTimer = 0.8;
      this.shotClock = SHOT_CLOCK;
    },

    _beginFreeThrowAttempt() {
      const ft = this.ft;
      if (!ft) return;
      ft.shooter.intentX = 0; ft.shooter.intentY = 0; ft.shooter.intentMag = 0;
      ft.shooter.sprinting = false;
      ft.shooter.giveBall(this.ball);
      ft.shooter._beginFreeThrow(ft.hoop);
    },

    _resolveFreeThrow(made, e) {
      if (this.phase !== 'freethrow') return; // stray/late event
      const ft = this.ft;
      if (!ft) return;
      ft.remaining--;
      ft.shooter.box.fta++;
      const ex = e && e.hoop ? e.hoop.x : ft.hoop.x;
      const ey = e && e.hoop ? e.hoop.y : ft.hoop.y;

      if (made) {
        ft.made++;
        ft.shooter.box.ftm++;
        ft.shooter.box.pts += 1;
        this._addScore(ft.shooter.team, 1);
        BB.Audio.play('swish', { pan: BB.Camera.panFor(ex) });
        BB.FX.popup({ x: ex, y: ey, z: C.RIM_HEIGHT + 1.2, text: 'GOOD!', colour: PAL.gold, size: 0.9, life: 1.0 });
      } else {
        BB.Commentary.freeThrowMiss(ft.shooter.name);
        BB.FX.popup({ x: ex, y: ey, z: C.RIM_HEIGHT + 1.0, text: 'MISS', colour: PAL.chalkDim, size: 0.8, life: 0.9 });
      }
      this._updateHud();

      if (ft.remaining > 0) { this.ftTimer = 0.9; return; }

      const shooter = ft.shooter;
      this.ft = null;
      if (made) {
        // Last one down: ball to the other team, everyone resets.
        this.phase = 'check';
        this.checkTimer = 0.9;
        this._formUp(shooter.team === this.teamA ? this.teamB : this.teamA);
      } else {
        // Live rebound off the last miss.
        this.phase = 'live';
        this._offenseTeam = shooter.team;
        this.shotClock = SHOT_CLOCK;
      }
    },

    /* ================================================================ clock */
    _advanceClock(dt) {
      if (this.phase !== 'live') return;
      this.gameClock -= dt;
      this.shotClock -= dt;

      if (this.shotClock <= 0) {
        const offender = this._offenseTeam;
        BB.HUD.banner('SHOT CLOCK', (offender === this.teamA ? this.teamB.abbr : this.teamA.abbr) + ' BALL', 1500);
        BB.Audio.play('whistle', { pan: 0 });
        this.phase = 'check';
        this.checkTimer = 0.9;
        this._formUp(offender === this.teamA ? this.teamB : this.teamA);
        return;
      }

      if (this.gameClock <= 0) {
        this.gameClock = 0;
        this._endQuarter();
      }
    },

    _endQuarter() {
      if (this.quarter >= QUARTERS) {
        // Overtime rather than a tie: nobody wants a drawn basketball game.
        if (this.score.away === this.score.home) {
          this.quarter++;
          this.gameClock = 60;
          BB.HUD.banner('OVERTIME', this.score.away + ' – ' + this.score.home, 2200);
          this.phase = 'check';
          this.checkTimer = 1.4;
          this._formUp(U.rng.chance(0.5) ? this.teamA : this.teamB);
          return;
        }
        this._endGame();
        return;
      }
      this.quarter++;
      this.gameClock = QUARTER_SECONDS;
      BB.HUD.banner('END OF QUARTER ' + (this.quarter - 1), this.score.away + ' – ' + this.score.home, 2000);
      BB.Audio.crowdBurst(0.4);
      this.phase = 'check';
      this.checkTimer = 1.6;
      this._formUp(this.quarter % 2 === 0 ? this.teamB : this.teamA);
    },

    _endGame() {
      this.phase = 'over';
      const win = this.score.away > this.score.home;
      BB.Commentary.win(win, this.human.name);
      BB.Audio.crowdBurst(1);
      if (win) BB.FX.confetti(140, [PAL.gold, PAL.orange, PAL.mint], 40);
      BB.HUD.banner(win ? 'YOU WIN' : 'YOU LOSE', this.score.away + ' – ' + this.score.home, 3000);

      const you = this.human;
      const careerResult = BB.Career.recordGame({
        won: win, pointsScored: you.box.pts,
        fgMade: you.box.fgm, fgAtt: you.box.fga,
        bestStreak: you.stats.bestStreak
      });
      if (careerResult.leveledUp) BB.Commentary.levelUp(you.name, careerResult.newLevel);
      setTimeout(() => {
        BB.Menus.push('matchend', {
          win, youScore: this.score.away, cpuScore: this.score.home, career: careerResult
        });
      }, 1800);
    },

    /* ================================================================= loop */
    fixedUpdate(dt) {
      const ball = this.ball;
      BB.World.hoops.forEach((h) => h.update(dt));
      if (this._foulCooldown > 0) this._foulCooldown -= dt;
      for (const p of this.all) {
        if (p._assistTimer > 0) {
          p._assistTimer -= dt;
          if (p._assistTimer <= 0) p._assistFrom = null;
        }
      }

      if (this.phase === 'check') {
        this.checkTimer -= dt;
        ball.update(dt);
        BB.FX.update(dt);
        for (const p of this.all) p.update(dt, ball);
        if (this.checkTimer <= 0) this.phase = 'live';
        return;
      }

      if (this.phase === 'over') {
        ball.update(dt);
        BB.FX.update(dt);
        for (const p of this.all) p.update(dt, ball);
        return;
      }

      if (this.phase === 'freethrow') {
        ball.update(dt);
        BB.FX.update(dt);
        if (!this.ft) { this.phase = 'live'; return; } // defensive: never deref a null ft
        if (this.ftTimer > 0) {
          this.ftTimer -= dt;
          for (const p of this.all) p.update(dt, ball);
          if (this.ftTimer <= 0) this._beginFreeThrowAttempt();
          return;
        }
        for (const p of this.all) p.update(dt, ball);
        this._tryPickups(dt);
        return;
      }

      /* ---- live ---------------------------------------------------------- */
      ball.update(dt);
      for (const p of this.all) p.update(dt, ball);
      BB.FX.update(dt);

      this._resolveCollisions(dt);
      this._updatePass();
      this._tryPickups(dt);
      this._advanceClock(dt);

      /* Out of bounds. A LOOSE ball has already landed or been deflected and
       * a PASS that crosses the line is simply a bad pass — both are dead
       * immediately. Waiting for the ball to slow first let it roll absurdly
       * far off the floor; excluding PASS let errant passes skid away
       * unclaimed. SHOT is excluded: it resolves through the rim/floor path. */
      const carrier = ball.owner;
      const looseOut = ball.owner == null && ball.isOutOfBounds() &&
        (ball.state === BB.Ball.STATE.LOOSE || ball.state === BB.Ball.STATE.PASS);
      const heldOut = carrier != null && !carrier.isBusyShooting && ball.isOutOfBounds();
      if ((looseOut || heldOut) && this.phase === 'live') {
        const causer = heldOut ? carrier : ball.lastToucher;
        const loserTeam = causer ? causer.team : this._offenseTeam;
        if (heldOut) { carrier.hasBall = false; carrier.box.to++; }
        BB.HUD.toast('OUT OF BOUNDS', 1100);
        this.phase = 'check';
        this.checkTimer = 0.8;
        this._formUp(loserTeam === this.teamA ? this.teamB : this.teamA);
      }

      /* Stamina feedback for the player you're actually holding. */
      BB.HUD.setStamina('away', this.controlled.stamina);
      const cpuAvg = this.startersB.reduce((s, p) => s + p.stamina, 0) / 5;
      BB.HUD.setStamina('home', cpuAvg);
      if (this.controlled.stamina < 0.32) {
        if (!this._staminaWarned) { this._staminaWarned = true; BB.HUD.toast('GASSED — SLOWING DOWN', 1600); }
      } else if (this.controlled.stamina > 0.6) {
        this._staminaWarned = false;
      }

      BB.Commentary.tick(dt);
      BB.Commentary.ambient(this.human.name);
    },

    update(dt, rawDt) {
      const menuOpen = BB.Menus.isOpen;

      if (!menuOpen) {
        if (this.phase === 'live') {
          for (const p of this.all) {
            if (p.human) {
              const owner = this.ball.owner;
              p.isGuarding = !!(owner && owner.team !== p.team);
              p.readInput(BB.Input);
              if (p.hasBall && !p.isBusyShooting) {
                if (BB.Input.pressed('pass')) this._humanPass(p, false);
                else if (BB.Input.pressed('lob')) this._humanPass(p, true);
              }
            } else {
              this._think(p, dt);
            }
          }
          if (BB.Input.pressed('switchMan')) this._switchControl();
          this._autoSwitchDefense(dt);
        } else if (this.phase === 'freethrow' && this.ft && this.ft.shooter.human) {
          this.ft.shooter.readInput(BB.Input);
          this.ft.shooter.intentX = 0; this.ft.shooter.intentY = 0;
          this.ft.shooter.intentMag = 0; this.ft.shooter.sprinting = false;
        }
        if (this.phase !== 'over' && BB.Input.pressed('pause')) this._openPause();
      }

      this.dim = U.approach(this.dim, menuOpen ? 0.55 : 0, 6, rawDt);

      const ball = this.ball;
      const focus = ball.inFlight ? ball : (ball.owner || this.controlled);
      // Downcourt is whichever basket the team in possession is attacking, so
      // the forward rig turns around with the ball on a change of possession.
      const aim = this._hoopFor(ball.owner || this.controlled);
      if (aim) BB.Camera.setAim(aim.x, aim.y);
      BB.Camera.update(dt, { x: focus.x, y: focus.y }, { x: focus.vx || 0, y: focus.vy || 0 });

      const spread = Math.abs(this.score.away - this.score.home);
      const late = this.quarter >= QUARTERS && this.gameClock < 45;
      BB.World.arena.update(dt, late && spread < 8 ? 0.5 : (spread < 8 ? 0.3 : 0.18));
      BB.Audio.setCrowdIntensity(0.14 + (spread < 8 ? 0.28 : 0.12));

      this._updateHud();
    },

    render() {
      BB.Renderer.render({
        camera: BB.Camera, court: BB.World.court, arena: BB.World.arena,
        hoops: BB.World.hoops, ball: this.ball, entities: this.all,
        fx: BB.FX, dimmed: this.dim
      });
      if (BB.Settings.get('shotMeter') && this.controlled) {
        this.controlled.meter.draw(BB.Renderer.ctx, BB.Camera);
      }
    },

    _openPause() {
      BB.Engine.setTimeScale(0, true);
      BB.Menus.push('pause', {
        sub: '5 vs 5 · ' + this.score.away + '\u2013' + this.score.home,
        onResume: () => BB.Engine.setTimeScale(1, true)
      });
    },

    _updateHud() {
      const owner = this.ball.owner;
      let poss = null;
      if (owner) poss = owner.team === this.teamA ? 'away' : 'home';
      BB.HUD.set({
        awayScore: this.score.away,
        homeScore: this.score.home,
        quarter: this.quarter,
        gameClock: Math.max(0, this.gameClock),
        shotClock: this.phase === 'live' ? Math.max(0, this.shotClock) : -1,
        possession: poss
      });
    },

    /** Per-player box score, for the match-end screen or debugging. */
    boxScore() {
      const row = (p) => ({
        name: p.name, number: p.number, position: p.position,
        pts: p.box.pts, fgm: p.box.fgm, fga: p.box.fga,
        tpm: p.box.tpm, tpa: p.box.tpa, ftm: p.box.ftm, fta: p.box.fta,
        reb: p.box.reb, ast: p.box.ast, stl: p.box.stl, blk: p.box.blk,
        to: p.box.to, pf: p.box.pf
      });
      return {
        away: { abbr: this.teamA.abbr, score: this.score.away, players: this.startersA.map(row) },
        home: { abbr: this.teamB.abbr, score: this.score.home, players: this.startersB.map(row) }
      };
    }
  };

  BB.Engine.register('fiveVfive', FiveVFiveScene);
  BB.FiveVFive = FiveVFiveScene;
})(typeof window !== 'undefined' ? window : globalThis);
