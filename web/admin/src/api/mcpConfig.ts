import { request } from './client'
import type { MCPConfigInfo } from './types'

export async function getMCPConfig(): Promise<MCPConfigInfo> {
  return request<MCPConfigInfo>('/api/v1/admin/mcp-config')
}
