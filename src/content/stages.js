/**
 * Authored content for Fleet Signals: visual themes, the 40-stage Journey,
 * Challenge-mode entries, the deterministic daily stage, and validation.
 * Pure data plus small pure functions — no DOM, no engine imports.
 */

import { makeRng } from '../rules/rng.js';

export const CONTENT_VERSION = 1;

/** Ship sizes per fleet id, mirroring src/rules/engine.js FLEETS. */
const FLEET_SIZES = {
  standard: [5, 4, 3, 3, 2],
  compact: [4, 3, 3, 2],
  vanguard: [5, 4, 4, 3, 2],
  patrol: [3, 2, 2],
};

const MECHANIC_KEYS = ['salvo', 'moveLimit', 'mineCount', 'noTouch', 'allowUndo', 'fog'];
const AI_LEVELS = ['easy', 'medium', 'hard'];

export const THEMES = [
  {
    id: 'abyss-chart',
    name: 'Abyss Chart',
    ui: { accent: '#4fd8e8', bg: '#060d16', panel: '#0c1a26', text: '#d7e8f0' },
    scene: {
      waterDeep: '#04121e', waterShallow: '#0a2e42', sky: '#0a1a2a',
      fog: '#10303f', holoGrid: '#1e5f73', holoShip: '#63e2f2', sun: '#b8e6f0',
    },
  },
  {
    id: 'ember-drift',
    name: 'Ember Drift',
    ui: { accent: '#f0a24a', bg: '#140b06', panel: '#241408', text: '#f2e2cc' },
    scene: {
      waterDeep: '#1a0e06', waterShallow: '#3a2210', sky: '#241206',
      fog: '#2e1a0c', holoGrid: '#7a4a1e', holoShip: '#ffb45e', sun: '#ffd9a0',
    },
  },
  {
    id: 'verdant-sonar',
    name: 'Verdant Sonar',
    ui: { accent: '#5ee08a', bg: '#071008', panel: '#0f2012', text: '#dcf2e0' },
    scene: {
      waterDeep: '#06170c', waterShallow: '#0e3520', sky: '#0a2012',
      fog: '#12301e', holoGrid: '#2e7a4a', holoShip: '#7bf2a6', sun: '#d8f2b0',
    },
  },
  {
    id: 'umbral-violet',
    name: 'Umbral Violet',
    ui: { accent: '#b58af0', bg: '#0d0816', panel: '#1a1030', text: '#e6dcf5' },
    scene: {
      waterDeep: '#120a24', waterShallow: '#2a1a4a', sky: '#170e2e',
      fog: '#241640', holoGrid: '#5a3a9a', holoShip: '#c9a2ff', sun: '#e8d8ff',
    },
  },
  {
    id: 'glacier-front',
    name: 'Glacier Front',
    ui: { accent: '#7ec8f0', bg: '#0b141c', panel: '#14242e', text: '#e2eef4' },
    scene: {
      waterDeep: '#0e2230', waterShallow: '#2a4a5e', sky: '#33505f',
      fog: '#9fb8c4', holoGrid: '#4a8aa8', holoShip: '#a8e0f8', sun: '#f0f8ff',
    },
  },
];

const T = THEMES.map((t) => t.id);

