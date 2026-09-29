import { useEffect, useState } from 'react'
import styled from '@emotion/styled'
import { getAmazonConfigStatus } from '../api/dashboard'
import { listConnectedAccountEmployees } from '../api/connectedAccountEmployees'
import { createAuthorizationAttempt, getAuthorizationAttempt } from '../api/authorizationAttempts'
import type { AmazonConfigStatus, AuthorizationAttempt, ConnectedAccountEmployee } from '../api/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { StatusBadge } from '../components/StatusBadge'
import { InlineAlert } from '../components/InlineAlert'
import { CopyButton } from '../components/CopyButton'

export function AmazonSetupPage() {
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1)
  const [configStatus, setConfigStatus] = useState<AmazonConfigStatus | null>(null)
  const [employees, setEmployees] = useState<ConnectedAccountEmployee[]>([])
  const [selectedEmployee, setSelectedEmployee] = useState('')
  const [attempt, setAttempt] = useState<AuthorizationAttempt | null>(null)
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [authorizing, setAuthorizing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadConfig = async () => {
    setLoading(true)
    setError(null)
    try {
      const [status, employeePage] = await Promise.all([
        getAmazonConfigStatus(),
        listConnectedAccountEmployees(0, 50)
      ])
      setConfigStatus(status)
      setEmployees(employeePage.items)
      if (employeePage.items[0]) {
        setSelectedEmployee(`${employeePage.items[0].issuer}\n${employeePage.items[0].employee_id}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取 Amazon 配置状态失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadConfig()
  }, [])

  useEffect(() => {
    if (!attempt || attempt.status !== 'pending') return
    const timer = window.setInterval(async () => {
      try {
        const updated = await getAuthorizationAttempt(attempt.attempt_id)
        setAttempt(updated)
        if (updated.status !== 'pending') setAuthorizationUrl(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : '轮询授权状态失败')
        window.clearInterval(timer)
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [attempt?.attempt_id, attempt?.status])

  const startAuthorization = async () => {
    const separator = selectedEmployee.indexOf('\n')
    if (separator < 1) return
    setAuthorizing(true)
    setError(null)
    try {
      const created = await createAuthorizationAttempt(
        selectedEmployee.slice(0, separator),
        selectedEmployee.slice(separator + 1)
      )
      setAttempt(created)
      setAuthorizationUrl(created.authorization_url || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 Seller 授权失败')
    } finally {
      setAuthorizing(false)
    }
  }

  const openAuthorization = () => {
    if (!authorizationUrl) return
    const url = new URL(authorizationUrl, window.location.origin)
    if (url.origin !== window.location.origin || url.pathname !== '/oauth/amazon/start') {
      setError('授权地址校验失败')
      return
    }
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  if (loading || !configStatus) {
    return (
      <Container>
        <Title>Amazon / LWA 配置与授权向导</Title>
        <InlineAlert type={error ? "danger" : "info"}>
          {error || '正在加载 Amazon 配置与 Employee Registry…'}
        </InlineAlert>
        {error ? <Button variant="secondary" onClick={() => void loadConfig()} type="button">重试</Button> : null}
      </Container>
    )
  }

  return (
    <Container>
      <Header>
        <Title>Amazon / LWA 配置与授权向导</Title>
        <Subtitle>按步骤完成平台服务配置检查与 Amazon Seller 官方 OAuth 授权</Subtitle>
      </Header>

      {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}

      <StepNav>
        <StepItem active={currentStep === 1} completed={currentStep > 1} onClick={() => setCurrentStep(1)} type="button">
          <StepBadge>1</StepBadge>
          <StepLabel>服务配置检查</StepLabel>
        </StepItem>
        <StepDivider />
        <StepItem active={currentStep === 2} completed={currentStep > 2} onClick={() => setCurrentStep(2)} type="button">
          <StepBadge>2</StepBadge>
          <StepLabel>Amazon 后台配置</StepLabel>
        </StepItem>
        <StepDivider />
        <StepItem active={currentStep === 3} completed={attempt?.status === 'completed'} onClick={() => setCurrentStep(3)} type="button">
          <StepBadge>3</StepBadge>
          <StepLabel>Seller 授权</StepLabel>
        </StepItem>
      </StepNav>

      {currentStep === 1 && (
        <Card style={{ padding: '1.5rem' }}>
          <StepTitle>Step 1：基础设施与 LWA 服务配置检查</StepTitle>
          <StepDesc>检查底层存储、Keyring 及 LWA 客户端关键环境变量是否配置就绪。</StepDesc>

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
                {configStatus?.postgres_status === 'ok' ? '连接正常' : '连接异常'}
              </StatusBadge>
            </StatusRow>
            <StatusRow>
              <span>Redis 协同调度服务</span>
              <StatusBadge tone={configStatus?.redis_status === 'ok' ? 'success' : 'danger'}>
                {configStatus?.redis_status === 'ok' ? '连接正常' : '连接异常'}
              </StatusBadge>
            </StatusRow>
            <StatusRow>
              <span>Credential Keyring</span>
              <StatusBadge tone={configStatus?.credential_keyring_status === 'ok' ? 'success' : 'warning'}>
                {configStatus?.credential_keyring_status === 'ok' ? '加载就绪' : '未就绪'}
              </StatusBadge>
            </StatusRow>
          </StatusList>

          <StepActions>
            <Button variant="primary" onClick={() => setCurrentStep(2)} type="button">
              下一步：Amazon 后台配置 →
            </Button>
          </StepActions>
        </Card>
      )}

      {currentStep === 2 && (
        <Card style={{ padding: '1.5rem' }}>
          <StepTitle>Step 2：Amazon 开发者后台配置辅助</StepTitle>
          <StepDesc>请将下方回调地址填写到 Amazon Developer Central 的 App 授权配置中。</StepDesc>

          <FieldGroup>
            <FieldLabel>OAuth Redirect URI (回调地址)</FieldLabel>
            <CopyBox>
              <CodeValue>{configStatus?.oauth_callback_url || '未加载'}</CodeValue>
              {configStatus?.oauth_callback_url ? <CopyButton textToCopy={configStatus.oauth_callback_url} /> : null}
            </CopyBox>
          </FieldGroup>

          <FieldGroup style={{ marginTop: '1rem' }}>
            <FieldLabel>Public Origin (对外基准域名)</FieldLabel>
            <CopyBox>
              <CodeValue>{configStatus?.public_origin || '未加载'}</CodeValue>
            </CopyBox>
          </FieldGroup>

          <ChecklistCard>
            <ChecklistTitle>Seller 授权准备检查清单：</ChecklistTitle>
            <ChecklistItem>✓ 确认 Amazon Developer Central 已填写入上述 Redirect URI</ChecklistItem>
            <ChecklistItem>✓ 确认应用程序已在 Amazon 申请所需要的 SP-API Roles 权限</ChecklistItem>
            <ChecklistItem>✓ 确认 Seller 主账号已登录当前浏览器环境</ChecklistItem>
          </ChecklistCard>

          <StepActions>
            <Button variant="secondary" onClick={() => setCurrentStep(1)} type="button">
              ← 上一步
            </Button>
            <Button variant="primary" onClick={() => setCurrentStep(3)} type="button">
              下一步：Seller 授权 →
            </Button>
          </StepActions>
        </Card>
      )}

      {currentStep === 3 && (
        <Card style={{ padding: '1.5rem' }}>
          <StepTitle>Step 3：发起 Seller 授权</StepTitle>
          <StepDesc>选择已由 ConnectedAccount JWT 注册的 Employee 作为 Grant Owner。workspace、issuer 和 Credential owner 均由后端解析。</StepDesc>

          {employees.length === 0 ? (
            <InlineAlert type="warning">暂无已注册 ConnectedAccount Employee，不能创建 Owner-aware 授权。</InlineAlert>
          ) : (
            <FieldGroup>
              <FieldLabel htmlFor="authorization-employee">Grant Owner Employee</FieldLabel>
              <Select
                id="authorization-employee"
                value={selectedEmployee}
                onChange={(event) => setSelectedEmployee(event.target.value)}
                disabled={authorizing || attempt?.status === 'pending'}
              >
                {employees.map((employee) => (
                  <option
                    key={`${employee.issuer}:${employee.employee_id}`}
                    value={`${employee.issuer}\n${employee.employee_id}`}
                  >
                    {employee.employee_id} · {employee.issuer}
                  </option>
                ))}
              </Select>
            </FieldGroup>
          )}

          {attempt ? (
            <AttemptBox role="status" aria-live="polite">
              <span>Attempt: {attempt.attempt_id}</span>
              <StatusBadge tone={attempt.status === 'completed' ? 'success' : attempt.status === 'pending' ? 'warning' : 'danger'}>
                {attempt.status}
              </StatusBadge>
              {attempt.error_code ? <span>错误码：{attempt.error_code}</span> : null}
              {attempt.account_id ? (
                <Button variant="secondary" onClick={() => { window.location.hash = `#/accounts/${attempt.account_id}` }} type="button">
                  查看 Seller 账号
                </Button>
              ) : null}
            </AttemptBox>
          ) : null}

          <StepActions>
            <Button variant="secondary" onClick={() => setCurrentStep(2)} type="button">
              ← 上一步
            </Button>
            {authorizationUrl && attempt?.status === 'pending' ? (
              <Button variant="primary" onClick={openAuthorization} type="button">
                打开 Amazon 官方授权 ↗
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={authorizing || !selectedEmployee || attempt?.status === 'pending'}
                onClick={startAuthorization}
                type="button"
              >
                {authorizing ? '创建中…' : '创建 Authorization Attempt'}
              </Button>
            )}
          </StepActions>
        </Card>
      )}
    </Container>
  )
}

