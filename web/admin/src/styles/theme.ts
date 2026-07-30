export const theme = {
  colors: {
    background: 'oklch(97.5% 0.008 75)',
    surface: 'oklch(100% 0 0)',
    surfaceMuted: 'oklch(96% 0.01 75)',
    text: 'oklch(25% 0.02 75)',
    textMuted: 'oklch(48% 0.015 75)',
    textFaint: 'oklch(65% 0.012 75)',
    border: 'oklch(90% 0.008 75)',

    // Amazon Primary Accent Palette (Warm Amber/Orange accent)
    primary: 'oklch(58% 0.14 55)',
    primarySoft: 'oklch(95% 0.04 70)',
    primaryStrong: 'oklch(40% 0.10 50)',

    success: 'oklch(48% 0.12 155)',
    successSoft: 'oklch(94% 0.045 155)',
    warning: 'oklch(65% 0.14 70)',
    warningSoft: 'oklch(95% 0.06 70)',
    danger: 'oklch(54% 0.15 25)',
    dangerSoft: 'oklch(94% 0.05 25)',
    info: 'oklch(52% 0.12 240)',
    infoSoft: 'oklch(94% 0.04 240)'
  },
  fonts: {
    heading: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    body: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    numeric: 'ui-monospace, SFMono-Regular, SF Pro Display, Segoe UI, sans-serif'
  },
  typeScale: {
    caption: '0.75rem',
    small: '0.875rem',
    body: '1rem',
    lead: '1.125rem',
    title: '1.5rem',
    section: '2rem',
    display: 'clamp(2.25rem, 4vw, 3.5rem)'
  },
  space: {
    xs: '0.25rem',
    sm: '0.5rem',
    md: '0.75rem',
    lg: '1rem',
    xl: '1.5rem',
    '2xl': '2rem',
    '3xl': '3rem',
    '4xl': '4rem'
  },
  radii: {
    sm: '8px',
    md: '12px',
    lg: '18px',
    pill: '999px'
  },
  shadows: {
    xs: '0 1px 2px oklch(25% 0.02 75 / 0.04)',
    sm: '0 2px 8px oklch(25% 0.02 75 / 0.06)',
    soft: '0 4px 16px oklch(25% 0.02 75 / 0.08)',
    lift: '0 12px 40px oklch(25% 0.02 75 / 0.12)'
  },
  motion: {
    fast: '140ms',
    base: '220ms',
    slow: '320ms',
    easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)'
  }
} as const

export type AppTheme = typeof theme

declare module '@emotion/react' {
  export interface Theme extends AppTheme {}
}
