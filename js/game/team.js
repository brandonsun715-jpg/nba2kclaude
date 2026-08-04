/* =============================================================================
 * team.js  —  A roster and its identity.
 * -----------------------------------------------------------------------------
 * Deliberately small in this build: a Team is a colour identity plus an array
 * of Players. Trades, standings and schedules belong to season.js later; this
 * file only needs to answer "who is on the floor and what do they wear".
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U, PAL = BB.C.PAL;

  const FIRST_NAMES = [
    'Marcus', 'Jalen', 'Andre', 'Trey', 'DeAndre', 'Isaiah', 'Malik', 'Xavier',
    'Cole', 'Dominic', 'Elijah', 'Bryce', 'Nate', 'Reggie', 'Quentin', 'Miles',
    'Jordan', 'Terrence', 'Zane', 'Corey', 'Damon', 'Kellan', 'Rashad', 'Tobias'
  ];
  const LAST_NAMES = [
    'Carter', 'Whitfield', 'Ellison', 'Marsh', 'Okafor', 'Reyes', 'Sinclair',
    'Boateng', 'Delgado', 'Harmon', 'Pruitt', 'Voss', 'Kessler', 'Navarro',
    'Blackwood', 'Fontaine', 'Grier', 'Holloway', 'Iverson', 'Lang', 'Mercer'
  ];
  const SKIN_TONES = ['#E7B98C', '#C99268', '#A9744C', '#8A5A38', '#6B4128', '#4C2C19'];
  const HAIR_COLOURS = ['#0B0906', '#1B1310', '#2E1B10', '#5C4326', '#111111'];

  function randomName(rng) {
    rng = rng || U.rng;
    return { first: rng.pick(FIRST_NAMES), last: rng.pick(LAST_NAMES) };
  }

  const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

  class Team {
    constructor(cfg) {
      cfg = cfg || {};
      this.name = cfg.name || 'Hardwood';
      this.abbr = cfg.abbr || 'HWD';
      this.primary = cfg.primary || PAL.paint;
      this.secondary = cfg.secondary || PAL.orange;
      this.roster = [];
      this.wins = 0;
      this.losses = 0;
    }

    add(player) {
      player.team = this;
      player.jerseyMain = this.primary;
      player.jerseyTrim = this.secondary;
      this.roster.push(player);
      return player;
    }

    byPosition(pos) { return this.roster.filter((p) => p.position === pos); }

    /** The five best players by overall — a simple, transparent starter pick. */
    startingFive() {
      return this.roster.slice().sort((a, b) => b.overall - a.overall).slice(0, 5);
    }
  }

  /**
   * Build a full 12-man roster of randomly generated but internally consistent
   * players (guards skew toward speed/handle/three, bigs toward strength/
   * rebounding/interior defence).
   */
  function generateRoster(team, seed) {
    const rng = U.makeRng(seed == null ? (Math.random() * 1e9) | 0 : seed);
    const slots = [
      'PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C', 'C', 'SF', 'PG'
    ];
    let num = 0;
    const usedNumbers = new Set();

    for (let i = 0; i < slots.length; i++) {
      const pos = slots[i];
      const overall = Math.round(rng.gauss(72, 9));
      const ratings = Player_defaultRatingsForPosition(pos, overall, rng);
      const name = randomName(rng);

      let jersey = rng.i(0, 55);
      while (usedNumbers.has(jersey)) jersey = rng.i(0, 55);
      usedNumbers.add(jersey);

      const player = new BB.Player({
        name: name.first + ' ' + name.last,
        number: jersey,
        position: pos,
        ratings,
        height: heightForPosition(pos, rng),
        skin: rng.pick(SKIN_TONES),
        hair: rng.pick(HAIR_COLOURS)
      });
      team.add(player);
      num++;
    }
    void num;
    return team;
  }

  function heightForPosition(pos, rng) {
    const table = { PG: [70, 76], SG: [73, 78], SF: [76, 81], PF: [79, 84], C: [81, 87] };
    const r = table[pos] || [72, 82];
    return Math.round(rng.f(r[0], r[1]));
  }

  /** Position-flavoured rating generation, layered on top of Player's default. */
  function Player_defaultRatingsForPosition(pos, overall, rng) {
    const base = BB.Player.defaultRatings(overall);
    const boost = (keys, amt) => keys.forEach((k) => {
      base[k] = U.clamp(Math.round(base[k] + amt + rng.gauss(0, 3)), 25, 99);
    });
    switch (pos) {
      case 'PG':
        boost(['speed', 'acceleration', 'ballHandle', 'passAccuracy', 'passVision'], 8);
        boost(['strength', 'interiorDefense', 'offensiveRebound'], -8);
        break;
      case 'SG':
        boost(['threePoint', 'midRange', 'speed', 'perimeterDefense'], 6);
        boost(['interiorDefense', 'offensiveRebound'], -6);
        break;
      case 'SF':
        boost(['midRange', 'perimeterDefense', 'steal'], 4);
        break;
      case 'PF':
        boost(['strength', 'interiorDefense', 'offensiveRebound', 'defensiveRebound', 'standingDunk'], 7);
        boost(['threePoint', 'speed'], -6);
        break;
      case 'C':
        boost(['strength', 'block', 'interiorDefense', 'defensiveRebound', 'offensiveRebound', 'standingDunk'], 10);
        boost(['threePoint', 'speed', 'ballHandle'], -12);
        break;
      default: break;
    }
    return base;
  }

  Team.POSITIONS = POSITIONS;
  Team.randomName = randomName;
  Team.generateRoster = generateRoster;
  Team.SKIN_TONES = SKIN_TONES;
  Team.HAIR_COLOURS = HAIR_COLOURS;

  BB.Team = Team;
})(typeof window !== 'undefined' ? window : globalThis);
