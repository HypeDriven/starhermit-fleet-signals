// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's tables: nine locales keyed by the US-English text; en-GB,
// es-ES and fr-CA hold their differences, the chain reads the rest) in the
// interface language the runtime reports (the player's choice in Options ›
// Language, else the device's). The browser build's own Language selector, its
// ?lang= override and the account's preferred-language lookup are the runtime's
// now. The account lines the engine has are its `starhermit.*` keys. A change
// re-renders everything next frame (the UI is immediate mode).
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

/** Translates an English source string ({name} placeholders from vars); unknown text passes through. */
export function T(key: string, vars?: Record<string, string | number>): string {
  const s = String(key);
  if (strings.has(s)) return strings.t(s, vars);
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars && vars[k] != null ? String(vars[k]) : m));
}
/** Marks English text translated where it is drawn (keeps the key visible to tests/i18n.test.mjs). */
export const N = (key: string): string => key;
/** A player or ship name: built-in names (AI captains, ships, "You") are translated, typed names are not. */
export function pname(name: unknown): string { const s = String(name ?? ""); return strings.has(s) ? strings.t(s) : s; }