const Container = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};
`

const Header = styled.div`
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

const StepNav = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
  flex-wrap: wrap;
`

const StepItem = styled.button<{ active: boolean; completed: boolean }>`
  display: flex;
  min-height: 44px;
  border: 0;
  padding: 0;
  background: transparent;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  cursor: pointer;
  opacity: ${({ active, completed }) => (active || completed ? 1 : 0.6)};
`

const StepBadge = styled.span`
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.primary};
  font-weight: 700;
  font-size: ${({ theme }) => theme.typeScale.small};
`

const StepLabel = styled.span`
  font-weight: 650;
  font-size: ${({ theme }) => theme.typeScale.small};
`

const StepDivider = styled.div`
  width: 24px;
  height: 1px;
  background: ${({ theme }) => theme.colors.border};
`

const StepTitle = styled.h2`
  margin: 0 0 ${({ theme }) => theme.space.xs} 0;
  font-size: ${({ theme }) => theme.typeScale.lead};
  color: ${({ theme }) => theme.colors.text};
`

const StepDesc = styled.p`
  margin: 0 0 ${({ theme }) => theme.space.lg} 0;
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

  &:last-child {
    border-bottom: none;
  }
`

const StepActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.space.md};
  margin-top: ${({ theme }) => theme.space.xl};
`

