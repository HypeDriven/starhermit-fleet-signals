// Fleet Signals — localized strings for the StarHermit account surface (sign-in,
// invite link, sign-out notice), picked from navigator.language like the
// Graphics panel (exact match, then language family, then en-US).
import { pickGfxLocale as pickLocale } from './gfx-i18n.js';

const EN = {
  signIn: 'Sign in with StarHermit', signInSub: 'sync progress and settings to your account',
  invite: 'Invite a friend', inviteSub: 'copy a link that adds you as friends',
  inviteCopied: 'Invite link copied to clipboard', inviteFailed: 'Could not copy the invite link',
  signedOut: 'Signed out of StarHermit — progress keeps saving on this device.',
};

const STRINGS = {
  'en-US': EN,
  'en-GB': EN,
  'es-419': {
    signIn: 'Iniciar sesión con StarHermit', signInSub: 'sincroniza tu progreso y ajustes con tu cuenta',
    invite: 'Invitar a un amigo', inviteSub: 'copia un enlace para agregarse como amigos',
    inviteCopied: 'Enlace de invitación copiado al portapapeles', inviteFailed: 'No se pudo copiar el enlace de invitación',
    signedOut: 'Se cerró la sesión de StarHermit; el progreso se sigue guardando en este dispositivo.',
  },
  'es-ES': {
    signIn: 'Iniciar sesión con StarHermit', signInSub: 'sincroniza tu progreso y tus ajustes con tu cuenta',
    invite: 'Invitar a un amigo', inviteSub: 'copia un enlace para añadiros como amigos',
    inviteCopied: 'Enlace de invitación copiado al portapapeles', inviteFailed: 'No se ha podido copiar el enlace de invitación',
    signedOut: 'Se ha cerrado la sesión de StarHermit; el progreso se sigue guardando en este dispositivo.',
  },
  'de-DE': {
    signIn: 'Mit StarHermit anmelden', signInSub: 'Fortschritt und Einstellungen mit deinem Konto synchronisieren',
    invite: 'Freund einladen', inviteSub: 'Link kopieren, über den ihr Freunde werdet',
    inviteCopied: 'Einladungslink in die Zwischenablage kopiert', inviteFailed: 'Einladungslink konnte nicht kopiert werden',
    signedOut: 'Von StarHermit abgemeldet – der Fortschritt wird weiter auf diesem Gerät gespeichert.',
  },
  'fr-FR': {
    signIn: 'Se connecter avec StarHermit', signInSub: 'synchronise ta progression et tes réglages avec ton compte',
    invite: 'Inviter un ami', inviteSub: 'copie un lien pour devenir amis',
    inviteCopied: 'Lien d’invitation copié dans le presse-papiers', inviteFailed: 'Impossible de copier le lien d’invitation',
    signedOut: 'Déconnecté de StarHermit : la progression reste enregistrée sur cet appareil.',
  },
  'fr-CA': {
    signIn: 'Se connecter avec StarHermit', signInSub: 'synchronise ta progression et tes paramètres avec ton compte',
    invite: 'Inviter un ami', inviteSub: 'copie un lien pour devenir amis',
    inviteCopied: 'Lien d’invitation copié dans le presse-papiers', inviteFailed: 'Impossible de copier le lien d’invitation',
    signedOut: 'Déconnecté de StarHermit : la progression reste enregistrée sur cet appareil.',
  },
  'pt-BR': {
    signIn: 'Entrar com StarHermit', signInSub: 'sincronize progresso e configurações com sua conta',
    invite: 'Convidar um amigo', inviteSub: 'copie um link para virarem amigos',
    inviteCopied: 'Link de convite copiado para a área de transferência', inviteFailed: 'Não foi possível copiar o link de convite',
    signedOut: 'Você saiu do StarHermit — o progresso continua salvo neste dispositivo.',
  },
  'it-IT': {
    signIn: 'Accedi con StarHermit', signInSub: 'sincronizza progressi e impostazioni con il tuo account',
    invite: 'Invita un amico', inviteSub: 'copia un link per diventare amici',
    inviteCopied: 'Link d’invito copiato negli appunti', inviteFailed: 'Impossibile copiare il link d’invito',
    signedOut: 'Disconnesso da StarHermit: i progressi restano salvati su questo dispositivo.',
  },
};

export const PLATFORM_LOCALES = Object.keys(STRINGS);

/** Strings for the account surface in the browser's locale (en-US fallback). */
export function platformStrings(lang = (typeof navigator !== 'undefined' ? navigator.language : 'en-US')) {
  return { ...EN, ...(STRINGS[pickLocale(lang)] || {}) };
}
