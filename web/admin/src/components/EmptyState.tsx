import type { ReactNode } from 'react'
import styled from '@emotion/styled'
import { Card } from './Card'

export function EmptyState({
  title,
  description,
  action
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <Container>
      <Inner>
        <IconWrap aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </IconWrap>
        <Title>{title}</Title>
        {description ? <Description>{description}</Description> : null}
        {action ? <ActionWrap>{action}</ActionWrap> : null}
      </Inner>
    </Container>
  )
}

const Container = styled(Card)`
  padding: ${({ theme }) => theme.space['3xl']} ${({ theme }) => theme.space.xl};
  text-align: center;
`

const Inner = styled.div`
  display: grid;
  max-width: 440px;
  margin: 0 auto;
  gap: ${({ theme }) => theme.space.md};
  justify-items: center;
`

const IconWrap = styled.div`
  display: grid;
  width: 56px;
  height: 56px;
  place-items: center;
  border-radius: ${({ theme }) => theme.radii.pill};
  background: ${({ theme }) => theme.colors.surfaceMuted};
  color: ${({ theme }) => theme.colors.textMuted};
`

const Title = styled.h3`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.lead};
`

const Description = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const ActionWrap = styled.div`
  margin-top: ${({ theme }) => theme.space.md};
`
