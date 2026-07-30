export interface RuntimeConfig {
  publicBaseURL: string
  providerName: string
  mcpPath: string
  applicationId?: string
}

declare global {
  interface Window {
    __AMAZON_SP_API_ADMIN_CONFIG__?: Partial<RuntimeConfig>
  }
}

export const config: RuntimeConfig = {
  publicBaseURL: window.__AMAZON_SP_API_ADMIN_CONFIG__?.publicBaseURL || '',
  providerName: window.__AMAZON_SP_API_ADMIN_CONFIG__?.providerName || 'Amazon SP-API',
  mcpPath: window.__AMAZON_SP_API_ADMIN_CONFIG__?.mcpPath || '/mcp/amazon',
  applicationId: window.__AMAZON_SP_API_ADMIN_CONFIG__?.applicationId
}
