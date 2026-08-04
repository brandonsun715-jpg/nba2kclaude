/* =============================================================================
 * officiating.js  —  Fouls and violations, "streetball" ruleset.
 * -----------------------------------------------------------------------------
 * 1v1 has no clock/quarters and no bench, so this deliberately skips bonus/
 * team fouls and foul-outs: a shooting foul awards free throws (and an and-1
 * if the shot still falls), and every other whistle is a dead-ball turnover
 * straight back to the fouled player via the existing check-ball restart.
 *
 * This module holds no state of its own — it reads the small set of contact/
 * dribble-state fields the game and player code maintain (see player.js:
 * _dribbleLive, _pivotX/_pivotY, _setTimer) and turns them into decisions.
 * Nothing here touches rendering, audio or the ball directly; callers apply
 * the outcome.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C;

  const FOUL = {
    CHARGE: 'charge',       // offensive foul — turnover, no FTs
    SHOOTING: 'shooting',   // defensive foul during a shot motion — FTs (+and-1)
    ILLEGAL_CONTACT: 'illegalContact', // defensive foul off a shot — ball stays with fouled player
    REACH: 'reach'          // defensive foul off a failed steal — ball stays with fouled player
  };
  const VIOLATION = {
    TRAVEL: 'travel',
    DOUBLE_DRIBBLE: 'doubleDribble',
    OUT_OF_BOUNDS: 'outOfBounds'
  };

  const Rules = {
    FOUL, VIOLATION,

    /** Track how long a player has been ~stationary, for the charge rule. */
    updateSetStatus(player, dt) {
      const speed = Math.hypot(player.vx, player.vy);
      player._setTimer = speed < C.SET_DEFENDER_SPEED ? (player._setTimer || 0) + dt : 0;
    },

    isSet(player) { return (player._setTimer || 0) >= C.SET_DEFENDER_TIME; },

    inRestrictedArea(x, y, hoop) {
      return !hoop || U.dist(x, y, hoop.x, hoop.y) <= C.RESTRICTED_R;
    },

    /**
     * Has the ball-holder's pivot foot drifted illegally since they picked
     * up their dribble? Only meaningful once they've stopped dribbling live
     * (see player._dribbleLive) and aren't mid-gather-to-shoot, which is
     * legally exempt (the built-in 1-2 step gather).
     */
    checkTravel(player) {
      if (!player.hasBall || player.isBusyShooting || player._dribbleLive) return false;
      if (player._pivotX == null) return false;
      return U.dist(player.x, player.y, player._pivotX, player._pivotY) > C.TRAVEL_PIVOT_RADIUS;
    },

    /**
     * Decide what a resolved player collision means. `mover` is the player
     * with the ball (offense); `defender` is the other. Returns null for no
     * whistle, or { type, on: 'offense'|'defense' }.
     * @param {object} contact  result from BB.Collision.resolvePlayers
     * @param {object} ctx      { hoop }
     */
    classifyContact(mover, defender, contact, ctx) {
      if (!contact || contact.force < 0.05) return null;
      const hoop = ctx && ctx.hoop;
      const shooting = mover.isBusyShooting;
      const moverDriving = Math.hypot(mover.vx, mover.vy) > 2.5;
      const outsideRestricted = !this.inRestrictedArea(mover.x, mover.y, hoop);

      /* Charge: offense drives into a defender who was already set, outside
       * the restricted area. This is close to a geometric fact once a real
       * hit registers, so it's not probability-rolled the way a marginal
       * shooting-foul touch is — a ref doesn't need to "roll" an obvious one. */
      if (moverDriving && outsideRestricted && this.isSet(defender) && contact.force > 0.10) {
        return { type: FOUL.CHARGE, on: 'offense' };
      }

      /* Everything else that draws a whistle is on the defense. Verticality
       * (jumping straight up rather than still closing laterally) makes a
       * contest legal more often, same as the real rule. */
      const perimeter = !hoop || U.dist(mover.x, mover.y, hoop.x, hoop.y) > 12;
      const skillRating = perimeter ? defender.ratings.perimeterDefense : defender.ratings.interiorDefense;
      const discipline = U.remap(skillRating, 25, 99, 1.3, 0.6);
      const vertical = (defender.jumping && Math.hypot(defender.vx, defender.vy) < 3) ? 0.5 : 1;
      const base = shooting ? C.SHOOTING_FOUL_BASE : C.SHOOTING_FOUL_BASE * 0.45;
      const chance = U.clamp01(base * contact.force * discipline * vertical);

      if (!U.rng.chance(chance)) return null;
      return { type: shooting ? FOUL.SHOOTING : FOUL.ILLEGAL_CONTACT, on: 'defense' };
    },

    /**
     * Reach-in roll for a *failed* steal attempt at real contact range.
     * `force` is a 0..1-ish proxy built from proximity since a failed reach
     * doesn't necessarily produce a resolved body collision.
     */
    rollReachFoul(defender, ballHandler, force) {
      const discipline = U.remap(defender.ratings.steal, 25, 99, 0.75, 1.25);
      const handle = U.remap(ballHandler.ratings.ballHandle, 25, 99, 1.15, 0.85);
      const chance = U.clamp01(C.REACH_FOUL_BASE * force * discipline * handle);
      return U.rng.chance(chance);
    }
  };

  BB.Rules = Rules;
})(typeof window !== 'undefined' ? window : globalThis);
