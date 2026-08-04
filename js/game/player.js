/* =============================================================================
 * player.js  —  The on-court athlete.
 * -----------------------------------------------------------------------------
 * A Player owns three things: RATINGS (25-99 attributes that never change
 * during a game), STATE (position, velocity, action) and PRESENTATION (a small
 * vector figure drawn fresh every frame — there is no sprite art in this
 * project, so the body is built from primitives the same way arena.js draws
 * its bench and crowd figures).
 *
 * Input is optional. A Player with `human = true` reads BB.Input each frame;
 * every other player is driven externally (by ai.js in a later build, or left
 * standing still for now). This keeps the entity reusable for both the
 * shootaround practice court and full 5-on-5 games.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  // ---------------------------------------------------------------------
  // Skeleton: real joints (hip/knee/ankle, shoulder/elbow/wrist) solved with
  // two-bone inverse kinematics, instead of a single straight line per limb.
  // Everything below is defined in a reference LOCAL space with the foot at
  // y=0 and "up" as negative y, matching the rest of this file's convention.
  // Player.draw() scales that reference skeleton up per player via bodyScale
  // — but NOT to literal true height. A literal 1:1 scale (a 6'7" player
  // actually drawn 6.58 world-feet tall) reads as oversized on screen,
  // because this character's build (rounded joints, muscled limbs) carries
  // more visual "bulk" per foot of height than a slim silhouette would.
  // HEIGHT_LO/HI is a compressed, gamified target range instead — tall
  // enough to read clearly next to a true-to-scale ball and rim, short
  // enough that the ball and court stay legible and the figure doesn't
  // dominate the frame.
  // Proportions follow the eight-heads-tall figure that athletic reference
  // uses, which is what makes a body read as an NBA player rather than a
  // mascot: knee at 2 heads off the floor, hip joint at 4, shoulder at 6.5,
  // chin at 7, crown at 8. Everything is written in head units (HU) so the
  // ratios stay legible and the whole build retunes from one number.
  const HU = 0.235;
  const BONE = {
    shin: 2.00 * HU,       // floor contact up to the knee
    thigh: 2.00 * HU,      // knee to hip joint
    torso: 2.50 * HU,      // hip joint to shoulder joint
    neck: 1.00 * HU,       // shoulder joint to the centre of the head
    headR: 0.50 * HU,      // half the head's height — 1/16th of the figure
    upperArm: 1.45 * HU,
    forearm: 1.30 * HU,    // to the wrist; the hand adds a little more reach
    hipW: 0.60 * HU,       // half the span between hip joints
    shoulderW: 1.00 * HU,  // half the span between shoulder joints
    stance: 0.74 * HU      // half the span between the feet, wider than the hips
  };

  /* Limbs do not hang in a vertical plane straight off the joint they start at.
   * Arms converge toward the body as they go down — the wrists sit well inside
   * the shoulders — while legs splay the other way onto a base wider than the
   * hips. These are each joint's lateral offset as a fraction of the limb's
   * root width, and they are what stops the arms reading as slabs bolted to the
   * outside of the torso. The pose solver can't express any of this itself: it
   * works in a single flat plane, and everything past the IK origin's own x
   * becomes forward motion so that a run cycle scissors properly. */
  const SPLAY = {
    elbow: 0.84, wrist: 0.74,
    knee: 1.08, ankle: 1.23
  };

  // Nobody stands with locked knees, least of all somebody guarding you. The
  // hips ride this fraction lower than a fully extended leg would put them,
  // which the IK solver turns into a real bend at the knee and ankle.
  const REST_CROUCH = 0.05;
  const REST_HIP = (BONE.thigh + BONE.shin) * (1 - REST_CROUCH);
  const REF_HEIGHT = REST_HIP + BONE.torso + BONE.neck + BONE.headR;
  const HEIGHT_LO = 4.5;
  const HEIGHT_HI = 5.55;

  /* Limb thicknesses, in reference units, as {proximal, distal} pairs. Real
   * limbs are cones, not pipes — the taper from hip to knee and from calf to
   * ankle is most of what separates a leg from a broom handle. */
  const GIRTH = {
    thigh: [0.098, 0.070], calf: [0.078, 0.042], knee: 0.072, ankle: 0.048,
    upperArm: [0.070, 0.050], forearm: [0.056, 0.034], elbow: 0.052,
    deltoid: 0.076, sleeve: [0.082, 0.068],
    waist: 0.170, chest: 0.186, chestDepth: 0.62,
    shortsTop: 0.180, shortsLeg: [0.138, 0.120], shortsDepth: 0.78,
    neck: [0.064, 0.072], yoke: 0.084, yokeW: 0.62
  };
  /* How far the shorts hang down the thigh, and where the jersey's sleeve
   * starts and ends along the upper arm. */
  const SHORTS_DROP = 0.55;
  const SLEEVE_TOP = 0.20;
  const SLEEVE_HEM = 0.44;

  /**
   * Two-bone IK. Given a fixed origin (hip/shoulder) and a target position
   * for the extremity (foot/hand), returns where the middle joint
   * (knee/elbow) lands and where the extremity actually ends up — clamped to
   * the limb's true reach, so a target beyond max reach doesn't stretch the
   * limb unnaturally. `bend` (+1/-1) picks which of the two mirror-image
   * solutions to use; it's a fixed aesthetic choice per limb, not something
   * that needs to vary per pose.
   */
  function solveIK2(ox, oy, tx, ty, len1, len2, bend, out) {
    let dx = tx - ox, dy = ty - oy;
    let dist = Math.hypot(dx, dy);
    if (dist < 0.0001) { dx = 0.0001; dist = 0.0001; }
    const maxReach = len1 + len2 - 0.001;
    const minReach = Math.max(0.001, Math.abs(len1 - len2) + 0.001);
    const cd = U.clamp(dist, minReach, maxReach);

    const baseAngle = Math.atan2(dy, dx);
    const cosA = U.clamp((len1 * len1 + cd * cd - len2 * len2) / (2 * len1 * cd), -1, 1);
    const a = Math.acos(cosA) * bend;
    const jointAngle = baseAngle + a;

    out.jx = ox + Math.cos(jointAngle) * len1;
    out.jy = oy + Math.sin(jointAngle) * len1;
    out.ex = ox + (dx / dist) * cd;
    out.ey = oy + (dy / dist) * cd;
    return out;
  }

  /* ------------------------------------------------------------- attributes */
  const RATING_KEYS = [
    'layup', 'drivingDunk', 'standingDunk', 'closeShot', 'midRange', 'threePoint', 'freeThrow',
    'ballHandle', 'passAccuracy', 'passVision',
    'speed', 'acceleration', 'strength', 'vertical', 'stamina',
    'perimeterDefense', 'interiorDefense', 'steal', 'block',
    'offensiveRebound', 'defensiveRebound', 'basketballIQ'
  ];
  const TENDENCY_KEYS = ['shotTendency', 'driveTendency', 'passTendency'];

  /** Weighted overall — shooting/finishing/athleticism carry the most weight. */
  const OVERALL_WEIGHTS = {
    layup: 1.0, drivingDunk: 0.6, standingDunk: 0.4, closeShot: 1.0,
    midRange: 1.1, threePoint: 1.2, freeThrow: 0.5,
    ballHandle: 0.9, passAccuracy: 0.9, passVision: 0.7,
    speed: 1.0, acceleration: 0.8, strength: 0.6, vertical: 0.7, stamina: 0.4,
    perimeterDefense: 0.9, interiorDefense: 0.7, steal: 0.6, block: 0.5,
    offensiveRebound: 0.5, defensiveRebound: 0.6, basketballIQ: 0.8
  };
  let WEIGHT_SUM = 0;
  for (const k in OVERALL_WEIGHTS) WEIGHT_SUM += OVERALL_WEIGHTS[k];

  function computeOverall(r) {
    let sum = 0;
    for (const k in OVERALL_WEIGHTS) sum += (r[k] == null ? 60 : r[k]) * OVERALL_WEIGHTS[k];
    return Math.round(U.clamp(sum / WEIGHT_SUM, 25, 99));
  }

  function defaultRatings(overall) {
    const base = overall == null ? 75 : overall;
    const r = {};
    const rng = U.rng;
    for (const k of RATING_KEYS) r[k] = U.clamp(Math.round(base + rng.gauss(0, 7)), 25, 99);
    for (const k of TENDENCY_KEYS) r[k] = U.clamp(Math.round(rng.f(35, 85)), 0, 100);
    return r;
  }

  /** Physical movement/jump numbers derived once from ratings. */
  function derivePhysical(r) {
    return {
      maxSpeed: U.remap(r.speed, 25, 99, 9.5, 17.5),
      maxSprint: U.remap(r.speed, 25, 99, 12.5, 21.5),
      accel: U.remap(r.acceleration, 25, 99, 14, 42),
      decel: U.remap(r.acceleration, 25, 99, 20, 46),
      turnRate: U.remap(r.acceleration, 25, 99, 7, 16),
      jumpHeight: U.remap(r.vertical, 25, 99, 1.15, 3.35),
      dunkChance: U.clamp01(U.remap(Math.max(r.drivingDunk, r.standingDunk), 55, 99, 0, 0.95)),
      staminaDrain: U.remap(r.stamina, 25, 99, 1.35, 0.55)
    };
  }

  /* ---------------------------------------------------------------- action */
  const ACTION = {
    IDLE: 'idle', MOVE: 'move',
    GATHER: 'gather', METER: 'meter', RELEASE: 'release',
    LAYUP: 'layup', DUNK: 'dunk', BLOCK: 'block', STEAL: 'steal',
    CATCH: 'catch', CELEBRATE: 'celebrate'
  };

  /* ---------------------------------------------------------- dribble moves
   * Crossover / behind-the-back / hesitation change direction on the spot to
   * create separation; spin turns the whole body away from the defender.
   * Durations are how long the move's own animation/kick lasts; cooldown
   * (set in _startMove) is the minimum gap before another move can start. */
  const MOVE_DURATION = { crossover: 0.30, behindBack: 0.36, spin: 0.46, hesitation: 0.42 };
  const MOVE_COOLDOWN = { crossover: 0.32, behindBack: 0.38, spin: 0.65, hesitation: 0.40 };
  const MOVE_CHAIN_WINDOW = 0.55; // a second dribble press within this window chains into behind-the-back

  let NEXT_ID = 1;

  class Player {
    /**
     * @param {object} cfg {
     *   name, number, position, team, ratings, x, y, height (inches), skin,
     *   hair, human
     * }
     */
    constructor(cfg) {
      cfg = cfg || {};
      this.id = NEXT_ID++;
      this.name = cfg.name || 'Player';
      this.number = cfg.number == null ? 0 : cfg.number;
      this.position = cfg.position || 'G';
      this.team = cfg.team || null;
      this.human = !!cfg.human;

      this.ratings = cfg.ratings || defaultRatings(cfg.overall);
      this.overall = computeOverall(this.ratings);
      this.phys = derivePhysical(this.ratings);
      this.releaseProfileJumper = BB.Shooting.profileFromRatings(this.ratings, this.id * 7 + 1);
      this.releaseProfileLayup = BB.Shooting.makeReleaseProfile({
        riseTime: 0.30, target: 0.94, greenWindow: 0.19
      });
      this.releaseProfileDunk = BB.Shooting.makeReleaseProfile({
        riseTime: 0.22, target: 0.94, greenWindow: 0.14
      });

      this.heightIn = cfg.height || 79;
      this.skin = cfg.skin || '#C99268';
      this.hair = cfg.hair || '#1B1310';
      this.jerseyMain = (this.team && this.team.primary) || PAL.paint;
      this.jerseyTrim = (this.team && this.team.secondary) || PAL.orange;

      /* --------------------------------------------------------- world state */
      this.x = cfg.x == null ? C.HALF_L : cfg.x;
      this.y = cfg.y == null ? C.HALF_W : cfg.y;
      this.z = 0;
      this.vx = 0; this.vy = 0; this.vz = 0;
      this.facing = 0;             // radians, 0 = +x
      this.moveFacing = 0;

      this.jumping = false;
      this.landingTimer = 0;

      this.stamina = 1;
      this.sprinting = false;

      /* ------------------------------------------------------------- action */
      this.action = ACTION.IDLE;
      this.actionT = 0;
      this.hasBall = false;
      this.meter = new BB.Shooting.ShotMeter();
      this.shotType = null;        // 'jumper' | 'layup' | 'dunk'
      this.pendingShot = null;

      /* -------------------------------------------------------- animation */
      this.stridePhase = 0;
      this.dribblePhase = 0;
      this.armRaise = 0;           // 0..1, hands up for a shot
      this.lean = 0;               // signed, forward lean from acceleration
      this.squash = 0;             // landing squash-and-stretch

      this.stats = { att: 0, made: 0, streak: 0, bestStreak: 0 };
      this.events = new U.Emitter();

      /* --------------------------------------------------------- 1v1 / defense */
      this.opponent = null;      // the Player this one guards/attacks in 1v1
      this.stealCooldown = 0;
      this.blockCooldown = 0;
      this._blockConnected = false;
      this.boundX = null;        // optional [min, max] world-x play boundary
      this.isGuarding = false;   // set by the scene: true while actively defending —
                                  // drives a crouched, arms-wide stance in _updatePose().
                                  // False everywhere nothing sets it (1v1 unaffected).
      this._guardBlend = 0;
      this.fixedHoop = null;     // optional: this player's permanent attacking hoop
                                  // (5v5/full-court modes only — overrides the nearest-hoop
                                  // guess in _beginShot(), which is only safe when a player
                                  // can never be closer to their own basket. null in 1v1/
                                  // Shootaround, so behaviour there is unchanged.)
      this.aiPatience = 0;       // seconds an AI will hold the ball before forcing a decision
      this._wanderTimer = 0;
      this._wanderSign = 1;
      this.layupStyle = 'standard';
      this._beliefX = null;      // AI defense: lagged belief of the opponent's position
      this._beliefY = null;

      /* ----------------------------------------------------- rules/officiating
       * _dribbleLive: true while actively bouncing the ball (running/idle with
       * it); false once 'pickup' has gathered it two-handed. _pivotX/Y anchors
       * the legal-pivot check (BB.Rules.checkTravel) the moment it's picked up.
       * _setTimer feeds the charge/block distinction (BB.Rules.isSet). */
      this._dribbleLive = true;
      this._pivotX = null;
      this._pivotY = null;
      this._traveled = false;
      this._setTimer = 0;
      this.fouls = 0;
      this.releaseProfileFreeThrow = BB.Shooting.makeReleaseProfile({
        riseTime: U.remap(this.ratings.freeThrow, 25, 99, 0.72, 0.50),
        target: 0.95,
        greenWindow: U.remap(this.ratings.freeThrow, 25, 99, 0.032, 0.068)
      });

      /* --------------------------------------------------------- dribble moves */
      this.moveState = null;     // 'crossover' | 'behindBack' | 'spin' | 'hesitation' | null
      this.moveT = 0;
      this.moveCooldown = 0;
      this.moveDir = 1;
      this._lastMoveT = -99;
      this._moveFumble = false;
      this._spinFromFacing = 0;
      this._spinToFacing = 0;

      /* -------------------------------------------------- skeleton / pose
       * All persistent, mutated in place every frame by _updatePose() —
       * nothing here allocates per frame. */
      this._animClock = U.rng.f(0, 6.28); // phase-offset so idle players don't sync
      this.pose = {
        hipY: 0, shoulderY: 0, headY: 0, torsoLean: 0, hipLean: 0, armRoll: 0,
        footL: { x: 0, y: 0 }, footR: { x: 0, y: 0 },
        handL: { x: 0, y: 0 }, handR: { x: 0, y: 0 },
        kneeL: { jx: 0, jy: 0, ex: 0, ey: 0 }, kneeR: { jx: 0, jy: 0, ex: 0, ey: 0 },
        elbowL: { jx: 0, jy: 0, ex: 0, ey: 0 }, elbowR: { jx: 0, jy: 0, ex: 0, ey: 0 }
      };
      // Solve once up front so the skeleton is valid before the first update:
      // giveBall() asks where the hand is, and an all-zero pose puts it on the
      // floor at the player's feet.
      this._updatePose(0);
    }

    /* ------------------------------------------------------------- queries */
    get radius() { return 0.85; }
    get handZ() { return U.remap(this.heightIn, 68, 90, 6.6, 8.6) + this.z; }
    get eyeZ() { return U.remap(this.heightIn, 68, 90, 5.6, 7.4) + this.z; }
    get isBusyShooting() {
      return this.action === ACTION.GATHER || this.action === ACTION.METER ||
             this.action === ACTION.LAYUP || this.action === ACTION.DUNK;
    }

    /** How many world feet one skeleton unit is worth for this player. */
    get bodyScale() {
      return U.remap(this.heightIn, 68, 90, HEIGHT_LO, HEIGHT_HI) / REF_HEIGHT;
    }

    /** Fills the shared FRAME with this player's body axes, scale and squash. */
    _frame() {
      const f = FRAME;
      f.x = this.x; f.y = this.y; f.z = this.z;
      f.s = this.bodyScale;
      f.squash = 1 - this.squash * 0.22;
      f.stretch = 1 + this.squash * 0.16;
      f.fx = Math.cos(this.facing); f.fy = Math.sin(this.facing);
      f.rx = Math.sin(this.facing); f.ry = -Math.cos(this.facing);
      return f;
    }

    /**
     * Where the drawn ball hand actually is, in world feet — read off the same
     * solved pose and the same transform the body is built from.
     *
     * This has to come from the skeleton rather than from heightIn, because the
     * two live in different scales: the court, rim and ball are true size while
     * the figure is deliberately compressed (see HEIGHT_LO/HI). A hand position
     * computed from a player's real 6'7" lands about two feet above the head of
     * the 5-foot figure that gets drawn.
     */
    handAt(out) {
      out = out || { x: 0, y: 0, z: 0 };
      const p = this.pose, f = this._frame();
      const lean = p.torsoLean * 0.45 + this.lean * 0.16;
      posePoint(TMP_P0, f, p.elbowR.ex, p.elbowR.ey, BONE.shoulderW,
                BONE.shoulderW * SPLAY.wrist, lean, p.armRoll, -p.shoulderY * f.stretch);
      out.x = TMP_P0[0]; out.y = TMP_P0[1]; out.z = TMP_P0[2];
      return out;
    }

    /** World point the ball should render at while this player controls it. */
    handPosition(out) {
      out = out || { x: 0, y: 0, z: 0 };
      if (this.armRaise > 0.05) {
        // Release point. Calibrated against the true-scale ten-foot rim rather
        // than the drawn figure, because the shot arc is computed from it —
        // this is the one hand position gameplay reads, so it stays put.
        const reach = 1.15 + this.armRaise * 0.55;
        out.x = this.x + Math.cos(this.facing) * reach * 0.55;
        out.y = this.y + Math.sin(this.facing) * reach * 0.55;
        out.z = U.lerp(this.handZ - 0.6, this.handZ + 1.6, this.armRaise);
        return out;
      }
      this.handAt(out);
      out.z = this._dribbleZ(out.z);
      return out;
    }

    /** Ball height across one bounce: floor at the bottom, palm at the top. */
    _dribbleZ(handZ) {
      const low = C.BALL_RADIUS + 0.02;
      const high = Math.max(low, handZ - C.BALL_RADIUS * 0.5);
      const c = (Math.cos(this.dribblePhase * Math.PI * 2) + 1) * 0.5; // 1 = in hand
      return U.lerp(low, high, c);
    }

    /* --------------------------------------------------------------- setup */
    placeAt(x, y, facing) {
      this.x = x; this.y = y;
      if (facing != null) this.facing = this.moveFacing = facing;
    }

    giveBall(ball) {
      ball.hold(this);
      this.hasBall = true;
      this._dribbleLive = true;
      this._pivotX = null;
      this._pivotY = null;
      this._traveled = false;
      // aiPatience otherwise defaults to 0 and is only ever reset after a
      // shot — meaning a player's FIRST possession (a rebound, a steal, the
      // opening tip) would immediately read as "out of patience" and force
      // a shot on the very next AI tick, wherever they happen to be. Only
      // matters for AI (human ignores this field), harmless either way.
      this.aiPatience = U.rng.f(3.0, 6.0);
      const p = this.handPosition(TMP_V);
      ball.place(p.x, p.y, p.z);
    }

    /* ---------------------------------------------------------------- input
     * Only called for `human` players. Movement is expressed as an intent
     * vector so AI can later drive the exact same updateMovement().
     */
    readInput(input) {
      const v = input.moveVector(TMP_MOVE);
      this.sprinting = input.down('sprint') && v.mag > 0.05;
      this.intentX = v.x;
      this.intentY = v.y;
      this.intentMag = v.mag;

      if (this.hasBall && !this.isBusyShooting) {
        if (input.pressed('shoot')) this._beginShot();
      }

      /* Same physical keys as pass/lob double as steal/block on defense —
       * there is nobody to pass to while you don't have the ball. */
      if (!this.hasBall && this._ballRef) {
        if (input.pressed('steal')) this.trySteal(this._ballRef);
        if (input.pressed('block')) this.tryBlock(this._ballRef);
      }

      if (this.hasBall && !this.isBusyShooting && this._dribbleLive && input.pressed('dribble')) {
        const lateral = input.down('left') ? -1 : (input.down('right') ? 1 : 0);
        this._tryDribbleMove(lateral, input.down('sprint'));
      }

      if (this.hasBall && !this.isBusyShooting && input.pressed('pickup')) {
        this._togglePickup();
      }
    }

    /**
     * Gather the ball two-handed (ends the live dribble) or, if it's already
     * gathered, attempt to start dribbling again — which is a double dribble.
     * Shooting or passing out of the gathered state is always legal; this
     * only fires on a second, explicit attempt to resume bouncing it.
     */
    _togglePickup() {
      if (this._dribbleLive) {
        this._dribbleLive = false;
        this._pivotX = this.x;
        this._pivotY = this.y;
      } else {
        this.events.emit('violation', { type: BB.Rules.VIOLATION.DOUBLE_DRIBBLE, by: this });
      }
    }

    /**
     * Attempt to start a dribble move from the current input combo. Silently
     * does nothing if a move is already on cooldown or the ball isn't in
     * hand — safe to call speculatively from both human input and AI.
     */
    _tryDribbleMove(lateral, sprintHeld) {
      if (this.moveCooldown > 0 || this.moveState) return false;

      let type = null;
      if (sprintHeld && (this.intentMag || 0) > 0.25) {
        type = 'spin';
      } else if (lateral !== 0 && (this._animClock - this._lastMoveT) < MOVE_CHAIN_WINDOW) {
        type = 'behindBack';
      } else if (lateral !== 0) {
        type = 'crossover';
      } else if ((this.intentMag || 0) < 0.25) {
        type = 'hesitation';
      }
      if (!type) return false;

      this._startMove(type, lateral || (U.rng.chance(0.5) ? 1 : -1));
      return true;
    }

    _startMove(type, dir) {
      this.moveState = type;
      this.moveT = 0;
      this.moveDir = dir;
      this._lastMoveT = this._animClock;
      this.moveCooldown = MOVE_COOLDOWN[type];

      // Harder, more committal moves are riskier for a shaky ball handler.
      const riskMul = (type === 'spin' || type === 'behindBack') ? 1.4 : 1.0;
      const fumbleChance = U.remap(this.ratings.ballHandle, 25, 99, 0.16, 0.008) * riskMul;
      this._moveFumble = U.rng.chance(fumbleChance);

      if (type === 'spin') {
        this._spinFromFacing = this.facing;
        this._spinToFacing = this.facing + Math.PI * dir;
      } else {
        // A brief lateral kick sells the change of direction; normal
        // acceleration/deceleration physics takes over immediately after,
        // so it never fights the regular movement model.
        const kick = { crossover: 3.4, behindBack: 4.0, hesitation: 0 }[type] || 0;
        if (kick) {
          const perp = this.facing + Math.PI / 2;
          this.vx += Math.cos(perp) * dir * kick;
          this.vy += Math.sin(perp) * dir * kick;
        }
      }

      // The actual mechanism that sells a shake: nudge the defender's
      // reaction-lag belief further from reality, so their denial spot
      // briefly lags behind. A fumbled move sells nothing — you telegraphed
      // it by bobbling the ball.
      if (this.opponent && this.opponent._beliefX != null && !this._moveFumble) {
        const strength = U.remap(this.ratings.ballHandle, 25, 99, 0.5, 2.4) *
          (type === 'spin' ? 1.35 : type === 'behindBack' ? 1.15 : type === 'hesitation' ? 0.9 : 1.0);
        const perp = this.facing + Math.PI / 2;
        this.opponent._beliefX += Math.cos(perp) * dir * strength;
        this.opponent._beliefY += Math.sin(perp) * dir * strength;
      }

      if (BB.Audio) BB.Audio.play('dribble', { gain: 0.85, rate: 1.15 });
      if (this._moveFumble) {
        // The bad outcome doesn't land until partway through the move, so
        // the animation gets a beat to read before the ball squirts loose.
        this._fumbleAt = this.moveT + MOVE_DURATION[type] * U.rng.f(0.35, 0.65);
      } else {
        this._fumbleAt = -1;
      }
    }

    /** Ball squirts loose — the risk side of attempting an advanced move. */
    _fumbleBall() {
      const ball = this._ballRef;
      if (!ball || ball.owner !== this) return;
      ball.release(BB.Ball.STATE.LOOSE);
      const a = this.facing + U.rng.f(-1.2, 1.2);
      ball.vx = Math.cos(a) * U.rng.f(2, 5);
      ball.vy = Math.sin(a) * U.rng.f(2, 5);
      ball.vz = U.rng.f(1.5, 3.5);
      this.hasBall = false;
      this.events.emit('fumble', this);
    }

    /* ------------------------------------------------------------ movement */
    updateMovement(dt) {
      if (this.action === ACTION.DUNK || this.action === ACTION.LAYUP
        || this.action === ACTION.BLOCK || this.action === ACTION.STEAL) {
        // Committed to the finish — the drive itself still carries momentum,
        // but the player can no longer change direction. A steal is a
        // quick, committed lunge: no steering, and nothing here gets to
        // override the pose back to MOVE the instant there's leftover
        // movement intent. A block jump goes straight up — on top of the
        // plant-dampen when the jump starts (see tryBlock), it also sheds
        // any leftover drift fast in the air, so a hard closeout can never
        // turn into several feet of unnatural sliding mid-jump.
        if (this.action === ACTION.BLOCK) {
          const drag = Math.exp(-9 * dt);
          this.vx *= drag; this.vy *= drag;
        }
        this._integrate(dt);
        return;
      }

      const ix = this.intentX || 0, iy = this.intentY || 0, mag = this.intentMag || 0;
      // Fresh (stamina=1) should run at full speed; gassed (stamina=0) should
      // be noticeably slower - not the other way around.
      const gassed = 0.65 + this.stamina * 0.35;
      const top = (this.sprinting ? this.phys.maxSprint : this.phys.maxSpeed) * gassed;
      const targetVx = ix * top;
      const targetVy = iy * top;

      const accel = mag > 0.02 ? this.phys.accel : this.phys.decel;
      this.vx = U.moveToward(this.vx, targetVx, accel * dt);
      this.vy = U.moveToward(this.vy, targetVy, accel * dt);

      const speed = Math.hypot(this.vx, this.vy);
      this.lean = U.approach(this.lean, U.clamp01(speed / top) * (mag > 0.02 ? 1 : 0), 6, dt);

      if (this.moveState === 'spin') {
        const k = U.clamp01(this.moveT / MOVE_DURATION.spin);
        this.facing = U.angleLerp(this._spinFromFacing, this._spinToFacing, U.ease.outCubic(k));
      } else if (mag > 0.15) {
        this.moveFacing = Math.atan2(iy, ix);
        this.facing = U.angleLerp(this.facing, this.moveFacing, U.clamp01(this.phys.turnRate * dt));
      } else if (this.hasBall && this.pivotTarget != null) {
        this.facing = U.angleLerp(this.facing, this.pivotTarget, U.clamp01(this.phys.turnRate * 1.6 * dt));
      }

      if (speed > 0.05) {
        // Stride rate scales with speed so a jog and a sprint read differently.
        this.stridePhase += dt * (1.6 + (speed / top) * 3.4);
      }
      if (this.hasBall && this._dribbleLive && this.action === ACTION.MOVE) {
        this.dribblePhase += dt * (1.7 + (speed / top) * 1.3);
      } else if (this.hasBall && this._dribbleLive && this.action === ACTION.IDLE) {
        this.dribblePhase += dt * 1.5;
      }

      this._integrate(dt);

      /* Hard stop only at the outer edge of the painted apron — well past the
       * true sideline/baseline (x:0..COURT_L, y:0..COURT_W) — so a player
       * carrying the ball can actually cross the real line and trigger the
       * out-of-bounds whistle (checked in the scene, off the ball's own
       * position) before anything here gets in the way. */
      const pad = this.radius;
      this.x = U.clamp(this.x, pad - C.APRON, C.COURT_L - pad + C.APRON);
      this.y = U.clamp(this.y, pad - C.APRON, C.COURT_W - pad + C.APRON);
      if (this.boundX) this.x = U.clamp(this.x, this.boundX[0], this.boundX[1]);

      /* Stamina: drains while sprinting, recovers otherwise. Tuned so a
       * real sprint costs something noticeable (a below-average player
       * empties the tank in well under 10s of continuous sprinting) and
       * recovery takes real time, not a couple of idle seconds - the whole
       * point is that grinding out possessions on defense should catch up
       * with you late in a game. */
      if (this.sprinting && mag > 0.3) {
        this.stamina = Math.max(0, this.stamina - this.phys.staminaDrain * 0.14 * dt);
      } else {
        this.stamina = Math.min(1, this.stamina + 0.045 * dt);
      }

      this.action = mag > 0.05 ? ACTION.MOVE : (this.isBusyShooting ? this.action : ACTION.IDLE);
    }

    _integrate(dt) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
    }

    /* ------------------------------------------------------- defense (1v1) */
    /**
     * How well this player's opponent is contesting a shot taken from the
     * current position, 0 (uncontested) .. 1 (smothered). Distance dominates;
     * the defender's relevant rating and whether they're airborne with the
     * shooter both nudge it further.
     */
    _computeContest() {
      const d = this.opponent;
      if (!d) return 0;
      const dist = U.dist(this.x, this.y, d.x, d.y);
      const proximity = U.clamp01(1 - (dist - 0.9) / 5.2);
      if (proximity <= 0) return 0;
      const hoop = this.targetHoop;
      const perimeter = !hoop || U.dist(this.x, this.y, hoop.x, hoop.y) > 12 || U.isThree(this.x, this.y, hoop);
      const skillRating = perimeter ? d.ratings.perimeterDefense : d.ratings.interiorDefense;
      const skill = U.remap(skillRating, 25, 99, 0.55, 1.18);
      const jumpBonus = d.jumping ? 0.16 : 0;
      return U.clamp01(proximity * skill + jumpBonus);
    }

    /**
     * Attempt to strip the ball from `this.opponent`. Safe to call every
     * frame — an internal cooldown paces both the attempt rate and the
     * "recovery" after a failed reach.
     */
    trySteal(ball) {
      const d = this.opponent;
      if (this.stealCooldown > 0 || this.isBusyShooting) return false;

      const validTarget = !!(d && ball.owner === d && !d.isBusyShooting
        && U.dist(this.x, this.y, d.x, d.y) <= 3.3);

      // Same principle as the block fix: you should see the reach every
      // time you press the key, not just when it was already going to work.
      this.action = ACTION.STEAL;
      this.actionT = 0;

      if (!validTarget) {
        this.stealCooldown = 0.35;
        return false;
      }

      const dist = U.dist(this.x, this.y, d.x, d.y);
      const skillGap = this.ratings.steal - d.ratings.ballHandle;
      const base = U.remap(skillGap, -40, 40, 0.05, 0.55);
      const range = U.remap(dist, 0, 3.3, 1.2, 0.3);
      const chance = U.clamp01(base * range);
      this.stealCooldown = 0.55;

      if (!U.rng.chance(chance)) {
        if (BB.Rules && BB.Rules.rollReachFoul(this, d, U.clamp01(range))) {
          this.events.emit('foul', { type: BB.Rules.FOUL.REACH, by: this, victim: d });
        }
        return false;
      }

      const kx = this.x - d.x, ky = this.y - d.y;
      const km = Math.hypot(kx, ky) || 1;
      ball.release(BB.Ball.STATE.LOOSE);
      ball.vx = (kx / km) * 6.5 + U.rng.f(-1, 1);
      ball.vy = (ky / km) * 6.5 + U.rng.f(-1, 1);
      ball.vz = U.rng.f(2.2, 4.2);
      d.hasBall = false;
      this.events.emit('steal', { by: this, from: d });
      return true;
    }

    /**
     * Attempt to block `this.opponent`'s in-progress shot before it leaves
     * their hand. Only meaningful while the opponent is still holding the
     * ball through gather/meter/layup/dunk — once it has actually launched,
     * this is a contest, not a block, and the outcome model already accounts
     * for that.
     */
    tryBlock(ball) {
      const d = this.opponent;
      if (this.blockCooldown > 0 || this.isBusyShooting) return false;

      const validTarget = !!(d && d.isBusyShooting && ball.owner === d && !d._shotFouled
        && U.dist(this.x, this.y, d.x, d.y) <= 3.0);

      // The leap is the whole point — it happens every time you press the
      // key, not just when the game has quietly decided there's something
      // in range to contest. Whiffing at air still costs a short cooldown
      // so it can't be spammed into a glitchy blur, but nowhere near as
      // long as a real contest attempt.
      this.action = ACTION.BLOCK;
      this.actionT = 0;
      this._blockConnected = false;
      if (!this.jumping) {
        // A real jump plants and drives UP — it doesn't carry a sprint's
        // worth of horizontal speed straight through into the air. Without
        // this, closing out hard and going for a block could slide a
        // defender several feet across the floor mid-jump, which reads as
        // a flat-out teleport/glitch rather than an athletic leap.
        this.vx *= 0.42;
        this.vy *= 0.42;
        this._startJump(0.92);
      }

      if (!validTarget) {
        this.blockCooldown = 0.5;
        return false;
      }

      const shotRating = d._shotRatingFor(d.shotType || 'jumper');
      const chance = U.clamp01(U.remap(this.ratings.block - shotRating * 0.5, -30, 55, 0.02, 0.42));
      this.blockCooldown = 0.85;
      if (!U.rng.chance(chance)) return false;

      this._blockConnected = true;
      const a = Math.atan2(this.y - d.y, this.x - d.x) + Math.PI;
      ball.release(BB.Ball.STATE.LOOSE);
      ball.vx = Math.cos(a) * U.rng.f(9, 14);
      ball.vy = Math.sin(a) * U.rng.f(9, 14);
      ball.vz = U.rng.f(3, 6);
      d.hasBall = false;
      d.pendingShot = null;
      d.action = ACTION.IDLE;
      d.armRaise = 0;
      this.events.emit('block', { by: this, from: d });
      return true;
    }

    /** Delegates to the AI brain in ai.js. No-op for a human-controlled player. */
    runAI(dt, ball, ctx) {
      if (this.human || !BB.AI) return;
      BB.AI.think(this, dt, ball, ctx);
    }

    /* --------------------------------------------------------------- jump */
    _startJump(heightMul) {
      this.jumping = true;
      this.squash = 0;
      // Fatigue costs lift, not just foot speed - a gassed player's
      // vertical noticeably shrinks late in a game.
      const staminaFactor = 0.72 + this.stamina * 0.28;
      const h = this.phys.jumpHeight * (heightMul == null ? 1 : heightMul) * staminaFactor;
      this.vz = Math.sqrt(2 * C.GRAVITY * h);
    }

    updateJump(dt) {
      if (!this.jumping) {
        this.squash = U.approach(this.squash, 0, 10, dt);
        return;
      }
      this.vz -= C.GRAVITY * dt;
      this.z += this.vz * dt;
      if (this.z <= 0) {
        this.z = 0;
        this.jumping = false;
        this.squash = Math.min(1, Math.abs(this.vz) / 14);
        this.landingTimer = 0.12;
        this.events && this.events.emit('land', this);
        this.vz = 0;
      }
    }

    /* ---------------------------------------------------------- shot flow */
    _beginShot() {
      const hoop = this.fixedHoop || U.nearestHoop(this.x);
      const dHoop = U.dist(this.x, this.y, hoop.x, hoop.y);
      const close = dHoop <= C.RESTRICTED_R + 1.2;
      const speed = Math.hypot(this.vx, this.vy);
      const driving = speed > this.phys.maxSpeed * 0.35;

      this.targetHoop = hoop;
      this.action = ACTION.GATHER;
      this.actionT = 0;
      this.armRaise = 0;
      this._shotFouled = false;

      if (close) {
        const wantsDunk = driving
          ? U.rng.chance(this.phys.dunkChance)
          : U.rng.chance(this.phys.dunkChance * 0.55);
        this.shotType = wantsDunk ? 'dunk' : 'layup';
        this.driving = driving;

        // Finishing style: a euro step reads from driving at an angle across
        // the direct line to the rim (stepping around a defender); a hop
        // step reads from driving straight at the rim with a defender right
        // there to gather up against. Both are purely presentational — the
        // shot math is unchanged — but they make a defended finish look and
        // feel distinct from an open lane.
        this.layupStyle = 'standard';
        if (this.shotType === 'layup' && driving) {
          const toHoopAngle = Math.atan2(hoop.y - this.y, hoop.x - this.x);
          const velAngle = Math.atan2(this.vy, this.vx);
          const angleDiff = Math.abs(U.angleDelta(toHoopAngle, velAngle));
          if (angleDiff > 0.45) {
            this.layupStyle = 'euro';
          } else if (this.opponent && U.dist(this.x, this.y, this.opponent.x, this.opponent.y) < 4.2) {
            this.layupStyle = 'hop';
          }
        }
      } else {
        this.shotType = 'jumper';
      }
    }

    /** A free throw is always an unguarded jumper-style release from a fixed
     * spot — skip _beginShot()'s distance/driving detection entirely. */
    _beginFreeThrow(hoop) {
      this.targetHoop = hoop;
      this.action = ACTION.GATHER;
      this.actionT = 0;
      this.armRaise = 0;
      this.shotType = 'freethrow';
      this.driving = false;
      this.layupStyle = 'standard';
      this._shotFouled = false;
    }

    _profileFor(type) {
      if (type === 'jumper') return this.releaseProfileJumper;
      if (type === 'layup') return this.releaseProfileLayup;
      if (type === 'freethrow') return this.releaseProfileFreeThrow;
      return this.releaseProfileDunk;
    }

    _releaseShot() {
      const g = this.meter.release();
      this._commitShot(g);
    }

    updateShotState(dt, ball) {
      if (this.action !== ACTION.GATHER && this.action !== ACTION.METER) return;
      this.actionT += dt;
      this.armRaise = U.clamp01(this.armRaise + dt * 6);

      if (this.action === ACTION.GATHER) {
        const gatherLen = (this.shotType === 'jumper' || this.shotType === 'freethrow') ? 0.10 : 0.06;
        if (this.actionT >= gatherLen) {
          this.action = ACTION.METER;
          this.actionT = 0;
          if ((this.shotType === 'jumper' || this.shotType === 'freethrow') && !this.jumping) this._startJump(0.55);
          if (this.shotType === 'layup') this._startJump(0.7);
          if (this.shotType === 'dunk') this._startJump(1.0);
          const p = this.handPosition(TMP_V);
          const baseProfile = this._profileFor(this.shotType);
          const dist = this.targetHoop ? U.dist(this.x, this.y, this.targetHoop.x, this.targetHoop.y) : 0;
          const contestNow = this.shotType === 'freethrow' ? 0 : this._computeContest();
          const gw = BB.Shooting.greenWindowFor(this._shotRatingFor(this.shotType), dist, this.shotType, contestNow);
          this.meter.start({
            riseTime: baseProfile.riseTime, target: baseProfile.target,
            greenWindow: gw, name: baseProfile.name
          }, p);
        }
        return;
      }

      /* METER: a human's release is checked FIRST, using the meter value
       * exactly as it stood at the end of the last rendered frame — i.e.
       * exactly what was on screen when the decision was made — before this
       * tick's own meter.update() advances it any further. Checking input
       * only after the fixedUpdate loop (the old approach, in readInput)
       * let the value creep past what the player actually saw whenever a
       * frame ran more than one physics tick, which is exactly what could
       * make a shot that looked like a clean green hit grade as a miss.
       * A non-human player (or an over-held meter) auto-releases so the
       * game never stalls waiting for an AI to "let go". */
      if (this.human && BB.Input && BB.Input.released('shoot')) {
        this._releaseShot();
        return;
      }

      const p = this.handPosition(TMP_V);
      this.meter.setAnchor(p);
      const auto = this.meter.update(dt);
      if (auto) { this._commitShot(auto); return; }

      if (!this.human) {
        // AI aims for the profile's own sweet spot with a skill-based
        // jitter. For live shot attempts this has to be wide enough that
        // even a good AI shooter regularly lands outside the guaranteed-
        // make zone (Perfect through Slightly) - expressed relative to the
        // shooter's OWN green window rather than a flat number, since a
        // bigger window (the reward for a high rating) would otherwise just
        // compound with sloppier absolute aim and make good shooters even
        // MORE automatic instead of less. Free throws are the exception:
        // uncontested and practiced, so a good shooter missing most of them
        // would be wrong, not more realistic - keep those tight.
        const prof = this.meter.profile;
        const rating = this._shotRatingFor(this.shotType);
        const gw = prof.greenWindow;
        const diff = U.clamp(this.difficulty || 1, 0.55, 1.3);
        let sigma;
        if (this.shotType === 'freethrow') {
          sigma = U.lerp(0.05, 0.006, U.clamp01(rating / 99)) / diff;
        } else {
          const ratio = U.remap(rating, 25, 99, 13, 4.2);
          const dist = this.targetHoop ? U.dist(this.x, this.y, this.targetHoop.x, this.targetHoop.y) : 15;
          const distKicker = 1 + Math.max(0, dist - 13) * 0.018;
          sigma = (gw * ratio * distKicker) / diff;
        }
        const noise = U.rng.gauss(0, sigma);
        if (this.meter.value >= prof.target + noise) this._releaseShot();
      }
      void ball;
    }

    _shotRatingFor(type) {
      const r = this.ratings;
      if (type === 'dunk') return this.driving ? r.drivingDunk : r.standingDunk;
      if (type === 'layup') return r.layup;
      if (type === 'freethrow') return r.freeThrow;
      const three = this.targetHoop && U.isThree(this.x, this.y, this.targetHoop);
      return three ? r.threePoint : (U.dist(this.x, this.y, this.targetHoop.x, this.targetHoop.y) <= 12 ? r.closeShot : r.midRange);
    }

    _commitShot(grade) {
      const type = this.shotType;
      this.action = (type === 'jumper' || type === 'freethrow') ? ACTION.RELEASE : (type === 'dunk' ? ACTION.DUNK : ACTION.LAYUP);
      this.actionT = 0;
      this.pendingShot = { grade, type };

      // Layups/dunks release a beat after commit, in sync with the animation
      // reaching the rim; jumpers and free throws release immediately since
      // the meter already timed the moment.
      if (type === 'jumper' || type === 'freethrow') this._fireBall(this.pendingShot);
    }

    /** Called by the game scene when a delayed (layup/dunk) release lands. */
    _fireBall(pending) {
      const ball = this._ballRef;
      if (!ball || ball.owner !== this) return;
      const hoop = this.targetHoop;
      const hand = this.handPosition(TMP_V);
      ball.place(hand.x, hand.y, hand.z);

      const dist = U.dist(this.x, this.y, hoop.x, hoop.y);
      const rating = this._shotRatingFor(pending.type);
      // A free throw is by definition undefended — force zero contest rather
      // than reading the defender's actual (irrelevant) position.
      const contest = pending.type === 'freethrow' ? 0 : this._computeContest();
      const sol = BB.Shooting.solveShot({
        from: hand, hoop,
        grade: pending.grade,
        rating,
        contest,
        fatigue: 1 - this.stamina,
        zone: 0,
        moving: pending.type === 'jumper' ? U.clamp01(Math.hypot(this.vx, this.vy) / this.phys.maxSpeed) : 0,
        type: pending.type
      });

      ball.shooter = this;
      ball.shotWasThree = sol.isThree && pending.type !== 'dunk' && pending.type !== 'freethrow';
      ball.isFreeThrow = pending.type === 'freethrow';
      const apex = pending.type === 'dunk' ? 0.6 : sol.apex;
      if (pending.type === 'dunk' && dist < C.RIM_RADIUS + 1.3) {
        // Point-blank slam: thrown straight down through the rim rather than
        // arced, which is what sells the finish.
        ball.launch((hoop.x - hand.x) * 1.8, (hoop.y - hand.y) * 1.8, -6, BB.Ball.STATE.SHOT);
        ball.targetHoop = hoop;
      } else {
        ball.shootAt(hoop, apex, sol.errX, sol.errY, sol.errShort);
      }

      if (pending.type !== 'freethrow') this.stats.att++;
      this._lastShotQuality = sol.quality;
      this.hasBall = false;
      this.pendingShot = null;
    }

    /** Advance the post-release animation and detach from the ball cleanly. */
    updatePostShot(dt, ball) {
      if (this.action === ACTION.RELEASE) {
        this.actionT += dt;
        this.armRaise = U.approach(this.armRaise, 0, 4, dt);
        if (this.actionT > 0.5 && !this.jumping) this.action = ACTION.IDLE;
      } else if (this.action === ACTION.LAYUP || this.action === ACTION.DUNK) {
        this.actionT += dt;
        const fireAt = this.action === ACTION.DUNK ? 0.30 : 0.22;
        if (this.pendingShot && this.actionT >= fireAt) {
          this._ballRef = ball;
          this._fireBall(this.pendingShot);
        }
        this.armRaise = this.action === ACTION.DUNK
          ? U.clamp01(this.actionT / 0.3)
          : U.approach(this.armRaise, 0.7, 5, dt);
        if (this.actionT > 0.65 && !this.jumping) {
          this.action = ACTION.IDLE;
          this.armRaise = 0;
        }
      } else if (this.action === ACTION.BLOCK) {
        this.actionT += dt;
        // Held all the way up through the top of the jump; only lets go once
        // back on the ground, so the reach never gets cut short mid-air.
        if (!this.jumping && (this.landingTimer || 0) <= 0) this.action = ACTION.IDLE;
      } else if (this.action === ACTION.STEAL) {
        this.actionT += dt;
        if (this.actionT > 0.26) this.action = ACTION.IDLE;
      }
    }

    /* ------------------------------------------------------------- update */
    update(dt, ball) {
      this._ballRef = ball;
      this.meter.tick(dt);
      if (this.stealCooldown > 0) this.stealCooldown -= dt;
      if (this.blockCooldown > 0) this.blockCooldown -= dt;
      if (this.moveCooldown > 0) this.moveCooldown -= dt;
      if (this.moveState) {
        this.moveT += dt;
        if (this._fumbleAt >= 0 && this.moveT >= this._fumbleAt) {
          this._fumbleBall();
          this._fumbleAt = -1;
        }
        if (this.moveT >= MOVE_DURATION[this.moveState]) this.moveState = null;
      }
      this.updateShotState(dt, ball);
      this.updateMovement(dt);
      this.updateJump(dt);
      this.updatePostShot(dt, ball);

      if (this.landingTimer > 0) this.landingTimer -= dt;

      if (BB.Rules) {
        BB.Rules.updateSetStatus(this, dt);
        if (!this._traveled && BB.Rules.checkTravel(this)) {
          this._traveled = true;
          this.events.emit('violation', { type: BB.Rules.VIOLATION.TRAVEL, by: this });
        }
      }

      if (this.hasBall && ball.owner === this && !this.isBusyShooting) {
        const p = this.handPosition(TMP_V);
        ball.place(p.x, p.y, p.z);
      }

      this._updatePose(dt);
    }

    /* ------------------------------------------------------------ scoring */
    onMade() {
      this.stats.made++;
      this.stats.streak++;
      this.stats.bestStreak = Math.max(this.stats.bestStreak, this.stats.streak);
    }
    onMiss() { this.stats.streak = 0; }

    /* ------------------------------------------------------------- render */
    /** Soft contact shadow on the floor, fading out as the player leaves it. */
    drawShadow() {
      const h = U.clamp01(this.z / 10);
      const a = (1 - h) * 0.42 + 0.05;
      const r = this.radius * (1 + h * 0.45);
      BB.S3.shadow(this.x, this.y, r * 1.35, a);
    }

    /**
     * Submits the whole figure to the 3D scene.
     *
     * The pose solver still works in the original 2D reference plane (local x
     * across, local -y up, foot at 0). Mapping that onto a real 3D body splits
     * each joint's local x into two different world axes:
     *
     *   the fixed shoulder/hip half-width  ->  the player's RIGHT axis
     *   everything else (stride, reach)    ->  the player's FORWARD axis
     *
     * That decomposition is what makes a running player's legs scissor
     * fore-and-aft when seen from the sideline, instead of flapping sideways
     * the way a naive "local x is world x" mapping would.
     */
    draw() {
      const S3 = BB.S3;
      const p = this.pose;
      const f = this._frame();
      const s = f.s, squash = f.squash, stretch = f.stretch;
      const fx = f.fx, fy = f.fy, rx = f.rx, ry = f.ry;

      const skin = this._col('skin', this.skin);
      const skinDark = this._col('skinDark', U.shade(this.skin, -0.22));
      const shorts = this._col('shorts', U.shade(this.jerseyMain, -0.08));
      const jersey = this._col('jersey', this.jerseyMain);
      const trim = this._col('trim', this.jerseyTrim);
      const shoe = this._col('shoe', PAL.chalk);

      /* Lean tips the whole figure along its forward axis, exactly as the 2D
       * shear transform used to; hip and torso lean stay separate so a
       * crossover can still wind the shoulders against planted hips. */
      const leanF = this.lean * 0.16;

      function pt(out, lx, ly, baseX, width, lean, roll, rollUp) {
        return posePoint(out, f, lx, ly, baseX, width, lean, roll, rollUp);
      }

      const A = TMP_P0, B = TMP_P1, D = TMP_P2, E = TMP_P3, F = TMP_P4;
      const hipLean = p.hipLean * 0.45 + leanF;
      const torsoLean = p.torsoLean * 0.45 + leanF;
      const G = GIRTH;

      /* ------------------------------------------------------------- legs
       * Bare skin from hip to ankle, tapered the whole way down, with the
       * shorts drawn over the top half of the thigh as their own garment
       * rather than being implied by a change of colour. */
      for (const leg of LEGS) {
        const knee = leg.side < 0 ? p.kneeL : p.kneeR;
        const w = leg.side * BONE.hipW;
        pt(A, 0, p.hipY, 0, w, hipLean);
        pt(B, knee.jx, knee.jy, w, w * SPLAY.knee, hipLean);
        pt(D, knee.ex, knee.ey, w, leg.side * BONE.stance, hipLean);

        S3.bone(A[0], A[1], A[2], B[0], B[1], B[2],
                G.thigh[0] * s, G.thigh[1] * s, skin, 0.12);
        S3.bone(B[0], B[1], B[2], D[0], D[1], D[2],
                G.calf[0] * s, G.calf[1] * s, skin, 0.14);
        S3.sphere(B[0], B[1], B[2], G.knee * s, skin, 0.10);
        S3.sphere(D[0], D[1], D[2], G.ankle * s, skin, 0.12);

        // Shorts leg, hanging to just above the knee.
        mixPt(E, A, B, SHORTS_DROP);
        S3.trunk(A[0], A[1], A[2], E[0], E[1], E[2],
                 G.shortsLeg[0] * s, G.shortsLeg[1] * s, G.shortsDepth,
                 rx, ry, shorts, 0.06);

        /* Shoe: a flat box aligned with the direction of travel. */
        S3.box(D[0] + fx * 0.05 * s, D[1] + fy * 0.05 * s, this.z + 0.048 * s,
               0.30 * s, 0.115 * s, 0.096 * s, this.facing, shoe, 0.25);
        S3.box(D[0] + fx * 0.09 * s, D[1] + fy * 0.09 * s, this.z + 0.088 * s,
               0.14 * s, 0.105 * s, 0.055 * s, this.facing, trim, 0.2);
      }

      /* ------------------------------------------------- pelvis and torso
       * The torso is an ellipse in cross-section — twice as wide as it is
       * deep — and widens from the waist to the chest. Both segments overrun
       * their joints slightly so the primitive's pinched end caps fall
       * outside the body instead of narrowing the hips and shoulders. */
      pt(A, 0, p.hipY + 0.055, 0, 0, hipLean);
      pt(B, 0, p.shoulderY - 0.055, 0, 0, torsoLean);
      S3.trunk(A[0], A[1], A[2], B[0], B[1], B[2],
               G.waist * s, G.chest * s, G.chestDepth, rx, ry, jersey, 0.10);

      // Shorts: the seat, plus a waistband in the second team colour.
      pt(A, 0, p.hipY + 0.075, 0, 0, hipLean);
      pt(B, 0, p.hipY - 0.105, 0, 0, hipLean);
      S3.trunk(A[0], A[1], A[2], B[0], B[1], B[2],
               G.shortsLeg[0] * s, G.shortsTop * s, G.shortsDepth,
               rx, ry, shorts, 0.06);
      pt(A, 0, p.hipY - 0.075, 0, 0, hipLean);
      pt(B, 0, p.hipY - 0.130, 0, 0, hipLean);
      S3.trunk(A[0], A[1], A[2], B[0], B[1], B[2],
               G.shortsTop * s, G.shortsTop * 0.94 * s, G.shortsDepth,
               rx, ry, trim, 0.12);

      // Shoulder yoke: the fabric across the traps, stopping short of the
      // deltoids so the armholes of a sleeveless jersey stay open.
      const yw = BONE.shoulderW * G.yokeW;
      pt(A, 0, p.shoulderY - 0.022, 0, -yw, torsoLean);
      pt(B, 0, p.shoulderY - 0.022, 0, yw, torsoLean);
      S3.bone(A[0], A[1], A[2], B[0], B[1], B[2], G.yoke * s, G.yoke * s, jersey, 0.10);

      // Chest number, a flat plate sitting proud of the jersey.
      pt(D, 0, p.shoulderY + 0.235, 0, 0, torsoLean);
      S3.box(D[0] + fx * G.chest * 0.58 * s, D[1] + fy * G.chest * 0.58 * s, D[2],
             0.04 * s, 0.155 * s, 0.145 * s, this.facing, trim, 0.15);

      /* ------------------------------------------------------------- arms
       * Bare arms with a short jersey cap over the deltoid — the armhole of a
       * tank sits below the shoulder, so anything more than that reads as a
       * long-sleeve shirt nobody plays in. */
      for (const arm of ARMS) {
        const el = arm.side < 0 ? p.elbowL : p.elbowR;
        const w = arm.side * BONE.shoulderW;
        // Both arms roll away from the body by the same angle, mirrored.
        const roll = arm.side * p.armRoll;
        const pivot = -p.shoulderY * stretch;
        pt(A, 0, p.shoulderY, 0, w, torsoLean);
        pt(B, el.jx, el.jy, w, w * SPLAY.elbow, torsoLean, roll, pivot);
        pt(D, el.ex, el.ey, w, w * SPLAY.wrist, torsoLean, roll, pivot);

        S3.sphere(A[0], A[1], A[2], G.deltoid * s, skin, 0.14);
        S3.bone(A[0], A[1], A[2], B[0], B[1], B[2],
                G.upperArm[0] * s, G.upperArm[1] * s, skin, 0.14);
        S3.sphere(B[0], B[1], B[2], G.elbow * s, skin, 0.12);
        S3.bone(B[0], B[1], B[2], D[0], D[1], D[2],
                G.forearm[0] * s, G.forearm[1] * s, skin, 0.16);

        mixPt(E, A, B, SLEEVE_TOP);
        mixPt(F, A, B, SLEEVE_HEM);
        S3.bone(E[0], E[1], E[2], F[0], F[1], F[2],
                G.sleeve[0] * s, G.sleeve[1] * s, jersey, 0.08);

        // Hand: flattened along the forearm rather than a ball on a stick.
        S3.blob(D[0], D[1], D[2], 0.062 * s, 0.038 * s, 0.072 * s,
                this.facing, skin, 0.18);
      }

      /* ------------------------------------------------------------- head
       * An ellipsoid, not a sphere: a head is tallest top-to-bottom, deeper
       * front-to-back than it is wide, and at this scale it is a sixteenth of
       * the figure's height rather than the fifth it used to be. */
      pt(A, 0, p.shoulderY, 0, 0, torsoLean);
      pt(B, 0, p.headY, 0, 0, torsoLean);
      mixPt(E, A, B, 0.72);
      S3.bone(A[0], A[1], A[2], E[0], E[1], E[2],
              G.neck[0] * s, G.neck[1] * s, skin, 0.12);
      const headH = BONE.headR * 2 * s;
      S3.blob(B[0], B[1], B[2], headH * 0.83, headH * 0.68, headH, this.facing, skin, 0.20);
      // Hair, offset back and up so the head has a face and a crown.
      S3.blob(B[0] - fx * 0.020 * s, B[1] - fy * 0.020 * s, B[2] + 0.022 * s,
              headH * 0.80, headH * 0.68, headH * 0.86, this.facing, skinDark, 0.10);

      if (this.human) {
        // Selection ring under the controlled player. A torus, not a quad: a
        // square marker reads as a decal stuck to the floor at this camera
        // angle, where a ring reads as a marker sitting on it.
        S3.ring(this.x, this.y, 0.05, 0.98, MINT, 0.35, 0.22);
      }
    }

    /**
     * Flat side-on preview for the Player Creator, drawn straight into a small
     * 2D canvas. The game itself is fully 3D; this exists because the creator
     * panel is a DOM card with its own canvas and no access to the single
     * WebGL context that belongs to the court. It reads the same pose the 3D
     * body does, so colour and build changes preview accurately.
     *
     * Caller supplies a transform where one unit equals one skeleton unit.
     */
    drawPreview(ctx) {
      const p = this.pose;
      const s = this.bodyScale;

      ctx.save();
      ctx.scale(s, s);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      /**
       * A tapered bar. Canvas strokes are a fixed width, so the taper is drawn
       * as a filled quad with a round cap at each end — the flat equivalent of
       * what the vertex shader does to the 3D limb.
       */
      const bar = (x1, y1, x2, y2, w1, w2, col) => {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(x1 + nx * w1, y1 + ny * w1);
        ctx.lineTo(x2 + nx * w2, y2 + ny * w2);
        ctx.arc(x2, y2, w2, Math.atan2(ny, nx), Math.atan2(-ny, -nx), true);
        ctx.lineTo(x1 - nx * w1, y1 - ny * w1);
        ctx.arc(x1, y1, w1, Math.atan2(-ny, -nx), Math.atan2(ny, nx), true);
        ctx.closePath();
        ctx.fill();
      };
      const dot = (x, y, r, col) => {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      };

      const G = GIRTH;
      const skin = this.skin;
      const shorts = U.shade(this.jerseyMain, -0.08);
      const jersey = this.jerseyMain;

      /* legs: bare and tapered, with the shorts over the top of the thigh */
      for (const side of [-1, 1]) {
        const k = side < 0 ? p.kneeL : p.kneeR;
        const hx = side * BONE.hipW;
        bar(hx, p.hipY, k.jx, k.jy, G.thigh[0], G.thigh[1], skin);
        bar(k.jx, k.jy, k.ex, k.ey, G.calf[0], G.calf[1], skin);
        dot(k.jx, k.jy, G.knee, skin);
        bar(hx, p.hipY,
            hx + (k.jx - hx) * SHORTS_DROP, p.hipY + (k.jy - p.hipY) * SHORTS_DROP,
            G.shortsLeg[0], G.shortsLeg[1], shorts);
        ctx.fillStyle = PAL.chalk;
        ctx.beginPath();
        ctx.ellipse(k.ex + 0.02, k.ey + 0.02, 0.10, 0.045, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      /* torso: waist to chest, plus the shorts seat and waistband */
      bar(0, p.hipY + 0.055, 0, p.shoulderY - 0.055, G.waist, G.chest, jersey);
      bar(0, p.hipY + 0.075, 0, p.hipY - 0.105, G.shortsLeg[0], G.shortsTop, shorts);
      bar(0, p.hipY - 0.075, 0, p.hipY - 0.130, G.shortsTop, G.shortsTop * 0.94,
          this.jerseyTrim);
      bar(-BONE.shoulderW * G.yokeW, p.shoulderY, BONE.shoulderW * G.yokeW, p.shoulderY,
          G.yoke, G.yoke, jersey);

      /* arms: bare, with a jersey cap over the deltoid */
      for (const side of [-1, 1]) {
        const e = side < 0 ? p.elbowL : p.elbowR;
        const sx = side * BONE.shoulderW;
        dot(sx, p.shoulderY, G.deltoid, skin);
        bar(sx, p.shoulderY, e.jx, e.jy, G.upperArm[0], G.upperArm[1], skin);
        bar(e.jx, e.jy, e.ex, e.ey, G.forearm[0], G.forearm[1], skin);
        bar(sx + (e.jx - sx) * SLEEVE_TOP, p.shoulderY + (e.jy - p.shoulderY) * SLEEVE_TOP,
            sx + (e.jx - sx) * SLEEVE_HEM, p.shoulderY + (e.jy - p.shoulderY) * SLEEVE_HEM,
            G.sleeve[0], G.sleeve[1], jersey);
        dot(e.ex, e.ey, 0.05, skin);
      }

      /* head */
      bar(0, p.shoulderY, 0, p.headY + BONE.headR * 0.5, G.neck[0], G.neck[1], skin);
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.ellipse(0, p.headY, BONE.headR * 0.78, BONE.headR, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = U.shade(this.skin, -0.32);
      ctx.beginPath();
      ctx.ellipse(0, p.headY - BONE.headR * 0.10, BONE.headR * 0.76, BONE.headR * 0.92,
                  0, Math.PI * 1.02, Math.PI * 1.98);
      ctx.fill();

      /* jersey trim flash so the second team colour is visible in the panel */
      ctx.fillStyle = this.jerseyTrim;
      ctx.fillRect(-0.10, p.shoulderY + 0.13, 0.20, 0.14);

      ctx.restore();
    }

    /** Small per-player cache so colour strings are parsed once, not per frame. */
    _col(key, css) {
      const c = this._colors || (this._colors = Object.create(null));
      const hit = c[key];
      if (hit && hit.src === css) return hit.v;
      const v = BB.GLX.color(css);
      c[key] = { src: css, v };
      return v;
    }

    /**
     * Computes every joint target for the current action/velocity/timers and
     * solves IK for both knees and elbows. Pure state — draw() only ever
     * reads the result, never recomputes it, so this runs once per
     * simulation tick in update() rather than once per render.
     */
    _updatePose(dt) {
      this._animClock += dt;
      const t = this._animClock;
      const A = ACTION, p = this.pose;

      const speed = Math.hypot(this.vx, this.vy);
      const top = Math.max(this.sprinting ? this.phys.maxSprint : this.phys.maxSpeed, 1);
      const speedFrac = U.clamp01(speed / top);
      const running = speed > 0.35 && !this.jumping;

      // REST_HIP sits below a fully extended leg, so the solver puts a real
      // bend in both knees even when the player is doing nothing. Standing
      // locked out is the single thing that most makes a figure look like a
      // mannequin instead of an athlete waiting for the ball.
      const hipY = -REST_HIP;
      let shoulderY = hipY - BONE.torso;
      // Athletes carry a few degrees of forward lean at rest — weight over the
      // balls of the feet, ready to move, never stacked bolt upright.
      let torsoLean = 0.025;
      let hipLean = null; // null = "follow torsoLean", set explicitly to diverge (real twist)

      let flX = -BONE.hipW, flY = 0;
      let frX = BONE.hipW, frY = 0;
      // Hands hang just inside full extension so the elbows keep a soft bend.
      let hlX = -0.30, hlY = hipY + 0.02;
      let hrX = 0.30, hrY = hipY + 0.02;

      /* ---- locomotion base layer: run cycle, or idle breathing/sway ------ */
      if (running) {
        const phase = this.stridePhase;
        const strideLen = U.lerp(0.17, 0.50, speedFrac);
        const lift = U.lerp(0.055, 0.21, speedFrac);
        const swingL = Math.sin(phase + Math.PI), swingR = Math.sin(phase);

        flX = -BONE.hipW + swingL * strideLen;
        flY = -Math.max(0, swingL) * lift;
        frX = BONE.hipW + swingR * strideLen;
        frY = -Math.max(0, swingR) * lift;

        // The swing runs from a straight trailing arm at the hip up to a
        // sharply bent lead arm at chest height — the range has to stay inside
        // the arm's actual reach or the IK clamps it and both arms lock rigid.
        const armSwing = U.lerp(0.22, 0.58, speedFrac);
        const armPump = U.lerp(0.16, 0.36, speedFrac);
        hlX = -0.30 + Math.sin(phase) * armSwing * 0.46;
        hlY = hipY + 0.12 - Math.max(0, Math.sin(phase)) * armPump;
        hrX = 0.30 + Math.sin(phase + Math.PI) * armSwing * 0.46;
        hrY = hipY + 0.12 - Math.max(0, Math.sin(phase + Math.PI)) * armPump;

        // A touch of vertical bob and stride-linked hip counter-rotation —
        // the shoulders lead a full sprint slightly ahead of the hips.
        shoulderY += Math.abs(Math.sin(phase * 2)) * -0.014 * speedFrac;
        torsoLean = speedFrac * 0.16;
        hipLean = torsoLean - Math.sin(phase) * 0.05 * speedFrac;
      } else if (!this.jumping) {
        const sway = Math.sin(t * 1.15) * 0.024;
        const breathe = Math.sin(t * 0.85) * 0.014;
        const weightShift = Math.sin(t * 0.42) * 0.028; // slow idle weight transfer, knee to knee
        flX += sway + weightShift; frX -= sway - weightShift;
        flY = Math.max(0, -weightShift) * 0.4; frY = Math.max(0, weightShift) * 0.4;
        shoulderY += breathe;
        hlY += Math.sin(t * 1.0 + 1.4) * 0.020;
        hrY += Math.sin(t * 1.0) * 0.020;
      }

      /* ---- defensive stance: crouched, arms spread wide, wider base ------
       * Smoothed so it settles in/out rather than popping. Gated to the
       * neutral running/idle case only (!jumping, no ball) — a jump, shot,
       * or dribble-move overlay below always takes priority regardless of
       * isGuarding, since those all require states this excludes anyway. */
      const guardTarget = (this.isGuarding && !this.jumping && !this.hasBall && !this.isBusyShooting) ? 1 : 0;
      this._guardBlend = U.approach(this._guardBlend, guardTarget, 7, dt);
      let armRoll = 0;
      if (this._guardBlend > 0.001) {
        const g = this._guardBlend;
        shoulderY += g * 0.12;                    // lower center of gravity
        flX -= g * 0.12; frX += g * 0.12;          // wider base
        // Arms spread wide. This one cannot be expressed as an x offset the way
        // the stance can: the solver works in a single flat plane, and draw()
        // sends anything past the IK origin's own x down the FORWARD axis so a
        // run cycle scissors properly. Pushing the hands out through hlX/hrX
        // therefore put one arm in front and one behind. A roll angle tips both
        // arms out of that plane instead, mirrored, which is what a defensive
        // stance actually looks like from the sideline.
        armRoll = g * 0.62;
        torsoLean = (torsoLean || 0) + g * 0.05;   // a touch of alert forward lean
      }

      /* ---- airborne base layer: tuck on the way up, reach on the way down */
      if (this.jumping) {
        const rise = U.clamp01(this.vz / 8);
        const fall = U.clamp01(-this.vz / 10);
        const tuck = rise * 0.30;
        flX = -BONE.hipW * 0.55; flY = -tuck - fall * 0.02;
        frX = BONE.hipW * 0.55; frY = -tuck - fall * 0.02;
      }

      /* ---- dribbling hand: reaches down on the bounce, up on the catch --- */
      if (this.hasBall && !this.isBusyShooting) {
        const c = (Math.cos(this.dribblePhase * Math.PI * 2) + 1) * 0.5; // 1=held high, 0=at the bounce
        hrX = 0.32;
        hrY = U.lerp(hipY + 0.16, hipY - 0.08, c);
        hlX = -0.04; hlY = hipY + 0.04; // guide hand stays close, out of the way
      }

      /* ---- dribble moves: crossover / behind-the-back / spin / hesitation -
       * Each of these now visibly winds the shoulders against the hips
       * (hipLean vs torsoLean) instead of the whole body swinging as one
       * rigid block — that counter-twist is most of what sells a real
       * change-of-direction move rather than just an arm waving sideways. */
      if (this.moveState && this.hasBall) {
        const dur = MOVE_DURATION[this.moveState];
        const k = U.clamp01(this.moveT / dur);
        const dir = this.moveDir;

        if (this.moveState === 'crossover') {
          const sweep = U.ease.inOutSine(k);
          // Lower and sharper than a normal dribble — the ball dips toward
          // the floor at the midpoint of the sweep, the classic low snap.
          const dip = Math.sin(sweep * Math.PI);
          hrX = U.lerp(-0.34 * dir, 0.34 * dir, sweep);
          hrY = hipY + 0.10 + dip * 0.14;
          hlX = -hrX * 0.32; hlY = hipY + 0.30 - dip * 0.06;
          torsoLean = -dip * dir * 0.07;
          hipLean = dip * dir * 0.035; // hips barely move — the fake lives in the shoulders
          shoulderY += dip * 0.03;

        } else if (this.moveState === 'behindBack') {
          const sweep = U.ease.inOutSine(k);
          const dip = Math.sin(sweep * Math.PI);
          // A wider, lower sweep that carries past the hip to read as going
          // around the body, with real torso wind-up against planted hips.
          hrX = U.lerp(-0.40 * dir, 0.44 * dir, sweep);
          hrY = hipY + 0.02 + dip * 0.18;
          hlX = -hrX * 0.28; hlY = hipY + 0.28;
          torsoLean = dip * dir * 0.09;
          hipLean = dip * dir * 0.02;

        } else if (this.moveState === 'spin') {
          // Ball protected in tight to the body for the whole rotation, low
          // and compact, with a deeper knee bend to sell the pivot.
          hrX = 0.11; hrY = hipY + 0.22;
          hlX = -0.15; hlY = hipY + 0.30;
          flX *= 0.42; frX *= 0.42;
          flY -= 0.05; frY -= 0.05;
          // The shoulders lead the turn; hips catch up a beat behind.
          torsoLean = 0;
          hipLean = 0;

        } else if (this.moveState === 'hesitation') {
          if (k < 0.55) {
            // The freeze: a held, deliberately low dribble with a real
            // crouch and a sharper stutter than before.
            const kk = U.clamp01(k / 0.55);
            const stutter = (Math.cos(this._animClock * 16) + 1) * 0.5;
            const crouch = U.ease.outCubic(kk) * 0.14;
            hrX = 0.30; hrY = hipY + 0.02 + stutter * 0.04 + crouch * 0.3;
            hlX = 0.08; hlY = hipY + 0.26;
            flY -= crouch * 0.5; frY -= crouch * 0.5;
            torsoLean = crouch * 0.5;
          } else {
            // The burst: full extension as the player explodes forward,
            // hand climbing back up and out ahead of the body.
            const go = U.ease.outCubic((k - 0.55) / 0.45);
            hrX = U.lerp(0.30, 0.40, go); hrY = U.lerp(hipY + 0.16, hipY + 0.50, go);
            torsoLean = U.lerp(0.07, -0.10, go);
          }
        }
      }

      /* ---- action overrides ---------------------------------------------- */
      if (this.action === A.GATHER) {
        const k = U.clamp01(this.actionT / 0.10);
        // A real gather sinks the hips and pulls the ball in tight to the
        // chest, with a slight backward counter-lean before the drive up.
        flY = U.lerp(flY, -0.05, k); frY = U.lerp(frY, -0.05, k);
        flX = U.lerp(flX, -BONE.hipW * 0.7, k); frX = U.lerp(frX, BONE.hipW * 0.7, k);
        hlX = U.lerp(hlX, -0.14, k); hlY = U.lerp(hlY, hipY - 0.16, k);
        hrX = U.lerp(hrX, 0.14, k); hrY = U.lerp(hrY, hipY - 0.16, k);
        shoulderY += 0.07 * k;
        torsoLean = -0.03 * k;

      } else if (this.action === A.METER) {
        const v = U.clamp01(this.meter.value);
        // Higher release point, arm driven closer to full lockout, a
        // visible forward head/shoulder reach at the top of the motion.
        hrX = U.lerp(0.14, 0.24, v);
        hrY = U.lerp(hipY - 0.14, shoulderY - 0.72, v);
        hlX = U.lerp(-0.14, 0.10, v);
        hlY = U.lerp(hipY - 0.14, shoulderY - 0.36, v);
        if (this.jumping) {
          flX = -0.04; frX = 0.04;
          flY = frY = U.lerp(-0.12, 0.06, v);
        }
        torsoLean = U.lerp(0.02, -0.07, v);

      } else if (this.action === A.RELEASE) {
        const k = U.clamp01(this.actionT / 0.30);
        // Bigger wrist-snap: the hand keeps climbing past the peak, then
        // curls forward/down through the follow-through instead of just
        // holding still — the signature "cookie jar" finish.
        const snap = k < 0.35 ? U.ease.outCubic(k / 0.35) : 1;
        const curl = k > 0.35 ? U.ease.inOutSine((k - 0.35) / 0.65) : 0;
        hrX = U.lerp(0.24, 0.14, curl); hrY = shoulderY - 0.68 - snap * 0.10 + curl * 0.12;
        hlX = -0.04; hlY = shoulderY - 0.44;
        // Toe point — the plant foot stretches down through extension.
        flX = -0.06; frX = 0.06;
        flY = frY = this.jumping ? -0.09 - snap * 0.03 : U.lerp(-0.05, 0.01, k);
        torsoLean = -0.07 - snap * 0.03;

      } else if (this.action === A.LAYUP) {
        const k = U.clamp01(this.actionT / 0.5);
        const kneeUp = this.driving ? 1 : 0.6;

        if (this.layupStyle === 'euro') {
          // Two lateral steps crossing the body before the gather — bigger
          // reach on both plants and real torso counter-rotation between them.
          const step1 = U.clamp01(k / 0.5), step2 = U.clamp01((k - 0.5) / 0.5);
          flX = U.lerp(-0.03, 0.30, step1) - step2 * 0.24;
          flY = -0.13 * (1 - k);
          frX = U.lerp(0.28, -0.14, step1) + step2 * 0.38;
          frY = 0.07 + step2 * 0.15;
          hrX = U.lerp(0.10, 0.34, k); hrY = U.lerp(hipY + 0.24, shoulderY - 0.66, k);
          hlX = -0.24; hlY = shoulderY - 0.08;
          torsoLean = 0.08 - k * 0.13 + Math.sin(k * Math.PI) * 0.08;
          hipLean = torsoLean * 0.5;

        } else if (this.layupStyle === 'hop') {
          // A two-footed jump stop: bigger gather dip, a real hang at the
          // top of the rise before the release.
          const gather = U.clamp01(k / 0.4);
          const rise = U.clamp01((k - 0.4) / 0.6);
          flX = U.lerp(-0.18, -0.09, gather); flY = -0.06 * gather - rise * 0.26;
          frX = U.lerp(0.22, 0.09, gather); frY = -0.06 * gather - rise * 0.26;
          hrX = U.lerp(0.14, 0.32, k); hrY = U.lerp(hipY + 0.20, shoulderY - 0.68, k);
          hlX = -0.18; hlY = shoulderY - 0.10;
          torsoLean = 0.05 - k * 0.12;

        } else {
          // Standard: a much bigger knee drive (the classic finishing
          // silhouette) and a transition from two-hand protection to a
          // one-hand extension right at the rim.
          const oneHand = U.clamp01((k - 0.7) / 0.3);
          flX = -0.03; flY = -0.42 * kneeUp * (1 - k * 0.25);
          frX = 0.24; frY = 0.11 + k * 0.11;
          hrX = U.lerp(0.16, 0.34, k); hrY = U.lerp(hipY + 0.22, shoulderY - 0.68, k);
          hlX = U.lerp(-0.20, -0.30, oneHand); hlY = U.lerp(shoulderY - 0.12, shoulderY - 0.30, oneHand);
          torsoLean = 0.12 - k * 0.17;
        }

      } else if (this.action === A.DUNK) {
        const k = U.clamp01(this.actionT / 0.45);
        const cock = k < 0.55 ? U.ease.outCubic(k / 0.55) : 1;
        const thrust = k > 0.55 ? U.ease.inCubic((k - 0.55) / 0.45) : 0;
        // A much bigger wind-up (the ball goes way back and high) and a full
        // overhead extension on the thrust, off-arm driving up too for a
        // real two-arm power slam silhouette instead of one hand poking up.
        flX = -0.13; flY = -0.40 * (1 - thrust * 0.5);
        frX = 0.13; frY = -0.40 * (1 - thrust * 0.5);
        hrX = U.lerp(0.16, 0.04, thrust);
        hrY = U.lerp(shoulderY - 0.22 - cock * 0.46, shoulderY - 0.95 + thrust * 0.62, thrust);
        hlX = U.lerp(0.06, -0.10, thrust);
        hlY = shoulderY - 0.58 - cock * 0.26 - thrust * 0.30;
        torsoLean = -0.14 - cock * 0.06 - thrust * 0.16;

      } else if (this.action === A.BLOCK) {
        // A real contest has phases, not one held shape: a quick athletic
        // load/plant, an explosive rise to full extension, a sharp swat
        // snap AT THE ACTUAL APEX if it connects (synced to vz, not a
        // guessed time window, so it lines up regardless of how high this
        // particular jump goes), and a landing absorb instead of snapping
        // straight back to neutral.
        const t = this.actionT;
        const landed = !this.jumping;

        const load = landed ? 0 : U.clamp01(1 - t / 0.055);           // brief coil, gone by 55ms
        const rise = U.ease.outCubic(U.clamp01((t - 0.02) / 0.15));    // explosive unfold
        // Swat intensity peaks exactly when vz crosses zero (the true top
        // of the arc) and fades on either side of it - physically synced
        // rather than a fixed time offset, so a high jump and a low jump
        // both swat right at their own peak.
        const swat = (this._blockConnected && !landed)
          ? U.clamp01(1 - Math.abs(this.vz) / 5.5) * U.clamp01(t / 0.10)
          : 0;
        // Absorb the landing over the existing landingTimer window instead
        // of popping straight to a neutral stand.
        const absorb = landed ? U.clamp01((this.landingTimer || 0) / 0.12) : 0;

        const legTuck = landed
          ? 0.05 + absorb * 0.16
          : U.lerp(0.24, 0.15, rise) + load * 0.05;
        flX = -0.09 - load * 0.03; flY = -legTuck;
        frX = 0.09 + load * 0.03; frY = -legTuck;

        const reachY = shoulderY - 0.10 - rise * 0.90 - load * 0.08 + absorb * 0.55;
        const reachX = 0.13 - rise * 0.06;
        hrX = reachX + swat * 0.24; hrY = reachY + swat * 0.34;
        hlX = -reachX - swat * 0.05; hlY = reachY + swat * 0.10;

        torsoLean = 0.05 + load * 0.09 + rise * 0.08 - swat * 0.08 - absorb * 0.10;

      } else if (this.action === A.STEAL) {
        // A quick, grounded lunge — the lead hand darts out low toward the
        // ball while the other arm trails back for balance, front knee
        // driving forward. Nothing goes up in the air here, which is
        // exactly what makes it read as a different move from a block on
        // sight, even at a glance.
        const k = U.clamp01(this.actionT / 0.22);
        const lunge = U.ease.outCubic(Math.min(1, k * 1.9));
        const recover = k > 0.75 ? (k - 0.75) / 0.25 : 0;
        const amt = lunge * (1 - recover * 0.4);
        hrX = 0.14 + amt * 0.40; hrY = hipY + 0.34 - amt * 0.18;
        hlX = -0.24 - amt * 0.06; hlY = hipY + 0.18 + amt * 0.05;
        flX = -0.07 - amt * 0.02; flY = -amt * 0.03;
        frX = 0.14 + amt * 0.16; frY = 0.02;
        torsoLean = 0.20 * amt;

      }

      // Motion-line intensity: how hard the ball hand is snapping right now,
      // and which way — feeds the speed-line effect in _drawBody. Only the
      // genuinely explosive moments get it (a sweep, a burst, a thrust) so
      // it reads as a highlight rather than constant visual noise.
      const handDX = hrX - (this._prevHrX == null ? hrX : this._prevHrX);
      const handDY = hrY - (this._prevHrY == null ? hrY : this._prevHrY);
      this._prevHrX = hrX; this._prevHrY = hrY;
      let smearBoost = 0;
      if (this.moveState === 'crossover' || this.moveState === 'behindBack') smearBoost = 1;
      else if (this.moveState === 'hesitation' && this.moveT / MOVE_DURATION.hesitation > 0.55) smearBoost = 1;
      else if (this.action === A.DUNK && this.actionT / 0.45 > 0.55) smearBoost = 1;
      p.handSmear = p.handSmear || {};
      p.handSmear.dx = -handDX; p.handSmear.dy = -handDY;
      p.handSmear.intensity = dt > 0 ? U.clamp01(Math.hypot(handDX, handDY) / dt * 0.10) * smearBoost : 0;

      p.hipY = hipY;
      p.shoulderY = shoulderY;
      p.armRoll = armRoll;
      p.headY = shoulderY - BONE.neck - this.armRaise * 0.05;
      p.torsoLean = torsoLean;
      p.hipLean = hipLean == null ? torsoLean : hipLean;
      p.footL.x = flX; p.footL.y = flY;
      p.footR.x = frX; p.footR.y = frY;
      p.handL.x = hlX; p.handL.y = hlY;
      p.handR.x = hrX; p.handR.y = hrY;

      solveIK2(-BONE.hipW, hipY, flX, flY, BONE.thigh, BONE.shin, 1, p.kneeL);
      solveIK2(BONE.hipW, hipY, frX, frY, BONE.thigh, BONE.shin, -1, p.kneeR);
      solveIK2(-BONE.shoulderW, shoulderY, hlX, hlY, BONE.upperArm, BONE.forearm, -1, p.elbowL);
      solveIK2(BONE.shoulderW, shoulderY, hrX, hrY, BONE.upperArm, BONE.forearm, 1, p.elbowR);
    }
  }

  const TMP_V = { x: 0, y: 0, z: 0 };
  const TMP_MOVE = { x: 0, y: 0, mag: 0 };

  /* Scratch world points for draw(). Shared across every player because the
   * whole figure is submitted synchronously inside one draw() call. */
  const TMP_P0 = [0, 0, 0], TMP_P1 = [0, 0, 0], TMP_P2 = [0, 0, 0];
  const TMP_P3 = [0, 0, 0], TMP_P4 = [0, 0, 0];

  /* The body's axes, scale and squash for one player for one frame. Shared,
   * because a figure is always placed synchronously inside one call. */
  const FRAME = {
    x: 0, y: 0, z: 0, s: 1, squash: 1, stretch: 1, fx: 1, fy: 0, rx: 0, ry: -1
  };

  /**
   * Pose space -> world feet. The pose solver works in a single flat plane with
   * the foot at 0 and up as negative; this is the one place that decides how
   * that plane maps onto a body standing on a court, so the ball can ask where
   * a hand ended up without duplicating the transform and drifting from it.
   *
   * @param {number[]} out
   * @param {object} f a FRAME filled by Player#_frame
   * @param {number} lx local x from the solver
   * @param {number} ly local y (negative is up)
   * @param {number} baseX the x the limb's IK origin used, so `lx - baseX` is
   *        pure motion and can be sent down the forward axis
   * @param {number} width lateral offset in local units (right axis)
   * @param {number} lean shear applied to this layer
   * @param {number} [roll] radians to tip this point about the FORWARD axis
   *        running through `rollUp`, which swings a limb out sideways without
   *        touching its fore/aft motion. Signed: positive rolls toward the
   *        player's right. Being a rotation it preserves bone lengths exactly —
   *        the solver's flat plane cannot express a limb leaving it, and
   *        anything sent through `lx` instead comes out as forward motion.
   * @param {number} [rollUp] height the roll pivots about, in up-units
   */
  function posePoint(out, f, lx, ly, baseX, width, lean, roll, rollUp) {
    let up = -ly * f.stretch;
    let side = width;
    if (roll) {
      const dUp = up - rollUp;
      up = rollUp + dUp * Math.cos(roll);
      side = width - dUp * Math.sin(roll);
    }
    const fwd = (lx - baseX) + up * lean;
    out[0] = f.x + (fwd * f.fx + side * f.rx) * f.s * f.squash;
    out[1] = f.y + (fwd * f.fy + side * f.ry) * f.s * f.squash;
    out[2] = f.z + up * f.s;
    return out;
  }

  /** Point `t` of the way from world point a to world point b. */
  function mixPt(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }

  const LEGS = [{ side: -1 }, { side: 1 }];
  const ARMS = [{ side: -1 }, { side: 1 }];
  const MINT = [0.133, 0.894, 0.627, 0.85];

  Player.ACTION = ACTION;
  /* Exposed so tools/preview_player.js can measure the built figure against
   * real anatomical proportions rather than trusting the constants by eye. */
  Player.BONE = BONE;
  Player.GIRTH = GIRTH;
  Player.RATING_KEYS = RATING_KEYS;
  Player.TENDENCY_KEYS = TENDENCY_KEYS;
  Player.computeOverall = computeOverall;
  Player.defaultRatings = defaultRatings;
  Player.derivePhysical = derivePhysical;

  BB.Player = Player;
})(typeof window !== 'undefined' ? window : globalThis);
