import { request } from './client'
import type { AuthorizationAttempt } from './types'

export async function createAuthorizationAttempt(
  issuer: string,
  employeeId: string
): Promise<AuthorizationAttempt> {
  return request<AuthorizationAttempt>('/api/v1/admin/authorization-attempts', {
    method: 'POST',
    body: JSON.stringify({ issuer, employee_id: employeeId })
  })
}

export async function getAuthorizationAttempt(attemptId: string): Promise<AuthorizationAttempt> {
  return request<AuthorizationAttempt>(`/api/v1/admin/authorization-attempts/${attemptId}`)
}
