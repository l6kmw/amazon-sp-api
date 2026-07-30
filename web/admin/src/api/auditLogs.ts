import { request } from './client'
import type { AuditLogItem } from './types'

export interface ListAuditLogsParams {
  actor_type?: string
  action?: string
  result?: string
  request_id?: string
  cursor?: string
  limit?: number
}

export interface ListAuditLogsResponse {
  items: AuditLogItem[]
  next_cursor: string | null
}

export async function listAuditLogs(params: ListAuditLogsParams = {}): Promise<ListAuditLogsResponse> {
  const query = new URLSearchParams()
  if (params.actor_type) query.set('actor_type', params.actor_type)
  if (params.action) query.set('action', params.action)
  if (params.result) query.set('result', params.result)
  if (params.request_id) query.set('request_id', params.request_id)
  if (params.cursor) query.set('cursor', params.cursor)
  if (params.limit) query.set('limit', String(params.limit))

  const queryString = query.toString()
  return request<ListAuditLogsResponse>(`/api/v1/admin/audit-logs${queryString ? `?${queryString}` : ''}`)
}
