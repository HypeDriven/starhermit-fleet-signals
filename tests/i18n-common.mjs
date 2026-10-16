// Localization coverage helpers: collect the English keys a template-built UI
// shows, and audit the translation tables.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
export const FULL = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', larr: '←', rarr: '→', times: '×' };
const decode = (s) => s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m);
export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const unq = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"');
const HOLE = '\u0000';

/** Load classic-script string tables into one object. */
export function loadTables(root, files, globalName) {
  const sandbox = { self: {} };
  sandbox.window = sandbox.self;
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(readFileSync(new URL(f, root), 'utf8'), sandbox);
  return sandbox.self[globalName];
}

/** English keys passed to T('…') / N('…'), including T(c ? '…' : '…'). */
export function codeKeys(src, fns = ['T', 'N']) {
  const keys = new Set();
  const f = fns.join('|');
  const lit = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${f})\(\s*(?:${lit})`, 'g'))) keys.add(unq(m[1] ?? m[2]));
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${f})\((?:[^()'"?]|'[^'\n]*'|\([^()]*\))*\?\s*(?:${lit})\s*:\s*(?:${lit})`, 'g'))) {
    keys.add(unq(m[1] ?? m[2])); keys.add(unq(m[3] ?? m[4]));
  }
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

/**
 * Every string / template literal in a JS source, with ${…} replaced by a hole
 * marker. A small lexer: skips comments and regex literals.
 */
export function literals(src) {
  const out = [];
  let i = 0;
  let prev = '';
  const n = src.length;
  const regexAllowed = () => /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(?:return|typeof|case|of|in)$/.test(prev) || prev === '';
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === '/' && regexAllowed()) {
      i++; let cls = false;
      while (i < n) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; else if (d === '\n') break; i++; }
      i++; while (/[a-z]/.test(src[i] || '')) i++;
      prev = 'x'; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== c) { if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; } s += src[j]; j++; }
      out.push(s); i = j + 1; prev = 'x'; continue;
    }
    if (c === '`') {
      const r = template(src, i + 1);
      out.push(...r.nested, r.text); i = r.end; prev = 'x'; continue;
    }
    if (!/\s/.test(c)) prev = (prev + c).slice(-8);
    i++;
  }
  return out;
}
function template(src, i) {
  let text = '';
  const nested = [];
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { text += src[i + 1]; i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') {
      // Expression: find the matching brace, collecting nested literals.
      let depth = 1, j = i + 2; const start = j;
      while (j < src.length && depth) {
        const d = src[j];
        if (d === '`') { const r = template(src, j + 1); j = r.end; continue; }
        if (d === "'" || d === '"') { let k = j + 1; while (k < src.length && src[k] !== d) { if (src[k] === '\\') k++; k++; } j = k + 1; continue; }
        if (d === '{') depth++; else if (d === '}') depth--;
        j++;
      }
      nested.push(...literals(src.slice(start, j - 1)));
      text += HOLE; i = j; continue;
    }
    text += src[i]; i++;
  }
  return { text, nested, end: i + 1 };
}

/** Static text and aria-label/title/placeholder/alt values inside HTML-ish literals. */
export function htmlKeys(literal, { strict = false } = {}) {
  const keys = new Set();
  if (!/<\/?[a-z]/i.test(literal) && !strict) return [];
  let body = literal.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|code|kbd)\b[\s\S]*?<\/\1>/g, '')
    .replace(/<(\w+)[^>]*\bdata-i18n-skip\b[^>]*>[\s\S]*?<\/\1>/g, '');
  for (const m of body.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*)"/g)) {
    const v = norm(decode(m[2]));
    if (/[A-Za-z]/.test(v) && !v.includes(HOLE)) keys.add(v);
  }
  body = body.replace(/<[^<>]*>/g, '<>');
  for (const seg of body.split('<>')) {
    for (const part of seg.split(HOLE)) {
      const v = norm(decode(part));
      if (/[A-Za-z]{2}/.test(v)) keys.add(v);
    }
  }
  return [...keys];
}

/** Text segments inside HTML literals that also contain an interpolation (must use T()). */
export function mixedSegments(literal) {
  if (!/<\/?[a-z]/i.test(literal)) return [];
  const body = literal.replace(/<(script|style|code|kbd)\b[\s\S]*?<\/\1>/g, '').replace(/<[^<>]*>/g, '<>');
  return body.split('<>').filter((seg) => seg.includes(HOLE) && /[A-Za-z]{2}/.test(seg.split(HOLE).join(' '))).map((s) => norm(s.split(HOLE).join('…')));
}

/** Problems: missing translations in full locales, placeholder drift, stale or unknown keys. */
export function audit(tables, used, { allowUnused = [] } = {}) {
  const usedSet = new Set(used);
  const problems = [];
  for (const loc of FULL) {
    const t = tables[loc] || {};
    for (const k of usedSet) if (!Object.prototype.hasOwnProperty.call(t, k)) problems.push(`${loc} missing: ${k}`);
  }
  for (const [loc, table] of Object.entries(tables)) {
    if (!LOCALES.includes(loc)) problems.push(`unknown locale ${loc}`);
    for (const [k, v] of Object.entries(table)) {
      if (!usedSet.has(k) && !allowUnused.includes(k)) { problems.push(`${loc} unused: ${k}`); continue; }
      const want = (k.match(/\{\w+\}/g) || []).sort().join();
      const got = (String(v).match(/\{\w+\}/g) || []).sort().join();
      if (want !== got) problems.push(`${loc} placeholders: ${k}`);
      const tagsK = (k.match(/<\/?\w+/g) || []).sort().join();
      const tagsV = (String(v).match(/<\/?\w+/g) || []).sort().join();
      if (tagsK !== tagsV) problems.push(`${loc} markup: ${k}`);
    }
  }
  for (const loc of ['en-GB', 'es-ES', 'fr-CA']) if (!tables[loc]) problems.push(`no ${loc} table`);
  return problems;
}

/** A sandbox with sh-language.js + tables + the engine; returns the engine global. */
export function bootI18n(root, { files, global, event, languages = ['de-DE'] }) {
  const events = [];
  const doc = {
    documentElement: { lang: 'en' }, body: null,
    dispatchEvent: (e) => { if (e.type === event) events.push(e.detail.lang); },
    addEventListener() {},
  };
  const sandbox = {
    document: doc, location: { search: '' },
    navigator: { languages, language: languages[0] },
    localStorage: { getItem: () => null, setItem: () => {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o.detail; } },
    URLSearchParams,
  };
  sandbox.self = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(readFileSync(new URL(f, root), 'utf8'), sandbox);
  return { I18N: sandbox[global], events, doc };
}
