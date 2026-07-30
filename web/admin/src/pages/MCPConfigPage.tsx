import { useEffect, useMemo, useState } from 'react'
import styled from '@emotion/styled'
import { getMCPConfig } from '../api/mcpConfig'
import type { MCPConfigInfo } from '../api/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { StatusBadge } from '../components/StatusBadge'
import { InlineAlert } from '../components/InlineAlert'
import { CopyButton } from '../components/CopyButton'
import { config } from '../config'

export function MCPConfigPage() {
  const [configInfo, setConfigInfo] = useState<MCPConfigInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadMCPConfig = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getMCPConfig()
      setConfigInfo(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取 MCP 连接配置失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMCPConfig()
  }, [])

  const fullEndpointURL = new URL(configInfo?.endpoint || config.mcpPath, window.location.origin).toString()
  const healthURL = new URL('/healthz/amazon-mcp', fullEndpointURL).toString()

  const testAgentJSONTemplate = useMemo(() => {
    return JSON.stringify(
      {
        mcpServers: {
          'amazon-sp-api-test-agent': {
            transport: 'streamable-http',
            url: fullEndpointURL,
            headers: {
              Authorization: 'Bearer <OAT_TOKEN>'
            }
          }
        }
      },
      null,
      2
    )
  }, [fullEndpointURL])

  const employeeJSONTemplate = useMemo(() => {
    return JSON.stringify(
      {
        mcpServers: {
          'amazon-sp-api-connected-account-employee': {
            transport: 'streamable-http',
            url: fullEndpointURL,
            headers: {
              Authorization: 'Bearer <EMPLOYEE_JWT>'
            }
          }
        }
      },
      null,
      2
    )
  }, [fullEndpointURL])

  if (loading || !configInfo) {
    return (
      <Container>
        <Title>MCP 连接配置</Title>
        <InlineAlert type={error ? "danger" : "info"}>
          {error || '正在加载 MCP Endpoint 与双凭据配置…'}
        </InlineAlert>
        {error ? <Button variant="secondary" onClick={() => void loadMCPConfig()} type="button">重试</Button> : null}
      </Container>
    )
  }

  return (
    <Container>
      <Header>
        <HeaderLeft>
          <Title>MCP 连接配置 (MCP Connection Config)</Title>
          <Subtitle>获取 Streamable HTTP MCP 协议 Endpoint、Headers 规范与双凭据配置模版</Subtitle>
        </HeaderLeft>
        <StatusBadge tone={configInfo?.health_status === 'ok' ? 'success' : 'warning'}>
          {configInfo?.health_status === 'ok' ? '服务正常运行中' : '健康检查警告'}
        </StatusBadge>
      </Header>

      {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}

      <HeroCard>
        <HeroContent>
          <HeroLabel>MCP Endpoint (Streamable HTTP)</HeroLabel>
          <EndpointURL>{fullEndpointURL}</EndpointURL>
        </HeroContent>
        <HeroActions>
          <CopyButton textToCopy={fullEndpointURL} label="复制 Endpoint URL" />
          <Button variant="secondary" onClick={() => window.open(healthURL, '_blank', 'noopener,noreferrer')} type="button">
            健康检查 ↗
          </Button>
        </HeroActions>
      </HeroCard>

      <Grid>
        <Panel>
          <PanelTitle>双凭据规范说明</PanelTitle>

          <NoticeBox>
            <NoticeItem>
              <strong>1. Test Agent 凭据 (oat_* Token)</strong>
              <span>专用于平台的测试 Agent 诊断与连通性测试。凭据类型为 <code>test_agent_token</code>，可在控制台中随时生成、轮换与撤销。</span>
            </NoticeItem>

            <NoticeItem>
              <strong>2. ConnectedAccount Employee 凭据 (Employee JWT)</strong>
              <span>专用于生产环境数字员工调用。由 ConnectedAccount 运行时短期动态签发，凭据类型为 <code>employee_jwt</code>，用于按数字员工做隔离鉴权。</span>
            </NoticeItem>

            <NoticeItem>
              <strong>3. 安全隔离保障</strong>
              <span>以上两类凭据均不能用于登录管理控制台；管理控制台永不从服务端获取已有 Token 明文。</span>
            </NoticeItem>
          </NoticeBox>
        </Panel>

        <Panel>
          <PanelTitle>协议与 Header 规范</PanelTitle>
          <SpecList>
            <SpecRow>
              <SpecKey>Transport 方式</SpecKey>
              <SpecVal>Streamable HTTP</SpecVal>
            </SpecRow>
            <SpecRow>
              <SpecKey>Header 名称</SpecKey>
              <SpecVal>Authorization</SpecVal>
            </SpecRow>
            <SpecRow>
              <SpecKey>Header 格式</SpecKey>
              <SpecVal>Bearer &lt;TOKEN&gt;</SpecVal>
            </SpecRow>
            <SpecRow>
              <SpecKey>已注册工具数量</SpecKey>
              <SpecVal>{configInfo?.registered_tools_count ?? 0} 个 MCP Tools</SpecVal>
            </SpecRow>
          </SpecList>
        </Panel>
      </Grid>

      <CodePanel>
        <CodePanelHeader>
          <PanelTitle>JSON 配置模版 (Test Agent 示例)</PanelTitle>
          <CopyButton textToCopy={testAgentJSONTemplate} label="复制 Test Agent JSON" />
        </CodePanelHeader>
        <CodeBlock>{testAgentJSONTemplate}</CodeBlock>
      </CodePanel>

      <CodePanel>
        <CodePanelHeader>
          <PanelTitle>JSON 配置模版 (ConnectedAccount Employee 示例)</PanelTitle>
          <CopyButton textToCopy={employeeJSONTemplate} label="复制 Employee JSON" />
        </CodePanelHeader>
        <CodeBlock>{employeeJSONTemplate}</CodeBlock>
      </CodePanel>
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

const HeroCard = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.xl};
  background: linear-gradient(135deg, ${({ theme }) => theme.colors.primarySoft}, ${({ theme }) => theme.colors.surface});
  flex-wrap: wrap;
