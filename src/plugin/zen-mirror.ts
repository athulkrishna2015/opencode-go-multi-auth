import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/plugin'
import { logToFile } from '../logging/logger.js'

export const MIRROR_PROVIDER_ID = 'multi-auth-zen'
const PROXY_NPM = '@ai-sdk/openai-compatible'
// Placeholder credential: the proxy pools its own keys and overwrites
// incoming auth, so this value never leaves the machine as auth.
const POOL_API_KEY = 'multi-auth-pool'
const FULL_INPUT = ['text', 'image', 'video', 'pdf', 'audio']

interface BundleModel {
  id?: string
  name?: string
  status?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; input?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  reasoning_options?: Array<{ type?: string; values?: Array<string | null> }>
}

function bundlePath(): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  return path.join(cache, 'opencode', 'models.json')
}

function readOfficialModels(): Record<string, BundleModel> {
  try {
    const raw = fs.readFileSync(bundlePath(), 'utf8')
    const bundle = JSON.parse(raw) as Record<string, { models?: Record<string, BundleModel> }>
    return bundle.opencode?.models ?? {}
  } catch (err) {
    logToFile('warn', 'Zen mirror: official models bundle unreadable, new models get defaults.', {
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

/**
 * In-memory only: guarantees the mirror provider block exists with the
 * proxy wiring. Never touches the user's file.
 */
export function ensureMirrorProvider(input: Config, proxyPort: number): void {
  const root = input as unknown as { provider?: Record<string, Record<string, unknown>> }
  const providers = (root.provider ??= {})
  const block = ((providers[MIRROR_PROVIDER_ID] ??= {}) as Record<string, unknown>)
  block.npm ??= PROXY_NPM
  block.name ??= 'OpenCode Zen (multi-auth)'
  const options = ((block.options ??= {}) as Record<string, unknown>)
  options.baseURL ??= `http://localhost:${proxyPort}/zen`
  options.apiKey ??= POOL_API_KEY
}

// Effort values become selectable variants. Bodies stay minimal
// ({reasoningEffort}) because the mirror speaks openai-compatible: the
// Responses-only extras the official @ai-sdk/openai entries carry
// (reasoningSummary/include) have no chat/completions equivalent.
function variantsFrom(model: BundleModel): Record<string, Record<string, unknown>> | undefined {
  const effort = (model.reasoning_options ?? []).find((o) => o.type === 'effort')
  const values = effort?.values ?? []
  const out: Record<string, Record<string, unknown>> = {}
  for (const v of values) {
    const name = v === null ? 'none' : v
    if (typeof name === 'string' && name) out[name] = { reasoningEffort: name }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function toConfigModel(model: BundleModel): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    modalities: {
      input: model.modalities?.input ?? [...FULL_INPUT],
      output: model.modalities?.output ?? ['text'],
    },
  }
  if (model.name) entry.name = model.name
  const variants = variantsFrom(model)
  if (variants) entry.variants = variants
  if (model.limit) entry.limit = model.limit
  if (model.cost) {
    entry.cost = {
      input: model.cost.input ?? 0,
      output: model.cost.output ?? 0,
      cache_read: model.cost.cache_read ?? 0,
      cache_write: model.cost.cache_write ?? 0,
    }
  }
  return entry
}

// A model the live upstream serves but the official bundle does not know
// yet: include it fail-open with full input modalities (the Zen catalog is
// multimodal; text-only default would wall off images) and no variants.
function toDefaultConfigModel(id: string): Record<string, unknown> {
  return {
    modalities: { input: [...FULL_INPUT], output: ['text'] },
  }
}

async function fetchLiveIds(proxyPort: number): Promise<string[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/zen/v1/models`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
  } catch (err) {
    logToFile('warn', 'Zen mirror: live catalog unreachable, serving official list only.', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Rebuilds the mirror provider's models map from the official `opencode`
 * catalog (modalities, effort variants, limits, costs) intersected with the
 * live Zen catalog served through the proxy. New upstream models are added
 * automatically; deprecated / vanished ones drop out. Runs once per
 * opencode start via the plugin config hook, so no manual opencode.json
 * edits are ever needed.
 */
export async function syncMirrorModels(input: Config, proxyPort: number): Promise<void> {
  const root = input as unknown as { provider?: Record<string, Record<string, unknown>> }
  const block = ((root.provider ??= {})[MIRROR_PROVIDER_ID] ??= {}) as Record<string, unknown>

  const official = readOfficialModels()
  const live = await fetchLiveIds(proxyPort)

  const models: Record<string, Record<string, unknown>> = {}
  if (live === null) {
    for (const [id, model] of Object.entries(official)) {
      if (model.status === 'deprecated') continue
      models[id] = toConfigModel(model)
    }
  } else {
    const liveSet = new Set(live)
    for (const [id, model] of Object.entries(official)) {
      if (model.status === 'deprecated') continue
      if (!liveSet.has(id)) continue
      models[id] = toConfigModel(model)
    }
    const known = new Set(Object.keys(official))
    for (const id of live) {
      if (known.has(id)) continue
      logToFile('info', `Zen mirror: new upstream model "${id}" auto-added with default metadata.`)
      models[id] = toDefaultConfigModel(id)
    }
  }
  block.models = models
  logToFile('info', `Zen mirror: provider "${MIRROR_PROVIDER_ID}" synced with ${Object.keys(models).length} models.`)
}
