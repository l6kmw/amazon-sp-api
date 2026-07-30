import { useState, useEffect, type FormEvent } from 'react'
import styled from '@emotion/styled'
import {
  listAgents,
  createAgent,
  updateAgentStatus,
  rotateAgentToken,
  revokeAgentToken
} from '../api/agents'
import type { TestAgent } from '../api/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { StatusBadge } from '../components/StatusBadge'
import { InlineAlert } from '../components/InlineAlert'
import { CopyButton } from '../components/CopyButton'
import { ConfirmDialog } from '../components/ConfirmDialog'

export function TestAgentsPage() {
  const [agents, setAgents] = useState<TestAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rawTokenOnce, setRawTokenOnce] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<TestAgent | null>(null)

  // Form states
  const [agentIdInput, setAgentIdInput] = useState('')
  const [displayNameInput, setDisplayNameInput] = useState('')
  const [purposeInput, setPurposeInput] = useState('')
  const [creating, setCreating] = useState(false)

  const loadAgents = async () => {
    setLoading(true)
    setError(null)
    try {
      const items = await listAgents()
      setAgents(items || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取测试 Agent 列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAgents()
  }, [])

  const handleCreateAgent = async (e: FormEvent) => {
    e.preventDefault()
    if (creating || !agentIdInput.trim() || !displayNameInput.trim()) return
    setCreating(true)
    setError(null)
    try {
      const res = await createAgent({
        agent_id: agentIdInput.trim(),
        name: displayNameInput.trim(),
        purpose: purposeInput.trim()
      })
      setAgents((prev) => [res.agent, ...prev])
      setRawTokenOnce(res.api_token)
      setAgentIdInput('')
      setDisplayNameInput('')
      setPurposeInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建测试 Agent 失败')
    } finally {
      setCreating(false)
    }
  }

  const handleRotateToken = async (agent: TestAgent) => {
    setBusyId(agent.id)
    setError(null)
    try {
      const res = await rotateAgentToken(agent.id)
      setAgents((prev) => prev.map((a) => (a.id === res.agent.id ? res.agent : a)))
      setRawTokenOnce(res.api_token)
    } catch (err) {
      setError(err instanceof Error ? err.message : '轮换 Token 失败')
    } finally {
      setBusyId(null)
    }
  }

  const handleRevokeToken = async (agent: TestAgent) => {
    setBusyId(agent.id)
    setError(null)
    try {
      const updated = await revokeAgentToken(agent.id)
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
      setRawTokenOnce(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销 Token 失败')
    } finally {
      setBusyId(null)
    }
  }

  const handleToggleStatus = async (agent: TestAgent) => {
    const nextStatus = agent.status === 'active' ? 'disabled' : 'active'
    setBusyId(agent.id)
    setError(null)
    try {
      const updated = await updateAgentStatus(agent.id, nextStatus)
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换 Agent 状态失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Container>
      <Header>
        <HeaderLeft>
          <Title>测试 Agent (Test Agents)</Title>
          <Subtitle>创建独立测试 Agent，生成、轮换与撤销用于 MCP 联通性测试的 oat_* Token</Subtitle>
        </HeaderLeft>
        <Button variant="secondary" onClick={loadAgents} type="button">
          刷新列表
        </Button>
      </Header>

      {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}

      {rawTokenOnce ? (
        <TokenBanner>
          <BannerLeft>
            <BannerTitle>⚠️ oat_* Token 明文生成成功 (仅本次显示一次)</BannerTitle>
            <TokenCode>{rawTokenOnce}</TokenCode>
            <BannerNote>请妥善保存此凭据。刷新页面或导航离开后，明文将从内存中彻底删除，且系统无法恢复。</BannerNote>
          </BannerLeft>
          <CopyButton textToCopy={rawTokenOnce} label="复制 Token" />
        </TokenBanner>
      ) : null}

      <CreateFormCard onSubmit={handleCreateAgent}>
        <CardTitle>新建测试 Agent</CardTitle>
        <FormFields>
          <Field>
            <Label htmlFor="agent-id">Agent ID</Label>
            <Input
              id="agent-id"
              type="text"
              required
              value={agentIdInput}
              onChange={(e) => setAgentIdInput(e.target.value)}
              placeholder="e.g. diagnostic-agent-01"
            />
          </Field>
          <Field>
            <Label htmlFor="display-name">显示名称</Label>
            <Input
              id="display-name"
              type="text"
              required
              value={displayNameInput}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              placeholder="e.g. 连通性测试 Agent"
            />
          </Field>
          <Field>
            <Label htmlFor="purpose">用途说明</Label>
            <Input
              id="purpose"
              type="text"
              value={purposeInput}
              onChange={(e) => setPurposeInput(e.target.value)}
              placeholder="e.g. 仅用于 MCP 协议诊断"
            />
          </Field>
          <Button variant="primary" type="submit" disabled={creating || !agentIdInput.trim() || !displayNameInput.trim()} style={{ alignSelf: 'end' }}>
            {creating ? '创建中...' : '创建并生成 Token'}
          </Button>
        </FormFields>
      </CreateFormCard>

      <ListCard>
        <ListHeader>
          <CardTitle>已有的测试 Agent 列表</CardTitle>
          <StatusBadge tone="info">共 {agents.length} 个 Agent</StatusBadge>
        </ListHeader>

        {loading ? (
          <EmptyWrap>加载中...</EmptyWrap>
        ) : agents.length === 0 ? (
          <EmptyWrap>尚未创建任何测试 Agent。</EmptyWrap>
        ) : (
          <AgentList>
            {agents.map((a) => (
              <AgentItem key={a.id}>
                <AgentLeft>
                  <AgentTitleGroup>
                    <AgentName>{a.name}</AgentName>
                    <AgentSub>ID: {a.agent_id} · 用途: {a.purpose || '未填写'}</AgentSub>
                  </AgentTitleGroup>

                  <TokenHintRow>
                    <StatusBadge tone={a.status === 'active' ? 'success' : 'muted'}>
                      {a.status === 'active' ? '已启用' : '已禁用'}
                    </StatusBadge>
                    <TokenHintText>Token Hint: {a.api_token_hint || '未配置'}</TokenHintText>
                    <TokenHintText>创建时间: {a.created_at || '—'}</TokenHintText>
                  </TokenHintRow>
                </AgentLeft>

                <AgentActions>
                  <Button
                    variant="secondary"
                    disabled={busyId === a.id || a.status !== 'active'}
                    onClick={() => handleRotateToken(a)}
                    type="button"
                    style={{ minHeight: 36, padding: '0 12px' }}
                  >
                    {busyId === a.id ? '处理中...' : '轮换 Token'}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busyId === a.id}
                    onClick={() => setRevokeTarget(a)}
                    type="button"
                    style={{ minHeight: 36, padding: '0 12px' }}
                  >
                    撤销 Token
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busyId === a.id}
                    onClick={() => handleToggleStatus(a)}
                    type="button"
                    style={{ minHeight: 36, padding: '0 12px' }}
                  >
                    {a.status === 'active' ? '禁用' : '启用'}
                  </Button>
                </AgentActions>
              </AgentItem>
            ))}
          </AgentList>
        )}
      </ListCard>

      <ConfirmDialog
        danger
        isOpen={revokeTarget !== null}
        title="撤销 Test Agent Token"
        description={<>撤销后，Agent <strong>{revokeTarget?.name}</strong> 的当前 oat_* Token 将立即失去 MCP 访问权限。</>}
        confirmText="确认撤销"
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) void handleRevokeToken(revokeTarget)
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

const TokenBanner = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.lg};
  border: 1px solid ${({ theme }) => theme.colors.warning};
  border-radius: ${({ theme }) => theme.radii.lg};
  padding: ${({ theme }) => theme.space.lg};
  background: ${({ theme }) => theme.colors.warningSoft};