`

const HeroContent = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const HeroLabel = styled.span`
  color: ${({ theme }) => theme.colors.primaryStrong};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 700;
`

const EndpointURL = styled.code`
  font-family: ${({ theme }) => theme.fonts.numeric};
  font-size: ${({ theme }) => theme.typeScale.lead};
  color: ${({ theme }) => theme.colors.text};
  word-break: break-all;
`

const HeroActions = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
`

const Grid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};

  @media (min-width: 960px) {
    grid-template-columns: 1fr 1fr;
  }
`

const Panel = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
`

const PanelTitle = styled.h2`
  margin: 0;
  font-size: ${({ theme }) => theme.typeScale.lead};
  color: ${({ theme }) => theme.colors.text};
`

const NoticeBox = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.md};
`

const NoticeItem = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
  font-size: ${({ theme }) => theme.typeScale.small};
  color: ${({ theme }) => theme.colors.textMuted};

  strong {
    color: ${({ theme }) => theme.colors.text};
  }

  code {
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const SpecList = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.md};
`

const SpecRow = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: ${({ theme }) => theme.typeScale.small};
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};
  padding-bottom: ${({ theme }) => theme.space.xs};

  &:last-child {
    border-bottom: none;
  }
`

const SpecKey = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
`

const SpecVal = styled.span`
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const CodePanel = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: grid;
  gap: ${({ theme }) => theme.space.md};
`

const CodePanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`

const CodeBlock = styled.pre`
  margin: 0;
  overflow-x: auto;
  border-radius: ${({ theme }) => theme.radii.md};
  padding: ${({ theme }) => theme.space.xl};
  background: oklch(25% 0.02 75);
  color: oklch(96% 0.01 75);
  font-size: ${({ theme }) => theme.typeScale.small};
  line-height: 1.6;
`
