/* =============================================================================
 * hud.js  —  The broadcast scorebug.
 * -----------------------------------------------------------------------------
 * The HUD is DOM, not canvas. Text stays perfectly crisp at any DPI, it costs
 * nothing per frame when nothing changed, and it keeps presentation logic
 * completely out of the simulation.
 *
 * Every write goes through set(), which diffs against the previous value so a
 * static clock digit never touches the DOM.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U;

  const HUD = {
    root: null,
    el: {},
    _prev: Object.create(null),
    _safe: null,
    visible: false,

    init() {
      this.root = document.getElementById('hud');
      const q = (id) => document.getElementById(id);
      this.el = {
        awayAbbr: q('hud-away-abbr'),
        awayScore: q('hud-away-score'),
        awayCard: q('hud-away'),
        awayPoss: q('hud-away-poss'),
        awayBonus: q('hud-away-bonus'),
        awayTo: q('hud-away-to'),
        awayStamina: q('hud-away-stamina'),

        homeAbbr: q('hud-home-abbr'),
        homeScore: q('hud-home-score'),
        homeCard: q('hud-home'),
        homePoss: q('hud-home-poss'),
        homeBonus: q('hud-home-bonus'),
        homeTo: q('hud-home-to'),
        homeStamina: q('hud-home-stamina'),

        clock: q('hud-clock'),
        period: q('hud-period'),
        shot: q('hud-shot'),
        shotWrap: q('hud-shot-wrap'),

        banner: q('hud-banner'),
        bannerText: q('hud-banner-text'),
        bannerSub: q('hud-banner-sub'),
        toast: q('hud-toast')
      };
      global.addEventListener('resize', () => { this._safe = null; });
      return this;
    },

    show() {
      if (this.muted) return;
      this.visible = true; this._safe = null; this.root.classList.add('is-live');
    },
    hide() { this.visible = false; this.root.classList.remove('is-live'); },

    /* Silences the whole broadcast layer — scorebug, banners, toasts.
     *
     * The walkthrough needs this because it borrows the 1 vs 1 scene, and that
     * scene calls HUD.banner and HUD.toast from a dozen places. Muting the
     * presentation once beats threading an `if (practice)` through every one
     * of them, and it cannot be forgotten at a new call site later. */
    mute(on) {
      this.muted = !!on;
      if (on) this.hide();
    },

    /** Takes the scorebug away while an instant replay is on screen. */
    setReplay(on) { this.root.classList.toggle('is-replay', !!on); },

    /**
     * Where the scorebug ends, in CSS pixels down from the top of the window.
     *
     * The scorebug is DOM and the shot meter is canvas underneath it, so
     * anything the meter draws up here is simply painted over — and because
     * the meter fills bottom-to-top, the part it loses is the top, which is
     * exactly where the green window lives. Rather than have the meter guess
     * at a margin, it asks.
     *
     * Measured off the layout box (offsetTop/offsetHeight) rather than
     * getBoundingClientRect, because the bug slides down under a transform
     * when it appears and the transformed box would read high for the length
     * of that animation. Cached: the size is fixed by CSS, so it only changes
     * on a resize.
     */
    safeTop() {
      if (!this.visible) return 0;
      if (this._safe == null) {
        const bug = this.root && this.root.querySelector('.hud-bug');
        this._safe = bug ? bug.offsetTop + bug.offsetHeight : 0;
      }
      return this._safe;
    },

    /** Paint the fixed identity of both teams. Call once per game. */
    setTeams(away, home) {
      this._write('awayAbbr', away.abbr);
      this._write('homeAbbr', home.abbr);
      this.el.awayCard.style.setProperty('--team', away.primary);
      this.el.homeCard.style.setProperty('--team', home.primary);
      this.el.awayCard.style.setProperty('--team-2', away.secondary);
      this.el.homeCard.style.setProperty('--team-2', home.secondary);
    },

    /**
     * @param {object} s Partial state; only supplied keys are touched.
     *   awayScore, homeScore, quarter, gameClock, shotClock, possession
     *   ('away'|'home'|null), awayBonus, homeBonus, awayTimeouts, homeTimeouts
     */
    set(s) {
      if (s.awayScore != null) this._write('awayScore', s.awayScore);
      if (s.homeScore != null) this._write('homeScore', s.homeScore);

      if (s.gameClock != null) {
        this._write('clock', U.clockText(s.gameClock, true));
        this._toggle(this.el.clock, 'is-urgent', s.gameClock <= 60);
      }
      if (s.quarter != null) this._write('period', periodLabel(s.quarter));

      if (s.shotClock != null) {
        const off = s.shotClock < 0;
        this._toggle(this.el.shotWrap, 'is-off', off);
        this._write('shot', off ? '—' : (s.shotClock < 10 ? s.shotClock.toFixed(1) : Math.ceil(s.shotClock).toString()));
        this._toggle(this.el.shotWrap, 'is-urgent', !off && s.shotClock <= 5);
      }

      if (s.possession !== undefined) {
        this._toggle(this.el.awayPoss, 'is-on', s.possession === 'away');
        this._toggle(this.el.homePoss, 'is-on', s.possession === 'home');
      }
      if (s.awayBonus !== undefined) this._toggle(this.el.awayBonus, 'is-on', !!s.awayBonus);
      if (s.homeBonus !== undefined) this._toggle(this.el.homeBonus, 'is-on', !!s.homeBonus);
      if (s.awayTimeouts != null) this._dots(this.el.awayTo, s.awayTimeouts);
      if (s.homeTimeouts != null) this._dots(this.el.homeTo, s.homeTimeouts);
    },

    /** Live stamina readout, 0..1, for either side. Cheap to call every
     * frame - diffs against the last value so a steady-state fresh/gassed
     * player doesn't touch the DOM at all. */
    setStamina(side, value) {
      const el = side === 'away' ? this.el.awayStamina : this.el.homeStamina;
      if (!el) return;
      const pct = Math.round(U.clamp01(value) * 100);
      const key = side + 'Stamina';
      if (this._prev[key] === pct) return;
      this._prev[key] = pct;
      el.style.width = pct + '%';
      el.classList.toggle('is-low', pct <= 55 && pct > 25);
      el.classList.toggle('is-gassed', pct <= 25);
    },

    /** Big centre-screen callout: END OF 1ST, SHOT CLOCK VIOLATION, and so on. */
    banner(text, sub, ms) {
      if (this.muted) return;
      const b = this.el.banner;
      this.el.bannerText.textContent = text;
      this.el.bannerSub.textContent = sub || '';
      b.classList.remove('is-on');
      // Force a reflow so the animation restarts on a repeated call.
      void b.offsetWidth;
      b.classList.add('is-on');
      clearTimeout(this._bannerT);
      this._bannerT = setTimeout(() => b.classList.remove('is-on'), ms || 1800);
    },

    /** Small corner note: "24-second reset", control hints, etc. */
    toast(text, ms) {
      if (this.muted) return;
      const t = this.el.toast;
      t.textContent = text;
      t.classList.remove('is-on');
      void t.offsetWidth;
      t.classList.add('is-on');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => t.classList.remove('is-on'), ms || 2200);
    },

    /* ------------------------------------------------------------- internals */
    _write(key, value) {
      if (this._prev[key] === value) return;
      this._prev[key] = value;
      const el = this.el[key];
      if (el) el.textContent = value;
    },

    _toggle(el, cls, on) {
      if (!el) return;
      if (el.classList.contains(cls) === !!on) return;
      el.classList.toggle(cls, !!on);
    },

    _dots(el, n) {
      if (!el || el._n === n) return;
      el._n = n;
      let html = '';
      for (let i = 0; i < 7; i++) html += '<i class="' + (i < n ? 'on' : '') + '"></i>';
      el.innerHTML = html;
    }
  };

  function periodLabel(q) {
    if (q <= 4) return ['1ST', '2ND', '3RD', '4TH'][q - 1];
    return q === 5 ? 'OT' : 'OT' + (q - 4);
  }
  HUD.periodLabel = periodLabel;

  BB.HUD = HUD;
})(typeof window !== 'undefined' ? window : globalThis);
