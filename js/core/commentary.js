/* =============================================================================
 * commentary.js  —  Spoken play-by-play.
 * -----------------------------------------------------------------------------
 * Uses the browser's own text-to-speech (Web Speech API) rather than audio
 * files, so a real spoken voice works completely offline — no network, no
 * asset downloads, nothing to bundle. Every desktop OS ships at least one
 * system voice Chrome/Edge/Safari/Firefox can all reach locally.
 *
 * Feature-detected: on a browser/OS with no TTS voices installed, every
 * method here silently no-ops instead of throwing, so it's always safe to
 * call without checking support first.
 *
 * Lines can carry a {name} placeholder. Each category mixes name-lines and
 * pronoun-only lines in the same pool, so it reads like a real broadcaster —
 * using a name sometimes, "he"/generic phrasing the rest, never every time.
 * ========================================================================== */
(function (global) {
  'use strict';
  const BB = global.BB || (global.BB = {});
  const U = BB.U;

  const SUPPORTED = typeof global.speechSynthesis !== 'undefined'
    && typeof global.SpeechSynthesisUtterance !== 'undefined';

  const Commentary = {
    enabled: true,
    volume: 0.85,
    voice: null,
    _cooldowns: Object.create(null),
    _sinceLastLine: 0,       // seconds since any line last spoke, for ambient filler
    _sinceLastAmbient: 0,

    init() {
      if (!SUPPORTED) return this;
      const pick = () => {
        const voices = global.speechSynthesis.getVoices();
        if (!voices.length) return;
        this.voice = voices.find((v) => v.lang && v.lang.indexOf('en') === 0 && v.localService)
          || voices.find((v) => v.lang && v.lang.indexOf('en') === 0)
          || voices[0];
      };
      pick();
      global.speechSynthesis.onvoiceschanged = pick;
      return this;
    },

    setEnabled(v) { this.enabled = !!v; if (!this.enabled) this.stop(); },
    setVolume(v) { this.volume = U.clamp01(v); },
    stop() { if (SUPPORTED) global.speechSynthesis.cancel(); },

    /** Called once a fixed-tick from the live game loop so ambient filler
     * knows how long it's been since anything was said. Cheap no-op the
     * rest of the time. */
    tick(dt) {
      this._sinceLastLine += dt;
      this._sinceLastAmbient += dt;
    },

    /**
     * Speak one random line from `lines`, substituting {name} if the line
     * has it. `key` throttles by category so a flurry of events (a foul
     * right after a make) can't talk over itself. `priority` interrupts
     * whatever's currently being said; otherwise a line already speaking
     * just wins and this call is dropped rather than queuing up a backlog.
     */
    /* Silences the commentary box. The walkthrough borrows the 1 vs 1 scene,
     * which calls into here on every score, miss, steal, block and foul; a
     * drill does not want a play-by-play man reacting to it. */
    mute(on) { this.muted = !!on; },

    say(key, lines, opts) {
      if (this.muted) return;
      if (!SUPPORTED || !this.enabled || !lines || !lines.length) return;
      opts = opts || {};
      const now = (global.performance ? global.performance.now() : Date.now()) / 1000;
      const cd = opts.cooldown == null ? 1.5 : opts.cooldown;
      if (this._cooldowns[key] != null && now - this._cooldowns[key] < cd) return;
      this._cooldowns[key] = now;

      if (opts.priority) this.stop();
      else if (global.speechSynthesis.speaking) return;

      let text = lines[U.rng.i(0, lines.length - 1)];
      if (text.indexOf('{name}') >= 0) text = text.replace(/\{name\}/g, opts.name || 'he');

      const utter = new global.SpeechSynthesisUtterance(text);
      if (this.voice) utter.voice = this.voice;
      utter.volume = this.volume;
      utter.rate = opts.rate || 1.05;
      utter.pitch = opts.pitch == null ? 1.0 : opts.pitch;
      global.speechSynthesis.speak(utter);
      this._sinceLastLine = 0;
    },

    /* ------------------------------------------------------------- events */
    gameStart(names) {
      this.say('start', LINES.start, { priority: true, cooldown: 0, name: names && names.you });
    },
    make(name, three, clean) {
      const lines = three ? (clean ? LINES.threeClean : LINES.three) : (clean ? LINES.bucketClean : LINES.bucket);
      this.say('score', lines, { priority: true, cooldown: 0.8, name });
    },
    miss(name) { this.say('miss', LINES.miss, { cooldown: 1.3, name }); },
    block(name) { this.say('block', LINES.block, { priority: true, cooldown: 1.0, name }); },
    steal(name) { this.say('steal', LINES.steal, { priority: true, cooldown: 1.0, name }); },
    /* Not priority: good defence is a state, not an incident, and it should
     * never talk over a bucket or a whistle that lands in the same second. */
    lockdown(name) { this.say('lockdown', LINES.lockdown, { cooldown: 8.0, name }); },
    foul(isCharge, name) { this.say('foul', isCharge ? LINES.foulCharge : LINES.foul, { cooldown: 1.0, name }); },
    violation(name) { this.say('violation', LINES.violation, { cooldown: 1.0, name }); },
    andOne(name) { this.say('andOne', LINES.andOne, { priority: true, cooldown: 0.5, name }); },
    freeThrowMiss(name) { this.say('ftmiss', LINES.ftMiss, { cooldown: 1.5, name }); },
    streak(n, name) {
      if (n === 3) this.say('streak3', LINES.streak3, { cooldown: 25, name });
      else if (n >= 5) this.say('streak5', LINES.streak5, { cooldown: 20, name });
    },
    closeGame() { this.say('close', LINES.close, { cooldown: 15 }); },
    win(youWon, name) { this.say('final', youWon ? LINES.winYou : LINES.winCpu, { priority: true, cooldown: 0, name }); },
    levelUp(name, level) {
      this.say('levelup', LINES.levelUp, { priority: false, cooldown: 3, name: (name || 'he') + '... now level ' + level });
    },

    /**
     * Ambient colour commentary for quiet stretches — a live possession
     * with nobody shooting, stealing, or fouling for a while. Called from
     * the live game loop; internally throttled so it only actually speaks
     * occasionally (roughly once every 10-20s of genuine quiet, never on
     * top of a real event since `say()`'s normal speaking-check still
     * applies). Purely atmospheric, never carries game-state information a
     * player needs, so it's safe to fire on a loose timer.
     */
    ambient(name) {
      if (this._sinceLastLine < 6 || this._sinceLastAmbient < 14) return;
      if (!U.rng.chance(0.10)) return; // don't fire the instant the window opens
      this._sinceLastAmbient = 0;
      this.say('ambient', LINES.ambient, { cooldown: 0, name });
    }
  };

  const LINES = {
    start: [
      "Here we go, one on one.", "Ball's live — let's see what {name}'s got.",
      "And we are underway.", "First to eleven, win by two. Let's play."
    ],
    bucket: [
      "Bucket.", "{name} buries it.", "Good look, good shot.", "Right through the net.",
      "{name}'s got it going now.", "Counts.", "{name} scores."
    ],
    bucketClean: [
      "Nothing but net!", "Pure — doesn't touch a thing.", "Swish. Clean as it gets.",
      "Oh, that is silky smooth from {name}."
    ],
    three: [
      "From way downtown, {name} got it!", "He lets it fly, and it is good for three!",
      "Bang! Three!", "{name} steps back and drills it."
    ],
    threeClean: [
      "Splash! Nothing but the bottom of the net!", "Ohh, {name} was raining from deep!",
      "He was raining from outside there!"
    ],
    miss: [
      "No good.", "Off the rim.", "{name} can't buy one there.", "Rim rattles it out.",
      "Just missed that one.", "Front rim, no good.", "{name} misses."
    ],
    block: [
      "Rejected!", "{name} sends it back!", "Oh, he got all ball on that one!",
      "Denied at the rim!", "What a block by {name}!"
    ],
    steal: [
      "{name} picks his pocket!", "Strips it clean!", "Great hands, {name} takes it away!",
      "He jumps the lane — stolen!"
    ],
    lockdown: [
      "{name} is all over him!", "Great defensive position by {name}.",
      "He can't shake him — {name} is glued to his hip!",
      "Textbook stance from {name}, nowhere to go."
    ],
    foul: [
      "Whistle. That's a foul.", "The ref's got a call there.",
      "Contact — and that's a foul on {name}.", "They're going to call that one."
    ],
    foulCharge: [
      "Offensive foul! {name} ran right through him.", "Charge! That defender was already set.",
      "Oh, he lowered the shoulder — offensive foul."
    ],
    violation: [
      "Travel! They caught the extra step.", "Whistle — that's a violation on {name}.",
      "Double dribble, right there."
    ],
    andOne: [
      "{name} gets fouled and it goes in! And one!", "Contact, but it's still good! One more coming!",
      "He made it anyway! And a free throw to follow."
    ],
    ftMiss: ["Free throw's off.", "Rims out at the line.", "{name} doesn't get it to fall from the stripe."],
    streak3: ["{name}'s starting to heat up.", "That's a few in a row now.", "He's feeling it out there."],
    streak5: ["{name} is on fire right now!", "This guy cannot miss!", "Unconscious shooting from {name} right now."],
    close: ["Down to the wire here!", "This one is coming right down to the end.", "Every possession matters now."],
    winYou: ["Game! {name} takes it!", "That'll do it — {name} wins it!", "And that seals the victory for {name}!"],
    winCpu: ["Game. The CPU gets the win.", "That's it, CPU takes this one.", "And that seals it for the computer."],
    levelUp: ["Big moment for {name}.", "{name} is only getting better out here."],
    ambient: [
      "He's probing, looking for an opening.", "Working it out top.",
      "Feeling out the defense here.", "Both guys catching their breath a little.",
      "Patient possession here.", "He's not in a hurry with this one.",
      "Good defensive stance, staying in front.", "Cagey stuff right now, nobody giving an inch."
    ]
  };

  BB.Commentary = Commentary;
})(typeof window !== 'undefined' ? window : globalThis);
