/* =============================================================================
 * career.js  —  Career progression.
 * -----------------------------------------------------------------------------
 * Persistent XP/level/record/stat totals tied to the created player (see
 * playerProfile.js). Every finished 1v1 game reports its result here via
 * recordGame(); leveling up earns attribute points the player spends on
 * whichever of the created player's 21 ratings they want, permanently.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U;

  const DEFAULTS = {
    xp: 0, level: 1, points: 0,
    gamesPlayed: 0, wins: 0, losses: 0,
    totalPoints: 0, fgMade: 0, fgAtt: 0, bestStreak: 0,
    recent: []            // ['W','L',...] most recent first, capped at 10
  };

  /** Attribute groups for the Career screen's spend-points panel - purely
   * organisational, doesn't affect the sim, just keeps 21 rows legible. */
  const GROUPS = [
    { label: 'Finishing', color: '#2E8FE8', keys: ['layup', 'drivingDunk', 'standingDunk', 'closeShot'] },
    { label: 'Shooting', color: '#2ED47A', keys: ['midRange', 'threePoint', 'freeThrow'] },
    { label: 'Playmaking', color: '#F0A030', keys: ['ballHandle', 'passAccuracy', 'passVision'] },
    { label: 'Defense', color: '#E8425F', keys: ['steal', 'block', 'perimeterDefense', 'interiorDefense'] },
    { label: 'Rebounding', color: '#A063E0', keys: ['offensiveRebound', 'defensiveRebound'] },
    { label: 'Athleticism', color: '#D8B888', keys: ['speed', 'acceleration', 'strength', 'vertical', 'stamina'] }
  ];

  const Career = {
    GROUPS,

    load() { return Object.assign({}, DEFAULTS, U.store.get('career', {}) || {}); },
    save(c) { U.store.set('career', c); return c; },
    reset() { U.store.set('career', null); },

    /** XP needed to advance FROM this level to the next. */
    xpForLevel(level) { return Math.round(120 * Math.pow(Math.max(1, level), 1.32)); },

    record() {
      const c = this.load();
      return {
        level: c.level, xp: c.xp, xpNeeded: this.xpForLevel(c.level), points: c.points,
        gamesPlayed: c.gamesPlayed, wins: c.wins, losses: c.losses,
        winPct: c.gamesPlayed ? c.wins / c.gamesPlayed : 0,
        ppg: c.gamesPlayed ? c.totalPoints / c.gamesPlayed : 0,
        fgPct: c.fgAtt ? c.fgMade / c.fgAtt : 0,
        bestStreak: c.bestStreak, recent: c.recent || []
      };
    },

    /**
     * Call once when a 1v1 game ends. Awards XP for the result plus a
     * performance bonus, applies any level-ups, and returns a summary the
     * scene can show the player.
     */
    recordGame({ won, pointsScored, fgMade, fgAtt, bestStreak }) {
      const c = this.load();
      c.gamesPlayed++;
      if (won) c.wins++; else c.losses++;
      c.totalPoints += pointsScored || 0;
      c.fgMade += fgMade || 0;
      c.fgAtt += fgAtt || 0;
      c.bestStreak = Math.max(c.bestStreak, bestStreak || 0);
      c.recent = [won ? 'W' : 'L'].concat(c.recent || []).slice(0, 10);

      let xp = won ? 150 : 60;
      xp += (pointsScored || 0) * 4;
      xp += Math.max(0, (bestStreak || 0) - 2) * 15;
      c.xp += xp;

      let leveledUp = false, pointsGained = 0;
      while (c.xp >= this.xpForLevel(c.level)) {
        c.xp -= this.xpForLevel(c.level);
        c.level++;
        c.points += 2;
        pointsGained += 2;
        leveledUp = true;
      }

      this.save(c);
      return { xpGained: xp, leveledUp, newLevel: c.level, pointsGained, pointsAvailable: c.points };
    },

    /** Permanently bump one rating on the created player by 1, spending a
     * career point. Returns false if there's nothing to spend or the
     * attribute's already at its position/build cap (which may well be
     * below 99 - a Center can't spend points past their three-point cap
     * no matter how many they're holding). */
    spendPoint(key) {
      const c = this.load();
      if (c.points <= 0) return false;
      const draft = BB.PlayerProfile.newDraft();
      BB.PlayerProfile.ensureRatings(draft);
      const cap = BB.PlayerProfile.capFor(draft.position, draft.archetype, key);
      const cur = draft.ratings[key] || 25;
      if (cur >= cap) return false;
      draft.ratings[key] = Math.min(cap, cur + 1);
      BB.PlayerProfile.save(draft);
      c.points--;
      this.save(c);
      return true;
    }
  };

  BB.Career = Career;
})(typeof window !== 'undefined' ? window : globalThis);
