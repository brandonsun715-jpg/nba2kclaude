/* =============================================================================
 * collision.js  —  Player-vs-player solid bodies.
 * -----------------------------------------------------------------------------
 * Every player is a circle of radius C.PLAYER_COLLISION_R on the floor plane.
 * Two players can never fully overlap; contact between them gets resolved
 * every fixed step the same way the ball resolves against the rim (positional
 * correction first, then a velocity response), and — unlike the rim — the
 * outcome is also handed back as a "contact force" so the rules layer
 * (game/officiating.js) can decide whether it was foul-worthy.
 *
 * This module owns no state itself. It reads/writes x, y, vx, vy directly on
 * the two Player instances it's given and returns a small result object.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C;

  const MIN_SEP = C.PLAYER_COLLISION_R * 2;

  /**
   * Resolve contact between two players for this step, if any.
   * @returns {null|{overlap:number, closingSpeed:number, force:number, nx:number, ny:number}}
   */
  function resolvePlayers(a, b, dt) {
    // A player mid-drive-finish (layup/dunk) is already committed and airborne
    // in spirit even before the jump apex — don't let a collision yank them
    // sideways out of an animation that's already fired.
    const dx = b.x - a.x, dy = b.y - a.y;
    let dist = Math.hypot(dx, dy);
    if (dist >= MIN_SEP) return null;

    let nx, ny;
    if (dist < 1e-4) { nx = 1; ny = 0; dist = 0; } else { nx = dx / dist; ny = dy / dist; }
    const overlap = MIN_SEP - dist;

    // Closing speed along the normal — how hard they're driving into each
    // other, not just how deep they're overlapping (a stationary bump and a
    // full-speed drive can have the same overlap but very different force).
    const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
    const closing = -(rvx * nx + rvy * ny); // positive = still closing

    // Mass proxy from strength: a stronger body gives ground more slowly and
    // moves a weaker one more on contact.
    const massA = U.remap(a.ratings.strength, 25, 99, 0.78, 1.28);
    const massB = U.remap(b.ratings.strength, 25, 99, 0.78, 1.28);
    const totalMass = massA + massB;
    const shareA = massB / totalMass; // heavier body yields less
    const shareB = massA / totalMass;

    // Positional correction: push both bodies apart along the normal so they
    // can never sink into one another, split by relative mass.
    const push = overlap * (1 - Math.exp(-C.COLLISION_PUSH_RATE * dt));
    a.x -= nx * push * shareA; a.y -= ny * push * shareA;
    b.x += nx * push * shareB; b.y += ny * push * shareB;

    // Velocity response: kill the closing component so neither body tunnels
    // through, redistributed by the same mass split. Purely a soft body
    // bump — no bounce, this isn't the ball.
    if (closing > 0) {
      a.vx -= nx * closing * shareA; a.vy -= ny * closing * shareA;
      b.vx += nx * closing * shareB; b.vy += ny * closing * shareB;
    }

    const force = U.clamp01((overlap * Math.max(0, closing)) / C.CONTACT_FORCE_DIV);
    return { overlap, closingSpeed: Math.max(0, closing), force, nx, ny };
  }

  BB.Collision = { resolvePlayers, MIN_SEP };
})(typeof window !== 'undefined' ? window : globalThis);
