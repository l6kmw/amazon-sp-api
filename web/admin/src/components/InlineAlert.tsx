import type { ReactNode } from 'react'
import styled from '@emotion/styled'

type AlertType = 'info' | 'warning' | 'danger' | 'success'

export function InlineAlert({
  type = 'info',
  title,
  children
}: {
  type?: AlertType
  title?: string
  children: ReactNode
}) {
  return (
    <Container type={type} role="alert">
      {title ? <Title>{title}</Title> : null}
      <Content>{children}</Content>
    </Container>
  )
}

import type { AppTheme } from '../styles/theme'

const bgMap: Record<AlertType, keyof AppTheme['colors']> = {
  info: 'infoSoft',
  warning: 'warningSoft',
  danger: 'dangerSoft',
  success: 'successSoft'
}

const colorMap: Record<AlertType, keyof AppTheme['colors']> = {
  info: 'info',
  warning: 'warning',
  danger: 'danger',
  success: 'success'
}

const Container = styled.div<{ type: AlertType }>`
  border: 1px solid ${({ theme, type }) => theme.colors[colorMap[type]]};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: ${({ theme }) => theme.space.md} ${({ theme }) => theme.space.lg};
  background: ${({ theme, type }) => theme.colors[bgMap[type]]};
  color: ${({ theme, type }) => theme.colors[colorMap[type]]};
`

const Title = styled.div`
  font-weight: 700;
  font-size: ${({ theme }) => theme.typeScale.small};
  margin-bottom: ${({ theme }) => theme.space.xs};
`

const Content = styled.div`
  font-size: ${({ theme }) => theme.typeScale.small};
  line-height: 1.5;
`
