import { logToFile } from '../logging/logger.js'

const CACHE_HEADERS = new Set([
  'x-session-id',
  'prompt-cache-key',
  'prompt_cache_key',
  'cache-control',
  'cache_control',
])

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
])

const FORWARDED_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'content-type',
  'user-agent',
  'anthropic-version', 'anthropic-beta',
  'x-opencode-session',
  // Zen free-tier gate (FreeTierError) validates the client session, so the
  // affinity header opencode sends for non-opencode providers must survive.
  'x-session-affinity',
])

// Zen's free tier rejects requests it cannot identify as OpenCode
// ("free tier can only be used from within OpenCode"), so client
// identity headers must pass through instead of being replaced by
// the proxy runtime's own defaults.
const FORWARDED_PREFIXES = ['x-opencode-', 'x-stainless-']

export function isCacheHeader(name: string): boolean {
  return CACHE_HEADERS.has(name.toLowerCase())
}

export function extractCacheHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (isCacheHeader(key) && value !== undefined) {
      result[key] = Array.isArray(value) ? value.join(', ') : String(value)
    }
  }
  return result
}

export function buildUpstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
  bearerToken: string,
  host: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'authorization': `Bearer ${bearerToken}`,
    'x-api-key': bearerToken,
    'host': host,
    'content-type': 'application/json',
  }

  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase()

    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'authorization' || lower === 'host' || lower === 'content-length') continue
    if (lower.startsWith('sec-') || lower.startsWith('cf-')) continue

    if (CACHE_HEADERS.has(lower) || FORWARDED_HEADERS.has(lower) || FORWARDED_PREFIXES.some((p) => lower.startsWith(p))) {
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    }
  }

  return headers
}


export function logCacheMissWarning(keyAlias: string): void {
  logToFile('warn', `Cache miss: failover to "${keyAlias}" — cold start, no cached context`)
}
