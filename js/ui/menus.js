/* =============================================================================
 * menus.js  —  Screen stack and all front-end screens.
 * -----------------------------------------------------------------------------
 * Screens are plain objects: { id, build() -> html, mount(el), unmount() }.
 * The manager owns a stack, so a screen opened from another returns to it on
 * cancel without either screen knowing about the other.
 *
 * Navigation uses real <button> elements and native focus. Arrow keys move
 * focus, Enter activates, Escape pops — which also means the whole front end is
 * keyboard and screen-reader navigable for free.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, A = BB.Audio;

  const Menus = {
    root: null,
    stack: [],
    screens: Object.create(null),
    _busy: false,

    init() {
      this.root = document.getElementById('screens');
      this.root.addEventListener('keydown', (e) => this._onKey(e));
      registerScreens(this);
      return this;
    },

    define(screen) { this.screens[screen.id] = screen; return this; },

    get top() { return this.stack.length ? this.stack[this.stack.length - 1] : null; },
    get isOpen() { return this.stack.length > 0; },

    /* -------------------------------------------------------------- stack ops */
    push(id, params) {
      const screen = this.screens[id];
      if (!screen || this._busy) return;
      const prev = this.top;
      if (prev) prev.el.classList.add('is-behind');

      const el = document.createElement('div');
      el.className = 'screen screen--' + id;
      el.setAttribute('role', 'group');
      el.innerHTML = screen.build(params || {});
      this.root.appendChild(el);

      const entry = { id, screen, el, params: params || {} };
      this.stack.push(entry);
      if (screen.mount) screen.mount(el, entry.params, this);

      // Kick the entry animation on the next frame so CSS sees the change.
      requestAnimationFrame(() => el.classList.add('is-in'));
      focusFirst(el);
      this.root.classList.add('is-active');
      A.play('uiSelect');
      return entry;
    },

    pop() {
      if (!this.stack.length) return;
      const entry = this.stack.pop();
      if (entry.screen.unmount) entry.screen.unmount(entry.el);
      entry.el.classList.remove('is-in');
      entry.el.classList.add('is-out');
      const el = entry.el;
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 240);

      const prev = this.top;
      if (prev) {
        prev.el.classList.remove('is-behind');
        focusFirst(prev.el);
      } else {
        this.root.classList.remove('is-active');
      }
      A.play('uiBack');
    },

    replace(id, params) {
      while (this.stack.length) this.popImmediate();
      return this.push(id, params);
    },

    popImmediate() {
      const entry = this.stack.pop();
      if (!entry) return;
      if (entry.screen.unmount) entry.screen.unmount(entry.el);
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
      if (!this.stack.length) this.root.classList.remove('is-active');
    },

    closeAll() {
      while (this.stack.length) this.popImmediate();
    },

    /* ------------------------------------------------------------- keyboard */
    _onKey(e) {
      if (!this.stack.length) return;
      const top = this.top;
      if (top.el.querySelector('.is-rebinding')) return;   // rebind capture owns keys

      if (e.key === 'Escape') {
        e.preventDefault();
        if (top.screen.onCancel) top.screen.onCancel(this);
        else if (this.stack.length > 1) this.pop();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.prototype.slice.call(top.el.querySelectorAll('[data-nav]:not([disabled])'));
        if (!items.length) return;
        e.preventDefault();
        let i = items.indexOf(document.activeElement);
        i = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[i].focus();
        A.play('uiMove');
      }
    }
  };

  function focusFirst(el) {
    const f = el.querySelector('[data-autofocus]') || el.querySelector('[data-nav]:not([disabled])');
    if (f) f.focus();
  }

  /* ========================================================================
   * Screen definitions
   * ===================================================================== */
  function registerScreens(M) {

    /* ------------------------------------------------------------ main menu
     *
     * A front page rather than a list: one row of modes across the top, and
     * whichever mode the cursor is on gets the whole left column to explain
     * itself — what kind of thing it is, a sentence about it, and one button
     * that starts it. Nothing is buried in a submenu, and the scene behind is
     * left showing on the right, where the standby camera holds a live player
     * who changes what he is doing with the selection. The front end and the
     * game are obviously the same thing, because they are.
     *
     * MODES is the entire menu. Every mode this build has appears here exactly
     * once and owns its own copy, its action, and the pose the standby player
     * strikes while it is selected.
     */
    const MODES = [
      {
        id: 'oneVone', tab: '1 vs 1', title: '1 vs 1', pose: 'dribble',
        tags: ['Half Court', 'First to 11', 'Live Defender'],
        body: 'Take an AI defender off the dribble, one on one. Crossovers, ' +
              'step-backs and contested jumpers, with the real ruleset behind ' +
              'them — travels, fouls, and a shot clock that does not care ' +
              'how open you thought you were.',
        cta: 'Play 1 vs 1',
        act: function () { M.closeAll(); BB.Engine.setState('oneVone'); }
      },
      {
        id: 'fiveVfive', tab: '5 vs 5', title: '5 vs 5', pose: 'guard',
        tags: ['Full Court', 'Quarters', 'Team Control'],
        body: 'A full team game with a running clock, quarters, team fouls ' +
              'and the bonus. Control any player on the floor and switch on ' +
              'the fly — the other nine run their own offence and defence ' +
              'while you do.',
        cta: 'Play 5 vs 5',
        act: function () { M.closeAll(); BB.Engine.setState('fiveVfive'); }
      },
      {
        id: 'shootaround', tab: 'Shootaround', title: 'Shootaround', pose: 'shoot',
        tags: ['Free Practice', 'No Clock', 'Streaks'],
        body: 'An open gym and as many shots as you want. Learn the release ' +
              'meter, work on your range, and watch the streak counter climb. ' +
              'Nothing is guarding you and nothing is being scored against you.',
        cta: 'Start Shooting',
        act: function () { M.closeAll(); BB.Engine.setState('shootaround'); }
      },
      {
        id: 'createPlayer', tab: 'My Player', title: 'My Player', pose: 'idle',
        tags: ['Build', 'Appearance', 'Ratings'],
        body: 'Name, number, position, height, build and colours, plus the ' +
              'ratings that decide how this player actually moves and shoots. ' +
              'Whoever you make here is who you are in every other mode.',
        cta: 'Open Creator',
        status: function () {
          const p = BB.PlayerProfile.load();
          return p ? (p.name + '  ·  #' + p.number + '  ·  ' + p.position)
                   : 'No player saved yet';
        },
        act: function () { M.push('createPlayer'); }
      },
      {
        id: 'career', tab: 'Career', title: 'Career', pose: 'celebrate',
        tags: ['Progression', 'Upgrades', 'Record'],
        body: 'Every game banks experience. Level up to earn attribute points ' +
              'and spend them wherever you want them — your record and ' +
              'everything you have earned follow you from mode to mode.',
        cta: 'Open Career',
        status: function () {
          const r = BB.Career.record();
          return 'Level ' + r.level + '  ·  ' + r.wins + '-' + r.losses +
                 (r.points > 0 ? '  ·  ' + r.points + ' point' +
                  (r.points === 1 ? '' : 's') + ' to spend' : '');
        },
        act: function () { M.push('career'); }
      },
      {
        id: 'settings', tab: 'Settings', title: 'Settings', pose: 'idle',
        tags: ['Audio', 'Presentation', 'Difficulty'],
        body: 'Mix the crowd against the commentary, pick a camera, set a ' +
              'render quality your machine is happy with, and choose how hard ' +
              'the AI plays — Rookie through Hall of Fame.',
        cta: 'Open Settings',
        act: function () { M.push('settings'); }
      },
      {
        id: 'controls', tab: 'Controls', title: 'Controls', pose: 'guard',
        tags: ['Keyboard', 'Gamepad', 'Rebindable'],
        body: 'The full layout for keyboard and controller, every action ' +
              'rebindable. Worth a minute before your first game: the dribble ' +
              'moves and the pickup live on keys of their own.',
        cta: 'Open Controls',
        act: function () { M.push('controls'); }
      }
    ];

    function modeById(id) {
      for (let i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
      return MODES[0];
    }

    /** Tells the standby scene how to pose, when it is the scene running. */
    function spotlight(mode) {
      const s = BB.Engine && BB.Engine.scene;
      if (s && s.spotlight) s.spotlight(mode.pose);
    }

    function heroHtml(mode) {
      const status = mode.status ? mode.status() : '';
      return `
        <p class="menu-hero__tags">${mode.tags.join('<i aria-hidden="true">|</i>')}</p>
        <h2 class="menu-hero__title">${mode.title}</h2>
        <p class="menu-hero__body">${mode.body}</p>
        ${status ? `<p class="menu-hero__status">${status}</p>` : ''}
        <button class="menu-cta" data-nav data-autofocus data-go>
          <span class="menu-cta__dot" aria-hidden="true"></span>${mode.cta}
        </button>`;
    }

    M.define({
      id: 'main',
      build(params) {
        const active = modeById(params && params.mode);
        return `
          <div class="menu">
            <div class="menu__brand">
              <span class="menu__mark" aria-hidden="true"></span>
              <span class="menu__word">HARDWOOD</span>
            </div>
            <nav class="menu-tabs" role="tablist" aria-label="Game modes">
              ${MODES.map((m) => `
                <button class="menu-tab${m === active ? ' is-on' : ''}" role="tab"
                        aria-selected="${m === active}" data-nav data-tab="${m.id}"
                  >${m.tab}</button>`).join('')}
            </nav>
            <div class="menu-hero" id="menu-hero">${heroHtml(active)}</div>
            <p class="menu__foot">Build ${BB.C.VERSION} · ${BB.C.BUILD}</p>
          </div>`;
      },

      mount(el, params) {
        let active = modeById(params && params.mode);
        const hero = el.querySelector('#menu-hero');
        const tabs = Array.prototype.slice.call(el.querySelectorAll('[data-tab]'));

        /* Changing mode rewrites the hero panel in place instead of pushing a
         * screen. The tab row has to stay exactly where it is, and a mode you
         * are reading about is not a place you have gone to — only the
         * button takes you anywhere. */
        function select(mode) {
          if (mode === active) return;
          // Rewriting the panel destroys whatever is focused inside it. If
          // that was the button, the focus falls to <body>, which is outside
          // this screen — and every key handler on it, so the arrow keys that
          // just changed the mode would stop working after one press.
          const hadCta = document.activeElement &&
                         document.activeElement.hasAttribute('data-go');
          active = mode;
          for (const t of tabs) {
            const on = t.dataset.tab === mode.id;
            t.classList.toggle('is-on', on);
            t.setAttribute('aria-selected', String(on));
          }
          hero.innerHTML = heroHtml(mode);
          hero.classList.remove('is-swap');
          void hero.offsetWidth;              // restart the wipe
          hero.classList.add('is-swap');
          if (hadCta) hero.querySelector('[data-go]').focus();
          spotlight(mode);
          A.play('uiMove');
        }

        el.addEventListener('click', (e) => {
          const tab = e.target.closest('[data-tab]');
          if (tab) { A.unlock(); select(modeById(tab.dataset.tab)); return; }
          if (e.target.closest('[data-go]')) { A.unlock(); active.act(); }
        });

        // Sweeping the row previews as it goes, the way a console front end
        // does under a thumbstick.
        el.addEventListener('mouseover', (e) => {
          const tab = e.target.closest('[data-tab]');
          if (tab) select(modeById(tab.dataset.tab));
        });
        el.addEventListener('focusin', (e) => {
          const tab = e.target.closest('[data-tab]');
          if (tab) select(modeById(tab.dataset.tab));
        });

        // Left/right walk the row. Up/down still cycles every control on the
        // screen through the manager, so both habits work.
        el.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const n = MODES.length;
          const next = MODES[(MODES.indexOf(active) + (e.key === 'ArrowRight' ? 1 : n - 1)) % n];
          select(next);
          tabs[MODES.indexOf(next)].focus();
        });

        spotlight(active);
      },

      onCancel() { /* main menu is the root; nothing to cancel to */ }
    });

    /* Exposed so tools can enumerate the front page without scraping the DOM. */
    M.MODES = MODES;

    /* -------------------------------------------------------------- settings */
    M.define({
      id: 'settings',
      build() {
        const S = BB.Settings;
        return `
          <div class="panel">
            <header class="panel__head">
              <h2>Settings</h2>
              <button class="btn btn--ghost" data-nav data-act="back">Back</button>
            </header>
            <div class="panel__body">
              <section class="group">
                <h3>Audio</h3>
                ${slider('volMaster', 'Master', S.get('volMaster'))}
                ${slider('volSfx', 'Effects', S.get('volSfx'))}
                ${slider('volCrowd', 'Crowd', S.get('volCrowd'))}
                ${slider('volUi', 'Interface', S.get('volUi'))}
                ${slider('volCommentary', 'Commentary', S.get('volCommentary'))}
                ${toggle('commentary', 'Commentator voice', S.get('commentary'))}
                ${toggle('muted', 'Mute everything', S.get('muted'))}
              </section>
              <section class="group">
                <h3>Presentation</h3>
                ${segmented('quality', 'Render quality', S.get('quality'),
                  [['high', 'High'], ['balanced', 'Balanced'], ['performance', 'Performance']])}
                ${segmented('cameraMode', 'Camera', S.get('cameraMode'),
                  [['broadcast', 'Broadcast'], ['wide', 'Wide'], ['tight', 'Tight']])}
                ${slider('screenShake', 'Screen shake', S.get('screenShake'))}
                ${toggle('showDebug', 'Show performance readout', S.get('showDebug'))}
              </section>
              <section class="group">
                <h3>Game</h3>
                ${segmented('difficulty', 'Difficulty', S.get('difficulty'),
                  [['rookie', 'Rookie'], ['pro', 'Pro'], ['allstar', 'All-Star'], ['hall', 'Hall of Fame']])}
                ${toggle('shotMeter', 'Show shot meter', S.get('shotMeter'))}
              </section>
              <div class="panel__actions">
                <button class="btn btn--danger" data-nav data-act="reset">Reset to defaults</button>
              </div>
            </div>
          </div>`;
      },
      mount(el) {
        const S = BB.Settings;
        el.addEventListener('click', (e) => {
          const seg = e.target.closest('[data-seg]');
          if (seg) {
            const key = seg.parentNode.dataset.key;
            S.set(key, seg.dataset.seg);
            Array.prototype.forEach.call(seg.parentNode.children, (c) =>
              c.classList.toggle('is-on', c === seg));
            A.play('uiMove');
            return;
          }
          const b = e.target.closest('[data-act]');
          if (!b) return;
          if (b.dataset.act === 'back') M.pop();
          if (b.dataset.act === 'reset') { S.reset(); M.pop(); M.push('settings'); }
        });
        el.addEventListener('input', (e) => {
          const r = e.target.closest('input[type=range]');
          if (r) {
            const v = parseFloat(r.value) / 100;
            S.set(r.dataset.key, v);
            r.parentNode.querySelector('.row__val').textContent = Math.round(v * 100) + '%';
            r.style.setProperty('--fill', (v * 100) + '%');
          }
        });
        el.addEventListener('change', (e) => {
          const c = e.target.closest('input[type=checkbox]');
          if (c) { S.set(c.dataset.key, c.checked); A.play('uiMove'); }
        });
      },
      onCancel() { M.pop(); }
    });

    /* -------------------------------------------------------------- controls */
    M.define({
      id: 'controls',
      build() {
        const rows = [
          ['up', 'Move up'], ['down', 'Move down'], ['left', 'Move left'], ['right', 'Move right'],
          ['sprint', 'Sprint'], ['shoot', 'Shoot / gather'], ['pass', 'Pass / steal'],
          ['lob', 'Lob / block'], ['dribble', 'Dribble move (+ direction/Shift)'],
          ['pickup', 'Pick up dribble (press again to fake a re-dribble)'],
          ['switchMan', 'Switch defender'],
          ['intense', 'Intense defence'], ['timeout', 'Timeout'], ['pause', 'Pause']
        ];
        return `
          <div class="panel">
            <header class="panel__head">
              <h2>Controls</h2>
              <button class="btn btn--ghost" data-nav data-act="back">Back</button>
            </header>
            <div class="panel__body">
              <p class="note">Select an action, then press the key you want. A controller is picked up automatically when one is connected.</p>
              <div class="keys">
                ${rows.map(([k, label]) => `
                  <button class="key" data-nav data-bind="${k}">
                    <span class="key__label">${label}</span>
                    <kbd class="key__cap">${BB.Input.label(k)}</kbd>
                  </button>`).join('')}
              </div>
              <div class="panel__actions">
                <button class="btn btn--danger" data-nav data-act="resetKeys">Restore default keys</button>
              </div>
            </div>
          </div>`;
      },
      mount(el) {
        let capturing = null;

        const stopCapture = () => {
          if (!capturing) return;
          capturing.classList.remove('is-rebinding');
          capturing.querySelector('.key__cap').textContent = BB.Input.label(capturing.dataset.bind);
          capturing = null;
          global.removeEventListener('keydown', onCapture, true);
        };

        const onCapture = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.code === 'Escape') { A.play('uiBack'); stopCapture(); return; }
          BB.Input.rebind(capturing.dataset.bind, [e.code]);
          A.play('uiSelect');
          stopCapture();
        };

        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-bind]');
          if (b) {
            stopCapture();
            capturing = b;
            b.classList.add('is-rebinding');
            b.querySelector('.key__cap').textContent = 'Press a key';
            global.addEventListener('keydown', onCapture, true);
            return;
          }
          const a = e.target.closest('[data-act]');
          if (!a) return;
          if (a.dataset.act === 'back') M.pop();
          if (a.dataset.act === 'resetKeys') {
            BB.Input.resetBindings();
            el.querySelectorAll('[data-bind]').forEach((k) => {
              k.querySelector('.key__cap').textContent = BB.Input.label(k.dataset.bind);
            });
            A.play('uiSelect');
          }
        });

        this._cleanup = stopCapture;
      },
      unmount() { if (this._cleanup) this._cleanup(); },
      onCancel() { M.pop(); }
    });

    /* ------------------------------------------------------------ createPlayer */
    M.define({
      id: 'createPlayer',
      build() {
        const P = BB.PlayerProfile;
        const draft = P.newDraft();
        const archOpts = Object.keys(P.ARCHETYPES).map((k) => [k, P.ARCHETYPES[k].label]);
        return `
          <div class="panel panel--wide">
            <header class="panel__head">
              <h2>Create Player</h2>
              <button class="btn btn--ghost" data-nav data-act="back">Back</button>
            </header>
            <div class="panel__body">
              <div class="creator__layout">
                <div class="creator__preview">
                  <canvas id="cp-canvas" width="220" height="280"></canvas>
                  <div class="creator__previewLabel" id="cp-label">
                    <span id="cp-label-name">${(draft.name || 'YOU').toUpperCase()}</span>
                    <span id="cp-label-sub">#${draft.number} \u00B7 ${draft.position} \u00B7 ${P.heightLabel(draft.height)}</span>
                  </div>
                </div>
                <div class="creator__form">
                  <section class="group">
                    <h3>Identity</h3>
                    <label class="row"><span class="row__k">Name</span>
                      <input type="text" id="cp-name" data-key="name" maxlength="16" value="${escapeAttr(draft.name)}">
                      <span></span>
                    </label>
                    <label class="row"><span class="row__k">Number</span>
                      <input type="number" id="cp-number" data-key="number" min="0" max="99" value="${draft.number}">
                      <span></span>
                    </label>
                    ${segmented('position', 'Position', draft.position,
                      [['PG', 'PG'], ['SG', 'SG'], ['SF', 'SF'], ['PF', 'PF'], ['C', 'C']])}
                  </section>
                  <section class="group">
                    <h3>Appearance</h3>
                    ${swatchRow('skin', 'Skin tone', P.SKIN_TONES, draft.skin)}
                    ${swatchRow('hair', 'Hair color', P.HAIR_COLORS, draft.hair)}
                    ${swatchRow('jerseyMain', 'Jersey', P.JERSEY_COLORS, draft.jerseyMain)}
                    ${swatchRow('jerseyTrim', 'Trim', P.JERSEY_COLORS, draft.jerseyTrim)}
                    <div class="row">
                      <span class="row__k">Height</span>
                      <input type="range" id="cp-height" data-key="height" min="66" max="84" value="${draft.height}">
                      <span class="row__val" id="cp-height-val">${P.heightLabel(draft.height)}</span>
                    </div>
                  </section>
                  <section class="group">
                    <h3>Ability</h3>
                    ${segmented('archetype', 'Archetype', draft.archetype, archOpts)}
                    <div class="row">
                      <span class="row__k">Overall</span>
                      <input type="range" id="cp-overall" data-key="overall" min="60" max="99" value="${draft.overall}">
                      <span class="row__val" id="cp-overall-val">${draft.overall}</span>
                    </div>
                    <p class="note">Archetype shapes the full attribute spread that drives the sim — shooting touch, speed, hands on defence, all of it — not just this number.</p>
                  </section>
                </div>
              </div>
              <div class="panel__actions">
                <button class="btn btn--ghost" data-act="randomize">Randomize</button>
                <button class="btn btn--danger" data-act="clear">Reset</button>
                <button class="btn" data-act="save">Save Player</button>
              </div>
            </div>
          </div>`;
      },
      mount(el) {
        const P = BB.PlayerProfile;
        const draft = P.newDraft();
        const canvas = el.querySelector('#cp-canvas');
        const ctx = canvas.getContext('2d');

        const preview = new BB.Player(P.toPlayerConfig(draft, { x: 0, y: 0 }));
        P.applyAppearance(preview, draft);
        preview.facing = 0;
        preview.targetHoop = null;

        const refreshLabel = () => {
          el.querySelector('#cp-label-name').textContent = (draft.name || 'YOU').toUpperCase();
          el.querySelector('#cp-label-sub').textContent =
            '#' + draft.number + ' \u00B7 ' + draft.position + ' \u00B7 ' + P.heightLabel(draft.height);
        };

        let last = performance.now();
        let raf = null;
        const tick = (now) => {
          const dt = Math.min(0.05, (now - last) / 1000);
          last = now;
          preview._updatePose(dt);

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const scale = 62;
          ctx.setTransform(scale, 0, 0, scale, canvas.width / 2, canvas.height * 0.86);
          preview.drawPreview(ctx);
          ctx.setTransform(1, 0, 0, 1, 0, 0);

          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        this._cleanup = () => { if (raf) cancelAnimationFrame(raf); };

        el.addEventListener('click', (e) => {
          const sw = e.target.closest('[data-swatch]');
          if (sw) {
            const key = sw.parentNode.dataset.key;
            draft[key] = sw.dataset.swatch;
            preview[key] = sw.dataset.swatch;
            Array.prototype.forEach.call(sw.parentNode.children, (c) => c.classList.toggle('is-on', c === sw));
            A.play('uiMove');
            return;
          }
          const seg = e.target.closest('[data-seg]');
          if (seg) {
            const key = seg.parentNode.dataset.key;
            draft[key] = seg.dataset.seg;
            Array.prototype.forEach.call(seg.parentNode.children, (c) => c.classList.toggle('is-on', c === seg));
            if (key === 'position') refreshLabel();
            A.play('uiMove');
            return;
          }
          const b = e.target.closest('[data-act]');
          if (!b) return;
          if (b.dataset.act === 'back') { M.pop(); return; }
          if (b.dataset.act === 'save') {
            P.save(draft);
            A.play('uiSelect');
            M.pop();
            return;
          }
          if (b.dataset.act === 'clear') {
            P.clear();
            M.pop(); M.push('createPlayer');
            return;
          }
          if (b.dataset.act === 'randomize') {
            const arch = Object.keys(P.ARCHETYPES);
            draft.archetype = arch[U.rng.i(0, arch.length - 1)];
            draft.overall = U.rng.i(65, 96);
            draft.skin = P.SKIN_TONES[U.rng.i(0, P.SKIN_TONES.length - 1)];
            draft.hair = P.HAIR_COLORS[U.rng.i(0, P.HAIR_COLORS.length - 1)];
            draft.jerseyMain = P.JERSEY_COLORS[U.rng.i(0, P.JERSEY_COLORS.length - 1)];
            draft.jerseyTrim = P.JERSEY_COLORS[U.rng.i(0, P.JERSEY_COLORS.length - 1)];
            draft.height = U.rng.i(68, 82);
            draft.position = ['PG', 'SG', 'SF', 'PF', 'C'][U.rng.i(0, 4)];
            draft.ratings = null; // regenerate from the new overall/archetype below
            P.save(draft);
            M.pop(); M.push('createPlayer');
          }
        });

        el.addEventListener('input', (e) => {
          const t = e.target;
          if (t.id === 'cp-name') { draft.name = t.value.slice(0, 16) || 'YOU'; preview.name = draft.name; refreshLabel(); return; }
          if (t.id === 'cp-number') { draft.number = U.clamp(parseInt(t.value, 10) || 0, 0, 99); preview.number = draft.number; refreshLabel(); return; }
          if (t.id === 'cp-height') {
            draft.height = parseInt(t.value, 10);
            preview.heightIn = draft.height;
            el.querySelector('#cp-height-val').textContent = P.heightLabel(draft.height);
            refreshLabel();
            return;
          }
          if (t.id === 'cp-overall') {
            draft.overall = parseInt(t.value, 10);
            el.querySelector('#cp-overall-val').textContent = draft.overall;
          }
        });
      },
      unmount() { if (this._cleanup) this._cleanup(); },
      onCancel() { M.pop(); }
    });

    /* ----------------------------------------------------------------- career */
    M.define({
      id: 'career',
      build() {
        const Cr = BB.Career, P = BB.PlayerProfile;
        const r = Cr.record();
        const draft = P.newDraft();
        P.ensureRatings(draft);
        const xpPct = Math.round(U.clamp01(r.xpNeeded ? r.xp / r.xpNeeded : 0) * 100);
        const recentDots = (r.recent || []).map((g) =>
          `<i class="career__form ${g === 'W' ? 'is-w' : 'is-l'}">${g}</i>`).join('') || '<span class="note">No games yet</span>';

        const groups = Cr.GROUPS.map((g) => `
          <div class="attrgroup" style="--gc:${g.color}">
            <div class="attrgroup__label">${g.label}</div>
            <div class="attrgroup__bars">
              ${g.keys.map((k) => {
                const v = draft.ratings[k];
                const cap = P.capFor(draft.position, draft.archetype, k);
                const pct = Math.round(U.clamp01(v / 99) * 100);
                const capPct = Math.round(U.clamp01(cap / 99) * 100);
                const capped = v >= cap;
                const canSpend = r.points > 0 && !capped;
                return `
                <div class="attrcol ${capped ? 'is-capped' : ''}">
                  <div class="attrcol__name"><span>${attrLabel(k)}</span></div>
                  <div class="attrcol__top">${v}</div>
                  <div class="attrcol__cap">${capped ? 'MAX' : ''}</div>
                  <div class="attrcol__bar">
                    ${cap < 99 ? `<div class="attrcol__capline" style="bottom:${capPct}%" title="Position potential: ${cap}"></div>` : ''}
                    <div class="attrcol__fill" style="height:${pct}%"></div>
                  </div>
                  <div class="attrcol__bottom">${v}</div>
                  <button class="attrcol__plus" data-spend="${k}" ${canSpend ? '' : 'disabled'} aria-label="Upgrade ${attrLabel(k)}">+</button>
                </div>`;
              }).join('')}
            </div>
          </div>`).join('');

        return `
          <div class="panel panel--xwide">
            <header class="panel__head">
              <h2>Career</h2>
              <button class="btn btn--ghost" data-nav data-act="back">Back</button>
            </header>
            <div class="panel__body">
              <div class="career__summary">
                <div class="career__level">
                  <div class="career__levelnum">LVL ${r.level}</div>
                  <div class="xpbar"><div class="xpbar__fill" style="width:${xpPct}%"></div></div>
                  <div class="career__xplabel">${r.xp} / ${r.xpNeeded} XP</div>
                  ${r.points > 0 ? `<div class="career__points">${r.points} point${r.points === 1 ? '' : 's'} to spend below</div>` : ''}
                </div>
                <div class="career__stats">
                  <div class="career__stat"><b>${r.wins}-${r.losses}</b><span>Record</span></div>
                  <div class="career__stat"><b>${(r.winPct * 100).toFixed(0)}%</b><span>Win rate</span></div>
                  <div class="career__stat"><b>${r.ppg.toFixed(1)}</b><span>PPG</span></div>
                  <div class="career__stat"><b>${(r.fgPct * 100).toFixed(0)}%</b><span>FG%</span></div>
                  <div class="career__stat"><b>${r.bestStreak}</b><span>Best streak</span></div>
                </div>
                <div class="career__recent">${recentDots}</div>
              </div>
              <p class="note">
                Playing as a <b>${draft.position}</b> \u2014 ${(P.ARCHETYPES[draft.archetype] || P.ARCHETYPES.balanced).label}.
                Play 1v1 games to earn XP and level up; every level earns points to spend permanently on any attribute below.
                The dashed line on a bar is your position's potential \u2014 some attributes cap below 99 depending on your build,
                just like real position limits.
              </p>
              <div class="attrstrip">${groups}</div>
            </div>
          </div>`;
      },
      mount(el) {
        el.addEventListener('click', (e) => {
          const back = e.target.closest('[data-act="back"]');
          if (back) { M.pop(); return; }
          const spend = e.target.closest('[data-spend]');
          if (spend && !spend.disabled) {
            if (BB.Career.spendPoint(spend.dataset.spend)) {
              A.play('uiSelect');
              M.pop(); M.push('career');
            }
          }
        });
      },
      onCancel() { M.pop(); }
    });

    /* ----------------------------------------------------------------- pause */
    M.define({
      id: 'pause',
      build(p) {
        return `
          <div class="pause">
            <div class="pause__bar"></div>
            <h2 class="pause__title">Paused</h2>
            <p class="pause__sub">${p.sub || 'Shootaround'}</p>
            <nav class="menu-list menu-list--tight">
              <button class="menu-item" data-nav data-autofocus data-act="resume"><span class="menu-item__k">Resume</span></button>
              <button class="menu-item" data-nav data-act="settings"><span class="menu-item__k">Settings</span></button>
              <button class="menu-item" data-nav data-act="controls"><span class="menu-item__k">Controls</span></button>
              <button class="menu-item menu-item--warn" data-nav data-act="quit"><span class="menu-item__k">Leave to menu</span></button>
            </nav>
          </div>`;
      },
      mount(el, params) {
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b) return;
          switch (b.dataset.act) {
            case 'resume': M.pop(); if (params.onResume) params.onResume(); break;
            case 'settings': M.push('settings'); break;
            case 'controls': M.push('controls'); break;
            case 'quit':
              M.closeAll();
              BB.Engine.setState('menu');
              break;
          }
        });
      },
      onCancel(mm) {
        const p = mm.top.params;
        mm.pop();
        if (p.onResume) p.onResume();
      }
    });

    /* ------------------------------------------------------------- matchend */
    M.define({
      id: 'matchend',
      build(p) {
        const barColour = p.win ? 'var(--mint)' : 'var(--red)';
        const c = p.career || {};
        const levelBlock = c.leveledUp
          ? `<div class="matchend__level">LEVEL UP — NOW LEVEL ${c.newLevel} <span>(+${c.pointsGained} points to spend)</span></div>`
          : '';
        return `
          <div class="pause">
            <div class="pause__bar" style="background:${barColour}"></div>
            <h2 class="pause__title">${p.win ? 'YOU WIN' : 'CPU WINS'}</h2>
            <p class="pause__sub">FINAL &nbsp; ${p.youScore} – ${p.cpuScore}</p>
            <p class="matchend__xp">+${c.xpGained || 0} XP</p>
            ${levelBlock}
            <nav class="menu-list menu-list--tight">
              <button class="menu-item menu-item--lead" data-nav data-autofocus data-act="rematch">
                <span class="menu-item__k">Rematch</span>
              </button>
              <button class="menu-item" data-nav data-act="career">
                <span class="menu-item__k">Career</span>
              </button>
              <button class="menu-item" data-nav data-act="menu">
                <span class="menu-item__k">Main Menu</span>
              </button>
            </nav>
          </div>`;
      },
      mount(el) {
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b) return;
          if (b.dataset.act === 'rematch') { M.closeAll(); BB.Engine.setState('oneVone'); }
          if (b.dataset.act === 'career') { M.pop(); M.push('career'); }
          if (b.dataset.act === 'menu') { M.closeAll(); BB.Engine.setState('menu'); }
        });
      }
    });
  }

  /* ----------------------------------------------------------- html helpers */
  function slider(key, label, value) {
    const pct = Math.round(value * 100);
    return `
      <label class="row">
        <span class="row__k">${label}</span>
        <input type="range" min="0" max="100" value="${pct}" data-key="${key}" data-nav
               style="--fill:${pct}%" aria-label="${label}">
        <span class="row__val">${pct}%</span>
      </label>`;
  }

  function toggle(key, label, on) {
    return `
      <label class="row row--toggle">
        <span class="row__k">${label}</span>
        <input type="checkbox" data-key="${key}" data-nav ${on ? 'checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
      </label>`;
  }

  function segmented(key, label, value, opts) {
    return `
      <div class="row row--seg">
        <span class="row__k">${label}</span>
        <div class="seg" data-key="${key}">
          ${opts.map(([v, t]) =>
            `<button class="seg__b ${v === value ? 'is-on' : ''}" data-nav data-seg="${v}">${t}</button>`).join('')}
        </div>
      </div>`;
  }

  function swatchRow(key, label, colors, selected) {
    return `
      <div class="row row--seg">
        <span class="row__k">${label}</span>
        <div class="swatches" data-key="${key}">
          ${colors.map((c) =>
            `<button class="swatch ${c === selected ? 'is-on' : ''}" data-nav data-swatch="${c}" style="--c:${c}" aria-label="${label} ${c}"></button>`).join('')}
        </div>
      </div>`;
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  const ATTR_LABELS = {
    speed: 'Speed', acceleration: 'Accel', strength: 'Strength', vertical: 'Vertical', stamina: 'Stamina',
    layup: 'Layup', drivingDunk: 'Dri Dunk', standingDunk: 'Std Dunk', closeShot: 'Close Sh',
    midRange: 'Mid-Rng', threePoint: '3PT', freeThrow: 'Free Thr',
    ballHandle: 'Ball Hndl', passAccuracy: 'Pass Acc', passVision: 'Pass Vis',
    steal: 'Steal', block: 'Block', perimeterDefense: 'Perim D', interiorDefense: 'Inter D',
    offensiveRebound: 'Off Reb', defensiveRebound: 'Def Reb'
  };
  function attrLabel(key) { return ATTR_LABELS[key] || key; }

  BB.Menus = Menus;
})(typeof window !== 'undefined' ? window : globalThis);
