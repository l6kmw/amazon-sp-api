import styled from '@emotion/styled'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export const Button = styled.button<{ variant?: ButtonVariant }>`
  min-height: 44px;
  border: 1px solid
    ${({ theme, variant = 'primary' }) =>
      variant === 'primary' || variant === 'danger' ? 'transparent' : theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.lg};
  background: ${({ theme, variant = 'primary' }) => {
    if (variant === 'primary') return theme.colors.primary
    if (variant === 'danger') return theme.colors.dangerSoft
    if (variant === 'secondary') return theme.colors.surface
    return 'transparent'
  }};
  color: ${({ theme, variant = 'primary' }) =>
    variant === 'primary' ? theme.colors.surface : variant === 'danger' ? theme.colors.danger : theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
  white-space: nowrap;
  transition: all ${({ theme }) => theme.motion.fast} ${({ theme }) => theme.motion.easeOut};

  ${({ theme, variant = 'primary' }) => (variant === 'primary' ? `box-shadow: ${theme.shadows.xs};` : '')}

  &:hover {
    background: ${({ theme, variant = 'primary' }) => {
      if (variant === 'primary') return theme.colors.primaryStrong
      if (variant === 'danger') return theme.colors.danger
      if (variant === 'secondary') return theme.colors.surfaceMuted
      return theme.colors.primarySoft
    }};
    color: ${({ theme, variant = 'primary' }) => {
      if (variant === 'danger') return theme.colors.surface
      if (variant === 'primary') return theme.colors.surface
      if (variant === 'ghost') return theme.colors.primaryStrong
      return theme.colors.text
    }};
  }

  &:active {
    transform: scale(0.98);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.52;
    transform: none;
  }
`
