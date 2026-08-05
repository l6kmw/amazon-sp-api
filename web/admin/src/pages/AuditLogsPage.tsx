import { useEffect, useState } from 'react'
import styled from '@emotion/styled'
import { listAuditLogs } from '../api/auditLogs'
import type { AuditLogItem } from '../api/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { StatusBadge } from '../components/StatusBadge'
import { InlineAlert } from '../components/InlineAlert'
import { CopyButton } from '../components/CopyButton'

const chinaTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

function formatChinaTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : chinaTimeFormatter.format(date)
}

export function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([undefined])
  const [currentPage, setCurrentPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [actorTypeFilter, setActorTypeFilter] = useState('all')
  const [resultFilter, setResultFilter] = useState('all')
  const [requestIdQuery, setRequestIdQuery] = useState('')
  const [selectedLog, setSelectedLog] = useState<AuditLogItem | null>(null)

  const loadAuditLogs = async (page = currentPage, history = cursorHistory) => {
    setLoading(true)
    setError(null)
    try {
      const res = await listAuditLogs({
        actor_type: actorTypeFilter === 'all' ? undefined : actorTypeFilter,
        result: resultFilter === 'all' ? undefined : resultFilter,
        request_id: requestIdQuery.trim() || undefined,
        cursor: history[page - 1],
        limit: 20
      })
      setLogs(res.items || [])
      setNextCursor(res.next_cursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取审计日志失败')
    } finally {
      setLoading(false)
    }
  }

  const resetAndLoad = () => {
    const history = [undefined]
    setCurrentPage(1)
    setCursorHistory(history)
    loadAuditLogs(1, history)
  }

  useEffect(resetAndLoad, [actorTypeFilter, resultFilter])

  const handlePageChange = (page: number) => {
    const history = page > currentPage && nextCursor
      ? [...cursorHistory.slice(0, currentPage), nextCursor]
      : cursorHistory
    setCurrentPage(page)
    setCursorHistory(history)
    loadAuditLogs(page, history)
  }

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    resetAndLoad()
  }

  return (
    <Container>
      <Header>
        <HeaderLeft>
          <Title>审计日志 (Audit Logs)</Title>
          <Subtitle>查询管理员、Test Agent Token、Employee JWT 及系统对账号连接与凭据调用的关键日志</Subtitle>
        </HeaderLeft>
        <Button variant="secondary" onClick={() => loadAuditLogs(currentPage)} type="button">
          刷新
        </Button>
      </Header>

      {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}

      <FilterCard>
        <SearchForm onSubmit={handleSearchSubmit}>
          <SearchInput
            type="text"
            value={requestIdQuery}
            onChange={(e) => setRequestIdQuery(e.target.value)}
            placeholder="按 Request ID 精确检索..."
          />
          <Button variant="secondary" type="submit" style={{ minHeight: 38 }}>
            搜索
          </Button>
        </SearchForm>

        <FilterGroup>
          <FilterLabel>身份类型：</FilterLabel>
          <Select value={actorTypeFilter} onChange={(e) => setActorTypeFilter(e.target.value)}>
            <option value="all">全部身份</option>
            <option value="browser_session">平台管理员 (Browser Session)</option>
            <option value="employee_jwt">数字员工 (Employee JWT)</option>
            <option value="agent_token">测试 Agent (Agent Token)</option>
            <option value="system">系统内部 (System)</option>
          </Select>
        </FilterGroup>

        <FilterGroup>
          <FilterLabel>结果：</FilterLabel>
          <Select value={resultFilter} onChange={(e) => setResultFilter(e.target.value)}>
            <option value="all">全部结果</option>
            <option value="success">成功 (Success)</option>
            <option value="denied">拒绝 (Denied)</option>
            <option value="failed">失败 (Failed)</option>
          </Select>
        </FilterGroup>
      </FilterCard>

      <TableCard>
        <TableHeaderRow>
          <SummaryText>{loading ? '正在查询日志...' : `第 ${currentPage} 页，共 ${logs.length} 条`}</SummaryText>
        </TableHeaderRow>

        {loading ? (
          <EmptyWrap>加载审计日志中...</EmptyWrap>
        ) : logs.length === 0 ? (
          <EmptyWrap>暂无匹配的审计日志记录。</EmptyWrap>
        ) : (
          <TableArea>
            <Table>
              <thead>
                <tr>
                  <th>时间戳（北京时间）</th>
                  <th>操作主体 (Actor)</th>
                  <th>动作 (Action)</th>
                  <th>目标资源 (Resource)</th>
                  <th>结果</th>
                  <th>Request ID</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id || log.request_id}>
                    <td>
                      <CodeText title={log.created_at}>{formatChinaTime(log.created_at)}</CodeText>
                    </td>
                    <td>
                      <ActorWrap>
                        <BadgeLabel>{log.actor_type}</BadgeLabel>
                        <CodeText>{log.actor_id || '—'}</CodeText>
                      </ActorWrap>
                    </td>
                    <td>
                      <strong>{log.action}</strong>
                    </td>
                    <td>
                      <CodeText>
                        {log.resource_type}:{log.resource_id}
                      </CodeText>
                    </td>
                    <td>
                      <StatusBadge
                        tone={
                          log.result === 'success'
                            ? 'success'
                            : log.result === 'denied'
                            ? 'warning'
                            : 'danger'
                        }
                      >
                        {log.result}
                      </StatusBadge>
                    </td>
                    <td>
                      <ValueWrap>
                        <CodeText>{log.request_id}</CodeText>
                        {log.request_id ? <CopyButton textToCopy={log.request_id} /> : null}
                      </ValueWrap>
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() => setSelectedLog(log)}
                        type="button"
                        style={{ minHeight: 32, padding: '0 8px' }}
                      >
                        查看详情
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableArea>
        )}

        <PageButtons>
          <Button variant="secondary" disabled={currentPage === 1} onClick={() => handlePageChange(currentPage - 1)} type="button">
            上一页
          </Button>
          <SummaryText>第 {currentPage} 页</SummaryText>
          <Button variant="secondary" disabled={!nextCursor} onClick={() => handlePageChange(currentPage + 1)} type="button">
            下一页
          </Button>
        </PageButtons>
      </TableCard>

      {selectedLog ? (
        <ModalOverlay onClick={() => setSelectedLog(null)}>
          <ModalCard onClick={(e) => e.stopPropagation()}>
            <ModalTitle>审计日志结构化详情</ModalTitle>

            <DetailGrid>
              <DetailRow>
                <span>Log ID:</span>
                <code>{selectedLog.id}</code>
              </DetailRow>
              <DetailRow>
                <span>时间（北京时间）:</span>
                <code title={selectedLog.created_at}>{formatChinaTime(selectedLog.created_at)}</code>
              </DetailRow>
              <DetailRow>
                <span>Actor Type:</span>
                <strong>{selectedLog.actor_type}</strong>
              </DetailRow>
              <DetailRow>
                <span>Actor ID:</span>
                <code>{selectedLog.actor_id}</code>
              </DetailRow>
              <DetailRow>
                <span>Action:</span>
                <strong>{selectedLog.action}</strong>
              </DetailRow>
              <DetailRow>
                <span>Resource:</span>
                <code>
                  {selectedLog.resource_type}:{selectedLog.resource_id}
                </code>
              </DetailRow>
              <DetailRow>
                <span>Result:</span>
                <StatusBadge
                  tone={
                    selectedLog.result === 'success'
                      ? 'success'
                      : selectedLog.result === 'denied'
                      ? 'warning'
                      : 'danger'
                  }
                >
                  {selectedLog.result}
                </StatusBadge>
              </DetailRow>
              {selectedLog.error_code ? (
                <DetailRow>
                  <span>Error Code:</span>
                  <code style={{ color: 'var(--colors-danger)' }}>{selectedLog.error_code}</code>
                </DetailRow>
              ) : null}
              <DetailRow>
                <span>Request ID:</span>
                <code>{selectedLog.request_id}</code>
              </DetailRow>
            </DetailGrid>

            <ModalActions>
              <Button variant="secondary" onClick={() => setSelectedLog(null)} type="button">
                关闭
              </Button>
            </ModalActions>
          </ModalCard>
        </ModalOverlay>
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

const FilterCard = styled(Card)`
  padding: ${({ theme }) => theme.space.lg};
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xl};
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
  font-weight: 650;
`

const Select = styled.select`
  min-height: 38px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const TableCard = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
`

const TableHeaderRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`

const SummaryText = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
`

const TableArea = styled.div`
  overflow-x: auto;
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: ${({ theme }) => theme.typeScale.small};

  th,
  td {
    padding: ${({ theme }) => theme.space.md} ${({ theme }) => theme.space.sm};
    text-align: left;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  }

  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-weight: 700;
  }
`

const ActorWrap = styled.div`
  display: grid;
  gap: 2px;
`

const BadgeLabel = styled.span`
  color: ${({ theme }) => theme.colors.primaryStrong};
  font-size: ${({ theme }) => theme.typeScale.caption};
  font-weight: 700;
`

const CodeText = styled.code`
  font-family: ${({ theme }) => theme.fonts.numeric};
  font-size: ${({ theme }) => theme.typeScale.caption};
  color: ${({ theme }) => theme.colors.text};
`

const ValueWrap = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
`

const EmptyWrap = styled.div`
  padding: ${({ theme }) => theme.space.xl};
  text-align: center;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const PageButtons = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.space.md};
`

const ModalOverlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: oklch(0% 0 0 / 0.45);
  backdrop-filter: blur(4px);
  padding: ${({ theme }) => theme.space.lg};
`

const ModalCard = styled.div`
  width: min(100%, 520px);
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.lg};
  padding: ${({ theme }) => theme.space.xl};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadows.lift};
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
`

const ModalTitle = styled.h3`
  margin: 0;
  font-size: ${({ theme }) => theme.typeScale.title};
  color: ${({ theme }) => theme.colors.text};
`

const DetailGrid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.sm};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const DetailRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};
  padding-bottom: ${({ theme }) => theme.space.xs};

  span {
    color: ${({ theme }) => theme.colors.textMuted};
  }

  code,
  strong {
    font-family: ${({ theme }) => theme.fonts.numeric};
  }
`

const ModalActions = styled.div`
  display: flex;
  justify-content: flex-end;
`
