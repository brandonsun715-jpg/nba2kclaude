/* =============================================================================
 * teamai.js  —  Five-man team decision making.
 * -----------------------------------------------------------------------------
 * ai.js is the 1v1 brain: one attacker, one defender, no teammates, no pass.
 * It stays exactly as it is (1v1 mode still uses it verbatim). This module is
 * the layer 5v5 needs on top of it:
 *
 *   shotQuality()   how good a look actually is — distance, defender pressure,
 *                   the shooter's own rating for that range. Replaces the 1v1
 *                   "am I roughly open? shoot" test, which on a full court
 *                   produced 40-foot heaves.
 *   bestPass()      the most valuable open teammate, with a real passing-lane
 *                   check against every defender.
 *   onBall()        ball-handler logic: shoot / pass / drive / reset, driven by
 *                   shot quality and the shot clock rather than a timer alone.
 *   offBall()       spacing that reacts to where the ball is, plus occasional
 *                   cuts to the rim when the lane is genuinely open.
 *   defend()        man-to-man with real help: sag toward the ball when your
 *                   own man is far from it, close out when he isn't.
 *
 * Everything here only ever sets the same intent fields a human's input sets
 * (intentX / intentY / intentMag / sprinting) or calls the same public Player
 * methods a human triggers, so the AI is bound by identical movement, shot and
 * stamina mechanics. No privileged code paths.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C;

  /* How close a defender has to be to actually pressure a shot. */
  const CONTEST_RADIUS = 7.0;

  /** Perpendicular distance from point p to segment a->b, for pass lanes. */
  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return U.dist(px, py, ax, ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = U.clamp01(t);
    return U.dist(px, py, ax + dx * t, ay + dy * t);
  }

  /** 0..1 pressure on `p` from the nearest member of `defenders`. */
  function pressureOn(p, defenders) {
    let closest = Infinity;
    for (const d of defenders) {
      const dist = U.dist(p.x, p.y, d.x, d.y);
      if (dist < closest) closest = dist;
    }
    if (closest === Infinity) return 0;
    return U.clamp01(1 - closest / CONTEST_RADIUS);
  }

  /**
   * How good a shot this player has right now, 0..1.
   * Distance is weighted against the rating that actually governs that range,
   * so a Center at the three-point line correctly reads as a bad shot while
   * the same spot for an elite shooter reads as a fine one.
   */
  function shotQuality(p, hoop, defenders) {
    const dist = U.dist(p.x, p.y, hoop.x, hoop.y);
    const r = p.ratings;
    const three = U.isThree(p.x, p.y, hoop);
    const rating = three ? r.threePoint : (dist <= 12 ? r.closeShot : r.midRange);
    const skill = U.invLerp(25, 99, rating);

    // Range term: everyone is good at the rim; it eases off through the
    // midrange, and past ~28ft it is a heave for anybody. The arc sits around
    // 23.75ft and must land high enough that a real shooter will take an open
    // one — tuned too low and threes simply never get attempted at all.
    let range;
    if (dist <= 5) range = 1.0;
    else if (dist <= 16) range = U.remap(dist, 5, 16, 1.0, 0.75);
    else if (dist <= 24) range = U.remap(dist, 16, 24, 0.75, 0.68);
    else range = Math.max(0, U.remap(dist, 24, 32, 0.50, 0));

    // A good shooter extends their own effective range — and a poor one is
    // genuinely punished for stepping out, so a Center doesn't launch threes.
    range = U.clamp01(range * U.lerp(0.65, 1.30, skill));

    const pressure = pressureOn(p, defenders);
    const openness = 1 - pressure * U.lerp(0.75, 0.42, skill); // better shooters mind contests less

    return U.clamp01(range * openness);
  }

  /** True if nobody in `defenders` is sitting in the lane from a to b. */
  function laneClear(a, b, defenders, margin) {
    margin = margin == null ? 2.1 : margin;
    for (const d of defenders) {
      if (d === a || d === b) continue;
      if (distToSegment(d.x, d.y, a.x, a.y, b.x, b.y) < margin) return false;
    }
    return true;
  }

  /**
   * Best teammate to pass to, or null if nobody is meaningfully better off.
   * Value is their own shot quality plus a bonus for being closer to the rim,
   * minus the risk of the pass itself.
   */
  function bestPass(p, teammates, defenders, hoop) {
    const myQuality = shotQuality(p, hoop, defenders);
    const myPressure = pressureOn(p, defenders);
    let best = null, bestValue = 0;

    for (const t of teammates) {
      if (t === p) continue;
      const passDist = U.dist(p.x, p.y, t.x, t.y);
      if (passDist < 4 || passDist > 42) continue;     // too close to bother, too far to be safe
      if (!laneClear(p, t, defenders)) continue;

      const theirQuality = shotQuality(t, hoop, defenders);
      const theirPressure = pressureOn(t, defenders);
      // Weight by what the shot is actually worth. Judging purely on shot
      // quality sends every pass into the post, since a look at the rim always
      // grades higher than one behind the arc even when the three is better
      // value for a real shooter.
      const worth = U.isThree(t.x, t.y, hoop) ? 1.32 : 1.0;
      // Long passes are riskier; passing accuracy offsets some of that.
      const risk = U.clamp01(passDist / 55) * U.remap(p.ratings.passAccuracy, 25, 99, 1.15, 0.55);
      const value = theirQuality * worth + (myPressure - theirPressure) * 0.55 - risk;

      if (value > bestValue) { bestValue = value; best = t; }
    }

    // Only pass when it is a real upgrade over just taking the shot yourself,
    // otherwise the ball ping-pongs around the perimeter forever.
    const threshold = myQuality * 0.85 + 0.06;
    return bestValue > threshold ? best : null;
  }

  /* ============================================================== on-ball */
  /**
   * @param {object} ctx { hoop, teammates, defenders, dt, difficulty,
   *                       shotClock, onPass(target) }
   */
  function onBall(p, ctx) {
    const hoop = ctx.hoop, dt = ctx.dt;
    const defenders = ctx.defenders;
    const dist = U.dist(p.x, p.y, hoop.x, hoop.y);
    const quality = shotQuality(p, hoop, defenders);
    const pressure = pressureOn(p, defenders);
    const iq = U.remap(p.ratings.basketballIQ, 25, 99, 0.75, 1.2);

    p.aiPatience -= dt;
    const clock = ctx.shotClock == null ? 24 : ctx.shotClock;
    const desperate = clock < 4;
    const hurrying = clock < 8;

    /* --- shoot ---------------------------------------------------------- */
    // The bar falls as the shot clock drains: a look not worth taking with 18
    // seconds left is absolutely worth taking with 3. Early in the clock the
    // bar is high so a possession actually gets worked rather than the first
    // acceptable look going up immediately.
    let bar, rate;
    if (clock > 16) { bar = 0.66; rate = 0.07; }        // early: work for a good look
    else if (clock > 8) { bar = 0.54; rate = 0.11; }    // middle: take a decent one
    else if (clock > 4) { bar = 0.36; rate = 0.18; }    // late: take what's there
    else { bar = 0.18; rate = 0.40; }                   // desperate

    // Even desperate, a heave from beyond the far arc is worthless — hold it
    // and keep attacking until the clock is genuinely gone.
    const heaveOnly = dist > 30;
    const canShoot = !heaveOnly || clock < 1.0;

    const wantsShot = canShoot &&
      ((clock < 1.5 && dist < 34) ||                    // buzzer: get it up
       (quality >= bar &&
        U.rng.chance(quality * (p.ratings.shotTendency / 100) * iq * ctx.difficulty * rate)));

    if (wantsShot) {
      p.intentX = 0; p.intentY = 0; p.intentMag = 0;
      p._beginShot();
      p.aiPatience = U.rng.f(3.0, 6.0);
      return;
    }

    /* --- pass ----------------------------------------------------------- */
    if (!desperate) {
      const wantsPass = pressure > 0.35 || quality < 0.32 || p.aiPatience <= 0;
      if (wantsPass && ctx.onPass) {
        const target = bestPass(p, ctx.teammates, defenders, hoop);
        if (target && U.rng.chance(0.35 + p.ratings.passVision / 400)) {
          ctx.onPass(target);
          p.aiPatience = U.rng.f(3.0, 6.0);
          return;
        }
      }
    }

    /* --- drive / reposition --------------------------------------------- */
    // If the current look already clears the bar, settle into it rather than
    // driving. The shoot roll is per-tick, so a player who keeps advancing
    // while waiting for it will always end up finishing at the rim — which is
    // why almost nothing was ever shot from range.
    if (quality >= bar && dist < 27) {
      p.intentX = 0; p.intentY = 0; p.intentMag = 0; p.sprinting = false;
      return;
    }

    // Attack when there is a lane and it is worth attacking, otherwise work
    // toward a better spot instead of standing still or bulldozing a set
    // defender (which is just a charge).
    const toHoop = Math.atan2(hoop.y - p.y, hoop.x - p.x);
    const nearest = nearestOf(p, defenders);
    const guarded = nearest && U.dist(p.x, p.y, nearest.x, nearest.y) < 5.0;
    const driveLaneOpen = !nearest || !inCone(p, nearest, toHoop, 0.6, 7);

    if (dist > 26 || (hurrying && dist > 24)) {
      // Too far out to do anything useful — get into range first.
      steer(p, Math.cos(toHoop), Math.sin(toHoop), 1, true);
      return;
    }

    if (driveLaneOpen && (dist > 6 || !guarded)) {
      steer(p, Math.cos(toHoop), Math.sin(toHoop), 1, dist > 14);
      return;
    }

    // Guarded with no lane: try a move to shake free, then work laterally.
    if (guarded && !p.moveState && p.moveCooldown <= 0) {
      const chance = U.remap(p.ratings.ballHandle, 25, 99, 0.008, 0.05) * ctx.difficulty;
      if (U.rng.chance(chance)) {
        p._tryDribbleMove(nearest.y > p.y ? -1 : 1, U.rng.chance(0.25));
      }
    }
    const perp = toHoop + Math.PI / 2;
    const side = nearest && nearest.y > p.y ? -1 : 1;
    steer(p, Math.cos(perp) * side * 0.85 + Math.cos(toHoop) * 0.3,
      Math.sin(perp) * side * 0.85 + Math.sin(toHoop) * 0.3, 0.7, false);
  }

  /* ============================================================= off-ball */
  /**
   * Spacing that reacts to the ball, plus real cuts. `slot` is this player's
   * base formation spot; it is pushed away from the ball handler and from
   * crowded teammates so five players never end up occupying one spot.
   */
  function offBall(p, ctx) {
    const hoop = ctx.hoop, ball = ctx.ballHandler, dt = ctx.dt;

    p._cutTimer = (p._cutTimer || 0) - dt;

    /* Cut to the rim occasionally when the lane is genuinely open. */
    if (p._cutting) {
      p._cutT -= dt;
      if (p._cutT <= 0 || U.dist(p.x, p.y, hoop.x, hoop.y) < 4) {
        p._cutting = false;
        p._cutTimer = U.rng.f(3.5, 8.0);
      } else {
        const a = Math.atan2(hoop.y - p.y, hoop.x - p.x);
        steer(p, Math.cos(a), Math.sin(a), 1, true);
        return;
      }
    } else if (p._cutTimer <= 0) {
      const laneOpen = laneClear(p, hoop, ctx.defenders, 2.4);
      const iq = p.ratings.basketballIQ / 100;
      if (laneOpen && U.rng.chance(0.010 * iq * ctx.difficulty)) {
        p._cutting = true;
        p._cutT = U.rng.f(0.9, 1.6);
        return;
      }
      p._cutTimer = U.rng.f(1.0, 2.5);
    }

    /* Hold a spot: base slot, pushed off the ball handler and off teammates. */
    let tx = p._homeX == null ? p.x : p._homeX;
    let ty = p._homeY == null ? p.y : p._homeY;

    if (ball) {
      // Never stand on top of the ball handler.
      const d = U.dist(tx, ty, ball.x, ball.y);
      if (d < 12) {
        const a = Math.atan2(ty - ball.y, tx - ball.x);
        tx = ball.x + Math.cos(a) * 12;
        ty = ball.y + Math.sin(a) * 12;
      }
    }
    for (const t of ctx.teammates) {
      if (t === p) continue;
      const d = U.dist(tx, ty, t.x, t.y);
      if (d < 8 && d > 0.01) {
        const a = Math.atan2(ty - t.y, tx - t.x);
        tx += Math.cos(a) * (8 - d) * 0.5;
        ty += Math.sin(a) * (8 - d) * 0.5;
      }
    }

    // Stay on the floor and out of the backcourt corners.
    tx = U.clamp(tx, 3, C.COURT_L - 3);
    ty = U.clamp(ty, 4, C.COURT_W - 4);

    const dx = tx - p.x, dy = ty - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1.5) {
      steer(p, dx / dist, dy / dist, U.clamp01(dist / 7), dist > 16);
    } else {
      p.intentX = 0; p.intentY = 0; p.intentMag = 0; p.sprinting = false;
    }
  }

  /* ============================================================== defense */
  /**
   * Man-to-man with help. Guarding your own man is the default; when the ball
   * is elsewhere and your man is away from it, you sag toward the ball line
   * instead of following him into irrelevance.
   */
  function defend(p, ctx) {
    const man = p.opponent, ball = ctx.ballHandler, hoop = ctx.hoop, dt = ctx.dt;
    if (!man) { p.intentX = 0; p.intentY = 0; p.intentMag = 0; return; }

    // Reaction lag, same principle as ai.js: track a belief that catches up,
    // not the true position, or the defender is impossible to beat.
    if (p._beliefX == null) { p._beliefX = man.x; p._beliefY = man.y; }
    const iqRate = U.remap(p.ratings.basketballIQ, 25, 99, 0.8, 1.2);
    const rate = U.clamp(2.2 * ctx.difficulty * iqRate, 1.0, 4.8);
    p._beliefX = U.approach(p._beliefX, man.x, rate, dt);
    p._beliefY = U.approach(p._beliefY, man.y, rate, dt);

    const onBallDefender = ball === man;

    /* Shot in progress on my man: close out and contest. */
    if (onBallDefender && man.isBusyShooting) {
      const dx = man.x - p.x, dy = man.y - p.y;
      const m = Math.hypot(dx, dy) || 1;
      steer(p, dx / m, dy / m, U.clamp01((m - 0.6) / 2), m > 4);
      // Paced, like the steal reach — a per-frame roll here fires on almost
      // every frame the shooter is in range.
      if (p._nextBlock == null) p._nextBlock = 0;
      p._nextBlock -= dt;
      if (p.blockCooldown <= 0 && p._nextBlock <= 0 && m < 5.5) {
        p.tryBlock(ctx.ball);
        p._nextBlock = U.rng.f(0.7, 1.4);
      }
      return;
    }

    let spotX, spotY;
    if (onBallDefender) {
      // On the ball: sit between him and the basket, tighter near the rim.
      const toHoop = Math.atan2(hoop.y - p._beliefY, hoop.x - p._beliefX);
      const distHoop = U.dist(p._beliefX, p._beliefY, hoop.x, hoop.y);
      const gap = U.clamp(3.6 - ctx.difficulty * 1.0 - U.remap(distHoop, 0, 20, 0.85, 0), 1.3, 4.2);
      spotX = p._beliefX + Math.cos(toHoop) * gap;
      spotY = p._beliefY + Math.sin(toHoop) * gap;
    } else {
      // Off the ball: deny position, shaded toward the ball. The further my
      // man is from the ball, the more I help instead of shadowing him.
      const toHoop = Math.atan2(hoop.y - p._beliefY, hoop.x - p._beliefX);
      const denyX = p._beliefX + Math.cos(toHoop) * 2.6;
      const denyY = p._beliefY + Math.sin(toHoop) * 2.6;
      if (ball) {
        const manToBall = U.dist(man.x, man.y, ball.x, ball.y);
        const help = U.clamp01(U.remap(manToBall, 10, 26, 0, 0.55));
        // Help point: partway toward the line between the ball and the rim.
        const helpX = (ball.x + hoop.x) * 0.5;
        const helpY = (ball.y + hoop.y) * 0.5;
        spotX = U.lerp(denyX, helpX, help);
        spotY = U.lerp(denyY, helpY, help);
      } else {
        spotX = denyX; spotY = denyY;
      }
    }

    const dx = spotX - p.x, dy = spotY - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.2) {
      // Defensive slides are a notch slower than a sprint; only a real gap
      // triggers full-speed recovery.
      steer(p, dx / dist, dy / dist, U.clamp01(dist / 4) * 0.85, dist > 9);
    } else {
      p.intentX = 0; p.intentY = 0; p.intentMag = 0; p.sprinting = false;
    }

    /* Reach for a steal on a timer, not a per-frame dice roll. The AI runs
     * every rendered frame, so a flat per-call chance here becomes an attempt
     * multiple times a second — which produced dozens of steals a game and
     * made possessions impossible to sustain. */
    if (p._nextSteal == null) p._nextSteal = U.rng.f(2.5, 5.0);
    p._nextSteal -= dt;
    if (onBallDefender && p._nextSteal <= 0 && p.stealCooldown <= 0) {
      const close = U.dist(p.x, p.y, man.x, man.y) < 2.8;
      // Only worth reaching at a handler who is probing, not one blowing past.
      if (close && man.intentMag < 0.5) p.trySteal(ctx.ball);
      p._nextSteal = U.rng.f(4.0, 8.0) / U.clamp(ctx.difficulty, 0.6, 1.4);
    }
  }

  /* ================================================================ utils */
  function steer(p, dx, dy, mag, sprint) {
    const m = Math.hypot(dx, dy) || 1;
    p.intentX = dx / m; p.intentY = dy / m;
    p.intentMag = U.clamp01(mag);
    p.sprinting = !!sprint;
  }

  function nearestOf(p, list) {
    let best = null, bd = Infinity;
    for (const o of list) {
      const d = U.dist(p.x, p.y, o.x, o.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /** Is `other` within `halfAngle` of the direction `dir` from p, inside `range`? */
  function inCone(p, other, dir, halfAngle, range) {
    const d = U.dist(p.x, p.y, other.x, other.y);
    if (d > range) return false;
    const a = Math.atan2(other.y - p.y, other.x - p.x);
    return Math.abs(U.angleDelta(dir, a)) < halfAngle;
  }

  BB.TeamAI = {
    shotQuality, bestPass, laneClear, pressureOn, distToSegment,
    onBall, offBall, defend, CONTEST_RADIUS
  };
})(typeof window !== 'undefined' ? window : globalThis);
