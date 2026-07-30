import { request } from './client'
import type { TestAgent } from './types'

export interface CreateAgentPayload {
  agent_id: string
  name: string
  purpose: string
}

export interface GeneratedTokenResult {
  agent: TestAgent
  api_token: string
}

export async function listAgents(): Promise<TestAgent[]> {
  return (await request<{ items: TestAgent[] }>('/api/v1/admin/agents')).items
}

export async function createAgent(payload: CreateAgentPayload): Promise<GeneratedTokenResult> {
  return request<GeneratedTokenResult>('/api/v1/admin/agents', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function updateAgentStatus(id: string, status: 'active' | 'disabled'): Promise<TestAgent> {
  return request<TestAgent>(`/api/v1/admin/agents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  })
}

export async function rotateAgentToken(id: string): Promise<GeneratedTokenResult> {
  return request<GeneratedTokenResult>(`/api/v1/admin/agents/${id}/api-token`, {
    method: 'POST'
  })
}

export async function revokeAgentToken(id: string): Promise<TestAgent> {
  return request<TestAgent>(`/api/v1/admin/agents/${id}/api-token`, {
    method: 'DELETE'
  })
}
