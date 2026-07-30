import { useState, useEffect } from 'react'
import { ThemeProvider } from '@emotion/react'
import { theme } from './styles/theme'
import { GlobalStyles } from './styles/global'
import { ErrorBoundary } from './ErrorBoundary'
import { AppShell, type PageID } from './components/AppShell'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { AccountsPage } from './pages/AccountsPage'
import { AccountDetailPage } from './pages/AccountDetailPage'
import { AmazonSetupPage } from './pages/AmazonSetupPage'
import { CapabilitiesPage } from './pages/CapabilitiesPage'
import { MCPConfigPage } from './pages/MCPConfigPage'
import { ConnectedAccountEmployeesPage } from './pages/ConnectedAccountEmployeesPage'
import { TestAgentsPage } from './pages/TestAgentsPage'
import { AuditLogsPage } from './pages/AuditLogsPage'
import { getAdminSession, logoutAdmin } from './api/auth'

function parseHash(hash: string): { page: PageID; accountId?: string } {
  const clean = hash.replace(/^#\/?/, '')
  const parts = clean.split('/')

  if (parts[0] === 'accounts' && parts[1]) {
    return { page: 'account-detail', accountId: parts[1] }
  }

  switch (parts[0]) {
    case 'accounts':
      return { page: 'accounts' }
    case 'capabilities':
      return { page: 'capabilities' }
    case 'amazon-setup':
      return { page: 'amazon-setup' }
    case 'mcp-config':
      return { page: 'mcp-config' }
    case 'connected-account-employees':
      return { page: 'connected-account-employees' }
    case 'test-agents':
      return { page: 'test-agents' }
    case 'audit-logs':
      return { page: 'audit-logs' }
    case 'dashboard':
    default:
      return { page: 'dashboard' }
  }
}

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [route, setRoute] = useState<{ page: PageID; accountId?: string }>(() => parseHash(window.location.hash))

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseHash(window.location.hash))
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    const handleSessionExpired = () => {
      setIsAuthenticated(false)
    }

    window.addEventListener('admin-session-expired', handleSessionExpired)
    return () => window.removeEventListener('admin-session-expired', handleSessionExpired)
  }, [])

  // Check initial admin session status
  useEffect(() => {
    async function checkSession() {
      try {
        const session = await getAdminSession()
        if (session.authenticated) {
          setIsAuthenticated(true)
          return
        }
      } catch {
        // Fallback for offline / unauthenticated states
      }
      setIsAuthenticated(false)
    }

    checkSession()
  }, [])

  const navigate = (page: PageID, param?: string) => {
    if (page === 'account-detail' && param) {
      window.location.hash = `#/accounts/${param}`
    } else if (page === 'dashboard') {
      window.location.hash = '#/'
    } else {
      window.location.hash = `#/${page}`
    }
  }

  const handleLogout = async () => {
    try {
      await logoutAdmin()
    } catch {
      // Ignore
    }
    setIsAuthenticated(false)
  }

  if (isAuthenticated === null) {
    return null // Initial session loading spinner or blank
  }

  if (!isAuthenticated) {
    return (
      <ThemeProvider theme={theme}>
        <GlobalStyles />
        <LoginPage onAuthenticated={() => setIsAuthenticated(true)} />
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider theme={theme}>
      <GlobalStyles />
      <ErrorBoundary>
        <AppShell currentPage={route.page} onNavigate={navigate} onLogout={handleLogout}>
          {route.page === 'dashboard' && <DashboardPage />}
          {route.page === 'accounts' && (
            <AccountsPage onNavigate={(page, accountId) => navigate(page as PageID, accountId)} />
          )}
          {route.page === 'account-detail' && (
            <AccountDetailPage accountId={route.accountId} onBack={() => navigate('accounts')} />
          )}
          {route.page === 'capabilities' && <CapabilitiesPage />}
          {route.page === 'amazon-setup' && <AmazonSetupPage />}
          {route.page === 'mcp-config' && <MCPConfigPage />}
          {route.page === 'connected-account-employees' && <ConnectedAccountEmployeesPage />}
          {route.page === 'test-agents' && <TestAgentsPage />}
          {route.page === 'audit-logs' && <AuditLogsPage />}
        </AppShell>
      </ErrorBoundary>
    </ThemeProvider>
  )
}
