import { Global, css } from '@emotion/react'

export function GlobalStyles() {
  return (
    <Global
      styles={(theme) => css`
        *,
        *::before,
        *::after {
          box-sizing: border-box;
        }

        html {
          min-width: 320px;
          background: ${theme.colors.background};
          color: ${theme.colors.text};
          font-family: ${theme.fonts.body};
          font-feature-settings: 'cv11', 'ss01';
          text-rendering: optimizeLegibility;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }

        body {
          margin: 0;
          min-height: 100dvh;
          font-size: ${theme.typeScale.body};
          line-height: 1.6;
        }

        button,
        input,
        textarea,
        select {
          font: inherit;
        }

        button {
          cursor: pointer;
        }

        a {
          color: inherit;
          text-decoration: none;
        }

        :focus {
          outline: none;
        }

        :focus-visible {
          outline: 3px solid ${theme.colors.primary};
          outline-offset: 3px;
        }

        ::selection {
          background: ${theme.colors.primarySoft};
        }

        * {
          scrollbar-width: thin;
          scrollbar-color: ${theme.colors.surfaceMuted} transparent;
        }

        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }

        ::-webkit-scrollbar-track {
          background: transparent;
        }

        ::-webkit-scrollbar-thumb {
          border-radius: ${theme.radii.pill};
          background: ${theme.colors.surfaceMuted};
        }

        ::-webkit-scrollbar-thumb:hover {
          background: ${theme.colors.border};
        }

        @media (prefers-reduced-motion: reduce) {
          *,
          *::before,
          *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            scroll-behavior: auto !important;
            transition-duration: 0.01ms !important;
          }
        }
      `}
    />
  )
}
