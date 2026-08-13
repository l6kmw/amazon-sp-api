import type { ReactNode } from 'react'
import styled from '@emotion/styled'

export type PageID =
  | 'dashboard'
  | 'accounts'
  | 'account-detail'
  | 'capabilities'
  | 'amazon-setup'
  | 'mcp-config'
  | 'connected-account-employees'
  | 'test-agents'
  | 'audit-logs'

function NavIcon({ id }: { id: PageID }) {
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

  switch (id) {
    case 'dashboard':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      )
    case 'accounts':
    case 'account-detail':
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    case 'capabilities':
      return (
        <svg {...common}>
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
      )
    case 'amazon-setup':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
    case 'mcp-config':
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
    case 'connected-account-employees':
    case 'test-agents':
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M19 8v6" />
          <path d="M22 11h-6" />
        </svg>
      )
    case 'audit-logs':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      )
  }
}

function LogoIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

const navItems: Array<{ id: PageID; label: string }> = [
  { id: 'dashboard', label: '首页' },
  { id: 'accounts', label: 'Amazon 连接' },
  { id: 'capabilities', label: 'SP-API 能力' },
  { id: 'amazon-setup', label: 'Amazon 配置' },
  { id: 'mcp-config', label: 'MCP 配置' },
  { id: 'connected-account-employees', label: '数字员工' },
  { id: 'test-agents', label: '测试 Agent' },
  { id: 'audit-logs', label: '审计日志' }
]

export function AppShell({
  children,
  currentPage,
  onNavigate,
  onLogout
}: {
  children: ReactNode
  currentPage: PageID
  onNavigate: (page: PageID) => void
  onLogout?: () => void
}) {
  return (
    <Shell>
      <SkipLink href="#main-content">跳到主内容</SkipLink>
      <AppHeader>
        <HeaderInner>
          <HeaderTop>
            <Brand>
              <LogoMark>
                <LogoIcon />
              </LogoMark>
              <BrandText>
                <strong>Amazon API</strong>
                <span>管理控制台</span>
              </BrandText>
            </Brand>
            {onLogout ? (
              <LogoutButton onClick={onLogout} type="button">
                退出
              </LogoutButton>
            ) : null}
          </HeaderTop>
          <NavList aria-label="主导航">
            {navItems.map((item) => (
              <NavItem
                aria-current={item.id === currentPage || (item.id === 'accounts' && currentPage === 'account-detail') ? 'page' : undefined}
                key={item.id}
                onClick={() => onNavigate(item.id)}
                type="button"
              >
                {item.id === currentPage || (item.id === 'accounts' && currentPage === 'account-detail') ? (
                  <NavItemActive aria-hidden="true">
                    <NavIcon id={item.id} />
                  </NavItemActive>
                ) : (
                  <NavIconWrap aria-hidden="true">
                    <NavIcon id={item.id} />
                  </NavIconWrap>
                )}
                {item.label}
              </NavItem>
            ))}
          </NavList>
        </HeaderInner>
      </AppHeader>

      <MainArea>
        <Main id="main-content">{children}</Main>
      </MainArea>
    </Shell>
  )
}

const Shell = styled.div`
  min-height: 100dvh;
  background: ${({ theme }) => theme.colors.background};
`

const SkipLink = styled.a`
  position: fixed;
  top: ${({ theme }) => theme.space.lg};
  left: ${({ theme }) => theme.space.lg};
  z-index: 10;
  border-radius: ${({ theme }) => theme.radii.md};
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.lg};
  background: ${({ theme }) => theme.colors.primary};
  color: ${({ theme }) => theme.colors.surface};
  transform: translateY(-150%);

  &:focus {
    transform: translateY(0);
  }
`

const AppHeader = styled.header`
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};
  padding: ${({ theme }) => theme.space.lg} clamp(1rem, 3vw, 2rem);
`

const HeaderInner = styled.div`
  display: grid;
  width: min(100%, 1440px);
  margin: 0 auto;
  gap: ${({ theme }) => theme.space.md};
`

const HeaderTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.lg};
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

const NavList = styled.nav`
  display: flex;
  gap: ${({ theme }) => theme.space.sm};
  overflow-x: auto;
  padding-bottom: 1px;
`

const NavItem = styled.button`
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: ${({ theme }) => theme.space.md};
  min-height: 44px;
  border: 0;
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.lg};
  background: transparent;
  color: ${({ theme }) => theme.colors.textMuted};
  font-weight: 650;
  position: relative;
  transition:
    background ${({ theme }) => theme.motion.fast} ${({ theme }) => theme.motion.easeOut},
    color ${({ theme }) => theme.motion.fast} ${({ theme }) => theme.motion.easeOut};

  &::before {
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%) scaleY(0);
    width: 3px;
    height: 60%;
    border-radius: ${({ theme }) => theme.radii.pill};
    background: ${({ theme }) => theme.colors.primary};
    content: '';
    transition: transform ${({ theme }) => theme.motion.base} ${({ theme }) => theme.motion.easeOut};
  }

  &[aria-current='page'] {
    background: ${({ theme }) => theme.colors.primarySoft};
    color: ${({ theme }) => theme.colors.primaryStrong};

    &::before {
      transform: translateY(-50%) scaleY(1);
    }
  }

  &:not([aria-current='page']):hover {
    background: ${({ theme }) => theme.colors.surfaceMuted};
    color: ${({ theme }) => theme.colors.text};
  }
`

const NavIconWrap = styled.span`
  display: grid;
  place-items: center;
  flex-shrink: 0;
  color: ${({ theme }) => theme.colors.textFaint};
  transition: color ${({ theme }) => theme.motion.fast} ${({ theme }) => theme.motion.easeOut};
`

const NavItemActive = styled.span`
  display: grid;
  place-items: center;
  flex-shrink: 0;
  color: ${({ theme }) => theme.colors.primary};
`

const LogoutButton = styled.button`
  min-height: 36px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.pill};
  padding: 0 ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
  white-space: nowrap;
  transition:
    background ${({ theme }) => theme.motion.fast} ${({ theme }) => theme.motion.easeOut},
    color ${({ theme }) => theme.motion.fast} ${({ theme }) => theme.motion.easeOut};

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceMuted};
    color: ${({ theme }) => theme.colors.text};
  }
`

const MainArea = styled.div`
  min-width: 0;
`

const Main = styled.main`
  width: min(100%, 1440px);
  margin: 0 auto;
  padding: clamp(1rem, 3vw, 2rem);
`
