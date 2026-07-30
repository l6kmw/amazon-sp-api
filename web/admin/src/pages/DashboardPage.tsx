import { useEffect, useState } from 'react'
import styled from '@emotion/styled'
import { Card } from '../components/Card'
import { Button } from '../components/Button'
import { StatusBadge } from '../components/StatusBadge'
import { getDashboardStats, getAmazonConfigStatus } from '../api/dashboard'
import type { AmazonConfigStatus, DashboardStats } from '../api/types'

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted'

function MetricIcon({ index }: { index: number }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (index) {
    case 0:
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    case 1:
      return (
        <svg {...common}>
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      )
    case 2:
      return (
        <svg {...common}>
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      )
    case 3:
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 9h6v6H9z" />
          <path d="M9 1v3" />
          <path d="M15 1v3" />
          <path d="M9 20v3" />
          <path d="M15 20v3" />
          <path d="M20 9h3" />
          <path d="M20 15h3" />
          <path d="M1 9h3" />
          <path d="M1 15h3" />
        </svg>
      )
    default:
      return null
  }
}

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [configStatus, setConfigStatus] = useState<AmazonConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const hour = new Date().getHours()
  const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const today = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  }).format(new Date())

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)

    Promise.all([getDashboardStats(), getAmazonConfigStatus()])
      .then(([statsRes, configRes]) => {
        if (active) {
          setStats(statsRes)
          setConfigStatus(configRes)
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : '加载 Dashboard 数据失败')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [reloadKey])

  const metrics = [
    {
      label: 'Seller 账号总数',
      value: stats?.total_accounts ?? 0,
      helper: `${stats?.active_accounts ?? 0} 个活跃可调用`,
      tone: 'info' as Tone
    },
    {
      label: '活跃 Seller 账号',
      value: stats?.active_accounts ?? 0,
      helper: 'LWA Credential 状态正常',
      tone: 'success' as Tone
    },
    {
      label: '活跃 Employee Binding',
      value: stats?.active_bindings ?? 0,
      helper: '已与 ConnectedAccount Employee 关联',
      tone: 'warning' as Tone
    },
    {
      label: '活跃 Test Agent',
      value: stats?.active_test_agents ?? 0,
      helper: '持有有效 oat_* Token',
      tone: 'info' as Tone
    }
  ]

  const isConfigComplete =
    configStatus?.lwa_client_id_configured &&
    configStatus?.lwa_client_secret_configured &&
    configStatus?.postgres_status === 'ok' &&
    configStatus?.redis_status === 'ok'

  return (
    <Page>
      <WelcomeStrip>
        <WelcomeLeft>
          <Greeting>{greeting}</Greeting>
          <DateText>{today}</DateText>
        </WelcomeLeft>
        <StatusBadge tone={error ? 'danger' : 'success'}>
          {error ? '系统数据未同步' : 'Amazon MCP 服务正常运行'}
        </StatusBadge>
      </WelcomeStrip>

      {error ? (
        <ErrorPanel role="alert">
          <ErrorTextGroup>
            <PanelTitle style={{ color: 'var(--colors-danger)' }}>Dashboard 加载失败</PanelTitle>
            <PanelDesc>{error}</PanelDesc>
          </ErrorTextGroup>
          <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)} type="button">
            重新加载
          </Button>
        </ErrorPanel>
      ) : null}

      <MetricGrid>
        {metrics.map((m, i) => (
          <MetricCard key={m.label} aria-busy={loading}>
            <MetricTop>
              <MetricLabel>{m.label}</MetricLabel>
              <MetricIconWrap tone={m.tone}>
                <MetricIcon index={i} />
              </MetricIconWrap>
            </MetricTop>
            <MetricValue>{loading ? '—' : m.value}</MetricValue>
            <MetricHelper>{m.helper}</MetricHelper>
          </MetricCard>
        ))}
      </MetricGrid>

      <ContentGrid>
        <Panel>
          <PanelHeader>
            <PanelTitle>配置准备进度</PanelTitle>
            <StatusBadge tone={isConfigComplete ? 'success' : 'warning'}>
              {loading ? '检查中' : isConfigComplete ? '配置已就绪' : '待补充配置'}
            </StatusBadge>
          </PanelHeader>

          <StatusList>
            <StatusRow>
              <span>LWA App Client ID</span>
              <StatusBadge tone={configStatus?.lwa_client_id_configured ? 'success' : 'warning'}>
                {configStatus?.lwa_client_id_configured ? '已配置' : '未配置'}
              </StatusBadge>
            </StatusRow>
            <StatusRow>
              <span>LWA App Client Secret</span>
              <StatusBadge tone={configStatus?.lwa_client_secret_configured ? 'success' : 'warning'}>
                {configStatus?.lwa_client_secret_configured ? '已配置' : '未配置'}
              </StatusBadge>
            </StatusRow>
            <StatusRow>
              <span>PostgreSQL 凭据数据库</span>
              <StatusBadge tone={configStatus?.postgres_status === 'ok' ? 'success' : 'danger'}>
                {configStatus?.postgres_status === 'ok' ? '连接正常' : '服务未连接'}
              </StatusBadge>
            </StatusRow>
            <StatusRow>
              <span>Redis 协同调度器</span>
              <StatusBadge tone={configStatus?.redis_status === 'ok' ? 'success' : 'danger'}>
                {configStatus?.redis_status === 'ok' ? '连接正常' : '服务未连接'}
              </StatusBadge>
            </StatusRow>
            <StatusRow>
              <span>Credential Keyring</span>
              <StatusBadge tone={configStatus?.credential_keyring_status === 'ok' ? 'success' : 'warning'}>
                {configStatus?.credential_keyring_status === 'ok' ? '已加载' : '待初始化'}
              </StatusBadge>
            </StatusRow>
            <StatusRow>
              <span>ConnectedAccount JWT Keyring</span>
              <StatusBadge tone={configStatus?.connected-account_keyring_status === 'ok' ? 'success' : 'warning'}>
                {configStatus?.connected-account_keyring_status === 'ok' ? '已加载' : '待初始化'}
              </StatusBadge>
            </StatusRow>
          </StatusList>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>系统运行摘要</PanelTitle>
            <StatusBadge tone={stats?.recent_errors_count ? 'danger' : 'muted'}>
              {stats?.recent_errors_count ? `${stats.recent_errors_count} 项报错` : '运行平稳'}
            </StatusBadge>
          </PanelHeader>

          <SummaryBox>
            <SummaryItem>
              <SummaryLabel>MCP Endpoint</SummaryLabel>
              <SummaryValue>/mcp (Streamable HTTP)</SummaryValue>
            </SummaryItem>
            <SummaryItem>
              <SummaryLabel>公共 OAuth Callback</SummaryLabel>
              <SummaryValue>{configStatus?.oauth_callback_url || '未加载'}</SummaryValue>
            </SummaryItem>
            <SummaryItem>
              <SummaryLabel>最近错误 / 告警</SummaryLabel>
              <SummaryValue>{stats?.recent_errors_count ? `过去 24 小时存在 ${stats.recent_errors_count} 次凭据刷库异常` : '暂无高优先级告警'}</SummaryValue>
            </SummaryItem>
          </SummaryBox>
        </Panel>
      </ContentGrid>
    </Page>
  )
}