export const STAGES = [
  {
    id: 'j01', index: 1, name: 'First Light on the Sound',
    briefing: 'Dawn watch, Captain. Three hostile hulls hide in a six-by-six sounding — small water, small fleet, no excuses. Find them and put them under.',
    seed: 'j01-first-light', gridSize: 6, fleetId: 'patrol', mechanics: {},
    aiDifficulty: 'easy', par: 22, theme: T[0], mastery: false,
    tutorialFlags: ['placement', 'firing'],
  },
  {
    id: 'j02', index: 2, name: 'Calm Water Drill',
    briefing: 'The gunnery crews are green, so the fleet kindly anchored more targets in the sound. Same drill as yesterday — steadier hands this time.',
    seed: 'j02-calm-water', gridSize: 6, fleetId: 'patrol', mechanics: {},
    aiDifficulty: 'easy', par: 20, theme: T[1], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j03', index: 3, name: 'Two-Buoy Channel',
    briefing: 'A fourth ship has joined the enemy flotilla — a cruiser, longer and harder to miss once you clip her. Work the grid methodically, Captain.',
    seed: 'j03-two-buoy', gridSize: 6, fleetId: 'compact', mechanics: {},
    aiDifficulty: 'easy', par: 23, theme: T[2], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j04', index: 4, name: 'Ink on the Chart',
    briefing: 'The admiral has authorised pencil corrections on this exercise: take back a placement or a shot while you still learn the chart. Training wheels, nothing more.',
    seed: 'j04-ink-chart', gridSize: 6, fleetId: 'compact', mechanics: { allowUndo: true },
    aiDifficulty: 'easy', par: 21, theme: T[3], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j05', index: 5, name: 'Breakwater Trial',
    briefing: 'Mastery board, Captain: the same cramped water, but the opposing commander finally woke up. Clear the channel cleanly and the fleet sails at your word.',
    seed: 'j05-breakwater', gridSize: 6, fleetId: 'compact', mechanics: {},
    aiDifficulty: 'medium', par: 20, theme: T[4], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j06', index: 6, name: 'Open Water Orders',
    briefing: 'The training pool is behind you. Eight by eight of open sea and a full five-ship squadron — carrier and all — waiting beyond the mist.',
    seed: 'j06-open-water', gridSize: 8, fleetId: 'standard', mechanics: {},
    aiDifficulty: 'easy', par: 38, theme: T[0], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j07', index: 7, name: 'The Rationed Broadside',
    briefing: 'New doctrine from the quartermaster: every shell is counted. You have a generous allowance for this patrol — spend it, but learn to spend it well.',
    seed: 'j07-rationed', gridSize: 8, fleetId: 'standard', mechanics: { moveLimit: 55 },
    aiDifficulty: 'easy', par: 36, theme: T[1], mastery: false, tutorialFlags: ['move-limit'],
  },
  {
    id: 'j08', index: 8, name: 'Counting Cordite',
    briefing: 'The magazines run thinner today. Fifty rounds for the whole engagement — a careful captain will not need the last ten.',
    seed: 'j08-cordite', gridSize: 8, fleetId: 'standard', mechanics: { moveLimit: 50 },
    aiDifficulty: 'easy', par: 34, theme: T[2], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j09', index: 9, name: 'Narrow Margin',
    briefing: 'Forty-five shells and an enemy who has started reading your patterns. Hunt in straight lines, close on your hits, and the margin holds.',
    seed: 'j09-narrow-margin', gridSize: 8, fleetId: 'standard', mechanics: { moveLimit: 45 },
    aiDifficulty: 'medium', par: 32, theme: T[3], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j10', index: 10, name: "Quartermaster's Audit",
    briefing: 'Mastery board. The audit is simple, Captain: sink the squadron inside forty-two rounds, or explain the shortfall to the fleet in person.',
    seed: 'j10-audit', gridSize: 8, fleetId: 'standard', mechanics: { moveLimit: 42 },
    aiDifficulty: 'medium', par: 30, theme: T[4], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j11', index: 11, name: 'Something Below',
    briefing: 'Charts show a single loose mine adrift in the patrol box. Striking it costs you an extra round and gains nothing — shoot around it, Captain.',
    seed: 'j11-something-below', gridSize: 8, fleetId: 'standard', mechanics: { mineCount: 1 },
    aiDifficulty: 'easy', par: 36, theme: T[0], mastery: false, tutorialFlags: ['mines'],
  },
  {
    id: 'j12', index: 12, name: 'Teeth in the Shallows',
    briefing: 'Two mines now, sown where the water runs shallow. The enemy hides among them and trusts you to be careless. Prove the trust misplaced.',
    seed: 'j12-teeth', gridSize: 8, fleetId: 'standard', mechanics: { mineCount: 2 },
    aiDifficulty: 'easy', par: 34, theme: T[1], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j13', index: 13, name: 'Mines and Measures',
    briefing: 'Now the two lessons meet: mines under the water, a ledger over your head. Fifty rounds, two hazards, one squadron to erase.',
    seed: 'j13-measures', gridSize: 8, fleetId: 'standard', mechanics: { mineCount: 2, moveLimit: 50 },
    aiDifficulty: 'medium', par: 33, theme: T[2], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j14', index: 14, name: 'The Sown Channel',
    briefing: 'Three mines and forty-eight shells. Every stray shot is a double loss now — the round, and the allowance it came from.',
    seed: 'j14-sown-channel', gridSize: 8, fleetId: 'standard', mechanics: { mineCount: 3, moveLimit: 48 },
    aiDifficulty: 'medium', par: 32, theme: T[3], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j15', index: 15, name: 'Harvest of Anchors',
    briefing: 'Mastery board. The channel is sown thick and the magazine is thin. Bring the fleet through, Captain, and no mine will ever frighten you again.',
    seed: 'j15-harvest', gridSize: 8, fleetId: 'standard', mechanics: { mineCount: 3, moveLimit: 44 },
    aiDifficulty: 'medium', par: 30, theme: T[4], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j16', index: 16, name: 'All Guns Speaking',
    briefing: 'Salvo doctrine, Captain: every ship still afloat fires each turn. Your broadsides grow weaker as hulls die — so will theirs. Trade well.',
    seed: 'j16-all-guns', gridSize: 8, fleetId: 'standard', mechanics: { salvo: true },
    aiDifficulty: 'medium', par: 34, theme: T[0], mastery: false, tutorialFlags: ['salvo'],
  },
  {
    id: 'j17', index: 17, name: 'Rolling Thunder Line',
    briefing: 'Two squadrons in line ahead, guns speaking in volleys. Kill their small ships early and starve their salvo before yours thins.',
    seed: 'j17-thunder-line', gridSize: 8, fleetId: 'standard', mechanics: { salvo: true },
    aiDifficulty: 'medium', par: 32, theme: T[1], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j18', index: 18, name: 'Thunder on a Budget',
    briefing: 'Salvos feel generous until the ledger arrives. Forty-eight total shots across every volley — make the early ones count.',
    seed: 'j18-budget-thunder', gridSize: 8, fleetId: 'standard', mechanics: { salvo: true, moveLimit: 48 },
    aiDifficulty: 'medium', par: 31, theme: T[2], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j19', index: 19, name: 'Fire Over the Sown Field',
    briefing: 'Full broadsides over mined water. A salvo that finds a mine pays double — watch where the volley falls.',
    seed: 'j19-sown-fire', gridSize: 8, fleetId: 'standard', mechanics: { salvo: true, mineCount: 2 },
    aiDifficulty: 'medium', par: 31, theme: T[3], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j20', index: 20, name: 'Symphony of the Watch',
    briefing: 'Mastery board. Salvos, mines, and a forty-four shot ceiling, all at once. Conduct it cleanly, Captain, and the watch will remember.',
    seed: 'j20-symphony', gridSize: 8, fleetId: 'standard', mechanics: { salvo: true, mineCount: 2, moveLimit: 44 },
    aiDifficulty: 'medium', par: 29, theme: T[4], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j21', index: 21, name: 'Wide Berth',
    briefing: 'New standing order: no two ships may moor hull-to-hull, not even corner to corner — collisions kill more fleets than guns do. Plot a spread formation.',
    seed: 'j21-wide-berth', gridSize: 8, fleetId: 'standard', mechanics: { noTouch: true },
    aiDifficulty: 'medium', par: 33, theme: T[0], mastery: false, tutorialFlags: ['no-touch'],
  },
  {
    id: 'j22', index: 22, name: 'The Quiet War',
    briefing: 'The enemy has jammed our signal lamps: sinkings are confirmed, but no longer named. Count hulls in your head, Captain, because the chart will not.',
    seed: 'j22-quiet-war', gridSize: 8, fleetId: 'standard', mechanics: { fog: true },
    aiDifficulty: 'medium', par: 33, theme: T[1], mastery: false, tutorialFlags: ['fog'],
  },
  {
    id: 'j23', index: 23, name: 'Vanguard Horizon',
    briefing: 'Ten by ten now — real ocean. The enemy fields a vanguard squadron: a carrier, twin cruisers, escorts. More water to search, more steel to sink.',
    seed: 'j23-vanguard', gridSize: 10, fleetId: 'vanguard', mechanics: {},
    aiDifficulty: 'medium', par: 40, theme: T[2], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j24', index: 24, name: 'Blind Etiquette',
    briefing: 'Wide-berth discipline under signal fog, on the big water. You will not know what you have sunk — only that something stopped answering.',
    seed: 'j24-blind-etiquette', gridSize: 10, fleetId: 'vanguard', mechanics: { noTouch: true, fog: true },
    aiDifficulty: 'medium', par: 38, theme: T[3], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j25', index: 25, name: 'Ghost Convoy',
    briefing: 'Mastery board. A convoy you cannot name, a sixty-shell allowance you cannot stretch. Trust the hunt, Captain — the ghosts will not trust you.',
    seed: 'j25-ghost-convoy', gridSize: 10, fleetId: 'vanguard', mechanics: { fog: true, moveLimit: 60 },
    aiDifficulty: 'medium', par: 36, theme: T[4], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j26', index: 26, name: 'Fog Over the Mine Line',
    briefing: 'Mines below, silence above. Two hazards you must feel for and a foe whose losses you must tally yourself.',
    seed: 'j26-fog-mines', gridSize: 8, fleetId: 'standard', mechanics: { mineCount: 2, fog: true },
    aiDifficulty: 'medium', par: 31, theme: T[0], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j27', index: 27, name: 'Formal Broadside',
    briefing: 'Salvo discipline with parade-ground spacing — your ships may not touch, and every survivor fires. Elegant on paper, murder on water.',
    seed: 'j27-formal', gridSize: 8, fleetId: 'standard', mechanics: { salvo: true, noTouch: true },
    aiDifficulty: 'medium', par: 30, theme: T[1], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j28', index: 28, name: 'The Long Ledger',
    briefing: 'Big ocean, two mines, fifty-five rounds. The ledger looks generous until the tenth empty volley — guard it, Captain.',
    seed: 'j28-long-ledger', gridSize: 10, fleetId: 'standard', mechanics: { moveLimit: 55, mineCount: 2 },
    aiDifficulty: 'medium', par: 34, theme: T[2], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j29', index: 29, name: 'Silent Salvos',
    briefing: 'Full broadsides under signal fog. Your guns speak in volleys; the enemy answers in silence. Count the quiet ones as they fall.',
    seed: 'j29-silent-salvos', gridSize: 10, fleetId: 'standard', mechanics: { salvo: true, fog: true },
    aiDifficulty: 'medium', par: 33, theme: T[3], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j30', index: 30, name: "Warden's Reckoning",
    briefing: 'Mastery board. Twin cruisers, three mines, fifty-eight rounds of cold arithmetic. The reckoning is yours to deliver, Captain.',
    seed: 'j30-reckoning', gridSize: 10, fleetId: 'vanguard', mechanics: { mineCount: 3, moveLimit: 58 },
    aiDifficulty: 'medium', par: 36, theme: T[4], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j31', index: 31, name: 'Hard Requisition',
    briefing: 'The requisition office has gone feral: forty shots for a full squadron under salvo doctrine, against a commander who shoots back like a veteran.',
    seed: 'j31-requisition', gridSize: 8, fleetId: 'standard', mechanics: { salvo: true, moveLimit: 40 },
    aiDifficulty: 'hard', par: 28, theme: T[0], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j32', index: 32, name: 'Black Water Arithmetic',
    briefing: 'Three mines, no names for the dead, forty-two rounds. The arithmetic is unforgiving and so is the water. Solve it anyway.',
    seed: 'j32-black-water', gridSize: 8, fleetId: 'standard', mechanics: { mineCount: 3, fog: true, moveLimit: 42 },
    aiDifficulty: 'hard', par: 29, theme: T[1], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j33', index: 33, name: 'The Crowded Chart',
    briefing: 'Ten by ten and still not enough sea: strict spacing, three mines, fifty-two shells. Every mark on this chart must earn its ink.',
    seed: 'j33-crowded-chart', gridSize: 10, fleetId: 'standard', mechanics: { noTouch: true, mineCount: 3, moveLimit: 52 },
    aiDifficulty: 'hard', par: 32, theme: T[2], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j34', index: 34, name: 'No Names, No Mercy',
    briefing: 'A vanguard squadron under full fog and salvo fire, fifty-five rounds to finish it. They will not announce their dead. Neither will you.',
    seed: 'j34-no-names', gridSize: 10, fleetId: 'vanguard', mechanics: { salvo: true, fog: true, moveLimit: 55 },
    aiDifficulty: 'hard', par: 34, theme: T[3], mastery: false, tutorialFlags: [],
  },
  {
    id: 'j35', index: 35, name: 'Iron Protocol',
    briefing: 'Mastery board. Salvos over mined water against the fleet’s best opposing mind. The protocol is iron, Captain — be iron with it.',
    seed: 'j35-iron-protocol', gridSize: 10, fleetId: 'vanguard', mechanics: { salvo: true, mineCount: 3, fog: true },
    aiDifficulty: 'hard', par: 33, theme: T[4], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j36', index: 36, name: 'Thirty-Eight Rounds',
    briefing: 'The gauntlet begins. Thirty-eight rounds, two mines, silent sinkings, and a full squadron that knows your trade. No margin was ever promised.',
    seed: 'j36-thirty-eight', gridSize: 8, fleetId: 'standard', mechanics: { moveLimit: 38, mineCount: 2, fog: true },
    aiDifficulty: 'hard', par: 27, theme: T[0], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j37', index: 37, name: 'The Disciplined Fleet',
    briefing: 'Wide spacing, salvo fire, fifty shots on the big ocean. Discipline is the only supply ship still sailing with you, Captain.',
    seed: 'j37-disciplined', gridSize: 10, fleetId: 'standard', mechanics: { salvo: true, noTouch: true, moveLimit: 50 },
    aiDifficulty: 'hard', par: 31, theme: T[1], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j38', index: 38, name: 'Hammer and Sown Deep',
    briefing: 'Twin cruisers, three mines, fifty-two rounds of thunder. Strike the hammer blow and do not waste the echo.',
    seed: 'j38-hammer-sown', gridSize: 10, fleetId: 'vanguard', mechanics: { salvo: true, mineCount: 3, moveLimit: 52 },
    aiDifficulty: 'hard', par: 32, theme: T[2], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j39', index: 39, name: 'The Unseen Toll',
    briefing: 'Four mines and total silence. The toll is paid in shells and certainty, and you are short of both. One stage remains after this.',
    seed: 'j39-unseen-toll', gridSize: 10, fleetId: 'vanguard', mechanics: { mineCount: 4, fog: true, moveLimit: 50 },
    aiDifficulty: 'hard', par: 31, theme: T[3], mastery: true, tutorialFlags: [],
  },
  {
    id: 'j40', index: 40, name: "Admiral's Silence",
    briefing: 'The capstone, Captain: a vanguard squadron under fog and mines, salvo against salvo, fifty-five rounds in the locker. Win, and the fleet speaks your name in every port.',
    seed: 'j40-admirals-silence', gridSize: 10, fleetId: 'vanguard', mechanics: { salvo: true, mineCount: 3, fog: true, moveLimit: 55 },
    aiDifficulty: 'hard', par: 33, theme: T[4], mastery: true, tutorialFlags: [],
  },
];

