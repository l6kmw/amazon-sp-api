import { useEffect, useState } from 'react'
import styled from '@emotion/styled'
import { disconnectConnection, getAccountDetail, refreshAccount } from '../api/accounts'
import { listConnectedAccountEmployees, shareEmployeeSeller } from '../api/connectedAccountEmployees'
import type { ConnectedAccountEmployee, SellerAccountDetail } from '../api/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { StatusBadge } from '../components/StatusBadge'
import { InlineAlert } from '../components/InlineAlert'
import { CopyButton } from '../components/CopyButton'
import { ConfirmDialog } from '../components/ConfirmDialog'

export function AccountDetailPage({ accountId, onBack }: { accountId?: string; onBack: () => void }) {
  const [detail, setDetail] = useState<SellerAccountDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<SellerAccountDetail['bindings'][number] | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [employees, setEmployees] = useState<ConnectedAccountEmployee[]>([])
  const [shareGrant, setShareGrant] = useState('')
  const [shareEmployeeId, setShareEmployeeId] = useState('')
  const [sharing, setSharing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const loadDetail = async () => {
    if (!accountId) return
    setLoading(true)
    setError(null)
    try {
      const [data, employeePage] = await Promise.all([
        getAccountDetail(accountId),
        listConnectedAccountEmployees(0, 50)
      ])
      setDetail(data)
      setEmployees(employeePage.items)
      const firstGrant = data.bindings.find((binding) => binding.status === 'active')
      if (firstGrant) {
        setShareGrant(`${firstGrant.issuer}\n${firstGrant.connection_id}`)
        setShareEmployeeId(
          employeePage.items.find((employee) =>
            employee.issuer === firstGrant.issuer
            && !data.bindings.some((binding) =>
              binding.connection_id === firstGrant.connection_id
              && binding.employee_id === employee.employee_id
              && binding.status === 'active'
            )
          )?.employee_id || ''
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载账号详情失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadDetail()
  }, [accountId])

  const refreshStatus = async () => {
    if (!accountId) return
    setRefreshing(true)
    setError(null)
    try {
      await refreshAccount(accountId)
      await loadDetail()
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新账号状态失败')
    } finally {
      setRefreshing(false)
    }
  }

  const shareGrantWithEmployee = async () => {
    const separator = shareGrant.indexOf('\n')
    if (separator < 1 || !shareEmployeeId) return
    setSharing(true)
    setError(null)
    try {
      await shareEmployeeSeller(
        shareEmployeeId,
        shareGrant.slice(0, separator),
        shareGrant.slice(separator + 1)
      )
      await loadDetail()
    } catch (err) {
      setError(err instanceof Error ? err.message : '分享 Seller Grant 失败')
    } finally {
      setSharing(false)
    }
  }

  const disconnectGrant = async () => {
    if (!disconnectTarget) return
    setDisconnecting(true)
    setError(null)
    try {
      await disconnectConnection(disconnectTarget.issuer, disconnectTarget.connection_id)
      onBack()
    } catch (err) {
      setError(err instanceof Error ? err.message : '断开 Seller Grant 失败')
    } finally {
      setDisconnecting(false)
    }
  }

  const activeGrants = Array.from(new Map(
    (detail?.bindings || [])
      .filter((binding) => binding.status === 'active')
      .map((binding) => [`${binding.issuer}\n${binding.connection_id}`, binding])
  ).values())
  const shareIssuer = shareGrant.slice(0, shareGrant.indexOf('\n'))
  const selectedConnectionId = shareGrant.slice(shareGrant.indexOf('\n') + 1)
  const eligibleEmployees = employees.filter((employee) =>
    employee.issuer === shareIssuer
    && !detail?.bindings.some((binding) =>
      binding.connection_id === selectedConnectionId
      && binding.employee_id === employee.employee_id
      && binding.status === 'active'
    )
  )

  if (!accountId || loading || !detail) {
    return (
      <Container>
        <InlineAlert type={!accountId || error ? "danger" : "info"}>
          {!accountId ? '未指定 account_id' : loading ? '正在加载 Seller 账号详情…' : error || '未找到 Seller 账号'}
        </InlineAlert>
        <Button variant="secondary" onClick={onBack} type="button">
          ← 返回账号列表
        </Button>
      </Container>
    )
  }

  return (
    <Container>
      <Header>
        <Button variant="secondary" onClick={onBack} type="button" style={{ minHeight: 36, padding: '0 12px' }}>
          ← 返回账号列表
        </Button>
        <TitleGroup>
          <Title>{detail?.display_name || 'Seller 账号详情'}</Title>
          <Subtitle>Account ID: {accountId}</Subtitle>
        </TitleGroup>
        <Button variant="secondary" disabled={refreshing} onClick={() => void refreshStatus()} type="button">
          {refreshing ? '刷新中…' : 'Refresh 状态'}
        </Button>
      </Header>

      {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}

      <Grid>
        <Panel>
          <PanelHeader>
            <PanelTitle>账号凭据与元信息</PanelTitle>
            {detail ? (
              <StatusBadge tone={detail.credential_status === 'active' ? 'success' : 'danger'}>
                Credential: {detail.credential_status}
              </StatusBadge>
            ) : null}
          </PanelHeader>

          <DetailList>
            <DetailRow>
              <DetailKey>Display Name</DetailKey>
              <DetailValue>{detail?.display_name || '—'}</DetailValue>
            </DetailRow>
            <DetailRow>
              <DetailKey>Selling Partner ID</DetailKey>
              <ValueWrap>
                <DetailValue>{detail?.selling_partner_id_masked || '—'}</DetailValue>
                {detail?.selling_partner_id_masked ? (
                  <CopyButton textToCopy={detail.selling_partner_id_masked} />
                ) : null}
              </ValueWrap>
            </DetailRow>
            <DetailRow>
              <DetailKey>Region</DetailKey>
              <DetailValue>{detail?.region || '—'}</DetailValue>
            </DetailRow>
            <DetailRow>
              <DetailKey>Marketplaces</DetailKey>
              <DetailValue>{detail?.marketplaces?.join(', ') || '—'}</DetailValue>
            </DetailRow>
            <DetailRow>
              <DetailKey>Key Revision</DetailKey>
              <DetailValue>v{detail?.credential_info?.revision ?? 1}</DetailValue>
            </DetailRow>
            <DetailRow>
              <DetailKey>Key ID</DetailKey>
              <DetailValue>{detail?.credential_info?.key_id || '—'}</DetailValue>
            </DetailRow>
            <DetailRow>
              <DetailKey>最近刷新时间</DetailKey>
              <DetailValue>{detail?.credential_info?.last_refreshed_at || detail?.last_synced_at || '—'}</DetailValue>
            </DetailRow>
          </DetailList>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>已绑定的 ConnectedAccount Employee</PanelTitle>
            <StatusBadge tone="info">{detail?.bindings?.length ?? 0} 个 Binding</StatusBadge>
          </PanelHeader>

          {detail?.bindings && detail.bindings.length > 0 ? (
            <BindingTable>
              <thead>
                <tr>
                  <th>Employee ID</th>
                  <th>Issuer</th>
                  <th>Remark</th>
                  <th>绑定时间</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.bindings.map((b) => (
                  <tr key={`${b.connection_id}:${b.employee_id}`}>
                    <td>{b.employee_id}</td>
                    <td>{b.issuer}</td>
                    <td>{b.remark || '—'}</td>
                    <td>{b.bound_at}</td>
                    <td>
                      <StatusBadge tone={b.status === 'active' ? 'success' : 'muted'}>{b.status}</StatusBadge>
                    </td>
                    <td>
                      {b.status === 'active' ? (
                        <Button
                          variant="danger"
                          disabled={disconnecting}
                          onClick={() => setDisconnectTarget(b)}
                          type="button"
                          style={{ minHeight: 32, padding: '0 10px' }}
                        >
                          Disconnect Grant
                        </Button>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </BindingTable>
          ) : (
            <NoBindingText>当前未绑定任何 ConnectedAccount Employee。</NoBindingText>
          )}
        </Panel>
      </Grid>

      <Panel>
        <PanelHeader>
          <PanelTitle>分享 Grant 给 Employee</PanelTitle>
          <StatusBadge tone="info">同 issuer</StatusBadge>
        </PanelHeader>
        <ShareGrid>
          <Field>
            <FieldLabel htmlFor="share-grant">Owner Grant</FieldLabel>
            <Select
              id="share-grant"
              value={shareGrant}
              onChange={(event) => {
                const value = event.target.value
                const issuer = value.slice(0, value.indexOf('\n'))
                setShareGrant(value)
                const connectionId = value.slice(value.indexOf('\n') + 1)
                setShareEmployeeId(employees.find((employee) =>
                  employee.issuer === issuer
                  && !detail?.bindings.some((binding) =>
                    binding.connection_id === connectionId
                    && binding.employee_id === employee.employee_id
                    && binding.status === 'active'
                  )
                )?.employee_id || '')
              }}
            >
              {activeGrants.map((binding) => (
                <option key={`${binding.issuer}:${binding.connection_id}`} value={`${binding.issuer}\n${binding.connection_id}`}>
                  {binding.connection_id} · {binding.issuer}
                </option>
              ))}
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="share-employee">Target Employee</FieldLabel>
            <Select
              id="share-employee"
              value={shareEmployeeId}
              onChange={(event) => setShareEmployeeId(event.target.value)}
            >
              {eligibleEmployees.map((employee) => (
                <option key={`${employee.issuer}:${employee.employee_id}`} value={employee.employee_id}>
                  {employee.employee_id}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="primary"
            disabled={sharing || !shareGrant || !shareEmployeeId}
            onClick={() => void shareGrantWithEmployee()}
            type="button"
          >
            {sharing ? '分享中…' : '分享 Binding'}
          </Button>
        </ShareGrid>
        {activeGrants.length === 0 || eligibleEmployees.length === 0 ? (
          <NoBindingText>需要 active Grant 和同 issuer 的已注册 Employee。</NoBindingText>
        ) : null}
      </Panel>

      <ConfirmDialog
        danger
        isOpen={disconnectTarget !== null}
        title="断开 Seller Grant"
        description={<>将撤销该 Grant 的 Owner Credential，并停用它的全部 Employee Binding；同一 Seller 的其他 Owner Grant 不受影响。</>}
        confirmText={disconnecting ? '断开中…' : '确认断开'}
        confirmValueToType={accountId}
        onClose={() => setDisconnectTarget(null)}
        onConfirm={() => void disconnectGrant()}
      />
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
  gap: ${({ theme }) => theme.space.lg};
`

const TitleGroup = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const Title = styled.h1`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.title};
`

const Subtitle = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.caption};
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const Grid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};

  @media (min-width: 1024px) {
    grid-template-columns: 1fr 1fr;
  }
`

const Panel = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
`

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
`

const ShareGrid = styled.div`
  display: grid;
  align-items: end;
  gap: ${({ theme }) => theme.space.md};

  @media (min-width: 860px) {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }
`

const Field = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const FieldLabel = styled.label`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
`

const Select = styled.select`
  width: 100%;
  min-height: 44px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
`

const PanelTitle = styled.h2`
  margin: 0;
  font-size: ${({ theme }) => theme.typeScale.lead};
  font-weight: 700;
`

const DetailList = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.md};
`

const DetailRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${({ theme }) => theme.space.xs} 0;
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};

  &:last-child {
    border-bottom: none;
  }
`

const DetailKey = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const DetailValue = styled.span`
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
  font-size: ${({ theme }) => theme.typeScale.small};
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const ValueWrap = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
`

const BindingTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: ${({ theme }) => theme.typeScale.small};

  th,
  td {
    padding: ${({ theme }) => theme.space.sm};
    text-align: left;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  }

  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-weight: 650;
  }
`

const NoBindingText = styled.p`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  margin: 0;
`
