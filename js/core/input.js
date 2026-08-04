/* =============================================================================
 * input.js  —  Device polling and action mapping.
 * -----------------------------------------------------------------------------
 * Gameplay code never reads key codes. It asks for ACTIONS ("shoot", "sprint"),
 * which keeps the control scheme remappable and lets keyboard and gamepad share
 * a single code path.
 *
 * Edge state ("pressed this frame") is latched on the raw event and cleared by
 * Input.endFrame(), so a fast key tap can never be missed between frames.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U;

  /* Default binding table. Values are arrays so an action can have aliases. */
  const DEFAULT_KEYS = {
    up:        ['KeyW', 'ArrowUp'],
    down:      ['KeyS', 'ArrowDown'],
    left:      ['KeyA', 'ArrowLeft'],
    right:     ['KeyD', 'ArrowRight'],
    shoot:     ['Space'],
    pass:      ['KeyJ'],
    lob:       ['KeyK'],
    sprint:    ['ShiftLeft', 'ShiftRight'],
    dribble:   ['KeyL'],
    pickup:    ['KeyB'],
    steal:     ['KeyJ'],
    block:     ['KeyK'],
    switchMan: ['KeyQ'],
    intense:   ['KeyE'],
    call:      ['KeyC'],
    timeout:   ['KeyT'],
    pause:     ['Escape', 'KeyP'],
    confirm:   ['Enter', 'NumpadEnter'],
    cancel:    ['Backspace'],
    replay:    ['KeyR'],
    camera:    ['KeyV']
  };

  /* Gamepad button indices (standard mapping). */
  const DEFAULT_PADS = {
    shoot: [0], pass: [2], lob: [3], sprint: [7], dribble: [1], pickup: [5],
    steal: [2], block: [3], switchMan: [4], intense: [6],
    pause: [9], confirm: [0], cancel: [1],
    up: [12], down: [13], left: [14], right: [15]
  };

  const Input = {
    keys: Object.create(null),        // code -> true while held
    _pressed: Object.create(null),    // code -> true for one frame
    _released: Object.create(null),

    bindings: JSON.parse(JSON.stringify(DEFAULT_KEYS)),
    padBindings: DEFAULT_PADS,

    mouse: { x: 0, y: 0, down: false, pressed: false, released: false, wheel: 0, inside: false },

    pad: null,
    padIndex: -1,
    axes: { lx: 0, ly: 0, rx: 0, ry: 0 },
    lastDevice: 'keyboard',

    enabled: true,
    _target: null,

    /* ------------------------------------------------------------- lifecycle */
    init(canvas) {
      this._target = canvas;

      global.addEventListener('keydown', (e) => {
        // Never swallow browser chrome shortcuts the player may need.
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTextField(e.target)) return;
        if (!this.keys[e.code]) this._pressed[e.code] = true;
        this.keys[e.code] = true;
        this.lastDevice = 'keyboard';
        if (SCROLL_KEYS.has(e.code)) e.preventDefault();
      }, { passive: false });

      global.addEventListener('keyup', (e) => {
        if (isTextField(e.target)) return;
        this.keys[e.code] = false;
        this._released[e.code] = true;
      });

      // Losing focus must clear held keys or the player "sticks" in a direction.
      global.addEventListener('blur', () => this.clear());

      if (canvas) {
        canvas.addEventListener('mousemove', (e) => {
          const r = canvas.getBoundingClientRect();
          this.mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
          this.mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
          this.mouse.inside = true;
        });
        canvas.addEventListener('mouseleave', () => { this.mouse.inside = false; });
        canvas.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          this.mouse.down = true; this.mouse.pressed = true;
          this.lastDevice = 'keyboard';
        });
        global.addEventListener('mouseup', (e) => {
          if (e.button !== 0) return;
          this.mouse.down = false; this.mouse.released = true;
        });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        canvas.addEventListener('wheel', (e) => { this.mouse.wheel += e.deltaY; }, { passive: true });
      }

      global.addEventListener('gamepadconnected', (e) => {
        this.padIndex = e.gamepad.index;
        this.lastDevice = 'gamepad';
      });
      global.addEventListener('gamepaddisconnected', () => {
        this.padIndex = -1; this.pad = null;
      });

      const saved = U.store.get('bindings', null);
      if (saved) Object.assign(this.bindings, saved);
    },

    /** Poll continuous devices. Call once at the top of every frame. */
    beginFrame() {
      this.pollGamepad();
    },

    /** Clear one-frame edges. Call once at the very end of every frame. */
    endFrame() {
      this._pressed = Object.create(null);
      this._released = Object.create(null);
      this.mouse.pressed = false;
      this.mouse.released = false;
      this.mouse.wheel = 0;
      if (this.pad) {
        for (let i = 0; i < this._padPrev.length; i++) this._padPrev[i] = this._padNow[i];
      }
    },

    clear() {
      this.keys = Object.create(null);
      this._pressed = Object.create(null);
      this._released = Object.create(null);
      this.mouse.down = false;
      this.axes.lx = this.axes.ly = this.axes.rx = this.axes.ry = 0;
    },

    /* ---------------------------------------------------------------- query */
    /** Held state for an action. */
    down(action) {
      if (!this.enabled) return false;
      const codes = this.bindings[action];
      if (codes) for (let i = 0; i < codes.length; i++) if (this.keys[codes[i]]) return true;
      return this._padDown(action);
    },

    /** True only on the frame the action went down. */
    pressed(action) {
      if (!this.enabled) return false;
      const codes = this.bindings[action];
      if (codes) for (let i = 0; i < codes.length; i++) if (this._pressed[codes[i]]) return true;
      return this._padPressed(action);
    },

    /** True only on the frame the action came up. */
    released(action) {
      if (!this.enabled) return false;
      const codes = this.bindings[action];
      if (codes) for (let i = 0; i < codes.length; i++) if (this._released[codes[i]]) return true;
      return this._padReleased(action);
    },

    /**
     * Movement vector in the -1..1 square, normalised so diagonals are not
     * faster than cardinals. Stick input wins when it is being used.
     */
    moveVector(out) {
      out = out || { x: 0, y: 0, mag: 0 };
      let x = 0, y = 0;
      if (Math.abs(this.axes.lx) > 0.001 || Math.abs(this.axes.ly) > 0.001) {
        x = this.axes.lx; y = this.axes.ly;
      } else {
        if (this.down('left')) x -= 1;
        if (this.down('right')) x += 1;
        if (this.down('up')) y -= 1;
        if (this.down('down')) y += 1;
      }
      const m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      out.x = x; out.y = y;
      out.mag = Math.min(1, m);
      return out;
    },

    /* -------------------------------------------------------------- gamepad */
    _padNow: new Uint8Array(20),
    _padPrev: new Uint8Array(20),

    pollGamepad() {
      if (!global.navigator || !navigator.getGamepads) return;
      const pads = navigator.getGamepads();
      let gp = this.padIndex >= 0 ? pads[this.padIndex] : null;
      if (!gp) {
        for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; this.padIndex = i; break; }
      }
      this.pad = gp || null;
      if (!gp) { this.axes.lx = this.axes.ly = this.axes.rx = this.axes.ry = 0; return; }

      const dz = 0.18;
      const ax = (v) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));
      this.axes.lx = ax(gp.axes[0] || 0);
      this.axes.ly = ax(gp.axes[1] || 0);
      this.axes.rx = ax(gp.axes[2] || 0);
      this.axes.ry = ax(gp.axes[3] || 0);

      const n = Math.min(20, gp.buttons.length);
      let any = false;
      for (let i = 0; i < n; i++) {
        const v = gp.buttons[i] && gp.buttons[i].pressed ? 1 : 0;
        this._padNow[i] = v;
        if (v) any = true;
      }
      if (any || Math.abs(this.axes.lx) > 0.3 || Math.abs(this.axes.ly) > 0.3) this.lastDevice = 'gamepad';
    },

    _padDown(action) {
      const b = this.padBindings[action];
      if (!b || !this.pad) return false;
      for (let i = 0; i < b.length; i++) if (this._padNow[b[i]]) return true;
      return false;
    },
    _padPressed(action) {
      const b = this.padBindings[action];
      if (!b || !this.pad) return false;
      for (let i = 0; i < b.length; i++) if (this._padNow[b[i]] && !this._padPrev[b[i]]) return true;
      return false;
    },
    _padReleased(action) {
      const b = this.padBindings[action];
      if (!b || !this.pad) return false;
      for (let i = 0; i < b.length; i++) if (!this._padNow[b[i]] && this._padPrev[b[i]]) return true;
      return false;
    },

    /* ------------------------------------------------------------- rebinding */
    rebind(action, codes) {
      this.bindings[action] = codes.slice();
      U.store.set('bindings', this.bindings);
    },
    resetBindings() {
      this.bindings = JSON.parse(JSON.stringify(DEFAULT_KEYS));
      U.store.remove('bindings');
    },
    /** Human readable label for the first key bound to an action. */
    label(action) {
      const c = this.bindings[action];
      return c && c.length ? prettyKey(c[0]) : '—';
    }
  };

  const SCROLL_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  function isTextField(el) {
    if (!el) return false;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
  }

  function prettyKey(code) {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Arrow')) return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[code.slice(5)];
    const map = {
      Space: 'SPACE', ShiftLeft: 'SHIFT', ShiftRight: 'R-SHIFT', Escape: 'ESC',
      Enter: 'ENTER', NumpadEnter: 'ENTER', Backspace: 'BKSP', Tab: 'TAB'
    };
    return map[code] || code.toUpperCase();
  }
  Input.prettyKey = prettyKey;

  BB.Input = Input;
})(typeof window !== 'undefined' ? window : globalThis);
