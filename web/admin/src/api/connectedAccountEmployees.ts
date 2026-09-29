import { request } from './client'
import type { AccountBinding, ConnectedAccountEmployee } from './types'

export interface ListEmployeesResponse {
  items: ConnectedAccountEmployee[]
  total: number
  offset: number
  limit: number
}

export async function listConnectedAccountEmployees(offset = 0, limit = 50): Promise<ListEmployeesResponse> {
  return request<ListEmployeesResponse>(`/api/v1/admin/connected-account-employees?offset=${offset}&limit=${limit}`)
}

export async function listEmployeeSellerBindings(
  employeeId: string,
  issuer: string
): Promise<AccountBinding[]> {
  return request<AccountBinding[]>(
    `/api/v1/admin/connected-account-employees/${employeeId}/accounts?issuer=${encodeURIComponent(issuer)}`
  )
}

export async function shareEmployeeSeller(
  employeeId: string,
  issuer: string,
  connectionId: string
): Promise<void> {
  await request(`/api/v1/admin/connected-account-employees/${employeeId}/account-bindings`, {
    method: 'POST',
    body: JSON.stringify({ issuer, connection_id: connectionId })
  })
}

export async function unbindEmployeeSeller(
  employeeId: string,
  issuer: string,
  connectionId: string
): Promise<void> {
  await request<void>(
    `/api/v1/admin/connected-account-employees/${employeeId}/account-bindings/${connectionId}?issuer=${encodeURIComponent(issuer)}`,
    { method: 'DELETE' }
  )
}
