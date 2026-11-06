// Localization coverage: every English key the engine client shows — T('…') /
// N('…') keys in native/*.ts, the engine's log and score patterns, the audio
// captions and the content names (stages, briefings, challenges, themes,
// lessons, achievements, ships, captains) — is translated in every locale
// (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit) with intact
// placeholders; no table row goes unused; the lookup switches locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeKeys, audit } from './i18n-common.mjs';
import { STAGES, CHALLENGES, THEMES } from '../src/content/stages.js';
import { LESSONS } from '../src/content/tutorial.js';
import { FLEETS } from '../src/rules/engine.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const TABLES = JSON.parse(read('assets/strings.json'));
const NATIVE = readdirSync(new URL('native/', ROOT)).filter((f) => f.endsWith('.ts')).map((f) => 'native/' + f);

export function usedKeys() {
  const keys = new Set();
  for (const f of NATIVE) codeKeys(read(f)).forEach((k) => keys.add(k));
  // The audio captions (native/audio.ts CAPTIONS, translated where they are drawn).
  const audio = read('native/audio.ts');
  for (const m of audio.matchAll(/"(\[[^"\]]+\])"/g)) keys.add(m[1]);
  for (const s of STAGES) { keys.add(s.name); keys.add(s.briefing); }
  for (const c of CHALLENGES) { keys.add(c.name); keys.add(c.description); keys.add(c.goalText); }
  for (const t of THEMES) keys.add(t.name);
  for (const l of LESSONS) { keys.add(l.title); keys.add(l.intro); for (const s of l.steps) keys.add(s.text); }
  for (const fleet of Object.values(FLEETS)) for (const s of fleet) keys.add(s.name);
  const save = read('src/platform/save.js');
  for (const m of save.matchAll(/name: '([^']+)', description: '([^']+)'/g)) { keys.add(m[1]); keys.add(m[2]); }
  const stages = read('src/content/stages.js');
  const daily = stages.slice(stages.indexOf('const DAILY_BRIEFINGS'), stages.indexOf('];', stages.indexOf('const DAILY_BRIEFINGS')));
  for (const m of daily.matchAll(/'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
  // Built-in captains and seats (pname() translates them), the daily stage name.
  for (const n of ['Rookie Beacon', 'Signal Officer', 'Admiral Cipher', 'Instructor', 'You', 'Guest Captain', 'Daily Signal']) keys.add(n);
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact; no unused rows', () => {
  assert.deepEqual(audit(TABLES, usedKeys()), []);
});

test('the tables hold every locale and the regional differences', () => {
  assert.equal(TABLES['en-US']['Confirm deployment'], 'Confirm deployment');
  assert.equal(TABLES['de-DE']['Confirm deployment'], 'Aufstellung bestätigen');
  assert.equal(TABLES['fr-FR']['Admiral Cipher'], 'Amiral Chiffre');
  assert.equal(TABLES['es-419']['Deploy all {n} ships first.'], 'Despliega primero los {n} buques.');
  assert.equal(TABLES['en-GB']['Color-vision palette'], 'Colour-vision palette');
  assert.ok(TABLES['en-US']['Sentinel Carrier'] && !TABLES['en-US']['Salty Admiral']);
});
