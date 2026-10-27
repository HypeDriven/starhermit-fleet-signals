// Fleet Signals — the translation lookup (pure; shared by the engine client
// native/i18n.ts and the node tests). Nine locales: en-US, en-GB, es-419,
// es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT. English source strings are the
// keys; src/i18n/strings*.js fill globalThis.FS_STRINGS (en-GB, es-ES and
// fr-CA carry only their differences from en-US, es-419 and fr-FR).

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
const hasOwn = Object.prototype.hasOwnProperty;

/** The shipped locale nearest a BCP 47 tag (es-MX → es-419, en-AU → en-GB, fr → fr-FR, pt-PT → pt-BR). */
export function matchLocale(tag) {
  const t = String(tag || '').trim();
  const exact = LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const [lang, region = ''] = t.toLowerCase().split(/[-_]/);
  const R = region.toUpperCase();
  if (lang === 'en') return ['GB', 'AU', 'NZ', 'IE', 'IN', 'ZA'].includes(R) ? 'en-GB' : 'en-US';
  if (lang === 'es') return R === 'ES' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return R === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

/** A translator over the tables: T(key, vars), has(key), setLocale(tag), lang. */
export function createI18n(tables) {
  const TABLES = tables || {};
  const KEYS = TABLES['es-419'] || {};
  let lang = 'en-US';
  const lookup = (key) => {
    for (let l = lang; l; l = PARENT[l]) {
      const t = TABLES[l];
      if (t && hasOwn.call(t, key)) return t[key];
    }
    return key;
  };
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  return {
    T(key, vars) {
      let s = lookup(String(key));
      if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (hasOwn.call(vars, k) ? String(vars[k]) : m));
      return s;
    },
    has(key) { return hasOwn.call(KEYS, norm(key)); },
    setLocale(tag) { lang = matchLocale(tag); return lang; },
    get lang() { return lang; },
    locales: LOCALES,
    tables: TABLES,
  };
}
