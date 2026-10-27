// Localization: the browser build's tables (src/i18n/strings.js and
// strings-content.js, nine locales keyed by the US-English text) through
// src/i18n/core.js, in the interface language the runtime reports
// (preferences().language: the player's choice in Options › Language, else
// the device's). The browser build's own Language selector, its ?lang=
// override and the account's preferred-language lookup are the runtime's
// now. globalThis.FSI18N is set so the shared modules' helpers
// (src/i18n/t.js T / pname) translate too. A change re-renders everything
// next frame (the UI is immediate mode).
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import "../src/i18n/strings.js";
import "../src/i18n/strings-content.js";
import { createI18n } from "../src/i18n/core.js";

const I = createI18n((globalThis as unknown as { FS_STRINGS: Record<string, Record<string, string>> }).FS_STRINGS);
(globalThis as unknown as { FSI18N: unknown }).FSI18N = I;

/** Translates an English source string ({name} placeholders from vars). */
export function T(key: string, vars?: Record<string, string | number>): string { return I.T(key, vars); }
/** Marks English text translated where it is drawn (keeps the key visible to tests/i18n.test.mjs). */
export const N = (key: string): string => key;
/** A player or ship name: built-in names (AI captains, ships, "You") are translated, typed names are not. */
export function pname(name: unknown): string { const s = String(name ?? ""); return I.has(s) ? I.T(s) : s; }
export function lang(): string { return I.lang; }

function apply(tag: string): void {
  const locale = I.setLocale(tag);
  ui.setLanguage(locale);
}
/** Wires the language (from onStart; preferences are read at once too). */
export function initLanguage(): void {
  apply(preferences().language);
  onPreferencesChange((p) => apply(p.language));
}
