import { request } from './client'
import type { AmazonCapability } from './types'

export interface ListCapabilitiesParams {
  domain?: string
  availability?: string
  region?: string
}

export async function listCapabilities(params: ListCapabilitiesParams = {}): Promise<AmazonCapability[]> {
  const query = new URLSearchParams()
  if (params.domain) query.set('domain', params.domain)
  if (params.availability) query.set('availability', params.availability)
  if (params.region) query.set('region', params.region)

  const queryString = query.toString()
  return request<AmazonCapability[]>(`/api/v1/admin/capabilities${queryString ? `?${queryString}` : ''}`)
}
