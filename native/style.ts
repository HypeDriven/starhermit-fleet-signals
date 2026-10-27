// The look of the menus, HUD and dialogs: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start with the theme the runtime's own widgets (checkboxes, selects, text
// fields, dialogs, scroll bars) take. The visual theme (Settings › Display)
// recolours the accent, background, panels and text as App.applySettings
// set the CSS variables; the colour-vision palettes re-hue the hit and miss
// tokens (and the chart's markers, native/render.ts) as the old
// html.palette-* rules did. High contrast is the runtime's option.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export interface UiTheme { accent: string; bg: string; panel: string; text: string }

/** The colour-vision palettes' hit / miss colours (styles.css html.palette-*). */
export const PALETTES: Record<string, { hit: string; miss: string }> = {
  default: { hit: "#ff7a3c", miss: "#cfe8ff" },
  deuteranopia: { hit: "#ffd23c", miss: "#7cc7ff" },
  protanopia: { hit: "#ffd23c", miss: "#9ad5ff" },
  tritanopia: { hit: "#ff5ea8", miss: "#d8f4ff" },
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$warn", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$text" }, minHeight: 44,
      parts: { box: { background: "#ffffff14", border: { width: 1, color: "#ffffff40" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: {
      text: { color: "$text" },
      parts: {
        field: { background: "#ffffff14", radius: 8, padding: { top: 10, end: 12, bottom: 10, start: 12 }, minHeight: 44, border: { width: 1, color: "#ffffff40" }, hovered: { border: { color: "$accent" } } },
        list: { background: "$panel-solid", radius: 8, border: { width: 1, color: "$accent" } },
        option: { hovered: { background: "#59e6ff3d" }, selected: { text: { color: "$accent" } } },
      },
    },
    textField: { text: { color: "$text" }, background: "#ffffff14", radius: 8, border: { width: 1, color: "#ffffff40" }, padding: { top: 10, end: 12, bottom: 10, start: 12 }, minHeight: 44 },
    dialog: {
      background: "$panel-solid", radius: 14, padding: 24, border: { width: 1, color: "$line" },
      shadow: { y: 18, blur: 32, color: "#00000080" },
      parts: { backdrop: { background: "$veil" } },
    },
    scrollArea: { parts: { bar: { background: "#59e6ff59", radius: 4 } } },
    // The key art above the title and the results illustrations (the old <img>s).
    ".title-art-img": { extends: [".title-art"], background: [{ image: "assets/key-art.webp", size: "cover", position: { x: 0.5, y: 0.6 } }, "#0d1c30"] },
    ".results-win-img": { extends: [".results-art"], background: [{ image: "assets/results-win.webp", size: "cover" }, "#0d1c30"] },
    ".results-lose-img": { extends: [".results-art"], background: [{ image: "assets/results-lose.webp", size: "cover" }, "#0d1c30"] },
  });
}

let themeKey = "";
/** The visual theme's colours over the sheet's tokens and the runtime's widgets. */
export function applyUiTheme(t: UiTheme, palette: string): void {
  const key = `${t.accent}${t.bg}${t.panel}${t.text}${palette}`;
  if (key === themeKey) return;
  themeKey = key;
  const p = PALETTES[palette] ?? PALETTES.default!;
  // The old --panel was rgba(…, .88) over the 3D view; the theme's panel colour takes that alpha.
  ui.setTokens({ accent: t.accent, bg: t.bg, panel: t.panel + "e0", text: t.text, hit: p.hit, miss: p.miss });
  ui.setTheme({
    fontSize: 16, headingSize: 24, smallSize: 13.6, padding: 8, spacing: 8, radius: 10,
    text: t.text, muted: "#9db4c6", panel: "#0d1c30", control: "#59e6ff1f", hovered: "#59e6ff3d",
    pressed: "#59e6ff52", field: "#ffffff14", accent: t.accent, focus: "#ffc857", outline: "#59e6ff73",
  });
}
