import { useEffect, useState } from 'react'
import styled from '@emotion/styled'
import { listAccounts } from '../api/accounts'
import type { CredentialStatus, SellerAccount } from '../api/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { StatusBadge } from '../components/StatusBadge'
import { InlineAlert } from '../components/InlineAlert'
import { EmptyState } from '../components/EmptyState'

function StatusTag({ status }: { status: CredentialStatus }) {
  switch (status) {
    case 'active':
      return <StatusBadge tone="success">可用</StatusBadge>
    case 'pending':
      return <StatusBadge tone="warning">授权处理中</StatusBadge>
    case 'refresh_failed':
      return <StatusBadge tone="danger">LWA 刷新失败</StatusBadge>
    case 'revoked':
      return <StatusBadge tone="danger">授权已撤销</StatusBadge>
    case 'disconnected':
      return <StatusBadge tone="muted">已断开</StatusBadge>
    default:
      return <StatusBadge tone="muted">未知</StatusBadge>
  }
}

export function AccountsPage({
  onNavigate,
  showHeader = true
}: {
  onNavigate: (page: string, param?: string) => void
  showHeader?: boolean
}) {
  const [accounts, setAccounts] = useState<SellerAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listAccounts({
        status: statusFilter === 'all' ? undefined : statusFilter,
        query: searchQuery.trim() || undefined
      })
      setAccounts(res.items || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 Seller 账号列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [statusFilter])

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    loadData()
  }

  return (
    <Container>
      {showHeader ? <Header>
        <HeaderLeft>
          <Title>Amazon Seller 账号</Title>
          <Subtitle>管理已授权的 Amazon 卖家账号及其 LWA 凭据状态</Subtitle>
        </HeaderLeft>
        <Button variant="secondary" onClick={loadData} type="button">
          刷新列表
        </Button>
      </Header> : null}

      {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}
      {loading ? <InlineAlert type="info">正在加载 Seller 账号…</InlineAlert> : null}

      <FilterCard>
        <SearchForm onSubmit={handleSearchSubmit}>
          <SearchInput
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索显示名、account_id 或 Selling Partner ID..."
          />
          <Button variant="secondary" type="submit" style={{ minHeight: 38 }}>
            搜索
          </Button>
        </SearchForm>

        <FilterGroup>
          <FilterLabel>状态筛选：</FilterLabel>
          <FilterSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">全部状态</option>
            <option value="active">可用 (Active)</option>
            <option value="pending">处理中 (Pending)</option>
            <option value="refresh_failed">刷新失败 (Refresh Failed)</option>
            <option value="revoked">已撤销 (Revoked)</option>
            <option value="disconnected">已断开 (Disconnected)</option>
          </FilterSelect>
        </FilterGroup>
      </FilterCard>

      {!loading && !error && accounts.length === 0 ? (
        <EmptyState
          title="没有找到匹配的 Seller 账号"
          description="尚无已完成授权并写入数据库的 Seller 账号。"
        />
      ) : !loading && accounts.length > 0 ? (
        <Grid>
          {accounts.map((acc) => (
            <AccountCard key={acc.account_id}>
              <CardHeader>
                <AccountInfo>
                  <DisplayName>{acc.display_name || '未命名卖家'}</DisplayName>
                  <AccountMeta>Account ID: {acc.account_id}</AccountMeta>
                </AccountInfo>
                <StatusTag status={acc.credential_status} />
              </CardHeader>

              <MetaTable>
                <MetaRow>
                  <MetaKey>Partner ID</MetaKey>
                  <MetaValue>{acc.selling_partner_id_masked || '—'}</MetaValue>
                </MetaRow>
                <MetaRow>
                  <MetaKey>Region</MetaKey>
                  <MetaValue>{acc.region || '—'}</MetaValue>
                </MetaRow>
                <MetaRow>
                  <MetaKey>Marketplaces</MetaKey>
                  <MetaValue>{acc.marketplaces?.join(', ') || '—'}</MetaValue>
                </MetaRow>
                <MetaRow>
                  <MetaKey>活跃 Binding</MetaKey>
                  <MetaValue>{acc.active_bindings_count ?? 0} 个 Employee</MetaValue>
                </MetaRow>
              </MetaTable>

              <CardActions>
                <Button
                  variant="secondary"
                  onClick={() => onNavigate('account-detail', acc.account_id)}
                  type="button"
                  style={{ minHeight: 36, padding: '0 12px' }}
                >
                  详情
                </Button>
              </CardActions>
            </AccountCard>
          ))}
        </Grid>
      ) : null}
    </Container>
  )
}

const Container = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};
`

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.lg};
`

const HeaderLeft = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const Title = styled.h1`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.title};
`

const Subtitle = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const FilterCard = styled(Card)`
  padding: ${({ theme }) => theme.space.lg};
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.lg};
  flex-wrap: wrap;
`

const SearchForm = styled.form`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  flex: 1;
  min-width: 280px;
`

const SearchInput = styled.input`
  flex: 1;
  min-height: 38px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.md};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const FilterGroup = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
`

const FilterLabel = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const FilterSelect = styled.select`
  min-height: 38px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const Grid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
`

const AccountCard = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
`

const CardHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
`

const AccountInfo = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const DisplayName = styled.h3`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.lead};
`

const AccountMeta = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.caption};
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const MetaTable = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
  border-top: 1px dashed ${({ theme }) => theme.colors.border};
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};
  padding: ${({ theme }) => theme.space.md} 0;
`

const MetaRow = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: ${({ theme }) => theme.typeScale.small};
`

const MetaKey = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
`

const MetaValue = styled.span`
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const CardActions = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.space.sm};
`
