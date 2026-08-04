/* =============================================================================
 * game.js  —  Scene definitions.
 * -----------------------------------------------------------------------------
 * Three scenes ship in this build:
 *
 *   'menu'         an idle, lightly animated court behind the front-end screens
 *   'shootaround'  free shooting on a live court — physics, release meter,
 *                  layups, dunks, rebounding, no defender
 *   'oneVone'      real half-court 1-on-1 against an AI opponent (ai.js) —
 *                  make-it-take-it scoring, steals, blocks, contested shots,
 *                  contested rebounds, first to 11 win by 2
 *
 * Full 5-on-5 (Quick Play / Season / Playoffs) builds on the same Player /
 * Ball / Hoop / AI pieces and adds teammates, a real shot clock and fouls in
 * a later increment.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  /* ---------------------------------------------------------------- world
   * The floor, stands and rim geometry never change between scenes, so they
   * are built once and shared rather than rebuilt on every menu <-> game
   * transition.
   */
  const World = { ready: false, court: null, arena: null, hoops: null, team: null };

  function ensureWorld(team) {
    team = team || { name: 'Hardwood', abbr: 'HWD', primary: PAL.paint, secondary: PAL.orange };
    if (!World.ready) {
      World.court = BB.Court.init();
      World.court.setTeam(team);
      World.arena = BB.Arena.init(team);
      World.hoops = C.HOOPS.map((h) => new BB.Hoop(h));
      World.ready = true;
    } else if (team !== World.team) {
      World.court.setTeam(team);
      World.arena.setTeam(team);
    }
    World.team = team;
    return World;
  }

  /* ==========================================================================
   * Scene: menu
   * ======================================================================= */
  const MenuScene = {
    enter() {
      ensureWorld();
      BB.Camera.reset(C.HALF_L, C.HALF_W - 2, 1);
      BB.Camera.setMode(BB.Camera.MODES.WIDE);
      BB.HUD.hide();
      BB.Menus.replace('main');
      BB.Audio.setCrowdIntensity(0.06, 2);
    },

    fixedUpdate(dt) {
      World.hoops.forEach((h) => h.update(dt));
      BB.FX.update(dt);
    },

    update(dt) {
      // A slow, silent pan across the floor sells a "broadcast standby" feel.
      const t = BB.Engine.elapsed * 0.05;
      const fx = C.HALF_L + Math.sin(t) * 10;
      const fy = C.HALF_W + Math.cos(t * 0.7) * 4;
      BB.Camera.update(dt, { x: fx, y: fy }, null);
      World.arena.update(dt, 0.08);
    },

    render() {
      BB.Renderer.render({
        camera: BB.Camera, court: World.court, arena: World.arena,
        hoops: World.hoops, ball: null, entities: [], fx: BB.FX, dimmed: 0
      });
    }
  };

  /* ==========================================================================
   * Scene: shootaround
   * ======================================================================= */
  const ShootaroundScene = {
    dim: 0,
    hype: 0,
    points: 0,

    enter() {
      ensureWorld();
      BB.Menus.closeAll();
      BB.HUD.hide();
      BB.Engine.setTimeScale(1, true);

      this.ball = new BB.Ball(World.hoops);
      this.hoop = World.hoops[1];   // shoot at the right-hand basket

      const draft = BB.PlayerProfile.newDraft();
      const saved = BB.PlayerProfile.load();
      this.player = new BB.Player(BB.PlayerProfile.toPlayerConfig(draft, {
        x: this.hoop.x - 17, y: C.HALF_W
      }));
      if (saved) BB.PlayerProfile.applyAppearance(this.player, draft);
      const a = Math.atan2(this.hoop.y - this.player.y, this.hoop.x - this.player.x);
      this.player.placeAt(this.hoop.x - 17, C.HALF_W, a);
      this.player.giveBall(this.ball);

      this.points = 0;
      this.hype = 0;
      this.dim = 0;

      this._wireBallEvents();

      BB.Camera.reset(this.player.x - 4, this.player.y, 1);
      BB.Camera.setMode(BB.Settings.get('cameraMode') || BB.Camera.MODES.BROADCAST);

      this._showPractice(true);
      this._updatePracticeHud(true);
      BB.Audio.setCrowdIntensity(0.14, 1.5);
    },

    exit() {
      this._showPractice(false);
    },

    /* ------------------------------------------------------------- events */
    _wireBallEvents() {
      const ball = this.ball, hoop0 = World.hoops[0], hoop1 = World.hoops[1];
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

      ball.events.on('board', (e) => {
        e.hoop.hitBoard(e.force);
        BB.Audio.play('board', { pan: pan(e.x) });
      });

      ball.events.on('score', (e) => this._onScore(e));
      ball.events.on('miss', (e) => this._onMiss(e));

      void hoop0; void hoop1;
    },

    _onScore(e) {
      const three = e.three;
      const pts = three ? 3 : 2;
      this.points += pts;
      const p = this.player;
      p.onMade();
      BB.Commentary.make(p.name, three, !!e.clean);
      BB.Commentary.streak(p.stats.streak, p.name);

      e.hoop.swish(e.clean ? 1 : 0.6);
      BB.Audio.play('swish', { pan: BB.Camera.panFor(e.x) });
      BB.Audio.crowdBurst(U.clamp01(0.45 + p.stats.streak * 0.08));
      BB.Camera.addTrauma(0.12 * (BB.Settings.get('screenShake') || 1));

      const label = e.clean ? (p._lastShotQuality > 0.9 ? 'SWISH!' : 'BUCKET!') : 'GOOD!';
      BB.FX.popup({
        x: e.hoop.x, y: e.hoop.y, z: C.RIM_HEIGHT + 1.5,
        text: label, sub: '+' + pts + (p.stats.streak > 2 ? '   ' + p.stats.streak + ' IN A ROW' : ''),
        colour: three ? PAL.mint : PAL.gold, size: three ? 1.15 : 1.0, life: 1.4
      });

      this.hype = U.clamp01(this.hype + 0.16 + Math.min(0.24, p.stats.streak * 0.03));
      this._updatePracticeHud();
      this._scheduleRetrieve();
    },

    _onMiss(e) {
      this.player.onMiss();
      BB.Commentary.miss(this.player.name);
      BB.FX.popup({
        x: e.hoop ? e.hoop.x : e.x, y: e.hoop ? e.hoop.y : e.y, z: C.RIM_HEIGHT + 1.2,
        text: 'RIM OUT', colour: PAL.chalkDim, size: 0.8, life: 1.0
      });
      this.hype = Math.max(0, this.hype - 0.08);
      this._updatePracticeHud();
      void e;
    },

    /** Ball boy convenience: a dead ball far from the player drifts back. */
    _scheduleRetrieve() { /* handled continuously in fixedUpdate via pickup check */ },

    /* ------------------------------------------------------------- update */
    fixedUpdate(dt) {
      const ball = this.ball, player = this.player;

      World.hoops.forEach((h) => h.update(dt));
      ball.update(dt);
      player.update(dt, ball);
      BB.FX.update(dt);

      /* Pickup: only once the ball is a genuinely loose, settled-ish object. */
      if (!player.hasBall && ball.state === BB.Ball.STATE.LOOSE && ball.owner == null) {
        const d = U.dist(player.x, player.y, ball.x, ball.y);
        if (d < player.radius + 1.4 && ball.z < 4.0) {
          player.giveBall(ball);
        }
      }

      /* Ball-boy: nudge a dead, out-of-bounds ball back into play. */
      if (ball.state === BB.Ball.STATE.LOOSE && ball.speed < 0.2 && ball.isOutOfBounds()) {
        ball.place(this.hoop.x - 12, C.HALF_W, 3);
        ball.vx = ball.vy = 0; ball.vz = 0;
      }
    },

    update(dt, rawDt) {
      const menuOpen = BB.Menus.isOpen;

      if (!menuOpen) {
        this.player.readInput(BB.Input);
        if (BB.Input.pressed('pause')) this._openPause();
      }

      this.dim = U.approach(this.dim, menuOpen ? 0.55 : 0, 6, rawDt);
      this.hype = Math.max(0, this.hype - rawDt * 0.10);

      const ball = this.ball;
      const focus = ball.inFlight ? ball : this.player;
      BB.Camera.update(dt, { x: focus.x, y: focus.y }, { x: focus.vx, y: focus.vy });

      World.arena.update(dt, this.hype);
      BB.Audio.setCrowdIntensity(0.12 + this.hype * 0.75);

      this._updatePracticeHud();
    },

    render() {
      BB.Renderer.render({
        camera: BB.Camera, court: World.court, arena: World.arena,
        hoops: World.hoops, ball: this.ball, entities: [this.player],
        fx: BB.FX, dimmed: this.dim
      });
      // Screen-space shot meter, drawn on top of everything else.
      if (BB.Settings.get('shotMeter')) {
        this.player.meter.draw(BB.Renderer.ctx, BB.Camera);
      }
    },

    /* --------------------------------------------------------------- pause */
    _openPause() {
      BB.Engine.setTimeScale(0, true);
      BB.Menus.push('pause', {
        sub: 'Shootaround',
        onResume: () => BB.Engine.setTimeScale(1, true)
      });
    },

    /* ---------------------------------------------------------- practice HUD */
    _showPractice(on) {
      const el = document.getElementById('practice-hud');
      if (el) el.classList.toggle('is-on', on);
    },

    _updatePracticeHud(force) {
      const s = this.player.stats;
      const pct = s.att ? Math.round((s.made / s.att) * 100) : 0;
      const set = (id, text) => {
        const el = document.getElementById(id);
        if (el && (force || el.textContent !== text)) el.textContent = text;
      };
      set('pr-points', String(this.points));
      set('pr-fg', s.made + '/' + s.att);
      set('pr-pct', pct + '%');
      set('pr-streak', String(s.streak));
      set('pr-best', String(s.bestStreak));
    }
  };

  /* ==========================================================================
   * Scene: oneVone
   * ======================================================================= */
  const DIFFICULTY = {
    rookie: { mul: 0.62, overall: 64 },
    pro: { mul: 0.90, overall: 78 },
    allstar: { mul: 1.10, overall: 87 },
    hall: { mul: 1.35, overall: 94 }
  };

  const OneVOneScene = {
    enter() {
      ensureWorld();
      BB.Menus.closeAll();
      BB.Engine.setTimeScale(1, true);

      this.hoop = World.hoops[1];
      this.ball = new BB.Ball(World.hoops);

      const key = BB.Settings.get('difficulty') || 'pro';
      const d = DIFFICULTY[key] || DIFFICULTY.pro;
      this.difficulty = d.mul;
      this.target = 11;
      this.score = { you: 0, cpu: 0 };
      this.dim = 0;

      /* Fouls / free throws / out-of-bounds. */
      this._foulCooldown = 0;
      this._pendingAndOne = null;
      this.ft = null;
      this.ftTimer = 0;
      this._staminaWarned = false;

      const boundX = [this.hoop.x - 32, this.hoop.x - 1];

      const draft = BB.PlayerProfile.newDraft();
      const savedPlayer = BB.PlayerProfile.load();
      this.player = new BB.Player(BB.PlayerProfile.toPlayerConfig(draft, {
        x: this.hoop.x - 17, y: C.HALF_W
      }));
      if (savedPlayer) BB.PlayerProfile.applyAppearance(this.player, draft);

      this.ai = new BB.Player({
        human: false, name: 'CPU', number: 5, position: 'SG',
        overall: d.overall, height: 77, x: this.hoop.x - 22, y: C.HALF_W
      });
      this.ai.jerseyMain = PAL.red;
      this.ai.jerseyTrim = PAL.chalk;

      this.player.opponent = this.ai;
      this.ai.opponent = this.player;
      this.player.boundX = boundX;
      this.ai.boundX = boundX;

      this._wireEvents();

      BB.Camera.reset(this.hoop.x - 14, C.HALF_W, 1);
      BB.Camera.setMode(BB.Settings.get('cameraMode') || BB.Camera.MODES.BROADCAST);

      BB.HUD.setTeams(
        { abbr: (this.player.name || 'YOU').slice(0, 3).toUpperCase(), primary: this.player.jerseyMain, secondary: this.player.jerseyTrim },
        { abbr: 'CPU', primary: this.ai.jerseyMain, secondary: this.ai.jerseyTrim }
      );
      BB.HUD.el.period.textContent = '1 vs 1';
      BB.HUD.el.clock.textContent = 'TO ' + this.target;
      BB.HUD._toggle(BB.HUD.el.shotWrap, 'is-off', true);
      BB.HUD.show();

      this._startCheck(this.player, this.ai);
      this._updateHud();
      BB.HUD.setStamina('away', 1);
      BB.HUD.setStamina('home', 1);
      BB.Commentary.gameStart({ you: this.player.name });
      BB.HUD.toast('HOLD YOUR DRIBBLE: ' + BB.Input.label('pickup') + ' — WATCH YOUR STEPS AFTER', 3200);
      BB.Audio.setCrowdIntensity(0.16, 1.5);
      BB.HUD.toast('L + direction: crossover · L + Shift: spin · L alone (standing): hesitation', 3400);
    },

    exit() {
      BB.HUD.hide();
      clearTimeout(this._slowmoT);
      BB.Engine.setTimeScale(1, true);
    },

    /* ------------------------------------------------------------- events */
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
      ball.events.on('board', (e) => {
        e.hoop.hitBoard(e.force);
        BB.Audio.play('board', { pan: pan(e.x) });
      });
      ball.events.on('score', (e) => this._onScore(e));
      ball.events.on('miss', (e) => this._onMiss(e));

      this.player.events.on('steal', (e) => this._onSteal(e));
      this.ai.events.on('steal', (e) => this._onSteal(e));
      this.player.events.on('block', (e) => this._onBlock(e));
      this.ai.events.on('block', (e) => this._onBlock(e));
      this.player.events.on('fumble', (p) => this._onFumble(p));
      this.ai.events.on('fumble', (p) => this._onFumble(p));

      this.player.events.on('violation', (e) => this._onViolation(e));
      this.ai.events.on('violation', (e) => this._onViolation(e));
      this.player.events.on('foul', (e) => this._onFoul({ type: e.type, foulOn: e.by, against: e.victim }));
      this.ai.events.on('foul', (e) => this._onFoul({ type: e.type, foulOn: e.by, against: e.victim }));
    },

    _onScore(e) {
      if (this.phase === 'over') return;
      if (this.phase === 'freethrow') { this._resolveFreeThrow(true, e); return; }

      const scorer = e.shooter === this.ai ? this.ai : this.player;
      const defender = scorer === this.player ? this.ai : this.player;
      const pts = e.three ? 3 : 2;
      if (scorer === this.player) this.score.you += pts; else this.score.cpu += pts;
      scorer.onMade();
      BB.Commentary.make(scorer.name, !!e.three, !!e.clean);
      BB.Commentary.streak(scorer.stats.streak, scorer.name);
      if (Math.max(this.score.you, this.score.cpu) >= this.target - 2) BB.Commentary.closeGame();

      e.hoop.swish(e.clean ? 1 : 0.6);
      BB.Audio.play('swish', { pan: BB.Camera.panFor(e.x) });
      BB.Audio.crowdBurst(0.55);
      BB.Camera.addTrauma(0.10 * (BB.Settings.get('screenShake') || 1));

      BB.FX.popup({
        x: e.hoop.x, y: e.hoop.y, z: C.RIM_HEIGHT + 1.5,
        text: e.clean ? 'SWISH!' : 'GOOD!',
        sub: (scorer === this.player ? 'YOU' : 'CPU') + ' +' + pts,
        colour: e.three ? PAL.mint : PAL.gold, size: e.three ? 1.15 : 1.0, life: 1.3
      });

      this._updateHud();
      if (this._checkWin()) return;

      const andOne = this._pendingAndOne && this._pendingAndOne.shooter === scorer;
      this._pendingAndOne = null;
      if (andOne) {
        BB.Commentary.andOne(scorer.name);
        BB.HUD.banner('AND ONE!', 'ONE SHOT', 1400);
        this._awardFreeThrows(scorer, defender, 1);
        return;
      }
      this._startCheck(scorer, defender);
    },

    _onMiss(e) {
      if (this.phase === 'over') return;
      if (this.phase === 'freethrow') { this._resolveFreeThrow(false, e); return; }

      BB.FX.popup({
        x: e.hoop ? e.hoop.x : e.x, y: e.hoop ? e.hoop.y : e.y, z: C.RIM_HEIGHT + 1.2,
        text: 'RIM OUT', colour: PAL.chalkDim, size: 0.8, life: 1.0
      });
      const shooter = e.shooter === this.ai ? this.ai : this.player;
      if (shooter) shooter.onMiss();
      if (!this._pendingAndOne || this._pendingAndOne.shooter !== shooter) BB.Commentary.miss(shooter && shooter.name);

      if (this._pendingAndOne && this._pendingAndOne.shooter === shooter) {
        const fouled = this._pendingAndOne;
        this._pendingAndOne = null;
        const count = fouled.three ? 3 : 2;
        BB.HUD.banner('SHOOTING FOUL', count + ' SHOTS', 1400);
        this._awardFreeThrows(fouled.shooter, fouled.defender, count);
      }
    },

    _onSteal(e) {
      if (this.phase === 'over') return;
      BB.Commentary.steal(e.by.name);
      BB.Audio.play('rim', { pan: BB.Camera.panFor(e.by.x) });
      BB.Audio.crowdBurst(0.4);
      BB.FX.screenFlash(PAL.red, 0.32);
      BB.FX.burst(e.by.x, e.by.y, 2.5, 16, PAL.red, 1.3);
      BB.FX.burst(e.by.x, e.by.y, 2.5, 10, PAL.chalk, 0.9);
      BB.FX.popup({ x: e.by.x, y: e.by.y, z: 7.5, text: 'STEAL!', colour: PAL.red, size: 1.15, life: 1.2 });
      BB.Camera.addTrauma(0.16 * (BB.Settings.get('screenShake') || 1));
    },

    _onFumble(p) {
      if (this.phase === 'over') return;
      BB.Audio.play('dribble', { pan: BB.Camera.panFor(p.x), gain: 0.5, rate: 0.8 });
      BB.FX.dust(p.x, p.y, 6, 0.6);
      BB.FX.popup({ x: p.x, y: p.y, z: 5.5, text: 'FUMBLED!', colour: PAL.chalkDim, size: 0.85, life: 0.9 });
    },

    _onBlock(e) {
      if (this.phase === 'over') return;
      BB.Commentary.block(e.by.name);
      BB.Audio.play('board', { pan: BB.Camera.panFor(e.by.x) });
      BB.Audio.crowdBurst(0.7);
      BB.FX.screenFlash(PAL.mint, 0.45);
      BB.FX.burst(e.by.x, e.by.y, 8, 22, PAL.mint, 1.6);
      BB.FX.burst(e.by.x, e.by.y, 8, 12, PAL.chalk, 1.1);
      BB.FX.ring(e.by.x, e.by.y, PAL.mint, 1.4);
      BB.FX.popup({ x: e.by.x, y: e.by.y, z: 9.5, text: 'BLOCKED!', colour: PAL.mint, size: 1.35, life: 1.3 });
      BB.Camera.addTrauma(0.24 * (BB.Settings.get('screenShake') || 1));

      // A brief, highlight-reel slow-motion beat — real wall-clock timing so
      // it lasts the same perceived length regardless of the slowdown itself.
      clearTimeout(this._slowmoT);
      BB.Engine.setTimeScale(0.28, false);
      this._slowmoT = setTimeout(() => BB.Engine.setTimeScale(1, false), 380);
    },

    _onViolation(e) {
      if (this.phase !== 'live') return;
      BB.Commentary.violation(e.by && e.by.name);
      const offender = e.by;
      const other = offender === this.player ? this.ai : this.player;
      const label = e.type === BB.Rules.VIOLATION.TRAVEL ? 'TRAVELING' : 'DOUBLE DRIBBLE';

      BB.HUD.banner(label, 'BALL TO ' + (other === this.player ? 'YOU' : 'CPU'), 1500);
      BB.Audio.play('whistle', { pan: BB.Camera.panFor(offender.x) });
      BB.FX.popup({ x: offender.x, y: offender.y, z: 6.5, text: label, colour: PAL.orange, size: 1.0, life: 1.0 });

      offender.hasBall = false;
      offender.action = BB.Player.ACTION.IDLE;
      offender.armRaise = 0;
      offender.pendingShot = null;
      offender.meter.cancel();
      this._startCheck(other, offender);
    },

    /**
     * @param {object} e { type, foulOn (who committed it), against (who benefits), three }
     */
    _onFoul(e) {
      if (this.phase !== 'live') return;
      if (e.foulOn) e.foulOn.fouls++;
      this._foulCooldown = C.FOUL_COOLDOWN;
      BB.Commentary.foul(e.type === BB.Rules.FOUL.CHARGE, e.foulOn && e.foulOn.name);

      if (e.type === BB.Rules.FOUL.CHARGE) {
        const mover = e.foulOn, defender = e.against;
        BB.HUD.banner('OFFENSIVE FOUL', 'CHARGE \u2014 BALL TO ' + (defender === this.player ? 'YOU' : 'CPU'), 1600);
        BB.Audio.play('whistle', { pan: BB.Camera.panFor(mover.x) });
        BB.FX.popup({ x: mover.x, y: mover.y, z: 6.5, text: 'OFFENSIVE FOUL', colour: PAL.orange, size: 1.0, life: 1.1 });

        mover.hasBall = false;
        mover.action = BB.Player.ACTION.IDLE;
        mover.armRaise = 0;
        mover.pendingShot = null;
        mover.meter.cancel();
        this._startCheck(defender, mover);
        return;
      }

      if (e.type === BB.Rules.FOUL.SHOOTING) {
        const shooter = e.against, defender = e.foulOn;
        shooter._shotFouled = true;
        BB.HUD.banner('SHOOTING FOUL', null, 1200);
        BB.Audio.play('whistle', { pan: BB.Camera.panFor(defender.x) });
        // The shot is still live — _onScore/_onMiss finish the job (and-1 or
        // a clean set of free throws) once it resolves.
        this._pendingAndOne = { shooter, defender, three: !!e.three };
        return;
      }

      // illegalContact / reach — dead-ball turnover straight back to the
      // fouled player, no free throws (streetball rules).
      const fouled = e.against, other = e.foulOn;
      const label = e.type === BB.Rules.FOUL.REACH ? 'REACH-IN FOUL' : 'FOUL';
      BB.HUD.banner(label, 'BALL TO ' + (fouled === this.player ? 'YOU' : 'CPU'), 1500);
      BB.Audio.play('whistle', { pan: BB.Camera.panFor(other.x) });
      BB.FX.popup({ x: fouled.x, y: fouled.y, z: 6.5, text: label, colour: PAL.gold, size: 1.0, life: 1.0 });

      fouled.hasBall = false;
      this._startCheck(fouled, other);
    },

    /** Kick off a free-throw sequence. Both players freeze; the shooter steps
     * to the line after a short beat once the whistle/banner has read. */
    _awardFreeThrows(shooter, defender, count) {
      this.phase = 'freethrow';
      this.ft = { shooter, defender, remaining: count, made: 0, total: count };
      shooter.hasBall = false;
      defender.hasBall = false;
      shooter.action = BB.Player.ACTION.IDLE;
      defender.action = BB.Player.ACTION.IDLE;
      shooter.vx = 0; shooter.vy = 0;
      defender.vx = 0; defender.vy = 0;
      this._placeForFreeThrow();
      this.ftTimer = 0.7;
    },

    _placeForFreeThrow() {
      const hoop = this.hoop;
      const shooter = this.ft.shooter, defender = this.ft.defender;
      const ftX = hoop.x + hoop.dir * C.FT_LINE_DIST;
      shooter.placeAt(ftX, C.HALF_W, Math.atan2(hoop.y - C.HALF_W, hoop.x - ftX));

      // Defender parked on the lane for presence only — a free throw is
      // undefended by rule, so shot contest is forced to zero regardless.
      const dx = hoop.x - hoop.dir * 3.5, dy = C.HALF_W + C.PAINT_HALF_W * 0.55;
      defender.placeAt(dx, dy, Math.atan2(C.HALF_W - dy, hoop.x - dx));
    },

    _beginFreeThrowAttempt() {
      const ft = this.ft;
      if (!ft) return;
      // updateMovement() forces action back to MOVE whenever intent is
      // nonzero, regardless of what the shot state machine just set — and
      // nothing else was clearing a leftover drive/AI intent for a free
      // throw. Zero it right here, at the source, for both human and AI
      // shooters, rather than relying on the once-per-frame human-only
      // reset in update() (which runs after fixedUpdate and can lag a step).
      ft.shooter.intentX = 0; ft.shooter.intentY = 0; ft.shooter.intentMag = 0;
      ft.shooter.sprinting = false;
      ft.shooter.giveBall(this.ball);
      ft.shooter._beginFreeThrow(this.hoop);
    },

    _resolveFreeThrow(made, e) {
      if (this.phase !== 'freethrow') return; // stray/late event after the sequence already ended
      const ft = this.ft;
      if (!ft) return;
      ft.remaining--;
      const ex = e.hoop ? e.hoop.x : e.x, ey = e.hoop ? e.hoop.y : e.y;
      if (made) {
        ft.made++;
        if (ft.shooter === this.player) this.score.you += 1; else this.score.cpu += 1;
        BB.Audio.play('swish', { pan: BB.Camera.panFor(ex) });
        BB.FX.popup({
          x: ex, y: ey, z: C.RIM_HEIGHT + 1.2, text: 'GOOD!',
          sub: (ft.shooter === this.player ? 'YOU' : 'CPU') + ' +1', colour: PAL.gold, size: 0.95, life: 1.1
        });
      } else {
        BB.Commentary.freeThrowMiss(ft.shooter.name);
        BB.FX.popup({ x: ex, y: ey, z: C.RIM_HEIGHT + 1.0, text: 'MISS', colour: PAL.chalkDim, size: 0.8, life: 0.9 });
      }
      this._updateHud();
      if (this._checkWin()) return;

      if (ft.remaining > 0) { this.ftTimer = 0.9; return; }

      const shooter = ft.shooter, defender = ft.defender;
      this.ft = null;
      if (made) this._startCheck(shooter, defender);
      else this.phase = 'live'; // ball is already loose off the rim — normal rebound rules apply
    },

    _checkWin() {
      const you = this.score.you, cpu = this.score.cpu;
      const reached = you >= this.target || cpu >= this.target;
      const wonBy2 = Math.abs(you - cpu) >= 2;
      if (!reached || !wonBy2) return false;

      this.phase = 'over';
      const win = you > cpu;
      BB.Commentary.win(win, this.player.name);
      BB.Audio.crowdBurst(1);
      if (win) BB.FX.confetti(140, [PAL.gold, PAL.orange, PAL.mint], 40);
      BB.HUD.banner(win ? 'YOU WIN' : 'CPU WINS', you + ' – ' + cpu, 2600);
      const careerResult = BB.Career.recordGame({
        won: win, pointsScored: you,
        fgMade: this.player.stats.made, fgAtt: this.player.stats.att,
        bestStreak: this.player.stats.bestStreak
      });
      if (careerResult.leveledUp) BB.Commentary.levelUp(this.player.name, careerResult.newLevel);
      setTimeout(() => {
        BB.Menus.push('matchend', { win, youScore: you, cpuScore: cpu, career: careerResult });
      }, 1500);
      return true;
    },

    /** Make-it-take-it reset: ball to the new possessor at the top of the key. */
    _startCheck(possessor, defender) {
      this.phase = 'check';
      this.checkTimer = 0.85;
      this._pendingAndOne = null;
      this.ft = null;

      const hoop = this.hoop;
      const px = hoop.x - 17, py = C.HALF_W;
      // The defender belongs BETWEEN the ball handler and the basket — closer
      // to the hoop than the possessor, not further out behind them. A gap of
      // 4ft is a normal denial/on-ball distance to open the check with.
      const dx = hoop.x - 13, dy = C.HALF_W;

      possessor.placeAt(px, py, Math.atan2(hoop.y - py, hoop.x - px));
      possessor.vx = 0; possessor.vy = 0; possessor.action = BB.Player.ACTION.IDLE;

      defender.placeAt(dx, dy, Math.atan2(py - dy, px - dx));
      defender.vx = 0; defender.vy = 0; defender.action = BB.Player.ACTION.IDLE;
      defender._beliefX = possessor.x; defender._beliefY = possessor.y;

      possessor.giveBall(this.ball);
    },

    /* ------------------------------------------------------------- update */
    fixedUpdate(dt) {
      const ball = this.ball;
      World.hoops.forEach((h) => h.update(dt));
      if (this._foulCooldown > 0) this._foulCooldown -= dt;

      if (this.phase === 'check') {
        this.checkTimer -= dt;
        ball.update(dt);
        BB.FX.update(dt);
        if (this.checkTimer <= 0) this.phase = 'live';
        return;
      }
      if (this.phase === 'over') {
        ball.update(dt);
        BB.FX.update(dt);
        return;
      }
      if (this.phase === 'freethrow') {
        ball.update(dt);
        BB.FX.update(dt);
        if (!this.ft) { this.phase = 'live'; return; } // defensive: never dereference a null ft
        if (this.ftTimer > 0) {
          this.ftTimer -= dt;
          if (this.ftTimer <= 0) this._beginFreeThrowAttempt();
          return;
        }
        this.ft.shooter.update(dt, ball);
        return;
      }

      ball.update(dt);
      this.player.update(dt, ball);
      this.ai.update(dt, ball);
      BB.FX.update(dt);

      /* Stamina is otherwise invisible — a bar of text nobody's looking at
       * doesn't help mid-possession, so flag it the moment it actually
       * starts costing you speed and lift, once per time it dips that low. */
      BB.HUD.setStamina('away', this.player.stamina);
      BB.HUD.setStamina('home', this.ai.stamina);
      if (this.player.stamina < 0.32) {
        if (!this._staminaWarned) {
          this._staminaWarned = true;
          BB.HUD.toast('GASSED — SLOWING DOWN', 1800);
        }
      } else if (this.player.stamina > 0.6) {
        this._staminaWarned = false;
      }

      BB.Commentary.tick(dt);
      BB.Commentary.ambient(this.player.name);

      /* Solid-body contact: resolve the overlap, then let the rules layer
       * decide whether it was foul-worthy. Only meaningful while someone
       * actually has the ball — a loose-ball scramble bump isn't a foul. */
      const contact = BB.Collision.resolvePlayers(this.player, this.ai, dt);
      if (contact && ball.owner && this._foulCooldown <= 0) {
        const mover = ball.owner;
        const defender = mover === this.player ? this.ai : this.player;
        const decision = BB.Rules.classifyContact(mover, defender, contact, { hoop: this.hoop });
        if (decision) {
          const three = mover.isBusyShooting && U.isThree(mover.x, mover.y, this.hoop);
          if (decision.on === 'offense') {
            this._onFoul({ type: decision.type, foulOn: mover, against: defender, three });
          } else {
            this._onFoul({ type: decision.type, foulOn: defender, against: mover, three });
          }
        }
      }

      this._tryPickups();

      /* Out of bounds: either a loose ball rolls past the line, or the
       * carrier steps/dribbles across it while still holding the ball —
       * both are a live-ball turnover to whoever didn't cause it. */
      const carrier = ball.owner;
      const looseOut = ball.state === BB.Ball.STATE.LOOSE && ball.speed < 0.2 && ball.isOutOfBounds();
      const heldOut = carrier != null && !carrier.isBusyShooting && ball.isOutOfBounds();
      if ((looseOut || heldOut) && this.phase === 'live') {
        const loser = heldOut ? carrier : (ball.lastToucher === this.ai ? this.ai : this.player);
        const newPossessor = loser === this.player ? this.ai : this.player;
        const newDefender = newPossessor === this.player ? this.ai : this.player;
        if (heldOut) loser.hasBall = false;
        BB.HUD.toast('OUT OF BOUNDS', 1400);
        this._startCheck(newPossessor, newDefender);
      }
    },

    /** Whoever is close enough grabs a live loose ball; both in range = contest. */
    _tryPickups() {
      const ball = this.ball;
      if (ball.owner != null) return;
      const reboundable = ball.state === BB.Ball.STATE.LOOSE ||
        (ball.state === BB.Ball.STATE.SHOT && ball.touchedRim && ball.z < 8 && ball.vz < 0);
      if (!reboundable) return;

      const cands = [];
      for (const p of [this.player, this.ai]) {
        const dist = U.dist(p.x, p.y, ball.x, ball.y);
        const reach = p.radius + 1.4 + (p.jumping ? 1.2 : 0);
        if (dist < reach) cands.push({ p, dist });
      }
      if (!cands.length) return;

      let winner;
      if (cands.length === 1) {
        winner = cands[0].p;
      } else {
        const score = (c) => (c.p.ratings.offensiveRebound + c.p.ratings.defensiveRebound) * 0.5 / (c.dist + 0.5);
        const sa = score(cands[0]), sb = score(cands[1]);
        winner = U.rng.chance(sa / (sa + sb)) ? cands[0].p : cands[1].p;
      }
      winner.giveBall(ball);
    },

    update(dt, rawDt) {
      const menuOpen = BB.Menus.isOpen;

      if (!menuOpen) {
        if (this.phase === 'live') {
          this.player.readInput(BB.Input);
          this.ai.runAI(dt, this.ball, { hoop: this.hoop, difficulty: this.difficulty });
        } else if (this.phase === 'freethrow' && this.ft && this.ft.shooter === this.player) {
          this.player.readInput(BB.Input);
          // Locked to the line — a free throw isn't a driving shot attempt.
          this.player.intentX = 0; this.player.intentY = 0; this.player.intentMag = 0;
          this.player.sprinting = false;
        }
        if (this.phase !== 'over' && BB.Input.pressed('pause')) this._openPause();
      }

      this.dim = U.approach(this.dim, menuOpen ? 0.55 : 0, 6, rawDt);

      const ball = this.ball;
      const focus = ball.inFlight ? ball : (ball.owner || this.player);
      BB.Camera.update(dt, { x: focus.x, y: focus.y }, { x: focus.vx || 0, y: focus.vy || 0 });

      const spread = Math.abs(this.score.you - this.score.cpu);
      World.arena.update(dt, spread < 3 ? 0.32 : 0.18);
      BB.Audio.setCrowdIntensity(0.12 + (spread < 3 ? 0.3 : 0.15));

      this._updateHud();
    },

    render() {
      BB.Renderer.render({
        camera: BB.Camera, court: World.court, arena: World.arena,
        hoops: World.hoops, ball: this.ball, entities: [this.player, this.ai],
        fx: BB.FX, dimmed: this.dim
      });
      if (BB.Settings.get('shotMeter')) {
        this.player.meter.draw(BB.Renderer.ctx, BB.Camera);
        this.ai.meter.draw(BB.Renderer.ctx, BB.Camera);
      }
    },

    _openPause() {
      BB.Engine.setTimeScale(0, true);
      BB.Menus.push('pause', {
        sub: '1 vs 1 · ' + this.score.you + '–' + this.score.cpu,
        onResume: () => BB.Engine.setTimeScale(1, true)
      });
    },

    _updateHud() {
      const ball = this.ball;
      let poss = null;
      if (ball.owner === this.player) poss = 'away';
      else if (ball.owner === this.ai) poss = 'home';
      BB.HUD.set({ awayScore: this.score.you, homeScore: this.score.cpu, possession: poss });
    }
  };

  BB.Engine
    .register('menu', MenuScene)
    .register('shootaround', ShootaroundScene)
    .register('oneVone', OneVOneScene);

  BB.World = World;
  BB.Game = { ensureWorld };
})(typeof window !== 'undefined' ? window : globalThis);