const FieldGroup = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const FieldLabel = styled.label`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
`

const CopyBox = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.surfaceMuted};
`

const CodeValue = styled.code`
  font-family: ${({ theme }) => theme.fonts.numeric};
  font-size: ${({ theme }) => theme.typeScale.small};
  color: ${({ theme }) => theme.colors.text};
`

const ChecklistCard = styled.div`
  margin-top: ${({ theme }) => theme.space.lg};
  padding: ${({ theme }) => theme.space.md};
  border-radius: ${({ theme }) => theme.radii.md};
  background: ${({ theme }) => theme.colors.primarySoft};
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const ChecklistTitle = styled.span`
  font-weight: 700;
  font-size: ${({ theme }) => theme.typeScale.small};
  color: ${({ theme }) => theme.colors.primaryStrong};
`

const ChecklistItem = styled.span`
  font-size: ${({ theme }) => theme.typeScale.small};
  color: ${({ theme }) => theme.colors.text};
`

const Select = styled.select`
  min-height: 44px;
  width: 100%;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
`

const AttemptBox = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.md};
  margin-top: ${({ theme }) => theme.space.lg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: ${({ theme }) => theme.space.md};
  color: ${({ theme }) => theme.colors.textMuted};
  font-family: ${({ theme }) => theme.fonts.numeric};
  font-size: ${({ theme }) => theme.typeScale.small};
`