export const CHALLENGES = [
  {
    id: 'c01', name: 'Ration Run',
    description: 'The convoy sails at dusk and the magazine is nearly bare. Sink the squadron on the tightest allowance the quartermaster has ever signed.',
    seed: 'c01-ration-run', gridSize: 8, fleetId: 'standard', mechanics: { moveLimit: 34 },
    aiDifficulty: 'medium', par: 30, theme: 'ember-drift',
    goalText: 'Win with at most 34 shots', constraint: { type: 'move-limit', value: 34 },
  },
  {
    id: 'c02', name: 'Storm Battery',
    description: 'Salvo doctrine without restraint: every hull afloat fires every turn, theirs included. End the storm before it ends you.',
    seed: 'c02-storm-battery', gridSize: 10, fleetId: 'vanguard', mechanics: { salvo: true, moveLimit: 52 },
    aiDifficulty: 'hard', par: 34, theme: 'umbral-violet',
    goalText: 'Win the salvo duel with at most 52 shots', constraint: { type: 'move-limit', value: 52 },
  },
  {
    id: 'c03', name: 'The Sown Approach',
    description: 'Six mines guard the approach and every one of them bills you a shell for the lesson. Thread the field and sink what hides behind it.',
    seed: 'c03-sown-approach', gridSize: 8, fleetId: 'standard', mechanics: { mineCount: 6, moveLimit: 44 },
    aiDifficulty: 'medium', par: 31, theme: 'abyss-chart',
    goalText: 'Win with at most 44 shots across a six-mine field', constraint: { type: 'move-limit', value: 44 },
  },
  {
    id: 'c04', name: 'Etiquette of Distance',
    description: 'Parade rules at war footing: no two ships may touch, and the allowance leaves no room for awkward formations.',
    seed: 'c04-etiquette', gridSize: 10, fleetId: 'standard', mechanics: { noTouch: true, moveLimit: 56 },
    aiDifficulty: 'medium', par: 33, theme: 'verdant-sonar',
    goalText: 'Win with strict spacing and at most 56 shots', constraint: { type: 'move-limit', value: 56 },
  },
  {
    id: 'c05', name: 'Blindfold Duel',
    description: 'Total signal fog against a veteran commander. No names, no confirmations — only the tally you keep yourself.',
    seed: 'c05-blindfold', gridSize: 8, fleetId: 'standard', mechanics: { fog: true, moveLimit: 44 },
    aiDifficulty: 'hard', par: 30, theme: 'glacier-front',
    goalText: 'Win under fog with at most 44 shots', constraint: { type: 'move-limit', value: 44 },
  },
  {
    id: 'c06', name: 'Knife Fight in a Bathtub',
    description: 'Six by six of brackish water, three little ships apiece, and eighteen rounds to settle it. Every shot is a declaration.',
    seed: 'c06-knife-fight', gridSize: 6, fleetId: 'patrol', mechanics: { moveLimit: 18 },
    aiDifficulty: 'medium', par: 15, theme: 'ember-drift',
    goalText: 'Win with at most 18 shots', constraint: { type: 'move-limit', value: 18 },
  },
  {
    id: 'c07', name: "Sharpshooter's Oath",
    description: 'The gunnery school wants proof, not victory laps. Sink the squadron while landing more hits than misses.',
    seed: 'c07-sharpshooter', gridSize: 8, fleetId: 'standard', mechanics: {},
    aiDifficulty: 'medium', par: 30, theme: 'abyss-chart',
    goalText: 'Win with at least 55% accuracy', constraint: { type: 'accuracy', value: 55 },
  },
  {
    id: 'c08', name: 'Signal Sprint',
    description: 'The relay buoy dies in four minutes. Break the squadron before the light does — hesitation is the only true enemy here.',
    seed: 'c08-signal-sprint', gridSize: 8, fleetId: 'standard', mechanics: {},
    aiDifficulty: 'medium', par: 29, theme: 'verdant-sonar',
    goalText: 'Win in under 240 seconds', constraint: { type: 'speed', value: 240 },
  },
];

