/* =============================================================================
 * constants.js  —  Immutable configuration for NBA 1K26
 * -----------------------------------------------------------------------------
 * All world-space units are FEET. The court is modelled at true NBA dimensions
 * (94 x 50) so that every rating, distance and shot-percentage curve tuned later
 * maps onto real basketball numbers instead of arbitrary pixels.
 *
 * Coordinate system
 *   x : 0 .. 94   (baseline to baseline, left basket is low x)
 *   y : 0 .. 50   (sideline to sideline)
 *   z : 0 .. up   (height off the floor)
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});

  const C = {
    VERSION: '1.0.0',
    BUILD: 'part1-foundation',

    /* ---------------------------------------------------------------- court */
    COURT_L: 94,
    COURT_W: 50,
    HALF_L: 47,
    HALF_W: 25,

    APRON: 8,              // out-of-bounds floor painted around the court
    HOOP_INSET: 5.25,      // rim centre distance from baseline
    RIM_HEIGHT: 10,
    RIM_RADIUS: 0.75,
    RIM_TUBE: 0.075,       // thickness of the ring itself
    NET_LENGTH: 1.25,

    BACKBOARD_INSET: 4.0,  // face of the glass from baseline
    BACKBOARD_HALF_W: 3.0, // 72" wide
    BACKBOARD_BOTTOM: 9.5,
    BACKBOARD_TOP: 13.0,
    BACKBOARD_INNER_W: 1.0, // inner square half-width
    BACKBOARD_INNER_BOT: 10.0,
    BACKBOARD_INNER_TOP: 11.5,

    PAINT_HALF_W: 8,       // 16ft lane
    PAINT_DEPTH: 19,       // baseline to free-throw line
    FT_CIRCLE_R: 6,
    RESTRICTED_R: 4,
    CENTER_R: 6,
    CENTER_INNER_R: 2,

    THREE_R: 23.75,        // arc radius from rim centre
    THREE_CORNER_INSET: 3, // corner three sits 3ft inside each sideline
    THREE_BREAK_X: 14,     // where the straight corner segment meets the arc

    /* -------------------------------------------------------------- physics */
    GRAVITY: 32.174,       // ft/s^2
    BALL_RADIUS: 0.395,    // ~9.47" circumference ball
    BALL_MASS: 1.4,
    // The arc solver (Ball.solveArc) assumes drag-free ballistic flight and
    // has no way to compensate for drag when computing a launch velocity.
    // Any nonzero value here creates real, uncompensated trajectory error
    // that grows with launch speed — at a typical ~22ft/s vertical release
    // speed even AIR_DRAG=0.001 was measured to bias landing spot by several
    // tenths of a foot, which silently degrades every shot regardless of
    // timing or rating. Real basketball flight over these ranges is also
    // negligibly affected by air resistance, so zero is both correct and
    // necessary rather than a simplification.
    AIR_DRAG: 0,
    FLOOR_RESTITUTION: 0.755,
    FLOOR_FRICTION: 0.72,
    RIM_RESTITUTION: 0.42,
    RIM_FRICTION: 0.55,
    BOARD_RESTITUTION: 0.50,
    NET_DAMPING: 0.55,
    REST_SPEED: 0.55,      // below this the ball is considered settled

    /* --------------------------------------------------------------- render */
    PPF: 13.35,            // pixels per foot at zoom 1.0
    Y_SQUASH: 0.795,       // pseudo-3D foreshortening on the y axis
    // Height is deliberately under-scaled relative to ground distance. At 1:1
    // the rim would float a full 10ft "north" of its floor position and read as
    // detached from the court; 0.45ft of screen travel per 1ft of height keeps
    // the whole hoop assembly sitting believably over the lane.
    Z_SCALE: 4.8,          // pixels per foot of height
    DESIGN_H: 720,
    SHADOW_MAX_H: 16,      // height at which a shadow fully fades

    /* ----------------------------------------------------------------- loop */
    FIXED_DT: 1 / 120,
    MAX_FRAME: 0.20,

    /* ----------------------------------------------------------------- rules
     * Fouls, violations and player-vs-player contact. 1v1 plays "streetball"
     * rules: a shooting foul awards free throws (and an and-1 if the shot
     * still falls); every other foul is a dead-ball turnover straight back
     * to the fouled player via the normal check-ball restart. No bonus/team
     * fouls, no foul-outs — there's no bench and no clock to hang them on.
     */
    PLAYER_COLLISION_R: 0.85,     // matches Player.radius; centre-to-centre min sep is 2x this
    COLLISION_PUSH_RATE: 14,      // how fast overlap resolves, 1/s
    CONTACT_FORCE_DIV: 9,         // overlap(ft)*closingSpeed(ft/s) / this = contactForce 0..1ish

    TRAVEL_PIVOT_RADIUS: 2.4,     // ft the pivot foot may drift once the ball is picked up
    SET_DEFENDER_TIME: 0.25,      // s a defender must be ~stationary to count as "set" (charge-eligible)
    SET_DEFENDER_SPEED: 1.6,      // ft/s below this counts toward "set"

    FOUL_COOLDOWN: 1.1,           // s after any whistle before a new foul can be called
    SHOOTING_FOUL_BASE: 0.16,     // base chance/contactForce for a shooting foul on real contact
    REACH_FOUL_BASE: 0.05,        // base chance/contactForce for a reach-in on a failed steal

    FT_LINE_DIST: 19,             // baseline-to-FT-line; matches PAINT_DEPTH exactly (real NBA dist)

    /* ---------------------------------------------------------------- audio */
    DEFAULT_VOLUME: { master: 0.8, sfx: 0.9, crowd: 0.55, ui: 0.7 }
  };

  /* Derived hoop positions — computed once, read everywhere. */
  C.HOOPS = [
    { side: 0, x: C.HOOP_INSET, y: C.HALF_W, dir: 1 },              // left basket
    { side: 1, x: C.COURT_L - C.HOOP_INSET, y: C.HALF_W, dir: -1 }  // right basket
  ];

  /* ------------------------------------------------------------------ theme
   * "Summer Run": an outdoor park court in the middle of the afternoon. Teal
   * acrylic inside the lines, a terracotta surround, weathered blacktop past
   * that, and a hard blue sky over all of it. Mint stays reserved exclusively
   * for perfect releases and made shots.
   *
   * The ink/slate family is kept: it is the interface's palette (menus, HUD,
   * scorebug), and dark chrome over a bright court is exactly the contrast
   * those want. It just no longer paints the world.
   */
  C.PAL = {
    ink: '#080B11',
    inkSoft: '#111823',
    slate: '#1C2635',
    steel: '#2E3C50',
    chalk: '#F3F0E7',
    chalkDim: 'rgba(243,240,231,0.62)',

    /* ---- the park ---- */
    sky: '#4FA8E8',            // zenith
    skyHaze: '#BBDFF4',        // horizon, and the colour distance fades into
    sun: '#FFF4D6',

    asphalt: '#5D6670',        // the pad the court is painted on
    asphaltLight: '#6E7883',
    asphaltDark: '#464E57',
    asphaltGrain: 'rgba(24,28,34,0.22)',

    acrylic: '#1E9C86',        // inside the lines
    acrylicLight: '#2CB89E',
    acrylicDark: '#177A69',
    clay: '#C4623A',           // the surround outside the lines
    clayLight: '#D97848',

    grass: '#5FA33C',
    grassDark: '#417329',
    leaf: '#4E8F32',
    leafLight: '#77B84A',
    bark: '#6B4E32',

    fence: '#9AA6AE',          // galvanised chain link
    fencePost: '#7A868F',

    paint: '#1D4E8F',
    paintDeep: '#153A6C',

    orange: '#FF5A1F',
    orangeDim: '#B33C11',
    mint: '#22E4A0',
    gold: '#FFC542',
    red: '#E23B4E',

    ball: '#D2601E',
    ballDark: '#8A3A0E',
    rim: '#F04E23',
    net: 'rgba(243,240,231,0.85)',
    glass: 'rgba(214,232,255,0.16)'
  };

  BB.C = Object.freeze(C);
})(typeof window !== 'undefined' ? window : globalThis);
