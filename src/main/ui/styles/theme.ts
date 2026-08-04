import type { ThemeDefinition } from 'vuetify'

/**
 * Refined dark palettes — blue-teal tinted neutrals (cohesive with the cyan
 * primary) instead of flat gray. Stronger surface separation for depth and a
 * clearer text hierarchy. Only these tokens — NEVER hand-rolled hex in
 * components. `pureblack` keeps the same hue family on a true-black base.
 */
export const dark: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#0d1117',
    surface: '#151b24',
    'surface-variant': '#1c242f',
    'surface-bright': '#283340',
    'on-surface': '#e6edf3',
    'on-surface-variant': '#8b97a5',
    primary: '#4cc4d6',
    'on-primary': '#00323a',
    'primary-container': '#0a4d58',
    'on-primary-container': '#aee9f2',
    secondary: '#8b9aa8',
    'on-secondary': '#182028',
    'secondary-container': '#2c3640',
    'on-secondary-container': '#c4d2dc',
    error: '#ff6b6b',
    'on-error': '#4d0008',
    'error-container': '#7a1a1f',
    'on-error-container': '#ffd6d6',
    success: '#5cb88a',
    'on-success': '#0a2e18',
    'success-container': '#1f4a2e',
    'on-success-container': '#bdf0d4',
    warning: '#e8a848',
    'on-warning': '#3d2400',
    'warning-container': '#5a3a08',
    'on-warning-container': '#ffddb0',
    info: '#4cc4d6',
    'on-info': '#00323a'
  }
}

export const pureblack: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#000000',
    surface: '#050709',
    'surface-variant': '#0f1419',
    'surface-bright': '#1a2128',
    'on-surface': '#d4dce4',
    'on-surface-variant': '#7a8593',
    primary: '#4cc4d6',
    'on-primary': '#00323a',
    'primary-container': '#063640',
    'on-primary-container': '#aee9f2',
    secondary: '#7a8896',
    'on-secondary': '#141a20',
    'secondary-container': '#222c35',
    'on-secondary-container': '#b8c6d0',
    error: '#ff6b6b',
    'on-error': '#4d0008',
    'error-container': '#4d1015',
    'on-error-container': '#ffd6d6',
    success: '#5cb88a',
    'on-success': '#0a2e18',
    'success-container': '#163a22',
    'on-success-container': '#bdf0d4',
    warning: '#e8a848',
    'on-warning': '#3d2400',
    'warning-container': '#403008',
    'on-warning-container': '#ffddb0',
    info: '#4cc4d6',
    'on-info': '#00323a'
  }
}
