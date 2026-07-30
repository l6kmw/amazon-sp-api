import { ERROR_MESSAGES, type ApiErrorCode } from './types'

export class ApiError extends Error {
  public readonly code: ApiErrorCode
  public readonly status: number

  constructor(code: ApiErrorCode, status: number, customMessage?: string) {
    super(customMessage || ERROR_MESSAGES[code] || '未知服务错误')
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

let csrfTokenInMemory: string | null = null

export function setCsrfToken(token: string | null) {
  csrfTokenInMemory = token
}

export function getCsrfToken(): string | null {
  return csrfTokenInMemory
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {})

  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  // Attach CSRF Token for mutating requests
  const method = (options.method || 'GET').toUpperCase()
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && csrfTokenInMemory) {
    headers.set('X-CSRF-Token', csrfTokenInMemory)
  }

  try {
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin'
    })

    if (response.status === 401) {
      csrfTokenInMemory = null
      window.dispatchEvent(new CustomEvent('admin-session-expired'))
      throw new ApiError('unauthorized', 401)
    }

    if (!response.ok) {
      let code: ApiErrorCode = 'internal_error'
      try {
        const errorJson = await response.json()
        const serverCode = errorJson.error?.code ?? errorJson.code
        if (serverCode && serverCode in ERROR_MESSAGES) {
          code = serverCode as ApiErrorCode
        }
      } catch {
        // Fallback status code mapping
        if (response.status === 403) code = 'forbidden'
        else if (response.status === 404) code = 'not_found'
        else if (response.status === 409) code = 'conflict'
        else if (response.status === 429) code = 'rate_limited'
      }

      throw new ApiError(code, response.status)
    }

    if (response.status === 204) {
      return {} as T
    }

    return (await response.json()) as T
  } catch (err) {
    if (err instanceof ApiError) {
      throw err
    }
    throw new ApiError('internal_error', 500, err instanceof Error ? err.message : undefined)
  }
}
