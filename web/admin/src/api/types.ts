/**
 * Amazon SP-API Admin Console DTO & Type Definitions (Phase F0)
 */

export interface AdminSession {
  authenticated: boolean
  auth_enabled?: boolean
  login_enabled?: boolean
  oa_login_enabled?: boolean
  oa_login_url?: string
  auth_method?: 'oa'
  username?: string
  role?: 'admin'
  csrf_token?: string
}

export interface DashboardStats {
  total_accounts: number
  active_accounts: number
  active_bindings: number
  active_test_agents: number
  credential_status_counts: Record<string, number>
  recent_errors_count: number
}

export type CredentialStatus = 'active' | 'pending' | 'refresh_failed' | 'revoked' | 'disconnected' | 'error' | 'unknown'

export interface SellerAccount {
  account_id: string
  selling_partner_id_masked: string
  display_name: string
  region: string
  marketplaces: string[]
  status: CredentialStatus
  credential_status: CredentialStatus
  credential_revision: number
  active_bindings_count: number
  last_synced_at: string | null
}

export interface AccountBinding {
  connection_id: string
  employee_id: string
  issuer: string
  remark?: string
  bound_at: string
  unbound_at?: string | null
  status: 'active' | 'unbound'
}

export interface SellerAccountDetail extends SellerAccount {
  bindings: AccountBinding[]
  credential_info: {
    key_id: string
    revision: number
    last_refreshed_at: string | null
  }
  last_attempt_status?: string | null
  last_attempt_error?: string | null
}

export interface AdsAccountBinding {
  connection_id: string
  issuer: string
  employee_id: string
  status: 'active' | 'unbound'
  remark: string | null
  bound_at: string
  updated_at: string
  is_owner: boolean
}

export interface AdsAccount {
  provider_key: 'amazon-ads'
  account_id: string
  connection_id: string
  external_account_id: string
  display_name: string
  status: 'active' | 'disconnected' | 'profile_missing'
  owner_issuer: string
  owner_employee_id: string
  active_bindings_count: number
  updated_at: string
  region?: 'na' | 'eu' | 'fe'
  country_code?: string
  currency_code?: string
  account_type?: string
  marketplace_id?: string
  bindings: AdsAccountBinding[]
}

export interface AdsEmployee {
  issuer: string
  employee_id: string
  first_seen_at: string
  last_seen_at: string
  active_bindings_count: number
  total_bindings_count: number
}

export interface AuthorizationAttempt {
  attempt_id: string
  status: 'pending' | 'completed' | 'failed' | 'expired'
  authorization_url?: string
  account_id?: string
  created_at: string
  expires_at: string
  error_code?: string
}

export interface AmazonCapability {
  tool_name: string
  title: string
  description: string
  domain: string
  action: string
  amazon_role: string
  supported_regions: string[]
  availability: 'unknown' | 'available' | 'permission_required'
  is_readonly: boolean
  restriction_notes?: string
}

export interface AmazonConfigStatus {
  lwa_client_id_configured: boolean
  lwa_client_secret_configured: boolean
  application_id_configured: boolean
  public_origin: string
  oauth_callback_url: string
  postgres_status: 'ok' | 'error'
  redis_status: 'ok' | 'error'
  credential_keyring_status: 'ok' | 'error'
  connected_account_keyring_status: 'ok' | 'error'
}

export interface MCPConfigInfo {
  endpoint: string
  transport: string
  header_name: string
  health_status: 'ok' | 'degraded' | 'down'
  registered_tools_count: number
  tools: Array<{
    name: string
    description: string
  }>
}

export interface ConnectedAccountEmployee {
  employee_id: string
  issuer: string
  first_seen_at: string
  last_seen_at: string
  active_bindings_count: number
  total_bindings_count: number
}

export interface TestAgent {
  id: string
  agent_id: string
  name: string
  purpose: string
  status: 'active' | 'disabled'
  api_token_configured: boolean
  api_token_hint: string
  api_token_created_at: string | null
  created_at: string
  updated_at: string
  last_used_at: string | null
}

export interface AuditLogItem {
  id: string
  tenant_id: string
  actor_type: 'browser_session' | 'agent_token' | 'employee_jwt' | 'system'
  actor_id: string
  agent_record_id: string | null
  action: string
  resource_type: string
  resource_id: string
  result: 'success' | 'denied' | 'failed'
  error_code: string | null
  request_id: string | null
  created_at: string
}

export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'upstream_error'
  | 'amazon_role_required'
  | 'account_not_found_or_forbidden'
  | 'authorization_expired'
  | 'internal_error'

export const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  invalid_request: '请求参数不完整，请检查输入',
  unauthorized: '登录已失效，请重新登录',
  forbidden: '当前身份不能执行此操作',
  not_found: '资源不存在或无权访问',
  conflict: '当前状态已变化，请刷新后重试',
  rate_limited: '操作过于频繁，请稍后重试',
  upstream_error: 'Amazon 服务暂时不可用，请稍后重试',
  amazon_role_required: 'Seller 授权缺少所需 Amazon Role',
  account_not_found_or_forbidden: '账号不存在或当前身份无权访问',
  authorization_expired: '授权链接已过期，请重新发起',
  internal_error: '服务暂时异常，请稍后重试'
}

/**
 * Security Denylist - Front-end must never store or transmit these field keys
 */
export const SECURITY_DENYLIST_KEYS = [
  'refresh_token',
  'access_token',
  'client_secret',
  'jwt_secret',
  'credential_key',
  'postgres_url',
  'redis_url',
  'oauth_code',
  'oauth_state'
] as const
