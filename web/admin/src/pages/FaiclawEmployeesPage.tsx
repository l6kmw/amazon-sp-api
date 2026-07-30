import { useEffect, useState } from 'react'
import styled from '@emotion/styled'
import {
  listConnectedAccountEmployees,
  listEmployeeSellerBindings,
  unbindEmployeeSeller
} from '../api/connected-accountEmployees'
import type { AccountBinding, ConnectedAccountEmployee } from '../api/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { StatusBadge } from '../components/StatusBadge'
import { InlineAlert } from '../components/InlineAlert'
import { EmptyState } from '../components/EmptyState'
import { ConfirmDialog } from '../components/ConfirmDialog'

export function ConnectedAccountEmployeesPage() {
  const pageSize = 50
  const [employees, setEmployees] = useState<ConnectedAccountEmployee[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<ConnectedAccountEmployee | null>(null)
  const [bindings, setBindings] = useState<AccountBinding[]>([])
  const [loading, setLoading] = useState(true)
  const [bindingsLoading, setBindingsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null)
  const [unbindTarget, setUnbindTarget] = useState<AccountBinding | null>(null)

  const refreshEmployees = async (targetOffset = offset) => {
    setLoading(true)
    setError(null)
    try {
      const res = await listConnectedAccountEmployees(targetOffset, pageSize)
      setEmployees(res.items || [])
      setTotal(res.total || 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取数字员工列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setSelected(null)
    setBindings([])
    refreshEmployees(offset)
  }, [offset])

  const handleSelectEmployee = async (emp: ConnectedAccountEmployee) => {
    setSelected(emp)
    setBindingsLoading(true)
    setError(null)
    try {
      const list = await listEmployeeSellerBindings(emp.employee_id, emp.issuer)
      setBindings(list || [])
    } catch (err) {
      setBindings([])
      setError(err instanceof Error ? err.message : '获取数字员工绑定的 Seller 账号失败')
    } finally {
      setBindingsLoading(false)
    }
  }

  const handleUnbind = async (connectionId: string) => {
    if (!selected) return
    setBusyConnectionId(connectionId)
    setError(null)
    try {
      await unbindEmployeeSeller(selected.employee_id, selected.issuer, connectionId)
      await handleSelectEmployee(selected)
      await refreshEmployees(offset)
    } catch (err) {
      setError(err instanceof Error ? err.message : '解绑 Seller 账号失败')
    } finally {
      setBusyConnectionId(null)
    }
  }

  return (
    <Container>
      <Header>
        <HeaderLeft>
          <Title>数字员工绑定 (ConnectedAccount Employees)</Title>
          <Subtitle>查看与管理使用 Employee JWT 访问 SP-API MCP 的数字员工及其绑定的 Amazon Seller 账号</Subtitle>
        </HeaderLeft>
        <Button variant="secondary" onClick={() => refreshEmployees(offset)} type="button">
          刷新
        </Button>
      </Header>

      {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}

      <Grid>
        <ListCard>
          <Toolbar>
            <span>{loading ? '加载中...' : `共 ${total} 位数字员工`}</span>
            <PaginationWrap>
              <Button
                variant="ghost"
                disabled={loading || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - pageSize))}
                type="button"
                style={{ minHeight: 32, padding: '0 8px' }}
              >
                上一页
              </Button>
              <PageText>第 {Math.floor(offset / pageSize) + 1} 页</PageText>
              <Button
                variant="ghost"
                disabled={loading || offset + employees.length >= total}
                onClick={() => setOffset(offset + pageSize)}
                type="button"
                style={{ minHeight: 32, padding: '0 8px' }}
              >
                下一页
              </Button>
            </PaginationWrap>
          </Toolbar>

          {!loading && employees.length === 0 ? (
            <EmptyWrap>尚无 ConnectedAccount 数字员工调用记录。</EmptyWrap>
          ) : null}

          {employees.map((emp) => (
            <EmployeeRow
              key={`${emp.issuer}:${emp.employee_id}`}
              selected={selected?.employee_id === emp.employee_id && selected?.issuer === emp.issuer}
              onClick={() => handleSelectEmployee(emp)}
              type="button"
            >
              <EmpID>{emp.employee_id}</EmpID>
              <EmpMeta>{emp.issuer}</EmpMeta>
              <EmpBadgeGroup>
                <StatusBadge tone="info">{emp.active_bindings_count ?? 0} 个活跃绑定</StatusBadge>
                <EmpMeta>总计 {emp.total_bindings_count ?? 0} 个</EmpMeta>
              </EmpBadgeGroup>
            </EmployeeRow>
          ))}
        </ListCard>

        <DetailCard>
          {!selected ? (
            <EmptyState title="未选择数字员工" description="请从左侧选择一位数字员工，查看其绑定的 Seller 账号与 Grant 关系。" />
          ) : (
            <>
              <DetailHead>
                <DetailEmpTitle>{selected.employee_id}</DetailEmpTitle>
                <DetailEmpMeta>Issuer: {selected.issuer}</DetailEmpMeta>
                <DetailEmpMeta>首次调用: {selected.first_seen_at || '—'} · 最近调用: {selected.last_seen_at || '—'}</DetailEmpMeta>
              </DetailHead>

              {bindingsLoading ? (
                <EmptyWrap>正在获取关联 Seller 账号...</EmptyWrap>
              ) : bindings.length === 0 ? (
                <EmptyState title="暂无绑定 Seller 账号" description="该数字员工尚未绑定任何 Amazon Seller 账号。" />
              ) : (
                <BindingList>
                  {bindings.map((b) => (
                    <BindingRow key={b.connection_id}>
                      <BindingLeft>
                        <BindingTitle>Connection ID: {b.connection_id}</BindingTitle>
                        <BindingSub>Remark: {b.remark || '无备注'}</BindingSub>
                        <BindingSub>绑定时间: {b.bound_at}</BindingSub>
                      </BindingLeft>
                      <BindingRight>
                        <StatusBadge tone={b.status === 'active' ? 'success' : 'muted'}>{b.status}</StatusBadge>
                        {b.status === 'active' ? (
                          <Button
                            variant="danger"
                            disabled={busyConnectionId === b.connection_id}
                            onClick={() => setUnbindTarget(b)}
                            type="button"
                            style={{ minHeight: 32, padding: '0 10px' }}
                          >
                            {busyConnectionId === b.connection_id ? '解绑中...' : '解绑'}
                          </Button>
                        ) : null}
                      </BindingRight>
                    </BindingRow>
                  ))}
                </BindingList>
              )}
            </>
          )}
        </DetailCard>
      </Grid>

      <ConfirmDialog
        danger
        isOpen={unbindTarget !== null}
        title="解绑 Employee 与 Seller"
        description={<>仅移除 Employee <strong>{selected?.employee_id}</strong> 对该 Seller 的 Binding；不会撤销 Owner Credential，也不会影响其他 Employee。</>}
        confirmText="确认解绑"
        onClose={() => setUnbindTarget(null)}
        onConfirm={() => {
          if (unbindTarget) void handleUnbind(unbindTarget.connection_id)
        }}
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
  align-items: flex-start;
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

const Grid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};

  @media (min-width: 860px) {
    grid-template-columns: minmax(300px, 0.9fr) minmax(360px, 1.1fr);
  }
`

const ListCard = styled(Card)`
  overflow: hidden;
`

const DetailCard = styled(Card)`
  overflow: hidden;
  align-self: start;
  padding: ${({ theme }) => theme.space.lg};
`

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => theme.space.lg};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  font-weight: 600;
  font-size: ${({ theme }) => theme.typeScale.small};
`

const PaginationWrap = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
`

const PageText = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.caption};
`

const EmployeeRow = styled.button<{ selected: boolean }>`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
  width: 100%;
  border: 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  padding: ${({ theme }) => theme.space.lg};
  background: ${({ theme, selected }) => (selected ? theme.colors.primarySoft : 'transparent')};
  text-align: left;
  cursor: pointer;

  &:hover {
    background: ${({ theme, selected }) => (selected ? theme.colors.primarySoft : theme.colors.surfaceMuted)};
  }
`

const EmpID = styled.strong`
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const EmpMeta = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.caption};
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const EmpBadgeGroup = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
  margin-top: ${({ theme }) => theme.space.xs};
`

const DetailHead = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  padding-bottom: ${({ theme }) => theme.space.lg};
  margin-bottom: ${({ theme }) => theme.space.lg};
`

const DetailEmpTitle = styled.h3`
  margin: 0;
  font-size: ${({ theme }) => theme.typeScale.lead};
  color: ${({ theme }) => theme.colors.text};
`

const DetailEmpMeta = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const BindingList = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.md};
`

const BindingRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.surface};
`

const BindingLeft = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const BindingTitle = styled.strong`
  font-size: ${({ theme }) => theme.typeScale.small};
  color: ${({ theme }) => theme.colors.text};
`

const BindingSub = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.caption};
`

const BindingRight = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
`

const EmptyWrap = styled.div`
  padding: ${({ theme }) => theme.space.xl};
  text-align: center;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`