const Page = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};
`

const WelcomeStrip = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.lg};
  padding: ${({ theme }) => theme.space.xl} ${({ theme }) => theme.space['2xl']};
  border-radius: ${({ theme }) => theme.radii.lg};
  background: linear-gradient(135deg, ${({ theme }) => theme.colors.primarySoft}, ${({ theme }) => theme.colors.surfaceMuted});
`

const WelcomeLeft = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const Greeting = styled.h1`
  margin: 0;
  font-size: clamp(1.5rem, 3vw, 2.25rem);
  font-weight: 800;
  letter-spacing: -0.03em;
  color: ${({ theme }) => theme.colors.text};
`

const DateText = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const ErrorPanel = styled(Card)`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.lg};
  padding: ${({ theme }) => theme.space.xl};
  border-left: 4px solid ${({ theme }) => theme.colors.danger};
`

const ErrorTextGroup = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const MetricGrid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
`

const MetricCard = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const MetricTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
`

const MetricLabel = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
`

const MetricIconWrap = styled.span<{ tone: Tone }>`
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: ${({ theme }) => theme.radii.md};
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.primary};
  flex-shrink: 0;
`

const MetricValue = styled.div`
  margin-top: ${({ theme }) => theme.space.sm};
  font-size: clamp(1.75rem, 4vw, 2.5rem);
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
`

const MetricHelper = styled.div`
  margin-top: ${({ theme }) => theme.space.md};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const ContentGrid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};

  @media (min-width: 1024px) {
    grid-template-columns: 1fr 1fr;
  }
`

const Panel = styled(Card)`
  overflow: hidden;
  padding: ${({ theme }) => theme.space.xl};
`

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
  margin-bottom: ${({ theme }) => theme.space.lg};
`

const PanelTitle = styled.h2`
  margin: 0;
  font-size: ${({ theme }) => theme.typeScale.title};
  font-weight: 700;
`

const PanelDesc = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const StatusList = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.md};
`

const StatusRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${({ theme }) => theme.space.sm} 0;
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 600;

  &:last-child {
    border-bottom: none;
  }
`

const SummaryBox = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
`

const SummaryItem = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};
  padding-bottom: ${({ theme }) => theme.space.md};

  &:last-child {
    border-bottom: none;
  }
`

const SummaryLabel = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
`

const SummaryValue = styled.span`
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-family: ${({ theme }) => theme.fonts.numeric};
  word-break: break-all;
`
