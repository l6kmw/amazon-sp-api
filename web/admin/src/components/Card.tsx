import styled from '@emotion/styled'

export const Card = styled.section`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.lg};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadows.xs};
  @media (min-width: 768px) {
    box-shadow: ${({ theme }) => theme.shadows.sm};
  }
`
