import { request } from './client'
import type { AdsAccount, AdsEmployee } from './types'

const base = '/api/v1/admin/providers/amazon-ads'

export function listAdsAccounts(): Promise<{ items: AdsAccount[]; total: number }> {
  return request(`${base}/accounts`)
}

export function getAdsAccount(accountId: string): Promise<AdsAccount> {
  return request(`${base}/accounts/${encodeURIComponent(accountId)}`)
}

export function listAdsEmployees(): Promise<{ items: AdsEmployee[]; total: number }> {
  return request(`${base}/employees`)
}

export async function shareAdsBinding(
  connectionId: string,
  issuer: string,
  employeeId: string
): Promise<void> {
  await request(`${base}/account-bindings`, {
    method: 'POST',
    body: JSON.stringify({ connection_id: connectionId, issuer, employee_id: employeeId })
  })
}

export async function unshareAdsBinding(
  connectionId: string,
  issuer: string,
  employeeId: string
): Promise<void> {
  const query = new URLSearchParams({ issuer, employee_id: employeeId })
  await request(`${base}/account-bindings/${encodeURIComponent(connectionId)}?${query}`, {
    method: 'DELETE'
  })
}

export async function disconnectAdsConnection(connectionId: string): Promise<void> {
  await request(`${base}/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' })
}
