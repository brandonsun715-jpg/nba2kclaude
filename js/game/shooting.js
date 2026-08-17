/* =============================================================================
 * shooting.js  —  Release timing and shot outcome.
 * -----------------------------------------------------------------------------
 * Two ideas drive the whole system:
 *
 *  1. RELEASE TIMING is graded on a meter whose target point and speed are
 *     unique to the shooter. Perfect timing does not guarantee a make; it
 *     shrinks the aim error.
 *
 *  2. NOTHING IS BINARY. The model never rolls "make/miss". It converts every
 *     modifier into an aim error in feet, applies it to the launch solution and
 *     lets the rim decide. Shots therefore rattle in, roll out and bank home on
 *     their own, and a 40% shooter misses in physically plausible ways.
 *
 * Release error maps to the SHORT/LONG axis, which is how real shooting works:
 * rush the release and the ball comes up short.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, C = BB.C, PAL = C.PAL;

  /* Feedback tiers, ordered from best to worst. */
  const TIER = {
    PERFECT:        { key: 'PERFECT',        label: 'PERFECT',        colour: PAL.mint,   quality: 1.00 },
    EXCELLENT:      { key: 'EXCELLENT',      label: 'EXCELLENT',      colour: '#8AF0C6',  quality: 0.86 },
    SLIGHTLY_EARLY: { key: 'SLIGHTLY_EARLY', label: 'SLIGHTLY EARLY', colour: '#C9F5DE',  quality: 0.66 },
    SLIGHTLY_LATE:  { key: 'SLIGHTLY_LATE',  label: 'SLIGHTLY LATE',  colour: '#C9F5DE',  quality: 0.66 },
    EARLY:          { key: 'EARLY',          label: 'EARLY',          colour: PAL.orange, quality: 0.42 },
    LATE:           { key: 'LATE',           label: 'LATE',           colour: PAL.orange, quality: 0.42 },
    VERY_EARLY:     { key: 'VERY_EARLY',     label: 'VERY EARLY',     colour: PAL.red,    quality: 0.18 },
    VERY_LATE:      { key: 'VERY_LATE',      label: 'VERY LATE',      colour: PAL.red,    quality: 0.18 }
  };

  /**
   * A shooter's personal release. Derived from ratings later; the defaults here
   * describe an average pro.
   */
  function makeReleaseProfile(o) {
    o = o || {};
    return {
      riseTime: o.riseTime == null ? 0.62 : o.riseTime,   // seconds to fill the meter
      target: o.target == null ? 0.95 : o.target,         // ideal release point 0..1 — right at the top
      greenWindow: o.greenWindow == null ? 0.045 : o.greenWindow,
      name: o.name || 'Standard'
    };
  }

  /* ==========================================================================
   * ShotMeter
   * ======================================================================= */
  class ShotMeter {
    constructor() {
      this.active = false;
      this.value = 0;         // 0..1 fill
      this.held = 0;          // seconds held
      this.profile = makeReleaseProfile();
      this.result = null;     // last grade, kept for the release flash
      this.flash = 0;
      this.anchor = { x: 0, y: 0, z: 0 };
      this.overheld = false;
    }

    start(profile, anchor) {
      this.active = true;
      this.value = 0;
      this.held = 0;
      this.overheld = false;
      this.profile = profile || this.profile;
      if (anchor) this.setAnchor(anchor);
      this.result = null;
    }

    setAnchor(a) { this.anchor.x = a.x; this.anchor.y = a.y; this.anchor.z = a.z || 0; }

    update(dt) {
      if (this.active) {
        this.held += dt;
        // The meter keeps climbing past 1.0 so "very late" is reachable.
        this.value = this.held / this.profile.riseTime;
        if (this.value >= 1.35) {
          this.overheld = true;
          return this.release();
        }
      }
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.2);
      return null;
    }

    /** @returns {object|null} grade */
    release() {
      if (!this.active) return null;
      this.active = false;
      const g = grade(this.value, this.profile);
      this.result = g;
      this.flash = 1;
      return g;
    }

    /* Takes the bar away entirely, flash included. A cancelled shot is one
     * that is not happening — a foul, a travel, a dunk that never needed
     * timing — and leaving the release ring fading on screen would report a
     * release that never occurred. */
    cancel() { this.active = false; this.result = null; this.flash = 0; }

    /**
     * Decays the post-release flash ring only. Unlike update(), this is safe
     * to call on every frame regardless of the meter's active state — nothing
     * else in the player's action state machine is guaranteed to call
     * update() once the shot has been released, so this is what actually
     * lets the release flash fade out instead of freezing on screen.
     */
    tick(dt) {
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.2);
    }

    /* ------------------------------------------------------------------ draw */
    /**
     * Signature element: a tall, gently-curved vertical bar beside the
     * shooter that fills bottom-to-top, with the green window cut into the
     * track itself so the player learns the timing by sight rather than by
     * reading a number. The window sits right at the top of the bar — how
     * much of that top edge is actually green is what varies with distance
     * and rating (see greenWindowFor), not its position.
     * Drawn in SCREEN space; call after the world pass.
     */
    draw(ctx, cam) {
      if (!this.active && this.flash <= 0.01) return;

      /* Where the bar hangs.
       *
       * ANCHOR_Z is the height the circle's CENTRE is pinned to, and the green
       * window sits about R*0.75 above that — so what the eye actually tracks
       * ends up roughly a foot higher again. At 6.6ft that put the green a full
       * half a body-length above the shooter's head, with the whole bar
       * floating clear of them: you had to look away from the player to read
       * the one thing you are timing. Pinned at shoulder height instead, the
       * green lands just over their head and the bar hangs down their side.
       *
       * The circle centre also moved in toward the anchor. The crescent bows
       * only to the LEFT of that centre, so pushing the centre well right used
       * to hold the bow out over the shooter — fine when the whole thing was
       * above them, but once it comes down to head height it would be drawn
       * across their chest. Near the anchor, the bow clears the shoulder and
       * the bar runs down beside the figure rather than over it. */
      const ANCHOR_Z = 4.6;
      const anchor = cam.project(this.anchor.x, this.anchor.y, this.anchor.z + ANCHOR_Z, TMP);
      const R = 58 * cam.fit;
      const HALF_SPAN = 0.95; // radians either side of due-left — a tall, gently-bowed crescent
      const A0 = Math.PI - HALF_SPAN; // bottom
      const A1 = Math.PI + HALF_SPAN; // top
      const span = A1 - A0;
      const prof = this.profile;
      let cx = anchor.x + R * 0.12, cy = anchor.y;

      /* Keep the whole crescent in the clear.
       *
       * The bar is canvas; the scorebug is DOM sitting on top of it. A shooter
       * anywhere up the floor puts the top of this bar underneath that bug,
       * and since the bar fills bottom-to-top the part that disappears is the
       * green window itself — the one part the player is actually reading. The
       * same goes for the edges of the window. So the bar follows the shooter
       * until it would leave the free area, then holds at the boundary rather
       * than sliding out of sight.
       *
       * The crescent only bows LEFT of its circle centre, so its box is not
       * centred on cx: it runs from cx - R to cx - R*cos(HALF_SPAN), and
       * cy ± R*sin(HALF_SPAN). PAD covers the track's own thickness and the
       * release flash, which rings a little wider still. */
      const PAD = 24 * cam.fit;
      const vExt = R * Math.sin(HALF_SPAN) + PAD;
      const top = (BB.HUD && BB.HUD.safeTop ? BB.HUD.safeTop() : 0) * (cam.dpr || 1);
      cy = U.clamp(cy, top + vExt, Math.max(top + vExt, cam.vh - vExt));
      cx = U.clamp(cx, R + PAD, Math.max(R + PAD, cam.vw - PAD + R * Math.cos(HALF_SPAN)));

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.lineCap = 'butt';

      /* Track */
      ctx.strokeStyle = 'rgba(6,9,14,0.80)';
      ctx.lineWidth = 15 * cam.fit;
      arc(ctx, cx, cy, R, A0, A1);

      ctx.strokeStyle = 'rgba(243,240,231,0.16)';
      ctx.lineWidth = 10 * cam.fit;
      arc(ctx, cx, cy, R, A0, A1);

      /* Green window — right at the top edge; only its THICKNESS changes
       * with difficulty, never its position. Excellent and Slightly
       * Early/Late (the two lighter halos drawn just outside it) are ALSO
       * guaranteed swishes now (see solveShot), so the bar has to actually
       * show them as green too, or "anywhere that looks green" and
       * "anywhere that's automatic" would silently disagree with each other.
       */
      const gw = prof.greenWindow;
      const ew = gw * 1.5;  // Excellent's threshold from grade()
      const sw = gw * 3.0;  // Slightly Early/Late's threshold from grade()

      ctx.strokeStyle = U.rgba('#C9F5DE', 0.18);
      ctx.lineWidth = 10 * cam.fit;
      arc(ctx, cx, cy, R,
        A0 + span * U.clamp01(prof.target - sw),
        A0 + span * U.clamp01(prof.target + sw));

      ctx.strokeStyle = U.rgba('#8AF0C6', 0.30);
      ctx.lineWidth = 10 * cam.fit;
      arc(ctx, cx, cy, R,
        A0 + span * U.clamp01(prof.target - ew),
        A0 + span * U.clamp01(prof.target + ew));

      ctx.strokeStyle = U.rgba(PAL.mint, 0.55);
      ctx.lineWidth = 10 * cam.fit;
      arc(ctx, cx, cy, R,
        A0 + span * U.clamp01(prof.target - gw),
        A0 + span * U.clamp01(prof.target + gw));

      /* Fill */
      const v = U.clamp(this.value, 0, 1.18);
      const distFromTarget = Math.abs(v - prof.target);
      const inGreen = distFromTarget <= gw;
      const inExcellent = !inGreen && distFromTarget <= ew;
      const inSlightly = !inGreen && !inExcellent && distFromTarget <= sw;
      const colour = this.active
        ? (inGreen ? PAL.mint : (inExcellent ? '#8AF0C6' : (inSlightly ? '#C9F5DE' : PAL.chalk)))
        : (this.result ? this.result.tier.colour : PAL.chalk);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 10 * cam.fit;
      arc(ctx, cx, cy, R, A0, A0 + span * Math.min(v, 1));

      /* Overrun tail turns the bar red once the window is gone */
      if (v > 1) {
        ctx.strokeStyle = PAL.red;
        arc(ctx, cx, cy, R, A1 - span * 0.06, A1);
      }

            /* Release flash ring */
      if (this.flash > 0 && this.result) {
        ctx.globalAlpha = this.flash * 0.7;
        ctx.strokeStyle = this.result.tier.colour;
        ctx.lineWidth = (2 + (1 - this.flash) * 7) * cam.fit;
        arc(ctx, cx, cy, R + (1 - this.flash) * 18 * cam.fit, A0, A1);
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    }
  }

  const TMP = { x: 0, y: 0, s: 1 };
  function arc(ctx, x, y, r, a0, a1) {
    if (a1 <= a0) return;
    ctx.beginPath();
    ctx.arc(x, y, r, a0, a1);
    ctx.stroke();
  }

  /**
   * How wide the green window is for THIS specific shot attempt. A shooter's
   * base window (from profileFromRatings) is their window on a comfortable,
   * close-in look. The further out they shoot, the tighter it gets — but a
   * higher rating buys back most of that tightening, so an elite shooter's
   * window barely narrows on a three while a poor shooter's collapses to
   * almost nothing. Free throws are always the same distance, so the rating
   * alone already captures the difficulty — no extra range penalty there.
   */
  function greenWindowFor(rating, dist, type, contest) {
    const base = U.remap(U.clamp(rating == null ? 70 : rating, 25, 99), 25, 99, 0.022, 0.062);
    if (type === 'freethrow') return base; // always uncontested by rule
    const skill = U.clamp01(U.invLerp(25, 99, rating == null ? 70 : rating));

    /* A layup's window is ENORMOUS, on purpose.
     *
     * The hard part of a layup is getting there — beating your man off the
     * dribble, picking the takeoff, surviving the help. Once you are in the
     * air a foot from the rim, asking for a sixtieth-of-a-second release is
     * asking the wrong question, and it punishes the player for the one thing
     * the drive was supposed to reward. So the bar goes almost entirely green:
     * hold it through the rise, let go anywhere near the top, and it drops.
     *
     * What still decides a layup is the CONTEST. A body at the rim shrinks
     * this hard, and solveShot keeps its own contest penalty on top, so
     * driving into three defenders is still a bad idea — it is just no longer
     * a timing minigame. */
    if (type === 'layup') {
      const w = U.remap(U.clamp(rating == null ? 70 : rating, 25, 99), 25, 99, 0.20, 0.34);
      const c = U.clamp01(contest || 0);
      return Math.max(0.05, w * (1 - c * 0.55));
    }

    /* A dunk you have to time gets a FREE THROW's window — literally `base`,
     * the same expression the freethrow branch above returns, not a number
     * that merely resembles it.
     *
     * The reasoning is the same one that makes a layup's window enormous, just
     * less extreme. You only ever see this bar when your reach clears the rim
     * but not by much (see Player#dunkHeadroom); the hard part was getting up
     * there, and what is left is a comfortable, practised release rather than
     * a sixtieth-of-a-second test. Clear the rim easily and there is no bar at
     * all. Contest still tightens it — a body at the rim is the one thing that
     * can still make a dunk a bad idea. */
    if (type === 'dunk') {
      const c = U.clamp01(contest || 0);
      return Math.max(0.010, base * (1 - c * 0.40));
    }

    const difficulty = U.clamp01(U.remap(dist, 9, 32, 0, 1));
    const shrink = difficulty * U.lerp(0.82, 0.22, skill);
    let w = Math.max(0.006, base * (1 - shrink));

    // A hand in your face doesn't take away a shot you've already timed
    // perfectly (see solveShot) - it makes timing it perfectly harder in
    // the first place, same as distance does. A better shooter shrugs off
    // more of it, same curve as the distance/rating tradeoff above.
    const c = U.clamp01(contest || 0);
    if (c > 0) {
      const contestShrink = c * U.lerp(0.46, 0.14, skill);
      w *= (1 - contestShrink);
    }
    return Math.max(0.004, w);
  }

  /* ==========================================================================
   * Grading
   * ======================================================================= */
  /**
   * @param {number} value meter fill at release
   * @param {object} profile release profile
   * @returns {{tier:object, error:number, quality:number, late:boolean}}
   *   error is signed: negative = early, positive = late, in meter units.
   */
  function grade(value, profile) {
    const err = value - profile.target;
    const a = Math.abs(err);
    const g = profile.greenWindow;
    const late = err > 0;

    let tier;
    if (a <= g) tier = TIER.PERFECT;
    else if (a <= g * 3.0) tier = late ? TIER.SLIGHTLY_LATE : TIER.SLIGHTLY_EARLY;
    else if (a <= g * 4.5) tier = late ? TIER.LATE : TIER.EARLY;
    else tier = late ? TIER.VERY_LATE : TIER.VERY_EARLY;

    // "Excellent" sits between perfect and slightly-off, on the good side only.
    if (tier !== TIER.PERFECT && a <= g * 1.5) tier = TIER.EXCELLENT;

    return { tier, error: err, quality: tier.quality, late };
  }

  /**
   * The grade a shot gets when there was never a meter to time.
   *
   * A dunk with real room over the rim skips the bar entirely (see
   * Player#dunkHeadroom), and something still has to be handed to solveShot.
   * Synthesizing a PERFECT here rather than passing null routes it down the
   * existing `guaranteed` path — zero systematic bias, capped spread — which
   * is exactly the promise being made by not showing a meter in the first
   * place. Passing null instead would quietly grade it as a mediocre 0.62.
   */
  function autoGrade() {
    return { tier: TIER.PERFECT, error: 0, quality: TIER.PERFECT.quality, late: false };
  }

  /* ==========================================================================
   * Outcome model
   * ======================================================================= */
  /**
   * Turn a shot attempt into a launch solution.
   *
   * @param {object} p {
   *   from:    {x, y, z}
   *   hoop:    hoop definition
   *   grade:   result from grade(), or null for an ungraded/AI shot
   *   rating:  0..100 relevant shooting attribute
   *   contest: 0..1 how well the shot is challenged
   *   fatigue: 0..1 (1 = gassed)
   *   zone:    -1 cold, 0 neutral, +1 hot
   *   moving:  0..1 how much lateral movement at release
   *   rng:     optional seeded rng
   * }
   * @returns {{errX:number, errY:number, errShort:number, apex:number,
   *            quality:number, distance:number, isThree:boolean}}
   */
  function solveShot(p) {
    const rng = p.rng || U.rng;
    const hoop = p.hoop;
    const dx = hoop.x - p.from.x;
    const dy = hoop.y - p.from.y;
    const dist = Math.hypot(dx, dy);
    const three = U.isThree(p.from.x, p.from.y, hoop);

    /* ---- quality: 0 (hopeless) .. 1 (dead centre) ----------------------- */
    const rating = U.clamp((p.rating == null ? 70 : p.rating), 25, 99);
    // Ratings curve: 25 -> 0.20, 70 -> 0.62, 99 -> 0.97. Deliberately steep at
    // the top so elite shooters feel elite.
    const skill = Math.pow(U.invLerp(20, 105, rating), 1.25);

    const timing = p.grade ? p.grade.quality : 0.62;

    // Distance falls off gently to the arc, then bites hard beyond ~27ft.
    const distPenalty = dist <= 10
      ? 0
      : (dist <= 23.75
        ? U.remap(dist, 10, 23.75, 0, 0.16)
        : 0.16 + U.remap(dist, 23.75, 34, 0, 0.34));

    const contest = U.clamp01(p.contest || 0);
    const contestPenalty = contest * (0.28 + (1 - skill) * 0.20);
    const fatiguePenalty = U.clamp01(p.fatigue || 0) * 0.15;
    const movingPenalty = U.clamp01(p.moving || 0) * 0.10;
    const zoneBonus = (p.zone || 0) * 0.06;

    // Timing is the dominant term, not one of several equally-weighted
    // inputs. A green release gets its own near-guaranteed path below —
    // the difficulty of a green shot already lives in how narrow that
    // window is to hit in the first place (tighter for a low-rated
    // shooter), so re-discounting it again by rating here would punish the
    // same thing twice. Every other tier still leans on rating/distance/
    // fatigue/movement the way a real, less-than-perfect shot should.
    const isGreen = !!(p.grade && p.grade.tier && p.grade.tier.key === 'PERFECT');
    const isExcellent = !!(p.grade && p.grade.tier && p.grade.tier.key === 'EXCELLENT');
    const isSlightly = !!(p.grade && p.grade.tier &&
      (p.grade.tier.key === 'SLIGHTLY_EARLY' || p.grade.tier.key === 'SLIGHTLY_LATE'));
    const isLayup = p.type === 'layup';
    const isDunk = p.type === 'dunk';

    let quality;
    if (isGreen || isExcellent || isSlightly) {
      // Anything that reads as green on the bar is a guaranteed swish, full
      // stop - no exceptions, no contest/distance/fatigue roll on top of it.
      // Perfect is the core band; Excellent and Slightly Early/Late are the
      // two lighter-green halos drawn just outside it (see draw()) - all
      // three read as "green" to the player, so all three are automatic.
      quality = 1.0;
    } else if (isDunk) {
      /* A dunk is the highest-percentage shot in basketball, and the model
       * should say so: the ball is being carried through the ring by hand
       * from a few inches away, so there is very little for physics to get
       * wrong. The floor is high and comes off the dunk rating.
       *
       * What can still ruin it is a body in the way — contest bites harder
       * here than on a layup, because a dunk commits you completely and there
       * is no adjusting once you have left the floor — and a genuinely bad
       * release, which matters more than on a layup (you are trying to put
       * the ball in a specific place at a specific height, not float it off
       * the glass) but nowhere near as much as on a jump shot. */
      const ratingFactor = U.remap(rating, 25, 99, 0.74, 0.97);
      quality = U.clamp01(ratingFactor - contest * 0.30
        - U.clamp01(p.fatigue || 0) * 0.06 - (1 - timing) * 0.22);
    } else if (isLayup) {
      // A layup's real difficulty is getting all the way to the rim, not
      // split-second timing — even a mistimed release should still be a
      // good look, roughly a ~70% shot for an average finisher. Timing
      // still nudges it (a totally rushed release is worse than a near
      // miss of green) but nowhere near as sharply as a jump shot.
      const ratingFactor = U.remap(rating, 25, 99, 0.68, 0.94);
      quality = U.clamp01(ratingFactor - contest * 0.34
        - U.clamp01(p.fatigue || 0) * 0.06 - (1 - timing) * 0.10);
    } else {
      const timingCeiling = 0.74 + skill * 0.26;
      const forgiveness = timing * timing;
      const softPenalty = (distPenalty + fatiguePenalty + movingPenalty) * (1 - forgiveness * 0.85);
      quality = U.clamp01(timing * timingCeiling + zoneBonus - softPenalty - contestPenalty);
    }

    /* ---- aim error in feet ---------------------------------------------- */
    // sigma collapses hard as quality approaches 1: a true green, uncontested
    // shot lands within a few inches almost every time, matching the ~98%
    // make rate a perfect release is supposed to feel like. Below that it
    // opens up quickly, so timing and defense both still read clearly.
    const sigma = U.lerp(1.55, 0.050, Math.pow(quality, 2.15));

    // Release timing pushes the ball short or long along the shot line. A
    // layup travels only a few feet, so the same timing-driven bias used for
    // a 15-24ft jumper would send it flying well past the rim — scaled way
    // down to match the distance.
    //
    // Guaranteed tiers only suppress the RANDOM spread via quality/sigma —
    // this bias is a SEPARATE, systematic long/short push straight off the
    // raw release error, and it was never being zeroed out for them. A
    // release anywhere in Excellent/Slightly (not dead-on the exact target)
    // still has real error to it, and that error was still shoving the shot
    // off-line by a meaningful distance even while sigma was tiny — which is
    // exactly how a "guaranteed" release could still miss. If it's
    // guaranteed, it's guaranteed: zero systematic bias too.
    const guaranteed = isGreen || isExcellent || isSlightly;
    const timingBias = p.grade
      ? -p.grade.error * (guaranteed ? 0 : (three ? 7.0 : (isLayup ? 1.6 : (isDunk ? 1.2 : 4.6))))
      : rng.gauss(0, 0.35);

    // A tiny sigma still has a real tail — an unlucky draw a couple standard
    // deviations out was, at longer range, sometimes still enough lateral
    // drift for the ball to physically clip the rim's collision geometry
    // (not miss cleanly, just catch the edge) and get stuck jittering
    // against it for the better part of a second instead of dropping
    // straight through. A guaranteed tier can't be "guaranteed, minus
    // whatever the gaussian tail feels like today" — it gets a hard cap on
    // top of the small sigma, and contest doesn't get to widen it at all
    // (the whole point is that contest no longer matters once it's green).
    const CAP = 0.028;
    const along = guaranteed
      ? U.clamp(rng.gauss(0, sigma * 1.15), -CAP, CAP)
      : timingBias + rng.gauss(0, sigma * 1.15);
    const lateral = guaranteed
      ? U.clamp(rng.gauss(0, sigma), -CAP, CAP)
      : rng.gauss(0, sigma) * (1 + contest * 0.5);

    const ux = dist > 0.01 ? dx / dist : 1;
    const uy = dist > 0.01 ? dy / dist : 0;

    return {
      errX: ux * along - uy * lateral,
      errY: uy * along + ux * lateral,
      // A hair of vertical error keeps identical shots from being identical.
      errShort: guaranteed ? U.clamp(rng.gauss(0, sigma * 0.16), -CAP * 0.5, CAP * 0.5) : rng.gauss(0, sigma * 0.16),
      // A steeper arc comes down closer to vertical, which is real physical
      // clearance around the rim's shape, not just a smaller aim error. At
      // some distances the "normal" arc grazes the rim close enough that
      // even a tiny residual error can catch the edge and jitter/miss — a
      // guaranteed tier can't be riding that geometry that close, so it
      // gets extra height on top of the usual arc as real insurance. Deeper
      // shots need proportionally more of it (the grazing risk gets worse
      // with distance, not constant), so this scales up past ~24ft rather
      // than adding a single flat amount everywhere.
      apex: arcHeight(dist, p.from.z || 6, quality) + (guaranteed ? 0.7 + Math.max(0, dist - 24) * 0.35 : 0),
      quality,
      distance: dist,
      isThree: three
    };
  }

  /** Peak height above the rim. Longer shots need a flatter, faster arc. */
  function arcHeight(dist, releaseZ, quality) {
    const base = U.remap(dist, 2, 30, 3.4, 6.8);
    const wobble = (1 - quality) * 0.8;
    return Math.max(1.6, base + wobble - Math.max(0, releaseZ - 7) * 0.35);
  }

  /**
   * Build a release profile from a player's attributes. Higher ratings give a
   * slightly wider green window and a faster, later release.
   */
  function profileFromRatings(r, seed) {
    const rng = U.makeRng(seed || 1);
    const shot = ((r.midRange || 70) + (r.threePoint || 70)) * 0.5;
    return makeReleaseProfile({
      riseTime: U.remap(shot, 25, 99, 0.78, 0.46) * rng.f(0.94, 1.06),
      target: U.clamp(rng.f(0.93, 0.97), 0.90, 0.99),
      greenWindow: U.remap(shot, 25, 99, 0.026, 0.062),
      name: 'custom'
    });
  }

  BB.Shooting = {
    TIER, ShotMeter, grade, autoGrade, solveShot, arcHeight,
    makeReleaseProfile, profileFromRatings, greenWindowFor
  };
})(typeof window !== 'undefined' ? window : globalThis);