const DAILY_BRIEFINGS = [
  'A cipher came through at midnight: hostile hulls in the patrol box, composition unknown until your first hit. Routine, if routine ever were.',
  'Today’s water, today’s war. The signal corps drew this box from the lottery drum — make it read like a lesson.',
  'No name for this engagement yet, Captain. Win it well and the logkeeper will invent something heroic.',
  'The fleet rotates its watch, but the sea keeps its own schedule. Clear today’s box before the tide of shells runs out.',
];

/**
 * Deterministically build today's daily stage from a 'YYYY-MM-DD' date string.
 * Same date always yields the same stage; never uses noTouch.
 * @param {string} dateStr date in 'YYYY-MM-DD' form
 * @returns stage-shaped object with daily: true
 */
export function dailyStage(dateStr) {
  const rng = makeRng('fleet-signals-daily-' + dateStr);
  const gridSize = rng.pick([8, 10]);
  const fleetId = gridSize === 8 ? rng.pick(['compact', 'standard']) : rng.pick(['standard', 'vanguard']);
  const theme = THEMES[rng.int(THEMES.length)].id;
  const weekday = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  const aiDifficulty = AI_LEVELS[(weekday + rng.int(3)) % 3];

  const fleetCells = FLEET_SIZES[fleetId].reduce((a, b) => a + b, 0);
  const lo = fleetCells + 8;
  const hi = Math.floor(gridSize * gridSize * 0.65);
  const par = Math.min(hi, Math.max(lo, fleetCells * 2 + gridSize));

  const mechanics = {};
  const pool = rng.shuffle(['salvo', 'moveLimit', 'mineCount', 'fog']).slice(0, rng.int(3));
  for (const key of pool) {
    if (key === 'salvo' || key === 'fog') mechanics[key] = true;
    else if (key === 'mineCount') mechanics.mineCount = rng.range(1, 3);
    else mechanics.moveLimit = par + rng.range(6, 14);
  }

  return {
    id: 'daily-' + dateStr,
    index: 0,
    name: 'Daily Signal',
    briefing: DAILY_BRIEFINGS[hashMod4(dateStr)],
    seed: 'daily-' + dateStr,
    gridSize,
    fleetId,
    mechanics,
    aiDifficulty,
    par,
    theme,
    mastery: false,
    tutorialFlags: [],
    daily: true,
  };
}

