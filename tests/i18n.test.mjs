// Localization coverage: every English key the UI shows — static text and
// labels inside the HTML templates (translated by the DOM observer in
// src/i18n/i18n.js), T('…') / N('…') keys in code, the engine's log and score
// patterns, and the content names (stages, briefings, challenges, themes,
// lessons, achievements, ships, captains) — is translated in every locale
// (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit) with intact
// placeholders, and the language follows sh-language.js and switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadTables, codeKeys, literals, htmlKeys, mixedSegments, audit, bootI18n } from './i18n-common.mjs';
import { STAGES, CHALLENGES, THEMES } from '../src/content/stages.js';
import { LESSONS } from '../src/content/tutorial.js';
import { FLEETS } from '../src/rules/engine.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const FILES = ['src/i18n/strings.js', 'src/i18n/strings-content.js'];
const jsFiles = (dir) => readdirSync(new URL(dir, ROOT), { recursive: true }).filter((f) => f.endsWith('.js') && !f.startsWith('i18n')).map((f) => dir + f);
const UI_FILES = [...jsFiles('src/ui/'), 'src/main.js'];

export function usedKeys() {
  const keys = new Set();
  for (const f of [...jsFiles('src/'), 'src/main.js']) {
    const src = read(f);
    codeKeys(src).forEach((k) => keys.add(k));
    if (UI_FILES.includes(f)) for (const lit of literals(src)) htmlKeys(lit).forEach((k) => keys.add(k));
  }
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

test('every used key is translated in every locale; placeholders intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, FILES, 'FS_STRINGS'), usedKeys()), []);
});

test('template text never mixes words with an interpolation in one text node', () => {
  const bad = [];
  for (const f of UI_FILES) for (const lit of literals(read(f))) bad.push(...mixedSegments(lit));
  // "Learn" / "Profile" are followed by a badge element, so they stay separate text nodes.
  assert.deepEqual(bad.filter((s) => !/^(Learn|Profile) …$/.test(s)), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { files: ['sh-language.js', ...FILES, 'src/i18n/i18n.js'], global: 'FSI18N', event: 'fs-language', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Confirm deployment'), 'Aufstellung bestätigen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  assert.equal(I18N.T('Admiral Cipher'), 'Amiral Chiffre');
  I18N.language.setChoice('es-ES');
  assert.equal(I18N.T('Deploy all {n} ships first.', { n: 5 }), 'Despliega primero los 5 buques.');
  assert.ok(I18N.has('Sentinel Carrier') && !I18N.has('Salty Admiral'));
});

test('graphics and platform strings cover all nine locales', async () => {
  const { platformStrings } = await import('../src/ui/platform-i18n.js');
  const { gfxStrings, pickGfxLocale } = await import('../src/ui/gfx-i18n.js');
  for (const l of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    for (const k of Object.keys(platformStrings('en-US'))) assert.ok(platformStrings(l)[k], `${l} ${k}`);
    assert.equal(pickGfxLocale(l), l);
    assert.ok(gfxStrings(l).graphics);
  }
});
