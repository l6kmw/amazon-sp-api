import { useState, type FormEvent } from 'react'
import styled from '@emotion/styled'
import { Card } from '../components/Card'
import { Button } from '../components/Button'
import { InlineAlert } from '../components/InlineAlert'
import { loginAdmin } from '../api/auth'
import type { AdminSession } from '../api/types'

type LoginPageProps = {
  session: AdminSession
  onAuthenticated: (session: AdminSession) => void
}

const iconAttrs = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

function LogoIcon() {
  return (
    <svg {...iconAttrs} width="22" height="22">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg {...iconAttrs} width="18" height="18">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}

export function LoginPage({ session, onAuthenticated }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setError('')
    setSubmitting(true)

    try {
      const session = await loginAdmin(username, password)
      if (session.authenticated) {
        onAuthenticated(session)
        return
      }
      setError('登录凭据无效，请确认管理员账号密码后重试。')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '登录服务暂时不可用，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Shell>
      <LoginPanel>
        <Brand>
          <LogoMark>
            <LogoIcon />
          </LogoMark>
          <BrandText>
            <strong>Amazon SP-API</strong>
            <span>管理控制台</span>
          </BrandText>
        </Brand>

        <CopyBlock>
          <SecurityBadge>
            <ShieldIcon />
            {session.oa_login_enabled ? '统一 OA 身份' : '仅管理员访问'}
          </SecurityBadge>
          <Title>登录控制台</Title>
          <Description>
            {session.oa_login_enabled
              ? '使用统一 OA 管理员身份登录。'
              : '请输入平台管理员凭据，管理 Amazon Seller 账号与 MCP 配置。'}
          </Description>
        </CopyBlock>

        {error ? (
          <InlineAlert type="danger">{error}</InlineAlert>
        ) : null}

        {session.oa_login_enabled && session.oa_login_url ? (
          <Button
            variant="primary"
            type="button"
            onClick={() => window.location.assign(session.oa_login_url!)}
            style={{ width: '100%' }}
          >
            使用统一 OA 登录
          </Button>
        ) : null}

        {session.login_enabled !== false ? <Form onSubmit={handleSubmit}>
          <Field>
            <Label htmlFor="admin-username">账号</Label>
            <Input
              id="admin-username"
              type="text"
              autoComplete="username"
              disabled={submitting}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入管理员账号"
            />
          </Field>

          <Field>
            <Label htmlFor="admin-password">密码</Label>
            <Input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              disabled={submitting}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
            />
          </Field>

          <Button
            variant="primary"
            type="submit"
            disabled={submitting || !username.trim() || !password}
            style={{ width: '100%' }}
          >
            {submitting ? '登录中…' : '登录控制台'}
          </Button>
        </Form> : null}
      </LoginPanel>
    </Shell>
  )
}

const Shell = styled.main`
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: clamp(1rem, 4vw, 3rem);
  background:
    linear-gradient(135deg, ${({ theme }) => theme.colors.primarySoft}, transparent 38%),
    ${({ theme }) => theme.colors.background};
`

const LoginPanel = styled(Card)`
  width: min(100%, 440px);
  display: grid;
  gap: ${({ theme }) => theme.space.xl};
  padding: clamp(1.25rem, 4vw, 2rem);
`

const Brand = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
`

const LogoMark = styled.div`
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: ${({ theme }) => theme.radii.md};
  background: ${({ theme }) => theme.colors.primary};
  color: ${({ theme }) => theme.colors.surface};
  flex-shrink: 0;
`

const BrandText = styled.div`
  display: grid;
  line-height: 1.25;

  strong {
    font-size: ${({ theme }) => theme.typeScale.small};
  }

  span {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: ${({ theme }) => theme.typeScale.caption};
  }
`

const CopyBlock = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.sm};
`

const SecurityBadge = styled.div`
  width: fit-content;
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  border-radius: ${({ theme }) => theme.radii.pill};
  background: ${({ theme }) => theme.colors.successSoft};
  color: ${({ theme }) => theme.colors.primaryStrong};
  font-size: ${({ theme }) => theme.typeScale.caption};
  font-weight: 700;
  padding: ${({ theme }) => theme.space.xs} ${({ theme }) => theme.space.md};
`

const Title = styled.h1`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.section};
  line-height: 1.2;
`

const Description = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const Form = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
`

const Field = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.sm};
`

const Label = styled.label`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
`

const Input = styled.input`
  width: 100%;
  min-height: 44px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  padding: 0 ${({ theme }) => theme.space.md};

  &:focus {
    border-color: ${({ theme }) => theme.colors.primary};
    box-shadow: 0 0 0 3px ${({ theme }) => theme.colors.primarySoft};
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }
`
