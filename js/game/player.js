/* =============================================================================
 * player.js  —  The on-court athlete.
 * -----------------------------------------------------------------------------
 * A Player owns three things: RATINGS (25-99 attributes that never change
 * during a game), STATE (position, velocity, action) and PRESENTATION (a small
 * vector figure drawn fresh every frame — there is no sprite art in this
 * project, so the body is built from primitives the same way park.js draws
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

  /* Reference stature in skeleton units. Every pose offset in this file is
   * hand-tuned against this scale, so it stays fixed even when the build
   * underneath it changes. */
  const REF_STATURE = 8 * HU;

  /**
   * Adopts a skinned mesh's own proportions.
   *
   * The table above is a drawn figure's build. A real mesh has its own, and if
   * the two disagree the skinning has to stretch bones to reconcile them — this
   * model's thighs were coming out 28% longer than the mesh was modelled with
   * and its hips 45% wider, which is most of why the figure looked wrong no
   * matter how good the animation driving it was. Taking the mesh's landmarks
   * as the skeleton means almost nothing has to stretch at all.
   *
   * Landmarks are fractions of stature, so they scale onto whatever reference
   * height the pose constants were tuned against.
   */
  function adoptMeshBuild(L) {
    if (!L) return;
    const S = REF_STATURE;
    // Legs are measured from the FLOOR, not the ankle: the solver's foot target
    // is the ground contact, and draw() lifts the mesh's ankle back up into the
    // shoe afterwards.
    BONE.shin = L.knee * S;
    BONE.thigh = (L.hip - L.knee) * S;
    BONE.torso = (L.shoulder - L.hip) * S;
    BONE.neck = (L.headCenter - L.shoulder) * S;
    BONE.headR = (L.crown - L.headCenter) * S;
    BONE.upperArm = L.upperArm * S;
    BONE.forearm = L.forearm * S;
    BONE.hipW = L.hipW * S;
    BONE.shoulderW = L.shoulderW * S;
    BONE.stance = L.hipW * 1.30 * S;
  }
  adoptMeshBuild(BB.PLAYER_MESH && BB.PLAYER_MESH.landmarks);

  /**
   * How far the toe sits in front of the ankle, in skeleton units.
   *
   * The foot is the one bone the pose solver has to know the shape of. Rolling
   * up onto the toe at push-off means lifting the ankle by exactly the toe's
   * own length times the sine of the roll — do it by any other number and the
   * shoe either hovers or sinks through the blacktop. Read off the same bind
   * skeleton draw() places the mesh with, so the two cannot drift apart.
   */
  BONE.toe = (function () {
    const M = BB.PLAYER_MESH;
    if (!M || !M.bind || !M.bind.footL) return 0.16;
    return (-M.bind.footL[1][1] / M.height) * REF_STATURE;
  })();

  /* Limbs do not hang in a vertical plane straight off the joint they start at.
   * These are each joint's lateral offset as a fraction of the limb's root
   * width. The pose solver can't express any of this itself: it works in a
   * single flat plane, and everything past the IK origin's own x becomes
   * forward motion so that a run cycle scissors properly.
   *
   * The arm numbers are measured against the mesh rather than chosen by eye.
   * This body is half a stature wide through the ribs (torso radius 0.100 of
   * stature) and its shoulder joints sit at 0.109, so an arm pulled even
   * slightly inboard of its own shoulder buries the humerus inside the
   * ribcage: the earlier 0.84/0.74 put the elbow at 0.091 and the wrist at
   * 0.081, both well inside a chest that reaches 0.100 — which is why the
   * arms read as melted into the jersey and tore the deltoid open. Hanging
   * them all but straight down off the joint, converging only slightly, keeps
   * the limb outside the torso with its surface just brushing it. */
  /* How fast a shooter squares up to the basket, in "fraction closed per
   * second". Fixed rather than scaled off the player's agility: squaring up
   * for a jump shot is not an athletic feat, and scaling it would mean the
   * least agile builds are the ones left shooting sideways. From facing dead
   * away this is within seven degrees of square by the end of the gather,
   * which is the earliest a shot can possibly be released. */
  const SQUARE_UP = 32;

  const SPLAY = {
    elbow: 1.06, wrist: 1.02,
    knee: 1.08, ankle: 1.23
  };

  /* How far from the rim a sprinting drive can still take off for a layup, in
   * feet. A real drive leaves the floor outside the restricted area (4ft) and
   * covers the rest in the air, so this has to be comfortably past it or the
   * shots that most want to be layups come out as jump shots. */
  const LAYUP_TAKEOFF = 11;

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
      // Which haircut, out of the shells baked into the mesh. The scalp is
      // always there; the style is the volume sitting on top of it.
      this.hairStyle = cfg.hairStyle || 'fade';
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
      /* Defence. `guardHeld` is the key; `isGuarding` is whether the stance is
       * actually up (which also needs a man with the ball to guard). Quality is
       * how good the position is right now, 0..1, and lockedT how long it has
       * been good for — that pair is what the ring under the feet is drawn
       * from and what the "LOCKED UP" call is earned with. */
      this.guardHeld = false;
      this.defenseQuality = 0;
      this.lockedT = 0;
      this._lockShown = 0;
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
        hipY: 0, shoulderY: 0, headY: 0, torsoLean: 0, hipLean: 0, armRoll: 0, armTuck: 0,
        // `side` is a lateral foot offset, across the body rather than along
        // the forward axis — the shuffle of a defensive slide, which cannot be
        // expressed in the solver's single flat plane.
        footL: { x: 0, y: 0, pitch: 0, side: 0 },
        footR: { x: 0, y: 0, pitch: 0, side: 0 },
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
    handAt(out, side) {
      out = out || { x: 0, y: 0, z: 0 };
      const p = this.pose, f = this._frame();
      const s = side < 0 ? -1 : 1;           // the shooting hand by default
      const el = s < 0 ? p.elbowL : p.elbowR;
      const w = s * BONE.shoulderW;
      const lean = p.torsoLean * 0.45 + this.lean * 0.16;
      posePoint(TMP_P0, f, el.ex, el.ey, w,
                w * SPLAY.wrist * (1 - p.armTuck), lean,
                s * p.armRoll, -p.shoulderY * f.stretch);
      out.x = TMP_P0[0]; out.y = TMP_P0[1]; out.z = TMP_P0[2];
      return out;
    }

    /**
     * Where the drawn foot is, in world feet. The leg counterpart to handAt,
     * and the only way to tell whether a planted foot is actually staying put
     * rather than sliding along under the player.
     */
    footAt(side, out) {
      out = out || { x: 0, y: 0, z: 0 };
      const p = this.pose, f = this._frame();
      const knee = side < 0 ? p.kneeL : p.kneeR;
      const w = side * BONE.hipW;
      const lean = p.hipLean * 0.45 + this.lean * 0.16;
      posePoint(TMP_P0, f, knee.ex, knee.ey, w, side * BONE.stance, lean);
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

    /**
     * Where the shot meter hangs: the spot on the floor this player is over.
     *
     * Not the hand. The hand is where the ball leaves from, which is calibrated
     * against the true-scale ten-foot rim and sits around nine feet up — and it
     * climbs for the whole rise, and again for the jump. Hanging the bar off it
     * put the bar up level with the backboard and slid it upward while the
     * player was trying to time it. The floor under the shooter is the one
     * point that holds still for the length of a shot, and it is where the
     * shooter is looking anyway.
     */
    meterAnchor(out) {
      out = out || { x: 0, y: 0, z: 0 };
      out.x = this.x; out.y = this.y; out.z = 0;
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
      /* Two players cannot both be holding it. Every path that changes hands
       * in the live game — a steal, a block, a rebound — clears the loser's
       * flag itself, so this has never bitten; it is here because a flag that
       * contradicts ball.owner silently disables everything downstream that
       * asks "am I on the ball", including the whole defensive read. */
      const prev = ball.owner;
      if (prev && prev !== this) prev.hasBall = false;
      ball.hold(this);
      this.hasBall = true;
      this._dribbleLive = true;
      // Hands come down to take it. Taking possession is never the follow
      // through of a shot, and the decay in updatePostShot would otherwise
      // leave the ball floating at the release point for a moment first —
      // which on a made basket is the exact moment the player is looking.
      this.armRaise = 0;
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

      /* Move relative to the CAMERA, not to the court's axes.
       *
       * W used to mean "toward court -y" whatever the camera was doing, which
       * only lines up with the screen for a rig parked on the sideline. Under
       * the forward rig — looking down the floor, with the court's length
       * running INTO the screen — W walked the player sideways and A/D pushed
       * them toward and away from the camera.
       *
       * The rig's own basis, flattened onto the floor, is the fix: W drives
       * away from the camera and D drives to the right of frame, whichever rig
       * is running and wherever it has swung to. The sideline rigs come out
       * exactly as they were, because their forward already IS court -y.
       */
      const cam = BB.Camera;
      let fx = cam.fwd[0], fy = cam.fwd[2];      // GL z is court y
      const fl = Math.hypot(fx, fy) || 1;
      fx /= fl; fy /= fl;
      let rx = cam.right[0], ry = cam.right[2];
      const rl = Math.hypot(rx, ry) || 1;
      rx /= rl; ry /= rl;

      // moveVector gives +x for right and -y for up the screen.
      this.intentX = rx * v.x - fx * v.y;
      this.intentY = ry * v.x - fy * v.y;
      this.intentMag = v.mag;

      if (this.hasBall && !this.isBusyShooting) {
        if (input.pressed('shoot')) this._beginShot();
      }

      /* Same physical keys as pass/lob double as steal/block on defense —
       * there is nobody to pass to while you don't have the ball. */
      // Held, not tapped: the stance is a thing you stay in.
      this.guardHeld = !!input.down('intense');

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
      // No sprinting out of a stance, and a slide is a shade slower than a run.
      const sprinting = this.sprinting && !this.isGuarding;
      /* Guarded, and going at them. A live defender right in front of you takes
       * better than a third off the top end and a fifth off the first step, so
       * a drive into good position is a wrestle rather than a straight line —
       * which, with a defender who only gives up 8% of their own top end to
       * hold the stance, is what makes staying in front possible at all. */
      const pressure = this.pressure();
      const top = (sprinting ? this.phys.maxSprint : this.phys.maxSpeed) * gassed *
                  (this.isGuarding ? 0.92 : 1) * (1 - pressure * 0.40);
      const targetVx = ix * top;
      const targetVy = iy * top;

      /* A defensive slide is not a run. It gives up a little top-end — you
       * cannot sprint out of a stance — and buys back quicker changes of
       * direction, which is what actually keeps you in front of somebody:
       * staying with a handler is won on the first step after they move, not
       * on how fast you can go in a straight line. */
      const slide = this.isGuarding ? 1 : 0;
      const accel = (mag > 0.02 ? this.phys.accel : this.phys.decel) *
                    (1 + slide * 0.55) * (1 - pressure * 0.22);
      this.vx = U.moveToward(this.vx, targetVx, accel * dt);
      this.vy = U.moveToward(this.vy, targetVy, accel * dt);

      const speed = Math.hypot(this.vx, this.vy);
      this.lean = U.approach(this.lean, U.clamp01(speed / top) * (mag > 0.02 ? 1 : 0), 6, dt);

      /* Squaring up.
       *
       * A jump shot is taken AT the rim. From the moment the gather starts the
       * shoulders turn to the basket and stay there for the length of the
       * shot, whatever the feet are doing — the stick still steers where the
       * player goes, it just stops steering which way they are pointed. Left
       * to the movement code, holding a direction through the release let a
       * shot go up sideways or with the shooter's back to the basket.
       *
       * Layups and dunks are deliberately not included: a drive finishes at
       * whatever angle it attacked from, and the euro step and the hop step
       * ARE angles. */
      const squaring = this.targetHoop != null &&
        (this.action === ACTION.GATHER || this.action === ACTION.METER) &&
        (this.shotType === 'jumper' || this.shotType === 'freethrow');

      /* In a stance you stay square to the man. Turning your back on a ball
       * handler is the one thing defence never does, and it is what the
       * movement code would otherwise do the moment you slid sideways. */
      const foe = this.isGuarding ? this._ballRef && this._ballRef.owner : null;
      const marking = foe && foe !== this ? foe : null;

      if (this.moveState === 'spin') {
        const k = U.clamp01(this.moveT / MOVE_DURATION.spin);
        this.facing = U.angleLerp(this._spinFromFacing, this._spinToFacing, U.ease.outCubic(k));
      } else if (squaring) {
        const aim = Math.atan2(this.targetHoop.y - this.y, this.targetHoop.x - this.x);
        this.facing = U.angleLerp(this.facing, aim, U.clamp01(SQUARE_UP * dt));
        // Still track where they are steering, so the run cycle underneath
        // reads the feet correctly the moment the shot is over.
        if (mag > 0.15) this.moveFacing = Math.atan2(iy, ix);
      } else if (marking) {
        /* Locked on, not merely turning towards. A stance points at the man
         * and the stick only decides where you slide — you never present a
         * shoulder, let alone your back, whatever direction you are moving.
         *
         * Turning towards him at a rate, however fast, is not the same thing:
         * a handler who changes direction hard is asking the defender to turn
         * faster than any rate would allow, and every degree of lag is a
         * degree of the floor they have won. moveFacing keeps tracking the
         * stick underneath, which is what the slide gait in _updatePose reads
         * to shuffle the feet sideways instead of scissoring them. */
        this.facing = Math.atan2(marking.y - this.y, marking.x - this.x);
        if (mag > 0.15) this.moveFacing = Math.atan2(iy, ix);
      } else if (mag > 0.15) {
        this.moveFacing = Math.atan2(iy, ix);
        this.facing = U.angleLerp(this.facing, this.moveFacing, U.clamp01(this.phys.turnRate * dt));
      } else if (this.hasBall && this.pivotTarget != null) {
        this.facing = U.angleLerp(this.facing, this.pivotTarget, U.clamp01(this.phys.turnRate * 1.6 * dt));
      }

      if (speed > 0.05) this._advanceStride(speed, top, dt);
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

      /* Re-aim the lock after the step, not before it. Everything above works
       * off where the body was at the top of the tick, so a defender sliding
       * hard came out of the frame a degree or two off the man — small, but
       * it is the difference between a lock and a very fast turn, and it is
       * free to take back here. */
      if (marking) this.facing = Math.atan2(marking.y - this.y, marking.x - this.x);

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

      /* Moving does NOT overwrite a shot.
       *
       * This line used to force ACTION.MOVE on any tick with movement intent,
       * which clobbered GATHER and METER the frame after they were set. Press
       * shoot while running and the shot began, was overwritten before the
       * meter could tick once, and nothing happened — no attempt, no release,
       * the ball still in hand. Holding sprint made it look like sprint was
       * the culprit; standing still was the only way to shoot at all.
       *
       * A finish already returns before reaching here (see the top of this
       * method); this covers the wind-up and the follow-through. */
      if (!this.isBusyShooting && this.action !== ACTION.RELEASE) {
        this.action = mag > 0.05 ? ACTION.MOVE : ACTION.IDLE;
      }
    }

    /**
     * Advances the stride by GROUND COVERED, not by elapsed time.
     *
     * A time-based rate has no relationship to how fast the body is actually
     * travelling, so the planted foot slides backwards under the player and
     * the whole run reads as skating. Tying phase to distance makes a foot
     * stay where it was put: each foot sweeps twice the stride amplitude while
     * it is down, and it is down for `stance` of the cycle, so a cycle has to
     * carry the body 2 * stride / stance for the contact to hold still.
     */
    _advanceStride(speed, top, dt) {
      const g = gaitOf(speed);
      const perCycle = Math.max(0.35, (2 * g.stride / g.stance) * this.bodyScale);
      this.stridePhase += (speed * dt / perCycle) * Math.PI * 2;
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
    /**
     * How well this player is guarding `foe` right now, 0..1.
     *
     * Four things, and they are the four things a coach shouts: be close, be
     * between them and the basket, be square to them, and be in a stance.
     * Being ON them is not the same as being close — inside about a yard is a
     * foul waiting to happen and reads as reaching rather than as position, so
     * the closeness term falls away again at the bottom.
     */
    guardQuality(foe) {
      if (!foe || foe === this) return 0;
      const hoop = foe.targetHoop || foe.fixedHoop || U.nearestHoop(foe.x);
      if (!hoop) return 0;

      const d = U.dist(this.x, this.y, foe.x, foe.y);
      /* Close is good; ON TOP of them is where it stops helping.
       *
       * The second term used to start punishing at 2.1 feet and bottom out at
       * 1.0, which graded a defender pressed right up into the handler at 0.58
       * while one standing three feet off scored 0.90. Two feet is not too
       * close to guard somebody, it is exactly where you want to be — the
       * penalty belongs where bodies are genuinely tangled and the handler can
       * simply step through you. */
      const near = U.clamp01(U.remap(d, 8.5, 2.8, 0, 1)) *
                   U.clamp01(U.remap(d, 0.55, 1.25, 0.45, 1));
      if (near <= 0) return 0;

      // On the line from the ball to the rim they are attacking.
      const toRim = Math.atan2(hoop.y - foe.y, hoop.x - foe.x);
      const toMe = Math.atan2(this.y - foe.y, this.x - foe.x);
      const online = U.clamp01(1 - Math.abs(U.angleDelta(toRim, toMe)) / 1.25);

      // Square to them, not turned around watching the ball go by.
      const off = Math.abs(U.angleDelta(Math.atan2(foe.y - this.y, foe.x - this.x), this.facing));
      const square = U.clamp01(1 - off / 1.4);

      const stance = this.isGuarding ? 1 : 0.5;
      const skill = U.remap(this.ratings.perimeterDefense, 25, 99, 0.82, 1.08);
      /* Multiplied, not added up.
       *
       * Weighted terms summed together gave a defender who had been blown by
       * completely — trailing on the wrong side of the man, with the whole
       * floor open in front of him — better than half marks, because the
       * closeness and the squareness still paid out in full. Being between
       * your man and the basket is not one contribution among three: if you
       * are not there you are not guarding anybody, and everything else is
       * worth a fraction of what it would otherwise be. */
      return U.clamp01(near * (0.15 + online * 0.85) * (0.55 + square * 0.45) *
                       stance * skill);
    }

    /**
     * How hard this player is being guarded RIGHT NOW, 0..1. Zero for anybody
     * who does not have the ball.
     *
     * The point of it is that good defensive position has to cost the handler
     * something on the floor, not only on the shot. A defender who graded well
     * and then watched the ball go past them at full speed was a scoreboard,
     * not an obstacle.
     *
     * Directional, because a defender is only in the way if they are in the
     * way: the same man at the same distance behind you as you drive away is
     * not guarding anything, and slowing you down for it would make beating
     * somebody feel worse than being stuck in front of them.
     */
    pressure() {
      if (!this.hasBall) return 0;
      const d = this.opponent;
      if (!d || !d.defenseQuality) return 0;
      const dist = U.dist(this.x, this.y, d.x, d.y);
      // Full weight from about two and a half feet, which is where a defender
      // is actually on you rather than merely near you.
      const close = U.clamp01(U.remap(dist, 6.0, 2.4, 0, 1));
      if (close <= 0) return 0;
      const heading = this.intentMag > 0.05
        ? Math.atan2(this.intentY, this.intentX) : this.facing;
      const toDef = Math.atan2(d.y - this.y, d.x - this.x);
      const inPath = U.clamp01(1 - Math.abs(U.angleDelta(heading, toDef)) / 1.35);
      return U.clamp01(d.defenseQuality * close * inPath);
    }

    /**
     * Runs every tick for every player. Decides whether the stance is up, how
     * good the position is, and how long it has been good for.
     */
    _updateDefense(dt, ball) {
      const foe = ball && ball.owner;
      const onBall = !!(foe && foe !== this && !this.hasBall);

      // A human is only in a stance while they are holding the key for it. The
      // AI's scene sets isGuarding for itself and is left alone.
      if (this.human) this.isGuarding = !!(this.guardHeld && onBall);

      const q = onBall ? this.guardQuality(foe) : 0;
      // Smoothed, because this drives something drawn on the floor and a raw
      // per-tick number flickers.
      this.defenseQuality = U.approach(this.defenseQuality, q, 6, dt);

      if (this.defenseQuality > 0.70 && this.isGuarding) this.lockedT += dt;
      else this.lockedT = Math.max(0, this.lockedT - dt * 2.5);
      if (this._lockShown > 0) this._lockShown -= dt;

      /* Sustained, not momentary. Standing in the right place for a frame is
       * luck; holding it for well over a second while they try to get past is
       * the thing worth saying out loud. */
      if (this.human && this.lockedT > 1.2 && this._lockShown <= 0) {
        this._lockShown = 4.0;
        this.events.emit('lockdown', { by: this, on: foe, quality: this.defenseQuality });
      }
    }

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
      /* Real position is worth something. A defender who is in a stance, on
       * the line and square gets credit for it here, which is where a contest
       * turns into a lower percentage — otherwise holding the stance would be
       * a costume rather than defence. */
      const stanceBonus = (d.defenseQuality || 0) * 0.22;
      return U.clamp01(proximity * skill + jumpBonus + stanceBonus);
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

      /* Sprinting at the rim and pressing shoot is a LAYUP. Not a dice roll,
       * not a jumper that happens to be taken close in — the one move the
       * whole drive was for.
       *
       * Three conditions, all of them things the player can feel: they are
       * sprinting, they are still carrying real speed, and they are pointed at
       * the basket rather than drifting past it. LAYUP_TAKEOFF is how far out
       * a takeoff can still cover — a drive is launched from outside the
       * restricted area and floats in, so the old "within five feet" test
       * turned exactly the shots that should be layups into jump shots. */
      const toHoop = Math.atan2(hoop.y - this.y, hoop.x - this.x);
      const headingAtRim = speed > 0.5 &&
        Math.abs(U.angleDelta(toHoop, Math.atan2(this.vy, this.vx))) < 1.0;
      const attacking = headingAtRim && dHoop <= LAYUP_TAKEOFF &&
        (this.sprinting ? speed > this.phys.maxSpeed * 0.55    // holding sprint: take their word for it
                        : speed > this.phys.maxSpeed * 0.85);  // otherwise they have to really be moving

      this.targetHoop = hoop;
      this.action = ACTION.GATHER;
      this.actionT = 0;
      this.armRaise = 0;
      this._shotFouled = false;

      if (attacking || close) {
        /* A dunker still throws one down, but only with the rim right there.
         * Past that the finish is a layup, so a drive from the free-throw line
         * cannot come out as a standing dunk on a coin flip. */
        const atRim = dHoop <= C.RESTRICTED_R * 0.9;
        const wantsDunk = atRim && U.rng.chance(this.phys.dunkChance * (driving ? 1 : 0.55));
        this.shotType = wantsDunk ? 'dunk' : 'layup';
        this.driving = driving || attacking;

        // Finishing style: a euro step reads from driving at an angle across
        // the direct line to the rim (stepping around a defender); a hop
        // step reads from driving straight at the rim with a defender right
        // there to gather up against. Both are purely presentational — the
        // shot math is unchanged — but they make a defended finish look and
        // feel distinct from an open lane.
        this.layupStyle = 'standard';
        if (this.shotType === 'layup' && driving) {
          const velAngle = Math.atan2(this.vy, this.vx);
          const angleDiff = Math.abs(U.angleDelta(toHoop, velAngle));
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
          // A driving layup leaves the floor harder than a standing one —
          // that lift is what carries a takeoff from outside the paint all
          // the way under the rim.
          if (this.shotType === 'layup') this._startJump(this.driving ? 0.88 : 0.7);
          if (this.shotType === 'dunk') this._startJump(1.0);
          const p = this.meterAnchor(TMP_V);
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

      this.meter.setAnchor(this.meterAnchor(TMP_V));
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
      } else if (this.armRaise > 0) {
        /* Nothing is driving the arms any more, so put them down.
         *
         * Left alone, armRaise simply stopped wherever the release animation
         * abandoned it — about 0.135 every time, because RELEASE hands over to
         * IDLE on a half-second timer rather than on the arm reaching the
         * bottom, and no other branch touches it again until the NEXT shot
         * starts. handPosition() reads anything above 0.05 as "still shooting"
         * and answers with the release point, which is calibrated against the
         * true-scale ten-foot rim rather than against the figure. So from the
         * first jump shot onward the ball hung two and a half feet above that
         * player's head and never bounced again — loudest on a make, where the
         * ball comes straight back to the scorer for the check. */
        this.armRaise = U.approach(this.armRaise, 0, 7, dt);
        if (this.armRaise < 0.004) this.armRaise = 0;
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
      this._updateDefense(dt, ball);
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

      /* The ball rides in the hand right up to the launch — INCLUDING through
       * the gather, the meter and the rise.
       *
       * It used to stop tracking the moment a shot began, which on a set jump
       * shot nobody could see: the shooter barely moves between the gather and
       * the release. On a drive it is glaring. The player takes off from ten
       * feet out, sails in toward the rim, and the ball hangs in the air back
       * where he left the floor until it teleports into his hand to launch.
       * `_fireBall` clears ownership, so this stops on its own the instant the
       * shot is actually away. */
      if (this.hasBall && ball.owner === this) {
        if (this.isBusyShooting) {
          /* Winding up, the ball sits in the hand that is DRAWN.
           *
           * handPosition() answers with the release point instead, which is
           * deliberately calibrated against the true-scale ten-foot rim rather
           * than against the figure — the shot arc is computed from it. The
           * figure is compressed to about five feet, so those two answers sit
           * a couple of feet apart, and carrying the ball at the second one
           * floats it above the player's head for the whole gather and rise.
           * Gameplay still launches from the release point; only the carry
           * moved. */
          const h = this.handAt(TMP_V);
          ball.place(h.x, h.y, h.z + C.BALL_RADIUS * 0.5);
        } else {
          const p = this.handPosition(TMP_V);
          ball.place(p.x, p.y, p.z);
        }
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
      const S3 = BB.S3, Skin = BB.Skin;
      const p = this.pose;
      const f = this._frame();

      const sp = S3.skinnedPose();
      if (!sp) return;
      Skin.beginPose(sp);

      /* Lean tips the whole figure along its forward axis, exactly as the 2D
       * shear transform used to; hip and torso lean stay separate so a
       * crossover can still wind the shoulders against planted hips. */
      const leanF = this.lean * 0.16;
      const hipLean = p.hipLean * 0.45 + leanF;
      const torsoLean = p.torsoLean * 0.45 + leanF;

      const A = TMP_P0, B = TMP_P1, D = TMP_P2, E = TMP_P3, F = TMP_P4;

      /* Model units to world feet. The mesh is authored at its own stature, so
       * everything scales off the ratio between that and the posed figure. */
      const statP = -p.headY + BONE.headR;
      const g = (statP * f.s) / Skin.height;
      const ref = REF_DIR;
      ref[0] = f.fx; ref[1] = f.fy; ref[2] = 0;

      /* -------------------------------------------------------- centreline
       * The spine bones are baked at fixed fractions of the model's height, so
       * the runtime places them by measuring the same fractions along the posed
       * body rather than by guessing which joint each one belongs to. Hip and
       * shoulder are the two known points; everything else rides that line and
       * therefore inherits the lean and the crouch for free. */
      posePoint(HIP, f, 0, p.hipY, 0, 0, hipLean);
      posePoint(SHO, f, 0, p.shoulderY, 0, 0, torsoLean);
      const hipH = -p.hipY / statP;
      const span = (-p.shoulderY / statP) - hipH;
      const spineAt = (out, h) => mixPt(out, HIP, SHO, span > 1e-6 ? (h - hipH) / span : 0);

      for (const name of SPINE_BONES) {
        const seg = Skin.bind[name];
        spineAt(A, seg[0][2] / Skin.height);
        spineAt(B, seg[1][2] / Skin.height);
        /* The head does not ride the lean.
         *
         * Every other bone on this line inherits the hip-to-shoulder tilt,
         * which is right for a spine and wrong for a neck: a sprinter's chest
         * pitches a long way forward but the eyes stay level and on the play,
         * and the neck is what takes the difference back out. Left following
         * the spine, the face at full tilt is aimed at the floor five feet
         * ahead. The base stays welded to the top of the torso and only the
         * crown swings back over it, so nothing detaches. */
        if (name === 'head') uprightHead(A, B);
        Skin.setBone(sp, name, A, B, ref, g);
      }

      /* ------------------------------------------------------------- legs
       * The solver's foot target sits on the floor, but the mesh's ankle is a
       * few inches up inside the shoe, so the shin has to stop short of the
       * ground or the whole foot sinks through it. */
      const ankleUp = Skin.bind.footL[0][2] * g;
      const toeFwd = -Skin.bind.footL[1][1] * g;
      const toeDrop = (Skin.bind.footL[0][2] - Skin.bind.footL[1][2]) * g;
      for (const leg of LEGS) {
        const knee = leg.side < 0 ? p.kneeL : p.kneeR;
        const foot = leg.side < 0 ? p.footL : p.footR;
        const sfx = leg.side < 0 ? 'L' : 'R';
        const w = leg.side * BONE.hipW;
        /* The slide's lateral step. The hip stays put and the foot goes out,
         * with the knee taking a little over half of it so the leg reads as
         * one limb rather than a shin swinging off a static thigh. */
        const out = foot.side || 0;
        posePoint(A, f, 0, p.hipY, 0, w, hipLean);
        posePoint(B, f, knee.jx, knee.jy, w, w * SPLAY.knee + out * 0.55, hipLean);
        posePoint(D, f, knee.ex, knee.ey, w, leg.side * BONE.stance + out, hipLean);
        D[2] += ankleUp;

        /* The foot pitches about the ankle: toe down through push-off, toe up
         * to clear the floor and land heel-first. _updatePose has already put
         * the matching lift into the ankle target, so through push-off the
         * contact point stays exactly where it was planted and the heel is
         * what comes up. */
        const pitch = foot.pitch || 0;
        const cp = Math.cos(pitch), sp2 = Math.sin(pitch);
        const outFwd = toeFwd * cp - toeDrop * sp2;
        const outUp = -toeFwd * sp2 - toeDrop * cp;

        E[0] = D[0] + f.fx * outFwd;
        E[1] = D[1] + f.fy * outFwd;
        E[2] = D[2] + outUp;

        Skin.setBone(sp, 'thigh' + sfx, A, B, ref, g);
        Skin.setBone(sp, 'shin' + sfx, B, D, ref, g);
        Skin.setBone(sp, 'foot' + sfx, D, E, ref, g);
      }

      /* ------------------------------------------------------------- arms */
      const handLen = dist3(Skin.bind.handL[0], Skin.bind.handL[1]) * g;
      for (const arm of ARMS) {
        const el = arm.side < 0 ? p.elbowL : p.elbowR;
        const sfx = arm.side < 0 ? 'L' : 'R';
        const w = arm.side * BONE.shoulderW;
        const roll = arm.side * p.armRoll;
        const pivot = -p.shoulderY * f.stretch;
        // The elbows come in about half as far as the hands do, which is what
        // a real player does carrying a ball in two hands: wrists together,
        // elbows still out either side of it.
        const tuckW = 1 - p.armTuck;
        const tuckE = 1 - p.armTuck * 0.45;

        /* The third axis.
         *
         * The solver works in ONE flat plane per limb pair, and everything
         * lateral has been mirrored: armRoll rotates both arms out by the same
         * angle in opposite directions, so whatever it does to one hand it
         * does to the other. That is fine for a stance and useless for a jump
         * shot, where the whole point is that the two hands are doing
         * DIFFERENT things — one under the ball, one on the side of it.
         *
         * `side` is a per-hand lateral offset off the plane entirely, exactly
         * the mechanism the feet already carry for the defensive slide. The
         * elbow follows at a fraction of it so the forearm swings across
         * rather than the wrist detaching from it. */
        const hand = arm.side < 0 ? p.handL : p.handR;
        const out = hand.side || 0;
        /* A hand may reach the centreline. It may not cross to the far side.
         *
         * Tuck and `side` both pull inward, and nothing stopped them summing
         * past zero — so with both spent on the same shot the left hand came
         * out right of centre and the right hand left of it, forearms folded
         * horizontally into an X across the face for the whole motion. It
         * reads as broken because it IS anatomically impossible, not because
         * the numbers were merely large.
         *
         * Clamped here rather than by tuning each pose down, because every
         * pose that ever wants tuck and side together would otherwise have to
         * rediscover the same limit, and the one that forgets ships the X. A
         * small allowance past centre stays, since a real guide hand does
         * cross slightly onto the ball. */
        const cross = BONE.shoulderW * 0.14;
        const keep = (lat) => (arm.side < 0 ? Math.min(lat, cross) : Math.max(lat, -cross));
        posePoint(A, f, 0, p.shoulderY, 0, w, torsoLean);
        posePoint(B, f, el.jx, el.jy, w, keep(w * SPLAY.elbow * tuckE + out * 0.42), torsoLean, roll, pivot);
        posePoint(D, f, el.ex, el.ey, w, keep(w * SPLAY.wrist * tuckW + out), torsoLean, roll, pivot);

        // The solver stops at the wrist; the hand carries on the way the
        // forearm was already pointing.
        let dx = D[0] - B[0], dy = D[1] - B[1], dz = D[2] - B[2];
        const L = Math.hypot(dx, dy, dz) || 1;
        F[0] = D[0] + (dx / L) * handLen;
        F[1] = D[1] + (dy / L) * handLen;
        F[2] = D[2] + (dz / L) * handLen;

        /* Palm twist.
         *
         * The mesh is bound in an A-pose with the arms held out and the palms
         * turned back. Bringing one down to the hip is a big swing, and a real
         * arm does not make it rigidly: the forearm rotates internally on the
         * way down so the palm ends up facing the thigh. This rig has no wrist
         * and no twist bone, so the hand kept whatever facing the bind gave it
         * and the palms pointed backwards in every hanging pose.
         *
         * `ref` is what pins rotation about a bone's own length, so spinning
         * the hand's copy of it about the forearm axis IS the twist — one
         * rotation, no new bone, and it costs nothing when the angle is zero. */
        Skin.setBone(sp, 'upperArm' + sfx, A, B, ref, g);
        Skin.setBone(sp, 'forearm' + sfx, B, D, ref, g);
        const tw = (hand.twist == null ? 0 : hand.twist) * arm.side;
        Skin.setBone(sp, 'hand' + sfx, D, F, tw ? spin(ref, dx / L, dy / L, dz / L, tw, HREF) : ref, g);
      }

      /* ------------------------------------------------------------- kit
       * The OBJ shipped an empty material library, so tools/rig_model.js tagged
       * every vertex with a zone instead and the team's colours are applied
       * here, per zone, at draw time. */
      const z = this._zones || (this._zones = [
        [0, 0, 0, 1, 0.16, 0], [0, 0, 0, 1, 0.10, 0], [0, 0, 0, 1, 0.06, 0],
        [0, 0, 0, 1, 0.25, 0], [0, 0, 0, 1, 0.08, 0], [0, 0, 0, 1, 0.15, 0]
      ]);
      copyCol(z[0], this._col('skin', this.skin));
      copyCol(z[1], this._col('jersey', this.jerseyMain));
      copyCol(z[2], this._col('shorts', U.shade(this.jerseyMain, -0.08)));
      copyCol(z[3], this._col('shoe', PAL.chalk));
      // The player's own hair colour, not a darkened skin tone. The creator
      // has offered seven of them since the day it shipped and every one of
      // them landed on the floor: this zone was painted from `skin`, so a
      // black-haired player and a blond one came out identical.
      /* A shaved head is the one style with no shell to draw, so it has to be
       * done in colour: paint the scalp with the skin tone (a shade down, the
       * way a fresh shave actually reads) instead of the hair colour. Every
       * other style leaves the scalp as hair and lets its shell add the
       * volume. */
      copyCol(z[4], this.hairStyle === 'bald'
        ? this._col('scalp', U.shade(this.skin, -0.10))
        : this._col('hair', this.hair || U.shade(this.skin, -0.42)));
      /* Zone 5 is the face. It was declared as the jersey trim and then never
       * used — the rigger emitted nothing in it — so the slot was free for the
       * brows, eyes and mouth, which need a colour of their own that is not
       * the hair (a face is not a haircut) and not the skin (or it vanishes).
       * Derived from the skin tone rather than fixed, so it stays a face on
       * every complexion instead of two black dots on a dark one. */
      copyCol(z[5], this._col('face', U.shade(this.skin, -0.52)));
      Skin.setZones(sp, z);
      sp.hairStyle = this.hairStyle;
      // The number on the back. Clamped because the glyph table only holds 0-99.
      sp.number = U.clamp(Math.round(this.number || 0), 0, 99);

      if (this.human) {
        // Selection ring under the controlled player. A torus, not a quad: a
        // square marker reads as a decal stuck to the floor at this camera
        // angle, where a ring reads as a marker sitting on it.
        S3.ring(this.x, this.y, 0.05, 0.98, MINT, 0.35, 0.22);
      }

      /* How the defence is going, drawn on the floor where the player is
       * already looking — at their own feet and the man in front of them.
       *
       * A second ring outside the selection one, which grows and brightens
       * with the quality of the position and goes gold once it has been held
       * long enough to count. This is the only readout: no number, no bar off
       * in a corner, because what it is describing is where the body is
       * standing and that is the thing being watched.
       *
       * Controlled player only. Every player on the floor computes a quality
       * — the contest maths reads it off the AI too — but ten rings lit up at
       * once is wallpaper, and this one is feedback on what YOU are doing. */
      if (this.human && this.defenseQuality > 0.05) {
        const q = this.defenseQuality;
        const locked = U.clamp01(this.lockedT / 1.2);
        const col = lerpCol(GUARD_COL, LOCK_COL, locked);
        /* S3.ring draws opaque, so the strength of the position has to be
         * carried by the colour itself: a weak stance sits dark against the
         * blacktop and a good one burns. */
        const lift = 0.45 + q * 0.55;
        col[0] *= lift; col[1] *= lift; col[2] *= lift;
        S3.ring(this.x, this.y, 0.04, 1.18 + q * 0.42, col, 0.3, 0.20);
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
      let hipY = -REST_HIP;
      let shoulderY = hipY - BONE.torso;
      // Athletes carry a few degrees of forward lean at rest — weight over the
      // balls of the feet, ready to move, never stacked bolt upright.
      let torsoLean = 0.025;
      let hipLean = null; // null = "follow torsoLean", set explicitly to diverge (real twist)
      let pitchL = 0, pitchR = 0;

      /* Every hand target below is written as THIS HAND'S OWN SHOULDER plus an
       * offset, never as a bare number.
       *
       * draw() sends whatever is left after subtracting the arm's own shoulder
       * x down the player's FORWARD axis, so a pair of hand targets at -0.30
       * and +0.30 is not a symmetric pose at all: with the shoulder joints at
       * ±0.20 it hangs the left hand a fifth of a unit behind the body and the
       * right hand the same distance in front of it. Anchoring on the shoulder
       * is what makes a symmetric pose come out symmetric, and it is why a
       * figure that was meant to be standing still no longer stands like it is
       * mid-stumble. */
      const shL = -BONE.shoulderW, shR = BONE.shoulderW;

      let flX = -BONE.hipW, flY = 0;
      let frX = BONE.hipW, frY = 0;
      // Lateral foot displacement, off the solver's plane entirely. Only the
      // slide writes it; everything else leaves the feet under the hips.
      let sideL = 0, sideR = 0;
      /* Hands hang just inside full extension so the elbows keep a soft bend —
       * and far enough inside it to survive the idle bob. At 0.96 the breathing
       * sway added below pushed the resting hand past the arm's actual reach
       * every few seconds, and a target the solver has to clamp draws a locked
       * straight arm with the elbow gone. */
      let hlX = shL, hlY = reachY(shoulderY, 0.93);
      let hrX = shR, hrY = reachY(shoulderY, 0.93);

      /* ---- locomotion base layer: run cycle, or idle breathing/sway ------ */
      if (running) {
        const phase = this.stridePhase;
        const gait = gaitOf(speed);

        /* The body rises through the float and sinks through mid-stance, twice
         * a cycle — and hips and shoulders move together, because a bob
         * applied to the shoulders alone is not a bob at all, it is the spine
         * concertinaing. Anchored on mid-stance (half of stance into the
         * cycle) so it stays in step when the stance fraction changes with
         * speed. */
        const bob = -U.lerp(0.004, 0.026, speedFrac)
                  * Math.cos(phase * 2 - Math.PI * 2 * gait.stance);
        hipY += gait.crouch - bob;   // pose y is negative for up
        shoulderY = hipY - BONE.torso;

        // Each leg walks a stance-then-swing cycle, half a period apart.
        // A plain sine on both axes cannot describe a run: it sends the
        // planted foot backwards and then forwards again while it is still on
        // the floor, so the foot has to slide no matter how the phase is
        // driven. During stance the foot tracks straight back at exactly the
        // rate the body moves forward, which is what leaves it standing still
        // on the blacktop.
        stepFoot(STEP_L, phase + Math.PI, gait);
        stepFoot(STEP_R, phase, gait);

        /* Which way the body is travelling relative to which way it is
         * pointed. Normally these are the same thing and this is a no-op, but
         * a defender locked onto their man — and a shooter squaring up on the
         * move — travel one way while facing another, and the stride has to
         * know the difference or the figure moonwalks: feet scissoring
         * forwards while the body slides sideways.
         *
         * `along` is signed, so backing up back-pedals for free rather than
         * running on the spot. */
        const rel = U.angleDelta(this.facing, this.moveFacing);
        const along = Math.cos(rel);
        // posePoint's `width` axis is the facing direction turned -90 degrees,
        // so the rightward component of the heading carries a minus sign.
        const lateral = -Math.sin(rel);

        flX = -BONE.hipW + STEP_L.x * along; flY = STEP_L.y; pitchL = STEP_L.pitch;
        frX = BONE.hipW + STEP_R.x * along; frY = STEP_R.y; pitchR = STEP_R.pitch;

        /* The shuffle. One foot reaches out the way the body is going while
         * the other pushes and recovers, and they never cross — cross your
         * feet in a slide and you are beaten. Capped below the width of the
         * stance for that reason, which also keeps the sideways displacement
         * small enough that the leg's true 3D length barely changes: the
         * solver works in the flat plane and knows nothing about this axis. */
        const shuffle = U.clamp(lateral * gait.stride * 1.15,
                                -BONE.stance * 0.8, BONE.stance * 0.8);
        sideR = shuffle * Math.sin(phase);
        sideL = -sideR;

        /* Arms swing as pendulums from the shoulder, on an arc rather than up
         * and down a line: the hand travels forward AND rises as it comes
         * through, which is the shape the eye actually reads as an arm
         * swinging. The elbow keeps a real bend throughout because the hand
         * rides at a fraction of full reach — driving it out past full reach
         * makes the IK clamp, and a clamped arm is a straight arm, frozen.
         *
         * cos, not sin: the left arm hits its front stop at the same instant
         * the right foot hits its own, which is what contralateral means. A
         * quarter-cycle out and the figure looks like it is being puppeted. */
        /* The hand climbs as it comes forward and falls as it goes back —
         * from past the hip behind to chest height in front, in one monotone
         * sweep.
         *
         * It used to swing the whole arm as a rigid pendulum about the
         * shoulder, so the hand rode a circular arc: level at both ends and
         * DIPPING half a foot in the middle. Measured, the hand finished the
         * forward swing two inches higher than it started the back one, which
         * is not an arm swing, it is a pair of hands paddling. What the eye
         * reads as running is the diagonal — low and back, high and forward —
         * and the elbow folding tight at the front and opening out behind
         * comes out of that shape for free, because the hand is close to the
         * shoulder at one end of it and far away at the other. */
        const swL = Math.cos(phase), swR = -swL;
        const amp = U.lerp(0.09, 0.30, speedFrac);      // fore and aft, pose units
        const carry = U.lerp(0.52, 0.47, speedFrac);    // hand height at mid-swing
        const rise = U.lerp(0.08, 0.27, speedFrac);     // how much higher in front
        const drop = 0.02;                              // and how much lower behind
        const high = carry - rise, low = carry + drop;
        const hL = U.lerp(low, high, U.ease.inOutSine((swL + 1) * 0.5));
        const hR = U.lerp(low, high, U.ease.inOutSine((swR + 1) * 0.5));
        hlX = shL + swL * amp; hlY = shoulderY + hL;
        hrX = shR + swR * amp; hrY = shoulderY + hR;

        torsoLean = speedFrac * 0.16;
        hipLean = torsoLean - Math.cos(phase) * 0.04 * speedFrac;
      } else if (!this.jumping) {
        const sway = Math.sin(t * 1.15) * 0.024;
        const breathe = Math.sin(t * 0.85) * 0.014;
        const weightShift = Math.sin(t * 0.42) * 0.028; // slow idle weight transfer, knee to knee
        flX += sway + weightShift; frX -= sway - weightShift;
        // The unweighted foot comes up off the floor, never down through it:
        // pose y is negative for up, so a positive lift here buries the shoe.
        flY = -Math.max(0, -weightShift) * 0.4; frY = -Math.max(0, weightShift) * 0.4;
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
      /* Per-hand lateral offset, off the pose plane. Zero for everything that
       * wants the old mirrored behaviour; the shot and the carry set it. */
      let hlSide = 0, hrSide = 0;
      /* Palm rotation about the forearm, mirrored per side. The resting value
       * turns the palms in toward the thighs, which is where a hanging arm
       * actually leaves them; poses that need a different palm say so. */
      let hlTwist = 0.85, hrTwist = 0.85;
      let armRoll = 0;
      /* How far the arms are drawn in toward the body's centreline, 0..1.
       *
       * The pose solver works in ONE flat plane per limb pair and the lateral
       * offset is a constant applied at draw time, so left and right hands are
       * always a shoulder-width apart however the plane is posed. That is fine
       * for everything except the one thing a basketball player does most: put
       * both hands on the same ball. armRoll cannot close it either — it is a
       * rotation about shoulder height, so it barely moves a hand that is AT
       * shoulder height and it shortens the ones that are not. */
      let armTuck = 0;
      if (this._guardBlend > 0.001) {
        const g = this._guardBlend;
        // Lower centre of gravity. The whole upper body sinks — hips, shoulders
        // and the hands riding off them — because dropping the shoulders alone
        // does not crouch a figure, it shortens its spine by a fifth.
        const drop = g * 0.12;
        hipY += drop; shoulderY += drop;
        hlY += drop; hrY += drop;
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

        /* The active hand. A stance with both arms held out symmetrically is a
         * scarecrow; what defence actually looks like is one hand out wide and
         * the other reaching in at the ball, jabbing at it and pulling back.
         *
         * The lead hand goes FORWARD, which in the pose plane is straight at
         * whoever is being guarded, because the stance turns the body to face
         * them. It reaches to the height the ball is actually being carried
         * at, and how far it commits scales with how close the ball is — you
         * do not swipe at a ball ten feet away. */
        const b = this._ballRef;
        const foe = b && b.owner;
        if (foe && foe !== this) {
          const d = U.dist(this.x, this.y, foe.x, foe.y);
          const commit = g * U.clamp01(U.remap(d, 6.5, 2.0, 0, 1));
          if (commit > 0.001) {
            // Ball height, in this figure's own units, off its own shoulder.
            const ballUp = U.clamp((this.z + 2.6 - b.z) / Math.max(this.bodyScale, 0.01),
                                   -0.30, 0.55);
            // A jab: the hand works at the ball rather than hanging there.
            const jab = 0.055 * Math.sin(this._animClock * 5.2);
            /* Where the hand wants to be: out in front, at the height the ball
             * is being carried. Both offsets are measured from the shoulder,
             * so they can be capped together — an arm cannot reach a long way
             * forward AND a long way down at the same time, and asking it to
             * would only get the whole limb clamped straight by the solver. */
            let fwd = 0.50 + jab;
            let up = ballUp;
            const cap = (BONE.upperArm + BONE.forearm) * 0.93;
            const len = Math.hypot(fwd, up);
            if (len > cap) { const s = cap / len; fwd *= s; up *= s; }
            /* Blended by commitment rather than scaled by it. Scaling the
             * offsets shortened the reach twice over — once here and again
             * through the blend — and left the hand tucked against the ribs at
             * exactly the range where the ball is worth reaching for. */
            hrX = U.lerp(hrX, shR + fwd, commit);
            hrY = U.lerp(hrY, shoulderY + up, commit);
            // And the off hand drops out of the way, palm down, walling off
            // the drive rather than mirroring the reach.
            hlX = shL + commit * 0.10;
            hlY = U.lerp(hlY, shoulderY + 0.34, commit * 0.6);
            armRoll = g * U.lerp(0.62, 0.40, commit);
          }
        }
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
        hrX = shR + 0.11;                          // ball works out in front of the hip
        hrY = U.lerp(reachY(shoulderY, 0.99), reachY(shoulderY, 0.72), c);
        hlX = shL + 0.09; hlY = reachY(shoulderY, 0.94); // guide hand close, out of the way
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
          const sweepX = U.lerp(-0.28 * dir, 0.28 * dir, sweep);
          hrX = shR + sweepX;
          hrY = hipY + 0.10 + dip * 0.14;
          hlX = shL - sweepX * 0.32; hlY = hipY + 0.30 - dip * 0.06;
          torsoLean = -dip * dir * 0.07;
          hipLean = dip * dir * 0.035; // hips barely move — the fake lives in the shoulders
          shoulderY += dip * 0.03;

        } else if (this.moveState === 'behindBack') {
          const sweep = U.ease.inOutSine(k);
          const dip = Math.sin(sweep * Math.PI);
          // A wider, lower sweep that carries past the hip to read as going
          // around the body, with real torso wind-up against planted hips.
          const sweepX = U.lerp(-0.34 * dir, 0.38 * dir, sweep);
          hrX = shR + sweepX;
          hrY = hipY + 0.02 + dip * 0.18;
          hlX = shL - sweepX * 0.28; hlY = hipY + 0.28;
          torsoLean = dip * dir * 0.09;
          hipLean = dip * dir * 0.02;

        } else if (this.moveState === 'spin') {
          // Ball protected in tight to the body for the whole rotation, low
          // and compact, with a deeper knee bend to sell the pivot.
          hrX = shR + 0.02; hrY = hipY + 0.22;
          hlX = shL + 0.06; hlY = hipY + 0.30;
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
            hrX = shR + 0.10; hrY = hipY + 0.02 + stutter * 0.04 + crouch * 0.3;
            hlX = shL + 0.12; hlY = hipY + 0.26;
            flY -= crouch * 0.5; frY -= crouch * 0.5;
            torsoLean = crouch * 0.5;
          } else {
            // The burst: full extension as the player explodes forward,
            // hand climbing back up and out ahead of the body.
            const go = U.ease.outCubic((k - 0.55) / 0.45);
            hrX = shR + U.lerp(0.10, 0.22, go); hrY = U.lerp(hipY + 0.16, hipY + 0.50, go);
            torsoLean = U.lerp(0.07, -0.10, go);
          }
        }
      }

      /* ---- action overrides ---------------------------------------------- */
      if (this.action === A.GATHER) {
        const k = U.clamp01(this.actionT / 0.10);
        // A real gather sinks the hips and pulls the ball in tight to the
        // chest, with a slight backward counter-lean before the drive up. Both
        // hands are on it from here until the release.
        flY = U.lerp(flY, -0.05, k); frY = U.lerp(frY, -0.05, k);
        flX = U.lerp(flX, -BONE.hipW * 0.7, k); frX = U.lerp(frX, BONE.hipW * 0.7, k);
        hlX = U.lerp(hlX, shL + 0.13, k); hlY = U.lerp(hlY, reachY(shoulderY, 0.60), k);
        hrX = U.lerp(hrX, shR + 0.15, k); hrY = U.lerp(hrY, reachY(shoulderY, 0.60), k);
        armTuck = 0.55 * k;
        armRoll = 0.10 * k;
        hipY += 0.07 * k;
        shoulderY += 0.07 * k;
        torsoLean = 0.04 * k;

      } else if (this.action === A.METER && this.shotType === 'layup') {
        /* The rise on a layup, held on the meter.
         *
         * This used to be the jump-shot pose: a driving finish squared up in
         * mid-air, both hands over the head, feet together — the one shot in
         * basketball that is never taken that way. A layup is asymmetric all
         * the way through, and the shape reads before you have named it: the
         * inside knee drives up hard, the trailing leg extends behind, the
         * ball goes up on one side of the body away from the defender, the
         * off hand comes off the ball, and the whole thing leans in toward
         * the rim rather than sitting back off it. */
        const v = U.clamp01(this.meter.value);
        const rise = U.ease.outCubic(v);
        const drive = this.driving ? 1 : 0.72;

        // Knee drive and trailing leg — the engine of the finish.
        flX = -BONE.hipW + 0.10 * rise;
        flY = -0.46 * drive * rise;
        frX = BONE.hipW - 0.16 * rise;
        frY = 0.05 + 0.16 * rise;

        // Ball up on the shooting side, off hand peeling away as it goes.
        hrX = shR + U.lerp(0.10, 0.20, rise);
        hrY = U.lerp(hipY + 0.16, shoulderY - 0.56, rise);
        hlX = shL + U.lerp(0.12, 0.00, rise);
        hlY = U.lerp(hipY + 0.06, shoulderY + 0.10, rise);
        armRoll = 0.24 * (1 - rise);      // two hands on it early, one late

        torsoLean = U.lerp(0.16, 0.03, rise);
        hipLean = torsoLean * 0.4;
        shoulderY -= 0.05 * rise;         // stretch up through the finish

      } else if (this.action === A.METER) {
        /* The jump shot, in the two beats a jump shot actually has.
         *
         * It used to be one straight sweep from the waist to full extension
         * with the guide hand trailing a third of an arm's length below the
         * shooting hand the entire way. Two hands on one ball cannot be a foot
         * and a half apart, and a figure holding them that way reads as
         * somebody whose shoulder has come out of its socket.
         *
         * SET: both hands carry the ball up together to a real set point —
         * wrist just above the shoulder, ball out in front of the forehead,
         * shooting elbow bent under it and the guide hand on its side.
         * EXTEND: only then does the shooting arm drive up, and the guide hand
         * comes off the ball and stays where it was rather than following.
         *
         * The offsets are the two arm bones, not taste: with a 1.45HU upper arm
         * and a 1.30HU forearm, a wrist 0.24 in front of the shoulder and 0.16
         * above it puts the elbow 0.31 forward and 0.14 down — under the ball,
         * forearm all but vertical, which is the whole shape. Nothing here
         * passes the arm's reach; a target the IK has to clamp comes out as a
         * locked, poker-straight arm. */
        const v = U.clamp01(this.meter.value);
        const set = U.ease.outCubic(U.clamp01(v / 0.55));
        const ext = U.ease.inOutSine(U.clamp01((v - 0.55) / 0.45));

        const setRX = U.lerp(0.13, 0.24, set);
        /* The ball rides ABOVE the brow, not across the eyes.
         *
         * The set used to finish with the hands 0.16 above the shoulder, which
         * on this figure is mouth height — so the gather played with two hands
         * over the face and the head vanished behind them. In the reference
         * the ball is at the forehead by the top of the set and clears the
         * head on the way up, which is what leaves a shooter able to see the
         * rim they are shooting at.
         *
         * Both hands rise by the same 0.14, so the gap between them — which
         * has to stay inside one ball, and the suite checks it — is a pure
         * translation and cannot change. */
        const setRY = U.lerp(reachY(shoulderY, 0.60), shoulderY - 0.30, set);
        const setLX = U.lerp(0.13, 0.21, set);
        const setLY = U.lerp(reachY(shoulderY, 0.60), shoulderY - 0.27, set);

        hrX = shR + U.lerp(setRX, 0.15, ext);
        hrY = U.lerp(setRY, shoulderY - 0.52, ext);
        hlX = shL + U.lerp(setLX, 0.17, ext);
        hlY = U.lerp(setLY, shoulderY - 0.20, ext);

        // Hands together on the ball through the set, then opening back out a
        // little as the shooting arm goes up over the shooting-side eye rather
        // than over the middle of the head.
        /* Now that a hand can leave the plane on its own, the shape stops
         * being a mirror. The guide hand comes ACROSS onto the side of the
         * ball; the shooting hand stays just inside its own shoulder so the
         * ball finishes over the shooting eyebrow rather than over the middle
         * of the head. armTuck used to have to do this job by pulling BOTH
         * hands toward the centreline, which is what put them in front of the
         * face — with a real lateral axis it barely has to do anything. */
        hlSide = U.lerp(0.03, 0.085, set) * (1 - ext * 0.30);
        hrSide = U.lerp(-0.01, -0.035, set);
        armTuck = U.lerp(0.28, 0.42, set) * (1 - ext * 0.42);
        armRoll = U.lerp(0.08, 0.16, set);

        if (this.jumping) {
          flX = -BONE.hipW + 0.02; frX = BONE.hipW + 0.02;
          flY = frY = U.lerp(-0.12, 0.06, v);
        }
        // Close to upright. The old backward lean at the top of every shot was
        // a fadeaway, and a fadeaway is not the default jump shot.
        torsoLean = U.lerp(0.04, -0.02, v);

      } else if (this.action === A.RELEASE) {
        /* The follow-through, and it HOLDS.
         *
         * The old one curled the whole hand back down a third of the way to
         * the shoulder as it finished, which is an arm collapsing, not a
         * follow-through. A shooter's arm stays where the ball left it and
         * reaches out after it; what comes down is the wrist alone.
         *
         * There is no wrist joint in this skeleton — the hand carries on in
         * whatever direction the forearm was already pointing — so the snap is
         * drawn by pushing the wrist forward at height, which tips the whole
         * forearm out over the shot. That is as close to fingers-in-the-cookie
         * -jar as a two-bone arm gets, and it is the right shape from every
         * angle the camera ever sees it from. */
        const k = U.clamp01(this.actionT / 0.30);
        const snap = U.ease.outCubic(U.clamp01(k / 0.30));
        const relax = k > 0.45 ? U.ease.inOutSine((k - 0.45) / 0.55) : 0;

        /* Every one of these is inside the arm's reach on purpose. The rig
         * clamps a target it cannot get to, and a clamped arm comes out
         * locked poker-straight with the elbow gone — which is exactly the
         * thing this whole change is about. Full extension here is nine
         * tenths of the way out, not ten. */
        hrX = shR + U.lerp(0.15, 0.24, snap) - relax * 0.03;
        hrY = shoulderY - U.lerp(0.52, 0.49, snap) - relax * 0.02;
        // The guide hand is left up around where the ball was, not dropped.
        hlX = shL + U.lerp(0.17, 0.21, relax);
        hlY = shoulderY - U.lerp(0.20, 0.15, relax);
        // The guide hand comes off the ball sideways as the shot leaves, which
        // is the separation the eye reads as a release rather than a push.
        hlSide = U.lerp(0.08, 0.15, relax);
        hrSide = -0.03;
        armTuck = 0.24 * (1 - relax * 0.35);
        armRoll = 0.16;
        // Toe point — the plant foot stretches down through extension.
        flX = -BONE.hipW; frX = BONE.hipW;
        flY = frY = this.jumping ? -0.09 - snap * 0.03 : U.lerp(-0.05, 0.01, k);
        torsoLean = -0.02 - snap * 0.02;

      } else if (this.action === A.LAYUP) {
        /* The finish, from the instant the meter is let go.
         *
         * The rise above already carried the body up; this picks the figure up
         * exactly where that left it rather than starting a new pose from
         * nothing, which is what made the old layup snap. Three beats: the
         * ball leaves the hand off the fingertips (the wrist flips at 0.22s,
         * which is when _fireBall runs), the arm hangs at full extension for a
         * moment, and then the knee comes down and the body squares up to
         * land. */
        const k = U.clamp01(this.actionT / 0.5);
        const kneeUp = this.driving ? 1 : 0.6;
        const flip = U.clamp01(this.actionT / 0.22);      // fingertips let go
        const down = U.clamp01((this.actionT - 0.26) / 0.34);  // gather to land

        if (this.layupStyle === 'euro') {
          // Two lateral steps crossing the body before the gather — bigger
          // reach on both plants and real torso counter-rotation between them.
          const step1 = U.clamp01(k / 0.5), step2 = U.clamp01((k - 0.5) / 0.5);
          flX = U.lerp(-0.03, 0.30, step1) - step2 * 0.24;
          flY = -0.13 * (1 - k);
          frX = U.lerp(0.28, -0.14, step1) + step2 * 0.38;
          frY = 0.07 + step2 * 0.15;
          hrX = shR + U.lerp(-0.02, 0.16, k); hrY = U.lerp(hipY + 0.24, shoulderY - 0.66, k);
          hlX = shL + 0.02; hlY = shoulderY - 0.08;
          torsoLean = 0.08 - k * 0.13 + Math.sin(k * Math.PI) * 0.08;
          hipLean = torsoLean * 0.5;

        } else if (this.layupStyle === 'hop') {
          // A two-footed jump stop: bigger gather dip, a real hang at the
          // top of the rise before the release.
          const gather = U.clamp01(k / 0.4);
          const rise = U.clamp01((k - 0.4) / 0.6);
          flX = U.lerp(-0.18, -0.09, gather); flY = -0.06 * gather - rise * 0.26;
          frX = U.lerp(0.22, 0.09, gather); frY = -0.06 * gather - rise * 0.26;
          hrX = shR + U.lerp(0.02, 0.14, k); hrY = U.lerp(hipY + 0.20, shoulderY - 0.68, k);
          hlX = shL + 0.06; hlY = shoulderY - 0.10;
          torsoLean = 0.05 - k * 0.12;

        } else {
          /* The driving finish. Continues the rise: knee still up, trailing
           * leg still extended, ball laid up off the fingers — then the legs
           * come back under the body to land. */
          flX = -BONE.hipW + 0.10 - 0.10 * down;
          flY = -0.46 * kneeUp * (1 - down * 0.92);
          frX = BONE.hipW - 0.16 + 0.16 * down;
          frY = (0.21 - 0.21 * down) * (1 - down * 0.5);

          // Full extension, then the wrist rolls over the ball and the arm
          // rides back down as the body comes out of the air.
          const reach = shoulderY - 0.56 - 0.02 * flip;
          hrX = shR + U.lerp(0.20, 0.26, flip) - 0.20 * down;
          hrY = U.lerp(reach, reachY(shoulderY, 0.70), down);
          hlX = shL + 0.00 + 0.10 * down;
          hlY = U.lerp(shoulderY + 0.10, reachY(shoulderY, 0.80), down);
          armRoll = 0;

          torsoLean = 0.03 + 0.06 * down;
          hipLean = torsoLean * 0.4;
        }

      } else if (this.action === A.DUNK) {
        const k = U.clamp01(this.actionT / 0.45);
        const cock = k < 0.55 ? U.ease.outCubic(k / 0.55) : 1;
        const thrust = k > 0.55 ? U.ease.inCubic((k - 0.55) / 0.45) : 0;
        // A much bigger wind-up (the ball goes way back and high) and a full
        // overhead extension on the thrust, off-arm driving up too for a
        // real two-arm power slam silhouette instead of one hand poking up.
        flX = -BONE.hipW - 0.03; flY = -0.40 * (1 - thrust * 0.5);
        frX = BONE.hipW - 0.03; frY = -0.40 * (1 - thrust * 0.5);
        hrX = shR + U.lerp(-0.06, 0.10, thrust);
        hrY = U.lerp(shoulderY - 0.22 - cock * 0.46, shoulderY - 0.95 + thrust * 0.62, thrust);
        hlX = shL + U.lerp(0.10, 0.04, thrust);
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
        flX = -BONE.hipW + 0.01 - load * 0.03; flY = -legTuck;
        frX = BONE.hipW + 0.01 + load * 0.03; frY = -legTuck;

        const reachY = shoulderY - 0.10 - rise * 0.90 - load * 0.08 + absorb * 0.55;
        // Straight overhead as the arms extend, so a contest is a wall rather
        // than one hand in front of the face and one behind the head.
        const reachX = 0.04 - rise * 0.03;
        hrX = shR + reachX + swat * 0.26; hrY = reachY + swat * 0.34;
        hlX = shL + reachX - swat * 0.05; hlY = reachY + swat * 0.10;

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
        hrX = shR + 0.02 + amt * 0.42; hrY = hipY + 0.34 - amt * 0.18;
        hlX = shL - 0.04 - amt * 0.06; hlY = hipY + 0.18 + amt * 0.05;
        flX = -BONE.hipW + 0.03 - amt * 0.02; flY = -amt * 0.03;
        frX = BONE.hipW + 0.04 + amt * 0.16; frY = 0.02;
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
      p.armTuck = armTuck;
      p.headY = shoulderY - BONE.neck - this.armRaise * 0.05;
      p.torsoLean = torsoLean;
      p.hipLean = hipLean == null ? torsoLean : hipLean;
      p.footL.x = flX; p.footL.y = flY; p.footL.pitch = pitchL; p.footL.side = sideL;
      p.footR.x = frX; p.footR.y = frY; p.footR.pitch = pitchR; p.footR.side = sideR;
      p.handL.side = hlSide; p.handR.side = hrSide;
      p.handL.twist = hlTwist; p.handR.twist = hrTwist;
      p.handL.x = hlX; p.handL.y = hlY;
      p.handR.x = hrX; p.handR.y = hrY;

      /* The bend flag picks which of the two mirror-image IK solutions to
       * take, and BOTH legs take the same one, as do both arms.
       *
       * Mirroring it left-to-right is only correct in a flat front-on view,
       * where left and right limbs really are mirrored across the screen. In
       * this solver's plane the axis is the player's FORWARD, not their left,
       * so a mirrored flag does not mirror anything — it points one knee where
       * it belongs and puts the other one in backwards, which is the reversed,
       * bird-legged knee and the elbow folded the wrong way across the chest.
       *
       * -1 for legs puts the knee ahead of the hip-to-ankle line and +1 for
       * arms puts the elbow behind the shoulder-to-wrist line, which is the
       * only way either joint goes. Being fore/aft, both are direction-aware
       * for free: the same +1 that keeps a hanging elbow behind the arm also
       * carries it out in front once the hand goes up over the head, exactly
       * as a real elbow travels through a jump shot. */
      solveIK2(-BONE.hipW, hipY, flX, flY, BONE.thigh, BONE.shin, -1, p.kneeL);
      solveIK2(BONE.hipW, hipY, frX, frY, BONE.thigh, BONE.shin, -1, p.kneeR);
      solveIK2(-BONE.shoulderW, shoulderY, hlX, hlY, BONE.upperArm, BONE.forearm, 1, p.elbowL);
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

  /**
   * Pose-space y for a hand hanging `frac` of the arm's full reach below the
   * shoulder. Pose space has -y as up, so a larger fraction hangs lower.
   *
   * Every rest and locomotion hand target goes through this instead of naming
   * a distance below the hip. The IK solver clamps a target it cannot reach,
   * which freezes the arm straight, and whether a given offset is reachable
   * depends entirely on how long this particular model's arms are.
   */
  function reachY(shoulderY, frac) {
    return shoulderY + (BONE.upperArm + BONE.forearm) * frac;
  }

  /**
   * The whole gait as one function of how fast the player is moving.
   *
   * update() needs it to advance the stride by ground covered and _updatePose
   * needs it to place the feet. They have to agree exactly — a stride phase
   * advanced against one stride length and spent against another is precisely
   * the skate this is all built to avoid — so both read it from here.
   *
   * `stride` is the foot's travel each way from under the hip, and it is the
   * number the leg's reach caps. A leg of length L with the hip carried at
   * height h can only put a foot sqrt(L^2 - h^2) from directly below it;
   * anything past that is a target the IK has to clamp, which stops the foot
   * where it can reach instead of where it was asked for and puts the skate
   * straight back. This build's leg is 0.90 with the hips at 0.86, which
   * allows 0.28 — so the hips also sink as the stride opens up, exactly as a
   * sprinter's do, and that is what buys the longer step.
   */
  /* The gait is a function of how fast the body is ACTUALLY travelling, in
   * feet per second — not of how close the player is to their own top speed.
   * Read as a fraction, a slow player at full tilt got the same stride as a
   * fast one, and holding sprint just spun the legs faster over the same
   * ground: at 18 ft/s the figure was taking seven and a half steps a second
   * at two and a half feet a step. A basketball player at a full-court sprint
   * takes about three and a half, at nearer five.
   *
   * GAIT_TOP is the speed the top of the curve is anchored to, and the
   * exponent puts most of the lengthening early, because that is where it
   * happens: the difference between a walk and a jog is nearly all stride,
   * and the difference between a jog and a sprint is mostly cadence. */
  const GAIT_TOP = 18;
  function gaitOf(speed, out) {
    const g = out || GAIT;
    const e = Math.pow(U.clamp01(speed / GAIT_TOP), 0.6);
    g.stride = U.lerp(0.16, 0.48, e);
    // Fraction of the cycle each foot spends on the floor. Over a half the
    // feet overlap (a walk's double support); under it they leave a float
    // phase with neither foot down, which is what makes a run a run.
    g.stance = U.lerp(0.60, 0.28, e);
    g.lift = U.lerp(0.05, 0.26, e);
    // A runner sinks. It is also what buys the room for the longer stride:
    // the foot can only reach so far forward and still be on the floor, and
    // that limit is set by how high the hip is carried.
    g.crouch = U.lerp(0.005, 0.130, e);
    return g;
  }
  const GAIT = { stride: 0, stance: 0, lift: 0, crouch: 0 };

  /* How far the foot rolls over the toe at push-off, and how far the toe comes
   * up to clear the floor on the way through and land heel-first. A foot held
   * rigidly flat through all of this is the single clearest tell of an
   * animation rig that stops at the ankle. */
  const TOE_OFF = 0.60;
  const HEEL_UP = 0.22;

  /**
   * One foot's offset for a point in the stride cycle.
   *
   * Stance is on the floor, travelling straight back, covering exactly the
   * ground the body covers forward. Swing lifts in an arc and returns to the
   * front. Writing it this way rather than as a sine is the difference between
   * running and skating.
   *
   * The ankle also rises through the back of stance. That is not a lift off
   * the floor: the foot is pivoting over a toe that stays planted, so the
   * ankle has to climb by the toe's length times the sine of the roll for the
   * contact point to stay exactly where it was put.
   *
   * @param {object} out {x, y, pitch}; y is negative for lift, pitch is
   *        radians with the toe going down
   * @param {number} phase radians, advanced by distance travelled
   * @param {object} g a gait from gaitOf
   */
  function stepFoot(out, phase, g) {
    const u = ((phase / (Math.PI * 2)) % 1 + 1) % 1;
    if (u < g.stance) {
      const k = u / g.stance;                    // 0 at touchdown, 1 at toe-off
      out.x = g.stride * (1 - 2 * k);
      const roll = k > 0.62 ? (k - 0.62) / 0.38 : 0;
      const heelOff = TOE_OFF * roll * roll;
      // Heel strike: the toe is still up for the first moments of contact.
      out.pitch = heelOff - HEEL_UP * Math.max(0, 1 - k / 0.12);
      out.y = -BONE.toe * Math.sin(heelOff);
    } else {
      const k = (u - g.stance) / (1 - g.stance); // 0 at toe-off, 1 at touchdown
      out.x = g.stride * (2 * k - 1);
      out.y = -Math.sin(k * Math.PI) * g.lift;
      // The foot leaves the floor still pointed, then dorsiflexes to land.
      out.pitch = U.lerp(TOE_OFF, -HEEL_UP, U.ease.inOutSine(Math.min(1, k * 1.35)));
    }
    return out;
  }
  const STEP_L = { x: 0, y: 0, pitch: 0 }, STEP_R = { x: 0, y: 0, pitch: 0 };

  /**
   * Rotates a bone's tail back toward vertical about its own head, keeping its
   * length. HEAD_UPRIGHT is how much of the spine's tilt is taken out: 1 would
   * be a head bolted permanently level, 0 the head riding the lean in full.
   */
  const HEAD_UPRIGHT = 0.78;
  function uprightHead(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    const t = HEAD_UPRIGHT;
    const ux = dx * (1 - t), uy = dy * (1 - t), uz = dz * (1 - t) + len * t;
    const ul = Math.hypot(ux, uy, uz) || 1;
    b[0] = a[0] + (ux / ul) * len;
    b[1] = a[1] + (uy / ul) * len;
    b[2] = a[2] + (uz / ul) * len;
  }

  /** Point `t` of the way from world point a to world point b. */
  function mixPt(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }

  /* Bones baked at fixed fractions of the model's height, placed by measuring
   * the same fractions along the posed body. */
  const SPINE_BONES = ['pelvis', 'torso', 'head'];
  const HIP = [0, 0, 0], SHO = [0, 0, 0];
  const REF_DIR = [1, 0, 0];
  const HREF = [1, 0, 0];

  /** Rotates `v` about unit axis (ax, ay, az) by `a` radians, into `out`.
   *  Rodrigues — used to twist a bone's reference direction about the bone. */
  function spin(v, ax, ay, az, a, out) {
    const c = Math.cos(a), s = Math.sin(a), d = ax * v[0] + ay * v[1] + az * v[2];
    out[0] = v[0] * c + (ay * v[2] - az * v[1]) * s + ax * d * (1 - c);
    out[1] = v[1] * c + (az * v[0] - ax * v[2]) * s + ay * d * (1 - c);
    out[2] = v[2] * c + (ax * v[1] - ay * v[0]) * s + az * d * (1 - c);
    return out;
  }

  function dist3(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }

  /** Copies rgb into a zone row, leaving its alpha/gloss/emissive alone. */
  function copyCol(row, c) {
    row[0] = c[0]; row[1] = c[1]; row[2] = c[2];
  }

  const LEGS = [{ side: -1 }, { side: 1 }];
  const ARMS = [{ side: -1 }, { side: 1 }];
  const MINT = [0.133, 0.894, 0.627, 0.85];
  /* The defensive readout. Cool blue while the position is merely good, gold
   * once it has been held long enough to be worth calling out — the same two
   * colours the shot meter already uses for "fine" and "that was the one", so
   * the language is consistent without a legend. */
  const GUARD_COL = [0.298, 0.643, 0.980, 1];
  const LOCK_COL = [1.000, 0.788, 0.239, 1];
  const COL_TMP = [0, 0, 0, 1];

  /** Blends two colours into scratch storage. Not re-entrant; draw only. */
  function lerpCol(a, b, t) {
    COL_TMP[0] = U.lerp(a[0], b[0], t);
    COL_TMP[1] = U.lerp(a[1], b[1], t);
    COL_TMP[2] = U.lerp(a[2], b[2], t);
    COL_TMP[3] = U.lerp(a[3] == null ? 1 : a[3], b[3] == null ? 1 : b[3], t);
    return COL_TMP;
  }

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
