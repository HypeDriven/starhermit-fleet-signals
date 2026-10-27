// The save's pure parts the engine client uses (src/platform/options.js):
// the browser build's cloud save read back (its JS SDK saveJSON text of the
// v2 document, a v1 document migrated, anything else refused), two devices'
// copies merged as the browser build merged them, and the game options with
// the browser build's settings keys they migrate from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSave, checksumDoc, storeSave, loadSave } from '../src/platform/save.js';
import { validDoc, readForeign, mergeDocs, checkOption, isBrowserKey, OPTION_DEFAULTS } from '../src/platform/options.js';

const sealed = (doc) => { doc.checksum = checksumDoc(doc); return doc; };
function progressed(stage, stars, sessions) {
  const d = defaultSave();
  d.journey.completed[stage] = { stars, score: 900, bestShots: 30 };
  d.stats.sessions = sessions;
  return sealed(d);
}

test('a valid v2 document passes; a tampered one does not', () => {
  const d = sealed(defaultSave());
  assert.ok(validDoc(d));
  d.stats.wins = 99;
  assert.ok(!validDoc(d));
  assert.ok(!validDoc(null) && !validDoc('x'));
});

test('the browser build\'s cloud save reads back as its document', () => {
  const d = progressed('j01', 2, 3);
  const got = readForeign(JSON.stringify(d));
  assert.deepEqual(got, d);
  assert.equal(readForeign('not json'), null);
  assert.equal(readForeign(null), null);
  assert.equal(readForeign(JSON.stringify({ version: 2, checksum: 'bad' })), null);
});

test('a v1 cloud save is migrated as loadSave migrates it', () => {
  const v1 = defaultSave();
  v1.version = 1;
  delete v1.boards; delete v1.tutorial;
  v1.journey.completed.j01 = { stars: 3, score: 1500, bestShots: 20 };
  sealed(v1);
  const got = readForeign(JSON.stringify(v1));
  assert.ok(got && got.version === 2 && validDoc(got));
  assert.deepEqual(got.boards, { entries: [] });
  assert.equal(got.journey.completed.j01.stars, 3);
  // loadSave agrees on the same document
  const store = { v: JSON.stringify(v1), getItem() { return this.v; }, setItem(k, v) { this.v = v; } };
  assert.equal(loadSave(store).doc.journey.completed.j01.stars, 3);
});

test('merging: a strict descendant wins, diverged copies combine, invalid ones lose', () => {
  const a = progressed('j01', 1, 2);
  const b = progressed('j01', 1, 2);
  b.journey.completed.j02 = { stars: 3, score: 1200, bestShots: 25 };
  b.stats.sessions = 3;
  sealed(b);
  assert.deepEqual(mergeDocs(a, b), b, 'the descendant');
  const c = progressed('j03', 2, 9); // more sessions, fewer stages: neither descends from the other
  const m = mergeDocs(b, c);
  assert.ok(validDoc(m));
  assert.deepEqual(Object.keys(m.journey.completed).sort(), ['j01', 'j02', 'j03']);
  assert.equal(m.stats.sessions, 9);
  assert.equal(mergeDocs(a, { junk: true }), a);
  assert.equal(mergeDocs(null, a), a);
});

test('storeSave/loadSave round-trip the document', () => {
  const store = { v: null, getItem() { return this.v; }, setItem(k, v) { this.v = v; } };
  const d = progressed('j05', 2, 7);
  storeSave(d, store);
  assert.deepEqual(loadSave(store).doc, d);
});

test('game options: defaults, checks and the browser build\'s settings keys', () => {
  assert.deepEqual(OPTION_DEFAULTS, { theme: 'abyss-chart', palette: 'default', leftHanded: false, haptics: true, captions: false });
  assert.equal(checkOption('theme', 'ember-drift'), 'ember-drift');
  assert.equal(checkOption('theme', 'neon'), undefined);
  assert.equal(checkOption('palette', 'tritanopia'), 'tritanopia');
  assert.equal(checkOption('palette', 'x'), undefined);
  assert.equal(checkOption('haptics', false), false);
  assert.equal(checkOption('haptics', 'yes'), undefined);
  assert.equal(checkOption('music', 0.5), undefined);
  for (const k of ['music', 'graphics', 'theme', 'ui.language', 'audio.options', 'graphics.gpu.desktop']) assert.ok(isBrowserKey(k), k);
  assert.ok(!isBrowserKey('game.theme'));
});
