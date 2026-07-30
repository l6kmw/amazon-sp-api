import { request, setCsrfToken } from './client'
import type { AdminSession } from './types'

export async function getAdminSession(): Promise<AdminSession> {
  const session = await request<AdminSession>('/api/v1/admin/session')
  if (session.csrf_token) {
    setCsrfToken(session.csrf_token)
  }
  return session
}

export async function loginAdmin(username: string, password: string): Promise<AdminSession> {
  const session = await request<AdminSession>('/api/v1/admin/session', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  })
  if (session.csrf_token) {
    setCsrfToken(session.csrf_token)
  }
  return session
}

export async function logoutAdmin(): Promise<void> {
  await request<void>('/api/v1/admin/session', {
    method: 'DELETE'
  })
  setCsrfToken(null)
}
