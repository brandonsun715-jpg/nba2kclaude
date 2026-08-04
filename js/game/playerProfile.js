/* =============================================================================
 * playerProfile.js  —  The created player: draft state + persistence.
 * -----------------------------------------------------------------------------
 * Everything the Create Player screen edits lives here as a plain object, not
 * a live Player instance — the menu can freely mutate a draft and throw it
 * away on cancel. Saving snapshots the draft to localStorage; OneVOneScene
 * and ShootaroundScene read it back (via toPlayerConfig) instead of the
 * hardcoded default whenever a save exists.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U;

  const SKIN_TONES = ['#F2C9A1', '#E5B48B', '#C99268', '#A8703F', '#8A5A32', '#6B4226', '#4A2E1C'];
  const HAIR_COLORS = ['#1B1310', '#3A2A1A', '#5C4530', '#8A6D4A', '#C9A227', '#B0B0B0', '#E8E4DA'];
  const JERSEY_COLORS = [
    '#1D4E8F', '#C0392B', '#1E8F5F', '#7B2D8E', '#E8871E',
    '#111721', '#F3F0E7', '#1AA6A0', '#B0242E', '#3D3D3D'
  ];

  const ARCHETYPES = {
    balanced: { label: 'Balanced', boost: [], cut: [] },
    sharpshooter: {
      label: 'Sharpshooter',
      boost: ['midRange', 'threePoint', 'freeThrow', 'passVision'],
      cut: ['strength', 'interiorDefense', 'block']
    },
    slasher: {
      label: 'Slasher',
      boost: ['speed', 'acceleration', 'layup', 'drivingDunk', 'vertical'],
      cut: ['threePoint', 'freeThrow']
    },
    defender: {
      label: 'Defender',
      boost: ['steal', 'block', 'perimeterDefense', 'interiorDefense'],
      cut: ['threePoint', 'midRange']
    },
    playmaker: {
      label: 'Playmaker',
      boost: ['ballHandle', 'passAccuracy', 'passVision', 'steal'],
      cut: ['standingDunk', 'block']
    }
  };

  /** Position potential caps — the actual new mechanic: your position sets
   * a hard ceiling most attributes can never cross, win, lose, or spend
   * career points however you like. A Center's three-point cap is 60, full
   * stop; no amount of grinding gets them past it. This is what makes
   * position a real build choice instead of a label, same as it works in
   * a certain other basketball game. */
  const POSITION_CAPS = {
    PG: {
      speed: 99, acceleration: 99, strength: 80, vertical: 92, stamina: 99,
      layup: 96, drivingDunk: 88, standingDunk: 68, closeShot: 92,
      midRange: 99, threePoint: 99, freeThrow: 99,
      ballHandle: 99, passAccuracy: 99, passVision: 99,
      steal: 99, block: 74, perimeterDefense: 96, interiorDefense: 70,
      offensiveRebound: 64, defensiveRebound: 74
    },
    SG: {
      speed: 97, acceleration: 97, strength: 85, vertical: 94, stamina: 97,
      layup: 96, drivingDunk: 92, standingDunk: 78, closeShot: 93,
      midRange: 99, threePoint: 99, freeThrow: 99,
      ballHandle: 96, passAccuracy: 92, passVision: 90,
      steal: 96, block: 78, perimeterDefense: 96, interiorDefense: 76,
      offensiveRebound: 70, defensiveRebound: 78
    },
    SF: {
      speed: 92, acceleration: 92, strength: 90, vertical: 95, stamina: 96,
      layup: 96, drivingDunk: 95, standingDunk: 88, closeShot: 95,
      midRange: 96, threePoint: 95, freeThrow: 95,
      ballHandle: 92, passAccuracy: 88, passVision: 88,
      steal: 92, block: 85, perimeterDefense: 92, interiorDefense: 85,
      offensiveRebound: 82, defensiveRebound: 86
    },
    PF: {
      speed: 82, acceleration: 82, strength: 97, vertical: 92, stamina: 92,
      layup: 92, drivingDunk: 95, standingDunk: 96, closeShot: 96,
      midRange: 88, threePoint: 76, freeThrow: 88,
      ballHandle: 78, passAccuracy: 78, passVision: 78,
      steal: 80, block: 96, perimeterDefense: 78, interiorDefense: 96,
      offensiveRebound: 94, defensiveRebound: 95
    },
    C: {
      speed: 72, acceleration: 74, strength: 99, vertical: 88, stamina: 88,
      layup: 86, drivingDunk: 88, standingDunk: 99, closeShot: 96,
      midRange: 74, threePoint: 58, freeThrow: 80,
      ballHandle: 60, passAccuracy: 70, passVision: 72,
      steal: 66, block: 99, perimeterDefense: 64, interiorDefense: 99,
      offensiveRebound: 99, defensiveRebound: 99
    }
  };

  const DEFAULT_DRAFT = {
    name: 'YOU', number: 23, position: 'SF',
    height: 79, skin: SKIN_TONES[2], hair: HAIR_COLORS[0],
    jerseyMain: JERSEY_COLORS[0], jerseyTrim: JERSEY_COLORS[8],
    overall: 82, archetype: 'balanced'
  };

  const PlayerProfile = {
    SKIN_TONES, HAIR_COLORS, JERSEY_COLORS, ARCHETYPES, POSITION_CAPS,

    /** The saved player, or null if nobody's ever saved one yet. */
    load() { return U.store.get('createdPlayer', null); },

    save(draft) {
      this.ensureRatings(draft);
      this.enforceCaps(draft);
      U.store.set('createdPlayer', draft);
      return draft;
    },

    /** Re-clamps every existing rating to the CURRENT position/archetype
     * caps. Needed because ratings persist once generated (see
     * generateRatings) - without this, creating as a Point Guard with a 99
     * three-point rating and then switching position to Center would let
     * that 99 survive uncapped forever. Called on every save. */
    enforceCaps(draft) {
      if (!draft.ratings) return;
      for (const k of BB.Player.RATING_KEYS) {
        const cap = this.capFor(draft.position, draft.archetype, k);
        if (draft.ratings[k] > cap) draft.ratings[k] = cap;
      }
    },

    clear() { U.store.set('createdPlayer', null); },

    /** A fresh draft to start editing from — the saved player if one
     * exists, otherwise sensible defaults. Always a new object, so editing
     * it can never corrupt the saved copy until save() is called again. */
    newDraft() {
      const saved = this.load();
      return Object.assign({}, DEFAULT_DRAFT, saved || {});
    },

    heightLabel(inches) {
      const ft = Math.floor(inches / 12), inch = inches % 12;
      return ft + "'" + inch + '"';
    },

    /** The real potential ceiling for one attribute given position + build:
     * position sets the base (a Center's three-point cap is 58, period),
     * archetype can nudge it a bit further in its own direction (a
     * Sharpshooter Center still caps lower than a Sharpshooter Guard, but
     * higher than a Defender Center would) — position is always the
     * dominant factor, archetype is the secondary one. */
    capFor(position, archetype, key) {
      const posCaps = POSITION_CAPS[position] || POSITION_CAPS.SF;
      const base = posCaps[key] == null ? 99 : posCaps[key];
      const arch = ARCHETYPES[archetype] || ARCHETYPES.balanced;
      let nudge = 0;
      if (arch.boost.indexOf(key) >= 0) nudge = 6;
      else if (arch.cut.indexOf(key) >= 0) nudge = -6;
      return U.clamp(base + nudge, 25, 99);
    },

    /** Generates a FRESH rating set from the archetype's boost/cut lists,
     * clamped to the position+build cap for every attribute — this is the
     * character's starting point, called once at creation (or on
     * Randomize). After that, ratings persist and only move through spent
     * career points - see career.js, which respects the same caps. */
    generateRatings(draft) {
      const arch = ARCHETYPES[draft.archetype] || ARCHETYPES.balanced;
      const base = U.clamp(draft.overall || 75, 60, 99);
      const r = {};
      for (const k of BB.Player.RATING_KEYS) {
        let v = base + U.rng.gauss(0, 5);
        if (arch.boost.indexOf(k) >= 0) v += 11;
        if (arch.cut.indexOf(k) >= 0) v -= 9;
        const cap = this.capFor(draft.position, draft.archetype, k);
        r[k] = U.clamp(Math.round(v), 25, cap);
      }
      r.shotTendency = U.clamp(Math.round(U.rng.f(55, 85)), 0, 100);
      r.driveTendency = U.clamp(Math.round(U.rng.f(40, 75)), 0, 100);
      r.passTendency = U.clamp(Math.round(U.rng.f(35, 65)), 0, 100);
      return r;
    },

    /** Attaches persisted ratings to a draft if it doesn't have any yet
     * (brand new player). Mutates and returns draft.ratings. */
    ensureRatings(draft) {
      if (!draft.ratings) draft.ratings = this.generateRatings(draft);
      return draft.ratings;
    },

    /** Config object ready to pass straight into `new BB.Player(...)`. */
    toPlayerConfig(draft, extra) {
      return Object.assign({
        human: true, name: draft.name || 'YOU', number: draft.number,
        position: draft.position, height: draft.height,
        skin: draft.skin, hair: draft.hair,
        overall: U.clamp(draft.overall || 75, 60, 99),
        ratings: this.ensureRatings(draft)
      }, extra || {});
    },

    /** Apply appearance fields that Player doesn't take via cfg (jersey
     * colours come from team assignment normally - see game.js). Call right
     * after construction, same pattern used for the CPU's jersey override. */
    applyAppearance(player, draft) {
      player.jerseyMain = draft.jerseyMain;
      player.jerseyTrim = draft.jerseyTrim;
    }
  };

  BB.PlayerProfile = PlayerProfile;
})(typeof window !== 'undefined' ? window : globalThis);
