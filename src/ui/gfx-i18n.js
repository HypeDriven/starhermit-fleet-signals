/**
 * Strings for the Settings → Graphics section in every supported locale.
 * The rest of the game ships in US English; this panel picks its locale
 * from navigator.language (exact tag, then language fallback).
 */

export const GFX_LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

const en = {
  graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})', renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device, so effects that need it are off.',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
    reflections: 'Reflections', water: 'Sea detail', particles: 'Particles', background: 'Ambient motion', detail: 'Model detail',
  },
  tier: {
    low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra', medium: 'Medium', off: 'Off', on: 'On',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', simple: 'Simple', detailed: 'Detailed', static: 'Still', animated: 'Animated', plain: 'Plain',
  },
};

const es = {
  graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})', renderScale: 'Escala de renderizado',
  fromPreset: 'Según ajuste ({tier})', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; los efectos que lo necesitan están desactivados.',
  cat: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Suavizado de bordes',
    reflections: 'Reflejos', water: 'Detalle del mar', particles: 'Partículas', background: 'Movimiento ambiental', detail: 'Detalle de modelos',
  },
  tier: {
    low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Media', off: 'No', on: 'Sí',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', simple: 'Sencillo', detailed: 'Detallado', static: 'Quieto', animated: 'Animado', plain: 'Básico',
  },
};

const fr = {
  graphics: 'Graphismes', quality: 'Qualité', auto: 'Automatique (détectée : {tier})', renderScale: 'Échelle de rendu',
  fromPreset: 'Préréglage ({tier})', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
  postFailed: 'Le post-traitement est indisponible sur cet appareil ; les effets qui en dépendent sont désactivés.',
  cat: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
    reflections: 'Reflets', water: 'Détail de la mer', particles: 'Particules', background: 'Animation ambiante', detail: 'Détail des modèles',
  },
  tier: {
    low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra', medium: 'Moyenne', off: 'Non', on: 'Oui',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', simple: 'Simple', detailed: 'Détaillé', static: 'Fixe', animated: 'Animé', plain: 'Sobre',
  },
};

const STRINGS = {
  'en-US': en,
  'en-GB': { ...en, cat: { ...en.cat, grade: 'Colour grade' } },
  'es-419': es,
  'es-ES': { ...es, fromPreset: 'Preajuste ({tier})', showFps: 'Mostrar imágenes por segundo' },
  'fr-FR': fr,
  'fr-CA': { ...fr, graphics: 'Graphiques', cat: { ...fr.cat, antialias: 'Anticrénelage (lissage)' } },
  'de-DE': {
    graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', renderScale: 'Renderskalierung',
    fromPreset: 'Voreinstellung ({tier})', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Effekte, die sie benötigen, sind aus.',
    cat: {
      shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
      reflections: 'Spiegelungen', water: 'Meeresdetails', particles: 'Partikel', background: 'Umgebungsbewegung', detail: 'Modelldetails',
    },
    tier: {
      low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra', medium: 'Mittel', off: 'Aus', on: 'An',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', simple: 'Einfach', detailed: 'Detailliert', static: 'Ruhig', animated: 'Animiert', plain: 'Schlicht',
    },
  },
  'pt-BR': {
    graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})', renderScale: 'Escala de renderização',
    fromPreset: 'Predefinição ({tier})', adaptive: 'Resolução adaptativa', showFps: 'Mostrar quadros por segundo',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; os efeitos que dependem dele estão desligados.',
    cat: {
      shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Suavização de serrilhado',
      reflections: 'Reflexos', water: 'Detalhe do mar', particles: 'Partículas', background: 'Movimento ambiente', detail: 'Detalhe dos modelos',
    },
    tier: {
      low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Média', off: 'Desligado', on: 'Ligado',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', simple: 'Simples', detailed: 'Detalhado', static: 'Parado', animated: 'Animado', plain: 'Básico',
    },
  },
  'it-IT': {
    graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', renderScale: 'Scala di rendering',
    fromPreset: 'Dal preset ({tier})', adaptive: 'Risoluzione adattiva', showFps: 'Mostra fotogrammi al secondo',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti che la richiedono sono disattivati.',
    cat: {
      shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing',
      reflections: 'Riflessi', water: 'Dettaglio del mare', particles: 'Particelle', background: 'Movimento ambientale', detail: 'Dettaglio modelli',
    },
    tier: {
      low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra', medium: 'Media', off: 'No', on: 'Sì',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', simple: 'Semplice', detailed: 'Dettagliato', static: 'Fermo', animated: 'Animato', plain: 'Semplice',
    },
  },
};

/** Best supported locale for a BCP 47 tag. */
export function pickGfxLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = GFX_LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.slice(0, 2).toLowerCase();
  return { en: 'en-US', es: 'es-419', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', it: 'it-IT' }[lang] || 'en-US';
}

/** Strings for a locale (falls back to en-US). */
export function gfxStrings(locale) {
  return STRINGS[locale] || STRINGS['en-US'];
}

export function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
