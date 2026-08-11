/* =============================================================================
 * tutorial.js  —  The walkthrough: drills you actually have to complete.
 * -----------------------------------------------------------------------------
 * The How to Play screen can tell somebody that sprint is held rather than
 * tapped. It cannot tell whether they have done it. This is the half that can:
 * a run of drills on a live court, each one watching the player's own state
 * until the thing it asked for has actually happened, then moving on.
 *
 * It is the 1 vs 1 scene with a coach standing over it. Object.create over the
 * registered scene means every drill runs against the real game — the real
 * movement, the real shot meter, the real defender — rather than against a
 * simplified copy that could drift away from it. Only the things that would
 * get in a learner's way are overridden: nobody wins, so a drill cannot be cut
 * short by somebody reaching eleven.
 *
 * Each drill is a `done` predicate over state that already exists. Nothing here
 * reaches into the player to instrument it; if a drill cannot be judged from
 * what the game already tracks, that is a sign the drill is vague.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U;

  /* Every drill: what to say, how to judge it, and how much of it is done.
   *
   * `test(t, dt)` runs every fixed step with the coach as `t`. Returning a
   * number 0..1 reports progress; returning true completes immediately. `t.k`
   * is scratch space cleared between drills so a drill can count things.
   */
  const DRILLS = [
    {
      id: 'move',
      title: 'Get moving',
      task: 'Run 25 feet in any direction.',
      why: 'Movement is relative to the CAMERA, not the court. Push the way you want to go on screen.',
      keys: ['up', 'left', 'down', 'right'],
      test(t, dt) {
        const p = t.pl;
        t.k.d = (t.k.d || 0) + Math.hypot(p.vx, p.vy) * dt;
        return U.clamp01(t.k.d / 25);
      }
    },
    {
      id: 'sprint',
      title: 'Sprint',
      task: 'Hold sprint and keep running for 2 seconds.',
      why: 'Sprint is held, not tapped. It burns stamina, and a gassed player is slower and shoots worse.',
      keys: ['sprint'],
      test(t, dt) {
        const p = t.pl;
        if (p.sprinting) t.k.s = (t.k.s || 0) + dt;
        else t.k.s = Math.max(0, (t.k.s || 0) - dt * 1.5);
        return U.clamp01(t.k.s / 2);
      }
    },
    {
      id: 'dribble',
      title: 'Move the ball',
      task: 'Pull off 3 dribble moves.',
      why: 'On its own it is a hesitation. Add a direction for a crossover, or hold sprint for a spin.',
      keys: ['dribble'],
      enter(t) { t.giveBall(); },
      test(t, dt) {
        const p = t.pl;
        t.ensureBall(p, dt);
        // _lastMoveT is stamped every time a move starts, off the anim clock.
        if (t.k.last == null) t.k.last = p._lastMoveT;
        if (p._lastMoveT !== t.k.last) { t.k.last = p._lastMoveT; t.k.n = (t.k.n || 0) + 1; }
        return U.clamp01((t.k.n || 0) / 3);
      }
    },
    {
      id: 'shoot',
      title: 'Put it in the hoop',
      task: 'Score 2 baskets.',
      why: 'Hold to gather, release at the top of the meter. Release inside the green window for the best chance the shot has.',
      keys: ['shoot'],
      enter(t) { t.giveBall(); },
      test(t, dt) {
        t.ensureBall(t.pl, dt);
        return U.clamp01(t.made() / 2);
      }
    },
    {
      id: 'three',
      title: 'Step out',
      task: 'Score once from behind the three-point line.',
      why: 'Distance costs you. Range comes off the rating, and a bad release costs more than the extra foot ever gains.',
      keys: ['shoot'],
      enter(t) { t.giveBall(); },
      test(t, dt) {
        t.ensureBall(t.pl, dt);
        return t.threes() >= 1;
      }
    },
    {
      id: 'stance',
      title: 'Get in a stance',
      task: 'Hold the defence key and stay in front of the CPU for 3 seconds.',
      why: 'In a stance your hips drop, your base widens, and you stay pointed at the ball handler however you slide.',
      keys: ['intense'],
      // The partner attacks but never shoots, so the stand can actually be
      // held for three seconds instead of ending in a jumper after one.
      partner: 'attack',
      enter(t) { t.giveBall(t.foe); },
      test(t, dt) {
        const p = t.pl, foe = t.foe;
        t.ensureBall(foe, dt);
        // guardQuality is the same 0..1 the contest maths reads: close, between
        // them and the rim, square, and in a stance — multiplied, not summed.
        /* Judged off defenseQuality, not a raw per-tick guardQuality.
         *
         * defenseQuality is the smoothed number the game already uses for the
         * ring under your feet and for the contest on the shot — so the drill
         * is asking for exactly the thing the player can SEE. Grading against
         * the raw per-tick value instead would tick the bar up and down on
         * frames where nothing the player did changed. */
        const q = p.defenseQuality || 0;
        if (p.isGuarding && q > 0.5) t.k.g = (t.k.g || 0) + dt;
        else t.k.g = Math.max(0, (t.k.g || 0) - dt * 0.6);
        return U.clamp01(t.k.g / 3);
      }
    },
    {
      id: 'stop',
      title: 'Get a stop',
      task: 'Make the CPU miss while you are guarding them.',
      why: 'A defender who is set, square and close takes a makeable shot and makes it bad. That is the whole job.',
      keys: ['intense'],
      // This one wants a shot to contest, so the partner is let off the leash.
      partner: 'shoot',
      enter(t) { t.giveBall(t.foe); },
      test(t, dt) {
        if (!(t.k.miss > 0)) t.ensureBall(t.foe, dt);
        return (t.k.miss || 0) >= 1;
      }
    }
  ];

  /* ------------------------------------------------------------------ coach */

  function Coach() {}

  const Tutorial = {
    DRILLS,

    /** Builds the scene once the 1 vs 1 scene it delegates to is registered.
     * Idempotent, because it is called from both ends: game.js asks for it as
     * soon as it has registered its own scenes, and this file asks again when
     * it loads. Whichever happens second is the one that finds a base to
     * delegate to — script order decides, and neither end should have to know
     * which it is. */
    install() {
      if (BB.Engine.scenes.tutorialDrills) return true;
      const base = BB.Engine.scenes.oneVone;
      if (!base) return false;

      const scene = Object.create(base);

      /* Nobody wins a tutorial. The base scene ends the game the moment
       * somebody reaches the target, which would tear the court down in the
       * middle of a drill the player is halfway through. */
      scene._checkWin = function () {};

      scene.enter = function (params, prev) {
        base.enter.call(this, params, prev);
        this.isTutorial = true;

        /* A drill is not a game. The scene underneath keeps a score, runs a
         * clock, calls a play-by-play man and throws SWISH! across the screen
         * — all correct for 1 vs 1 and all wrong here, where the only thing
         * that should be on screen is the drill you are being asked to do.
         *
         * Silenced at the presentation layer rather than by threading a flag
         * through every call site, so nothing added to the scene later can
         * leak a banner into the walkthrough by forgetting a condition. */
        BB.HUD.mute(true);
        BB.Commentary.mute(true);
        this.step = 0;
        this.k = {};
        this.progress = 0;
        this._holdDone = 0;
        this.pl = this.player;
        this.foe = this.ai;
        this._madeAt = this.score.you;
        this._threeAt = 0;
        this._buildPanel();
        this._enterDrill();
      };

      scene.exit = function () {
        this._killPanel();
        BB.HUD.mute(false);
        BB.Commentary.mute(false);
        if (this.foe) this.foe.noShoot = false;
        if (base.exit) base.exit.call(this);
      };

      /* ---- the bits drills are allowed to ask for */

      /* Hand possession over through the scene's own check-ball restart —
       * the same path a made basket takes. Poking ball.owner directly leaves
       * the two players standing wherever the last drill left them, and skips
       * the bookkeeping that clears the previous holder's hasBall. */
      scene.giveBall = function (who) {
        const p = who || this.pl;
        this._startCheck(p, p === this.pl ? this.foe : this.pl);
      };

      /* Re-check the ball only once it has genuinely gone dead. A shot in
       * flight belongs to nobody, so testing possession alone would snatch the
       * ball back out of the air mid-attempt. */
      scene.ensureBall = function (who, dt) {
        if (who.hasBall) { this._loose = 0; return; }
        this._loose = (this._loose || 0) + dt;
        if (this._loose > 1.6) { this._loose = 0; this.giveBall(who); }
      };
      scene.made = function () { return Math.max(0, this.score.you - this._madeAt); };
      scene.threes = function () { return this._threeAt; };

      /* Count a three off the same event the scoreboard uses, so "from behind
       * the line" means whatever the scorer already decided it meant. */
      const baseScore = base._onScore;
      scene._onScore = function (e) {
        if (e && e.shooter === this.player && e.three) this._threeAt++;
        if (baseScore) baseScore.call(this, e);
      };
      const baseMiss = base._onMiss;
      scene._onMiss = function (e) {
        if (e && e.shooter === this.ai) this.k.miss = (this.k.miss || 0) + 1;
        if (baseMiss) baseMiss.call(this, e);
      };

      scene.fixedUpdate = function (dt) {
        base.fixedUpdate.call(this, dt);
        if (BB.Menus.isOpen) return;
        const d = DRILLS[this.step];
        if (!d) return;

        const r = d.test(this, dt);
        this.progress = r === true ? 1 : (r === false ? 0 : U.clamp01(r || 0));

        if (this.progress >= 1) {
          // A short beat on a finished drill, so completing one is something
          // the player sees land rather than a panel that vanishes mid-input.
          this._holdDone += dt;
          if (this._holdDone > 1.1) this._advance();
        } else {
          this._holdDone = 0;
        }
        this._paintPanel();
      };

      scene._enterDrill = function () {
        const d = DRILLS[this.step];
        this.k = {};
        this.progress = 0;
        this._holdDone = 0;
        this._madeAt = this.score.you;
        this._threeAt = 0;
        if (!d) return;
        // Everything except the two defensive drills wants a partner that
        // stays out of the way; 'attack' drives without shooting, 'shoot'
        // plays normally so there is something to contest.
        this.foe.noShoot = d.partner !== 'shoot';
        if (d.enter) d.enter(this);
        this._paintPanel(true);
      };

      scene._advance = function () {
        this.step++;
        if (this.step >= DRILLS.length) { this._finish(); return; }
        if (BB.Audio) BB.Audio.play('uiSelect');
        this._enterDrill();
      };

      scene.skip = function () { this._advance(); };

      scene._finish = function () {
        this._killPanel();
        BB.Engine.setState('menu');
        BB.Menus.replace('main');
        BB.Menus.push('tutorialDone');
      };

      /* ---- the panel
       * Built as DOM rather than painted into the scene: it carries live key
       * caps, and those have to come from Input.label so a rebound control
       * teaches the truth. */
      scene._buildPanel = function () {
        this._killPanel();
        const el = document.createElement('div');
        el.className = 'coach';
        el.innerHTML =
          '<div class="coach__step"></div>' +
          '<h3 class="coach__title"></h3>' +
          '<p class="coach__task"></p>' +
          '<div class="coach__keys"></div>' +
          '<div class="coach__bar"><i></i></div>' +
          '<p class="coach__why"></p>' +
          '<button class="coach__skip" type="button">Skip this drill</button>';
        document.body.appendChild(el);
        el.querySelector('.coach__skip').addEventListener('click', () => {
          BB.Audio && BB.Audio.play('uiBack');
          this.skip();
        });
        this._panel = el;
      };

      scene._killPanel = function () {
        if (this._panel && this._panel.parentNode) this._panel.parentNode.removeChild(this._panel);
        this._panel = null;
      };

      scene._paintPanel = function (full) {
        const el = this._panel, d = DRILLS[this.step];
        if (!el || !d) return;
        if (full || el.dataset.id !== d.id) {
          el.dataset.id = d.id;
          el.querySelector('.coach__step').textContent =
            'Drill ' + (this.step + 1) + ' of ' + DRILLS.length;
          el.querySelector('.coach__title').textContent = d.title;
          el.querySelector('.coach__task').textContent = d.task;
          el.querySelector('.coach__why').textContent = d.why;
          el.querySelector('.coach__keys').innerHTML = (d.keys || [])
            .map((k) => '<kbd class="key__cap">' + BB.Input.label(k) + '</kbd>').join('');
          el.classList.remove('is-done');
        }
        el.querySelector('.coach__bar i').style.width = Math.round(this.progress * 100) + '%';
        el.classList.toggle('is-done', this.progress >= 1);
      };

      BB.Engine.register('tutorialDrills', scene);
      this.scene = scene;
      return true;
    }
  };

  BB.Tutorial = Tutorial;
  BB.Coach = Coach;

  // game.js registers oneVone and then asks for this, but it runs before this
  // file has loaded, so that call finds no BB.Tutorial. This is the one that
  // actually lands.
  Tutorial.install();
})(typeof window !== 'undefined' ? window : globalThis);
