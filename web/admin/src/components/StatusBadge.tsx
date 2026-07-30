import type { ReactNode } from 'react'
import styled from '@emotion/styled'

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted'

const toneColors = {
  success: ['successSoft', 'success'],
  warning: ['warningSoft', 'warning'],
  danger: ['dangerSoft', 'danger'],
  info: ['infoSoft', 'info'],
  muted: ['surfaceMuted', 'textMuted']
} as const

function withAlpha(color: string, alpha: number): string {
  return color.replace(')', ` / ${alpha})`)
}

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Badge tone={tone}>{children}</Badge>
}

const Badge = styled.span<{ tone: Tone }>`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  min-height: 28px;
  border: 1px solid ${({ theme, tone }) => withAlpha(theme.colors[toneColors[tone][1]], 0.25)};
  border-radius: ${({ theme }) => theme.radii.pill};
  backdrop-filter: blur(4px);
  padding: 0 ${({ theme }) => theme.space.md};
  background: ${({ theme, tone }) => theme.colors[toneColors[tone][0]]};
  color: ${({ theme, tone }) => theme.colors[toneColors[tone][1]]};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;

  &::before {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    content: '';
  }
`
