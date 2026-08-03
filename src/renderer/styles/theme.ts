import type { ThemeDefinition } from 'vuetify'

/**
 * Material 3 dark theme tokens. Only these tokens — NEVER hand-rolled hex in
 * components. `pureblack` collapses the tonal scale to flat black.
 */
export const dark: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#121212',
    surface: '#1e1e1e',
    'surface-variant': '#2a2a2a',
    'surface-bright': '#333333',
    'on-surface': '#e6e6e6',
    'on-surface-variant': '#b3b3b3',
    primary: '#4dd0e1',
    'on-primary': '#00363b',
    'primary-container': '#005f68',
    'on-primary-container': '#9ff1ff',
    secondary: '#b8c9cc',
    'on-secondary': '#2a3739',
    'secondary-container': '#405154',
    'on-secondary-container': '#d5e6e9',
    error: '#ff5449',
    'on-error': '#690005',
    'error-container': '#93000a',
    'on-error-container': '#ffdad6',
    success: '#4caf50',
    'on-success': '#0b3d0d',
    'success-container': '#2e7d32',
    'on-success-container': '#c8f0c9',
    warning: '#ffb74d',
    'on-warning': '#4a2b00',
    'warning-container': '#664300',
    'on-warning-container': '#ffddb3',
    info: '#4dd0e1',
    'on-info': '#00363b'
  }
}

export const pureblack: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#000000',
    surface: '#000000',
    'surface-variant': '#141414',
    'surface-bright': '#1c1c1c',
    'on-surface': '#d6d6d6',
    'on-surface-variant': '#9c9c9c',
    primary: '#4dd0e1',
    'on-primary': '#00363b',
    'primary-container': '#0a3d42',
    'on-primary-container': '#9ff1ff',
    secondary: '#9aa7aa',
    'on-secondary': '#1d2b2e',
    'secondary-container': '#2c3b3e',
    'on-secondary-container': '#d5e6e9',
    error: '#ff5449',
    'on-error': '#690005',
    'error-container': '#5c0a0a',
    'on-error-container': '#ffdad6',
    success: '#4caf50',
    'on-success': '#0b3d0d',
    'success-container': '#1e4a20',
    'on-success-container': '#c8f0c9',
    warning: '#ffb74d',
    'on-warning': '#4a2b00',
    'warning-container': '#4a3400',
    'on-warning-container': '#ffddb3',
    info: '#4dd0e1',
    'on-info': '#00363b'
  }
}