`

const BannerLeft = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const BannerTitle = styled.strong`
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const TokenCode = styled.code`
  font-family: ${({ theme }) => theme.fonts.numeric};
  font-size: ${({ theme }) => theme.typeScale.body};
  color: ${({ theme }) => theme.colors.primaryStrong};
  background: ${({ theme }) => theme.colors.surface};
  padding: ${({ theme }) => theme.space.xs} ${({ theme }) => theme.space.md};
  border-radius: ${({ theme }) => theme.radii.sm};
  word-break: break-all;
`

const BannerNote = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.caption};
`

const CreateFormCard = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
`

const CardTitle = styled.h2`
  margin: 0;
  font-size: ${({ theme }) => theme.typeScale.lead};
  color: ${({ theme }) => theme.colors.text};
`

const FormFields = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
`

const Field = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const Label = styled.label`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
`

const Input = styled.input`
  min-height: 40px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.md};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const ListCard = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
`

const ListHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`

const AgentList = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.md};
`

const AgentItem = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: ${({ theme }) => theme.space.lg};
  background: ${({ theme }) => theme.colors.surface};
  flex-wrap: wrap;
`

const AgentLeft = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.sm};
`

const AgentTitleGroup = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const AgentName = styled.strong`
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.lead};
`

const AgentSub = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.caption};
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const TokenHintRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
  flex-wrap: wrap;
`

const TokenHintText = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.caption};
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const AgentActions = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
`

const EmptyWrap = styled.div`
  padding: ${({ theme }) => theme.space.xl};
  text-align: center;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`
