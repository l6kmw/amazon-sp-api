import { useState } from 'react'
import styled from '@emotion/styled'
import { AccountsPage } from './AccountsPage'
import { AdsAccountsView } from './AdsAccountsView'

export function AmazonConnectionsPage({
  onNavigate
}: {
  onNavigate: (page: string, param?: string) => void
}) {
  const [provider, setProvider] = useState<'sp-api' | 'ads'>('sp-api')

  return (
    <Container>
      <Header>
        <div>
          <Title>Amazon 连接</Title>
          <Subtitle>分别管理 SP-API Seller 授权与 Amazon Ads Profile 授权</Subtitle>
        </div>
        <ProviderSwitch aria-label="Amazon Provider">
          <ProviderButton
            aria-pressed={provider === 'sp-api'}
            active={provider === 'sp-api'}
            onClick={() => setProvider('sp-api')}
            type="button"
          >
            SP-API
          </ProviderButton>
          <ProviderButton
            aria-pressed={provider === 'ads'}
            active={provider === 'ads'}
            onClick={() => setProvider('ads')}
            type="button"
          >
            Ads
          </ProviderButton>
        </ProviderSwitch>
      </Header>

      {provider === 'sp-api'
        ? <AccountsPage showHeader={false} onNavigate={onNavigate} />
        : <AdsAccountsView />}
    </Container>
  )
}

const Container = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};
`

const Header = styled.header`
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.lg};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  padding-bottom: ${({ theme }) => theme.space.lg};
  flex-wrap: wrap;
`

const Title = styled.h1`
  margin: 0 0 ${({ theme }) => theme.space.xs};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.title};
`

const Subtitle = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const ProviderSwitch = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 220px;
  min-height: 40px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 3px;
  background: ${({ theme }) => theme.colors.surfaceMuted};
`

const ProviderButton = styled.button<{ active: boolean }>`
  border: 0;
  border-radius: ${({ theme }) => theme.radii.sm};
  background: ${({ active, theme }) => active ? theme.colors.surface : 'transparent'};
  color: ${({ active, theme }) => active ? theme.colors.text : theme.colors.textMuted};
  box-shadow: ${({ active, theme }) => active ? theme.shadows.xs : 'none'};
  font: inherit;
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 700;
  cursor: pointer;
`
