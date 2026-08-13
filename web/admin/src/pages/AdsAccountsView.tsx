import { useEffect, useMemo, useState } from 'react'
import styled from '@emotion/styled'
import {
  disconnectAdsConnection,
  getAdsAccount,
  listAdsAccounts,
  listAdsEmployees,
  shareAdsBinding,
  unshareAdsBinding
} from '../api/adsAccounts'
import type { AdsAccount, AdsAccountBinding, AdsEmployee } from '../api/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { EmptyState } from '../components/EmptyState'
import { InlineAlert } from '../components/InlineAlert'
import { StatusBadge } from '../components/StatusBadge'

export function AdsAccountsView() {
  const [accounts, setAccounts] = useState<AdsAccount[]>([])
  const [selected, setSelected] = useState<AdsAccount | null>(null)
  const [employees, setEmployees] = useState<AdsEmployee[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shareEmployee, setShareEmployee] = useState('')
  const [sharing, setSharing] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const loadList = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await listAdsAccounts()
      setAccounts(result.items || [])
    } catch (value) {
      setError(value instanceof Error ? value.message : '加载 Ads 账号失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadList()
  }, [])

  const openDetail = async (accountId: string) => {
    setDetailLoading(true)
    setError(null)
    try {
      const [account, employeePage] = await Promise.all([
        getAdsAccount(accountId),
        listAdsEmployees()
      ])
      setSelected(account)
      setEmployees(employeePage.items || [])
      const eligible = employeePage.items.find((employee) =>
        employee.issuer === account.owner_issuer
        && !account.bindings.some((binding) =>
          binding.employee_id === employee.employee_id && binding.status === 'active'
        )
      )
      setShareEmployee(eligible ? `${eligible.issuer}\n${eligible.employee_id}` : '')
    } catch (value) {
      setError(value instanceof Error ? value.message : '加载 Ads 账号详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  const reloadDetail = async () => {
    if (!selected) return
    await openDetail(selected.account_id)
    await loadList()
  }

  const share = async () => {
    if (!selected || !shareEmployee) return
    const separator = shareEmployee.indexOf('\n')
    setSharing(true)
    setError(null)
    try {
      await shareAdsBinding(
        selected.connection_id,
        shareEmployee.slice(0, separator),
        shareEmployee.slice(separator + 1)
      )
      await reloadDetail()
    } catch (value) {
      setError(value instanceof Error ? value.message : '分享 Ads Binding 失败')
    } finally {
      setSharing(false)
    }
  }

  const removeBinding = async (binding: AdsAccountBinding) => {
    if (!selected) return
    setRemoving(binding.employee_id)
    setError(null)
    try {
      await unshareAdsBinding(binding.connection_id, binding.issuer, binding.employee_id)
      await reloadDetail()
    } catch (value) {
      setError(value instanceof Error ? value.message : '移除 Ads Binding 失败')
    } finally {
      setRemoving(null)
    }
  }

  const disconnect = async () => {
    if (!selected) return
    setDisconnecting(true)
    setError(null)
    try {
      await disconnectAdsConnection(selected.connection_id)
      setSelected(null)
      await loadList()
    } catch (value) {
      setError(value instanceof Error ? value.message : '断开 Ads Grant 失败')
    } finally {
      setDisconnecting(false)
    }
  }

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return accounts
    return accounts.filter((account) => [
      account.display_name,
      account.account_id,
      account.external_account_id,
      account.country_code || ''
    ].some((field) => field.toLowerCase().includes(value)))
  }, [accounts, query])

  const eligibleEmployees = selected ? employees.filter((employee) =>
    employee.issuer === selected.owner_issuer
    && !selected.bindings.some((binding) =>
      binding.employee_id === employee.employee_id && binding.status === 'active'
    )
  ) : []

  if (selected) {
    return (
      <Section>
        <DetailHeader>
          <Button variant="secondary" type="button" onClick={() => setSelected(null)}>
            返回 Ads 列表
          </Button>
          <TitleGroup>
            <SectionTitle>{selected.display_name}</SectionTitle>
            <Mono>{selected.account_id}</Mono>
          </TitleGroup>
          <StatusBadge tone={selected.status === 'active' ? 'success' : selected.status === 'profile_missing' ? 'danger' : 'muted'}>
            {selected.status === 'active' ? '可用' : selected.status === 'profile_missing' ? '凭据缺失' : '已断开'}
          </StatusBadge>
        </DetailHeader>

        {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}
        {detailLoading ? <InlineAlert type="info">正在更新 Ads 账号详情…</InlineAlert> : null}

        <DetailGrid>
          <Panel>
            <PanelTitle>Ads Profile</PanelTitle>
            <DefinitionList>
              <Definition><span>Profile ID</span><Mono>{selected.external_account_id}</Mono></Definition>
              <Definition><span>Region</span><strong>{selected.region?.toUpperCase() || '—'}</strong></Definition>
              <Definition><span>Country</span><strong>{selected.country_code || '—'}</strong></Definition>
              <Definition><span>Currency</span><strong>{selected.currency_code || '—'}</strong></Definition>
              <Definition><span>Account Type</span><strong>{selected.account_type || '—'}</strong></Definition>
              <Definition><span>Owner Employee</span><Mono>{selected.owner_employee_id}</Mono></Definition>
              <Definition><span>Connection ID</span><Mono>{selected.connection_id}</Mono></Definition>
            </DefinitionList>
          </Panel>

          <Panel>
            <PanelHeader>
              <PanelTitle>Employee Bindings</PanelTitle>
              <StatusBadge tone="info">{selected.active_bindings_count} 个 Active</StatusBadge>
            </PanelHeader>
            <TableScroll>
              <BindingTable>
                <thead>
                  <tr><th>Employee</th><th>Remark</th><th>状态</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {selected.bindings.map((binding) => (
                    <tr key={`${binding.issuer}:${binding.employee_id}`}>
                      <td><Mono>{binding.employee_id}</Mono>{binding.is_owner ? <OwnerTag>Owner</OwnerTag> : null}</td>
                      <td>{binding.remark || '—'}</td>
                      <td>
                        <StatusBadge tone={binding.status === 'active' ? 'success' : 'muted'}>
                          {binding.status === 'active' ? 'Active' : 'Unbound'}
                        </StatusBadge>
                      </td>
                      <td>
                        {!binding.is_owner && binding.status === 'active' ? (
                          <Button
                            variant="secondary"
                            disabled={removing === binding.employee_id}
                            onClick={() => void removeBinding(binding)}
                            type="button"
                          >
                            {removing === binding.employee_id ? '移除中…' : '移除 Binding'}
                          </Button>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </BindingTable>
            </TableScroll>
          </Panel>
        </DetailGrid>

        <ActionBand>
          <ActionGroup>
            <FieldLabel htmlFor="ads-share-employee">分享给同 issuer Employee</FieldLabel>
            <Select
              id="ads-share-employee"
              value={shareEmployee}
              onChange={(event) => setShareEmployee(event.target.value)}
            >
              <option value="">选择 Employee</option>
              {eligibleEmployees.map((employee) => (
                <option
                  key={`${employee.issuer}:${employee.employee_id}`}
                  value={`${employee.issuer}\n${employee.employee_id}`}
                >
                  {employee.employee_id}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              disabled={sharing || !shareEmployee || selected.status !== 'active'}
              onClick={() => void share()}
              type="button"
            >
              {sharing ? '分享中…' : '分享 Ads Binding'}
            </Button>
          </ActionGroup>
          <Button
            variant="danger"
            disabled={selected.status === 'disconnected'}
            onClick={() => setDisconnectOpen(true)}
            type="button"
          >
            断开 Ads Grant
          </Button>
        </ActionBand>

        <ConfirmDialog
          danger
          isOpen={disconnectOpen}
          title="断开 Ads Grant"
          description="将删除该 Ads Profile 的凭据引用，并停用此 Grant 的全部 Employee Binding。"
          confirmText={disconnecting ? '断开中…' : '确认断开'}
          confirmValueToType={selected.account_id}
          onClose={() => setDisconnectOpen(false)}
          onConfirm={() => void disconnect()}
        />
      </Section>
    )
  }

  return (
    <Section>
      <Toolbar>
        <SearchInput
          aria-label="搜索 Ads 账号"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 Profile 名称、account_id 或 Profile ID..."
        />
        <Button variant="secondary" type="button" onClick={() => void loadList()}>
          刷新 Ads
        </Button>
      </Toolbar>
      {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}
      {loading ? <InlineAlert type="info">正在加载 Ads 账号…</InlineAlert> : null}
      {!loading && filtered.length === 0 ? (
        <EmptyState title="没有 Ads 账号" description="尚无 active Grant 与 Profile 同时存在的 Amazon Ads 连接。" />
      ) : null}
      {!loading && filtered.length > 0 ? (
        <AccountGrid>
          {filtered.map((account) => (
            <AccountCard key={account.account_id}>
              <CardHeader>
                <div>
                  <AccountName>{account.display_name}</AccountName>
                  <Mono>{account.account_id}</Mono>
                </div>
                <StatusBadge tone={account.status === 'active' ? 'success' : account.status === 'profile_missing' ? 'danger' : 'muted'}>
                  {account.status === 'active' ? '可用' : account.status === 'profile_missing' ? '凭据缺失' : '已断开'}
                </StatusBadge>
              </CardHeader>
              <DefinitionList>
                <Definition><span>Profile ID</span><Mono>{account.external_account_id}</Mono></Definition>
                <Definition><span>Region</span><strong>{account.region?.toUpperCase() || '—'}</strong></Definition>
                <Definition><span>Country</span><strong>{account.country_code || '—'}</strong></Definition>
                <Definition><span>Active Binding</span><strong>{account.active_bindings_count}</strong></Definition>
              </DefinitionList>
              <CardActions>
                <Button variant="secondary" type="button" onClick={() => void openDetail(account.account_id)}>
                  Ads 详情
                </Button>
              </CardActions>
            </AccountCard>
          ))}
        </AccountGrid>
      ) : null}
    </Section>
  )
}

const Section = styled.section`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};
  min-width: 0;
`

const Toolbar = styled.div`
  display: flex;
  gap: ${({ theme }) => theme.space.md};
  align-items: center;
  flex-wrap: wrap;
`

const SearchInput = styled.input`
  flex: 1;
  min-width: min(100%, 280px);
  min-height: 42px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.md};
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.surface};
`

const AccountGrid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
`

const AccountCard = styled(Card)`
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
  padding: ${({ theme }) => theme.space.xl};
`

const CardHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
`

const AccountName = styled.h3`
  margin: 0 0 ${({ theme }) => theme.space.xs};
  font-size: ${({ theme }) => theme.typeScale.lead};
`

const Mono = styled.span`
  display: inline-block;
  max-width: min(100%, 42ch);
  overflow: hidden;
  color: ${({ theme }) => theme.colors.textMuted};
  font-family: ${({ theme }) => theme.fonts.numeric};
  font-size: ${({ theme }) => theme.typeScale.caption};
  text-overflow: ellipsis;
  vertical-align: middle;
  white-space: nowrap;
`

const DefinitionList = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.sm};
`

const Definition = styled.div`
  display: flex;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};
  padding-bottom: ${({ theme }) => theme.space.xs};
  font-size: ${({ theme }) => theme.typeScale.small};

  span:first-of-type { color: ${({ theme }) => theme.colors.textMuted}; }
  strong { text-align: right; }
`

const CardActions = styled.div`
  display: flex;
  justify-content: flex-end;
`

const DetailHeader = styled.div`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: ${({ theme }) => theme.space.lg};

  @media (max-width: 640px) {
    grid-template-columns: 1fr auto;
    & > button { grid-column: 1 / -1; justify-self: start; }
  }
`

const TitleGroup = styled.div`
  min-width: 0;
`

const SectionTitle = styled.h2`
  margin: 0 0 ${({ theme }) => theme.space.xs};
  font-size: ${({ theme }) => theme.typeScale.title};
`

const DetailGrid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};

  @media (min-width: 980px) { grid-template-columns: minmax(280px, 0.8fr) minmax(0, 1.2fr); }
`

const Panel = styled(Card)`
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
  min-width: 0;
  padding: ${({ theme }) => theme.space.xl};
`

const PanelHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
`

const PanelTitle = styled.h3`
  margin: 0;
  font-size: ${({ theme }) => theme.typeScale.lead};
`

const TableScroll = styled.div`
  max-width: 100%;
  overflow-x: auto;
`

const BindingTable = styled.table`
  width: 100%;
  min-width: 620px;
  border-collapse: collapse;
  font-size: ${({ theme }) => theme.typeScale.small};
  th, td { border-bottom: 1px solid ${({ theme }) => theme.colors.border}; padding: ${({ theme }) => theme.space.sm}; text-align: left; }
  th { color: ${({ theme }) => theme.colors.textMuted}; }
`

const OwnerTag = styled.span`
  margin-left: ${({ theme }) => theme.space.sm};
  color: ${({ theme }) => theme.colors.info};
  font-size: ${({ theme }) => theme.typeScale.caption};
  font-weight: 700;
`

const ActionBand = styled.div`
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.lg};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  padding-top: ${({ theme }) => theme.space.xl};
  flex-wrap: wrap;
`

const ActionGroup = styled.div`
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  align-items: end;
  gap: ${({ theme }) => theme.space.sm};

  @media (max-width: 640px) { width: 100%; grid-template-columns: 1fr; }
`

const FieldLabel = styled.label`
  grid-column: 1 / -1;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
`

const Select = styled.select`
  min-height: 42px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.md};
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.surface};
`