function hashMod4(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % DAILY_BRIEFINGS.length;
}

/**
 * Validate a stage-shaped object against the content contract.
 * Out-of-range par is reported as a 'warn:' problem but still counts as ok.
 * @param {object} stage
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateStage(stage) {
  const problems = [];
  const sizes = FLEET_SIZES[stage.fleetId];
  if (!sizes) problems.push(`unknown fleetId '${stage.fleetId}'`);

  const grid = stage.gridSize;
  const gridOk = Number.isInteger(grid) && grid >= 4 && grid <= 12;
  if (!gridOk) problems.push(`gridSize ${grid} outside integer range 4..12`);

  const mechanics = stage.mechanics ?? {};
  const mineCount = mechanics.mineCount ?? 0;
  if (sizes && gridOk && sizes.reduce((a, b) => a + b, 0) + mineCount >= grid * grid) {
    problems.push('fleet cells plus mineCount fill the board');
  }

  if (sizes && gridOk) {
    const fleetCells = sizes.reduce((a, b) => a + b, 0);
    const lo = fleetCells + 8;
    const hi = Math.floor(grid * grid * 0.65);
    if (!Number.isInteger(stage.par) || stage.par < lo || stage.par > hi) {
      problems.push(`warn: par ${stage.par} outside [${lo}, ${hi}]`);
    }
  }

  if (!THEMES.some((t) => t.id === stage.theme)) problems.push(`unknown theme '${stage.theme}'`);
  if (!AI_LEVELS.includes(stage.aiDifficulty)) problems.push(`unknown aiDifficulty '${stage.aiDifficulty}'`);

  for (const key of Object.keys(mechanics)) {
    if (!MECHANIC_KEYS.includes(key)) problems.push(`unknown mechanics key '${key}'`);
  }

  if (stage.mastery && stage.aiDifficulty === 'easy') {
    problems.push('mastery stage must use medium or hard AI');
  }

  return { ok: problems.every((p) => p.startsWith('warn:')), problems };
}

/**
 * Find a Journey stage by id.
 * @param {string} id e.g. 'j07'
 * @returns the stage or undefined
 */
export function stageById(id) {
  return STAGES.find((s) => s.id === id);
}

/**
 * Find a Challenge entry by id.
 * @param {string} id e.g. 'c03'
 * @returns the challenge or undefined
 */
export function challengeById(id) {
  return CHALLENGES.find((c) => c.id === id);
}
