import { request } from './client'
import type { SellerAccount, SellerAccountDetail } from './types'

export interface ListAccountsParams {
  status?: string
  query?: string
  page?: number
}

export async function listAccounts(params: ListAccountsParams = {}): Promise<{
  items: SellerAccount[]
  total: number
  page: number
  total_pages: number
}> {
  const query = new URLSearchParams()
  if (params.status) query.set('status', params.status)
  if (params.query) query.set('query', params.query)
  if (params.page) query.set('page', String(params.page))

  const queryString = query.toString()
  const path = `/api/v1/admin/accounts${queryString ? `?${queryString}` : ''}`
  return request(path)
}

export async function getAccountDetail(accountId: string): Promise<SellerAccountDetail> {
  return request<SellerAccountDetail>(`/api/v1/admin/accounts/${accountId}`)
}

export async function refreshAccount(accountId: string): Promise<void> {
  await request(`/api/v1/admin/accounts/${accountId}/refresh`, { method: 'POST' })
}

export async function disconnectConnection(issuer: string, connectionId: string): Promise<void> {
  await request<void>(
    `/api/v1/admin/connections/${connectionId}?issuer=${encodeURIComponent(issuer)}`,
    { method: 'DELETE' }
  )
}
