/* =============================================================================
 * ai.js  —  The opponent's brain, for 1v1.
 * -----------------------------------------------------------------------------
 * The AI never touches physics or rendering directly. Every decision here
 * boils down to setting the same `intentX / intentY / intentMag / sprinting`
 * fields that Player.readInput() sets for a human, and calling the same
 * `_beginShot()` / `trySteal()` / `tryBlock()` methods a human triggers with a
 * key press. That reuse is deliberate: it guarantees the bot is bound by
 * exactly the same movement, jumping and shot mechanics as the person playing
 * against it — no separate, secretly-more-capable code path.
 *
 * think() is the only entry point. It looks at who owns the ball and hands
 * off to one of three simple states: offense, defense, or chasing a loose
 * ball. There is no formal state object; the right behaviour for "right now"
 * is cheap enough to just recompute every call.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C;

  const AI = {
    /**
     * @param {object} bot   the AI-controlled Player
     * @param {number} dt
     * @param {object} ball  the live Ball
     * @param {object} [ctx] { hoop, difficulty } — difficulty is a 0.55..1.3 multiplier
     */
    think(bot, dt, ball, ctx) {
      const opp = bot.opponent;
      if (!opp) return;
      const hoop = (ctx && ctx.hoop) || bot.targetHoop || U.nearestHoop(bot.x);
      const diff = (ctx && ctx.difficulty) || 1;
      bot.difficulty = diff; // cached for updateShotState's release-accuracy noise

      if (bot.isBusyShooting) {
        // Committed to a shot already in progress; the existing shot state
        // machine (shared with the human) carries the rest of it, including
        // the auto-release timing for a non-human player.
        bot.intentX = 0; bot.intentY = 0; bot.intentMag = 0;
        return;
      }

      /* The stance belongs to the defensive branch and nowhere else. Cleared
       * up front rather than at the bottom of the other two, so a branch added
       * later cannot inherit a crouch from the last possession. */
      bot.isGuarding = false;

      /* A possession starts the moment the ball arrives, and the settling beat
       * in offense() is measured from there. Without this it carries over from
       * the last possession, and a bot that had been holding the ball a while
       * comes out of a turnover already free to fire. */
      if (ball.owner === bot && !bot._hadBall) bot.aiSettle = 0;
      bot._hadBall = ball.owner === bot;

      if (ball.owner === bot) {
        offense(bot, opp, hoop, dt, diff);
      } else if (ball.owner === opp) {
        defense(bot, opp, hoop, dt, ball, diff);
      } else {
        loose(bot, opp, hoop, ball, dt);
      }
    }
  };

  /* ============================================================== offense */
  function offense(bot, opp, hoop, dt, diff) {
    bot.aiPatience -= dt;

    /* Time on the ball this possession.
     *
     * Every random decision below runs once per RENDERED FRAME — runAI is
     * called from the scene's update(), not from its fixed step — so a chance
     * expressed per call is really a chance per frame, and the bot decides
     * faster on a faster machine. Measured on the old code: with nobody within
     * twelve feet it pulled the trigger a median of 0.27s after catching, and
     * even against a defender grading 0.90 it got a shot away in 1.32s. That
     * is what made a three-second defensive stand impossible to hold: the ball
     * was gone long before three seconds were up.
     *
     * Two changes. Rates below are now per SECOND and scaled by dt, so the
     * same bot plays the same way at any frame rate; and a possession has a
     * settling beat before any voluntary shot, because nobody catches and
     * fires in a quarter of a second. */
    bot.aiSettle = (bot.aiSettle || 0) + dt;
    const settled = bot.aiSettle > 0.55;

    const toHoop = Math.atan2(hoop.y - bot.y, hoop.x - bot.x);
    const distHoop = U.dist(bot.x, bot.y, hoop.x, hoop.y);
    const distDef = U.dist(bot.x, bot.y, opp.x, opp.y);
    const toDef = Math.atan2(opp.y - bot.y, opp.x - bot.x);
    const defenderInLane = distDef < 6.5 && Math.abs(U.angleDelta(toHoop, toDef)) < 0.6;

    const shotTendency = bot.ratings.shotTendency / 100;
    const driveTendency = bot.ratings.driveTendency / 100;
    const iq = U.remap(bot.ratings.basketballIQ, 25, 99, 0.6, 1.15);

    const forced = bot.aiPatience <= 0;
    const inCloseRange = distHoop <= 6.2;

    /* How well he is being guarded, off the same number the defender's own
     * ring is drawn from. This is a read, not just a speed penalty: a handler
     * with somebody genuinely in front of him does not lower his shoulder and
     * run into them. He probes, tries to shake them, and backs it out to come
     * again from a different angle — and the shot clock, not stubbornness, is
     * what eventually makes him take one anyway.
     *
     * Deliberately the defender's POSITION rather than bot.pressure(), which
     * is the physical version of the same idea and is relative to where the
     * handler is heading this instant. That is right for the speed penalty —
     * a man you have already gone past should not still be slowing you down —
     * and wrong here, because the first sidestep away from the rim would then
     * read as nobody guarding him and send him straight back into the same
     * wall, one step at a time, all the way to the basket. */
    const guarded = opp.defenseQuality || 0;

    /* An open look is not merely a gap in the driving lane. The old test was
     * `far away OR not in the lane`, which called a defender standing a foot
     * off your shoulder "open" the moment they drifted off the exact line to
     * the rim — so a handler with somebody genuinely in their face still shot
     * as if nobody were there. Good position now closes the look. */
    const openLook = (distDef > 4.6 || !defenderInLane) && guarded < 0.58;

    /* Closely guarded and not yet ready to shoot: occasionally try to shake
     * the defender with a move rather than just driving straight into them.
     * Frequency scales with ball-handle rating and difficulty — a butter-
     * fingered bot on Rookie hardly ever tries one. */
    if (!inCloseRange && defenderInLane && distDef < 4.6 && !bot.moveState && bot.moveCooldown <= 0) {
      // Tries a lot harder to shake somebody who is actually in front of him.
      const moveRate = U.remap(bot.ratings.ballHandle, 25, 99, 0.36, 2.7) * diff *
                       (1 + guarded * 2.4);
      if (U.rng.chance(moveRate * dt)) {
        const wantsSpin = distDef < 2.6 && U.rng.chance(0.30);
        const lateral = opp.y > bot.y ? -1 : 1; // juke away from the defender's lean
        bot._tryDribbleMove(wantsSpin ? 0 : lateral, wantsSpin);
      }
    }

    /* A coached bot is a drill partner, not an opponent. The walkthrough sets
     * this so a defensive drill has something to actually guard: it drives,
     * probes and tries to shake you exactly as it always does, and simply
     * never pulls the trigger. Without it the stance drill is unholdable —
     * the ball is gone in about a second and the drill resets forever. */
    if (bot.noShoot) {
      bot.aiPatience = Math.max(bot.aiPatience, 1.5);
    } else {

    /* Point-blank: go up rather than dribble into the defender — but not off
     * the catch, and not into a defender who is genuinely walling the rim. */
    if (inCloseRange && (settled || forced) && (guarded < 0.72 || forced)) {
      plant(bot);
      bot._beginShot();
      bot.aiSettle = 0;
      bot.aiPatience = U.rng.f(3.0, 5.5);
      return;
    }

    /* Good look and either patient enough or forced to decide: shoot.
     * The rate is per second, and a defender in good position takes most of
     * it away — being guarded should change the DECISION, not only the odds
     * once the ball is in the air. */
    const shotRate = shotTendency * iq * diff * 1.35 * (1 - guarded * 0.8);
    if (openLook && settled && (forced || U.rng.chance(shotRate * dt))) {
      plant(bot);
      bot._beginShot();
      bot.aiSettle = 0;
      bot.aiPatience = U.rng.f(3.0, 6.0);
      return;
    }
    }

    /* Walled off. Back it out and work a new angle rather than keep leaning
     * into somebody who is not moving. Skipped once the clock has run him out
     * of choices — at that point a bad shot beats no shot. */
    if (guarded > 0.62 && !forced && !inCloseRange) {
      resetOut(bot, dt, toHoop);
      return;
    }

    /* Otherwise keep working: drive when there's a lane, hunt separation when
     * there isn't. A defender who's already set and right in the lane is a
     * charge waiting to happen — peel off laterally instead of running
     * through them. */
    if (!defenderInLane || U.rng.chance(driveTendency * diff * 3.0 * (1 - guarded * 0.8) * dt)) {
      const chargeRisk = defenderInLane && distDef < 2.8 && BB.Rules && BB.Rules.isSet(opp);
      const sidestep = defenderInLane ? (opp.y > bot.y ? -1 : 1) * (chargeRisk ? 1.15 : 0.55) : 0;
      const perp = toHoop + Math.PI / 2;
      const forward = chargeRisk ? 0.35 : 1;
      let dx = Math.cos(toHoop) * forward + Math.cos(perp) * sidestep;
      let dy = Math.sin(toHoop) * forward + Math.sin(perp) * sidestep;
      const m = Math.hypot(dx, dy) || 1;
      bot.intentX = dx / m; bot.intentY = dy / m; bot.intentMag = 1;
      // Nobody sprints through a set defender; that is a charge, or a wall.
      bot.sprinting = distHoop > 11 && !chargeRisk && guarded < 0.55;

      if (chargeRisk && !bot.moveState && bot.moveCooldown <= 0) {
        bot._tryDribbleMove(opp.y > bot.y ? -1 : 1, false);
      }
    } else {
      wander(bot, dt, toHoop);
    }
  }

  function plant(bot) { bot.intentX = 0; bot.intentY = 0; bot.intentMag = 0; }

  /**
   * Backing it out. Away from the rim and hard across the floor, which resets
   * the angle of attack and drags the defender along the whole way — the
   * difference between a possession that has stalled and one that is still
   * looking for something.
   */
  function resetOut(bot, dt, toHoop) {
    bot._wanderTimer -= dt;
    if (bot._wanderTimer <= 0) {
      bot._wanderSign = U.rng.chance(0.5) ? 1 : -1;
      bot._wanderTimer = U.rng.f(0.5, 1.1);
    }
    const perp = toHoop + Math.PI / 2;
    const dx = -Math.cos(toHoop) * 0.55 + Math.cos(perp) * bot._wanderSign * 0.85;
    const dy = -Math.sin(toHoop) * 0.55 + Math.sin(perp) * bot._wanderSign * 0.85;
    const m = Math.hypot(dx, dy) || 1;
    bot.intentX = dx / m; bot.intentY = dy / m;
    bot.intentMag = 0.85;
    bot.sprinting = false;
  }

  /** Lateral hunting for separation when the direct lane is covered. */
  function wander(bot, dt, toHoop) {
    bot._wanderTimer -= dt;
    if (bot._wanderTimer <= 0) {
      bot._wanderSign = U.rng.chance(0.5) ? 1 : -1;
      bot._wanderTimer = U.rng.f(0.55, 1.3);
    }
    const perp = toHoop + Math.PI / 2;
    let dx = Math.cos(perp) * bot._wanderSign * 0.7 + Math.cos(toHoop) * 0.25;
    let dy = Math.sin(perp) * bot._wanderSign * 0.7 + Math.sin(toHoop) * 0.25;
    const m = Math.hypot(dx, dy) || 1;
    bot.intentX = dx / m; bot.intentY = dy / m; bot.intentMag = 0.62;
    bot.sprinting = false;
  }

  /* ============================================================== defense */
  function defense(bot, opp, hoop, dt, ball, diff) {
    // Reaction lag: the defender doesn't track the ball handler's true
    // position, it tracks a belief of where they are that catches up over
    // time. This is what actually makes a defender beatable — without it,
    // the denial spot recomputes from the attacker's exact position every
    // single frame and the defender teleport-tracks with zero reaction
    // window, which reads as "glued to you" and makes driving impossible
    // no matter how sharp the cut. Higher difficulty reacts faster (tighter
    // lag); a basketball-IQ defender also reacts a little faster.
    if (bot._beliefX == null) { bot._beliefX = opp.x; bot._beliefY = opp.y; }
    const iqRate = U.remap(bot.ratings.basketballIQ, 25, 99, 0.80, 1.20);
    const reactionRate = U.clamp(2.0 * diff * iqRate, 0.9, 4.6);
    bot._beliefX = U.approach(bot._beliefX, opp.x, reactionRate, dt);
    bot._beliefY = U.approach(bot._beliefY, opp.y, reactionRate, dt);

    const toHoopFromOpp = Math.atan2(hoop.y - bot._beliefY, hoop.x - bot._beliefX);
    const distOppHoop = U.dist(bot._beliefX, bot._beliefY, hoop.x, hoop.y);

    if (opp.isBusyShooting) {
      /* Close out hard and consider swatting it — this reacts off the real
       * position, not the lagged belief, since closing on a shot already in
       * progress is a reflex to a stationary target, not a tracking problem. */
      const dx = opp.x - bot.x, dy = opp.y - bot.y;
      const m = Math.hypot(dx, dy) || 1;
      bot.intentX = dx / m; bot.intentY = dy / m;
      bot.intentMag = U.clamp01((m - 0.6) / 2);
      bot.sprinting = m > 4;

      if (bot.blockCooldown <= 0 && U.rng.chance(0.55 * diff)) bot.tryBlock(ball);
      return;
    }

    /* Denial spot: a point between the (lagged) ball position and the hoop,
     * tighter the closer it gets to the rim and the higher the difficulty. */
    const gap = U.clamp(3.6 - diff * 1.0 - U.remap(distOppHoop, 0, 20, 0.85, 0), 1.3, 4.2);
    const spotX = bot._beliefX + Math.cos(toHoopFromOpp) * gap;
    const spotY = bot._beliefY + Math.sin(toHoopFromOpp) * gap;

    /* Down in a stance, the same one the human gets for holding the key —
     * but only once it is actually guarding somebody rather than sprinting
     * back into the play, because a recovery run is not a slide and crouching
     * through one would only make it slower. */
    bot.isGuarding = U.dist(bot.x, bot.y, opp.x, opp.y) < 9;

    const dx = spotX - bot.x, dy = spotY - bot.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.15) {
      bot.intentX = dx / dist; bot.intentY = dy / dist;
      // Defensive slides are deliberately a notch slower than a flat-out
      // sprint — only genuinely getting beaten (a real gap opening up)
      // triggers a full-speed recovery sprint, not routine shadowing.
      bot.intentMag = U.clamp01(dist / 4) * 0.82;
      bot.sprinting = dist > 9;
    } else {
      bot.intentX = 0; bot.intentY = 0; bot.intentMag = 0;
    }

    /* Reach for a steal when the ball handler looks stationary/probing —
     * gambling on a live, fast dribble is a low-percentage play and the AI
     * should feel disciplined, not spammy. Steal checks use the real
     * position: a reach is a reflex at contact range, not a tracking read. */
    if (bot.stealCooldown <= 0 && opp.intentMag < 0.55) {
      const distToOpp = U.dist(bot.x, bot.y, opp.x, opp.y);
      if (distToOpp < 3.3 && U.rng.chance(0.30 * diff)) bot.trySteal(ball);
    }
  }

  /* ================================================================ loose */
  function loose(bot, opp, hoop, ball, dt) {
    // Chase the ball itself if it's reachable; otherwise get goal-side.
    const distBall = U.dist(bot.x, bot.y, ball.x, ball.y);
    const distOppBall = U.dist(opp.x, opp.y, ball.x, ball.y);

    const chase = ball.z < 9 && (distBall < distOppBall + 2.5);
    const tx = chase ? ball.x : (ball.x + hoop.x) / 2;
    const ty = chase ? ball.y : (ball.y + hoop.y) / 2;

    const dx = tx - bot.x, dy = ty - bot.y;
    const m = Math.hypot(dx, dy);
    if (m > 0.1) {
      bot.intentX = dx / m; bot.intentY = dy / m;
      bot.intentMag = 1;
      bot.sprinting = true;
    } else {
      bot.intentX = 0; bot.intentY = 0; bot.intentMag = 0;
    }
    void dt; void C;
  }

  /* Exported alongside think() for modes with more than one opponent, where
   * "is the ball mine / my one opponent's / loose" isn't the right question
   * per player. think() itself is unchanged; this just lets a caller that
   * already knows a player's role (offense/defense) skip its ball-ownership
   * branch and call the right function directly. */
  AI.offense = offense;
  AI.defense = defense;
  AI.loose = loose;

  BB.AI = AI;
})(typeof window !== 'undefined' ? window : globalThis);
