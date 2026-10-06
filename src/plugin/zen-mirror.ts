import { Model, Provider } from '@opencode/plugin'
import { logToFile } from '../logging/logger.js'

export const MIRROR_PROVIDER_ID = 'multi-auth-zen'
export const PROXY_NPM = '@ai-sdk/openai-compatible'
// Placeholder credential: the proxy pools its own keys and overwrites incoming
// auth, so this value never leaves the machine as auth.
const POOL_API_KEY = 'multi-auth-pool'
const FULL_INPUT = ['text', 'image', 'video', 'pdf', 'audio']

/**
 * Identity and routing fields. Everything else on a catalog entry describes the
 * model and is safe to carry across. The routing four matter: official Zen
 * entries carry `package: "@opencode/ai/providers/openai"` and
 * `settings: { provider: "opencode" }` per model, and reusing those would send
 * the model to the real upstream instead of the local proxy.
 */
const ROUTING = new Set(['id', 'modelID', 'providerID', 'package', 'settings', 'headers', 'body'])

/** The mirror provider: the proxy's pooled Zen endpoint. */
export function mirrorProviderInfo(proxyPort: number): Provider.Info {
  const id = Provider.ID.make(MIRROR_PROVIDER_ID)
  return {
    ...Provider.Info.empty(id),
    name: 'OpenCode Zen (multi-auth)',
    activation: 'enabled',
    package: `aisdk:${PROXY_NPM}`,
    settings: { baseURL: `http://localhost:${proxyPort}/zen`, apiKey: POOL_API_KEY },
  } as Provider.Info
}

/**
 * Build the mirror's model inventory.
 *
 * Metadata comes from the official catalog the host already holds, which is
 * read through the provider transform rather than re-derived from
 * ~/.cache/opencode/models.json. That bundle is models.dev's raw V1 shape, so
 * using it means rebuilding capabilities, cost tiers and effort variants by
 * hand — and getting them subtly wrong, because the effort parameter differs per
 * model family (Claude wants `thinking.effort`, GPT `reasoningEffort`, Gemini
 * `thinkingConfig`). Cloning the host's entries carries the right shape for
 * every model, and a model the catalog has retired drops out of the mirror.
 *
 * A model the live proxy serves that the catalog does not know yet is included
 * fail-open with full input modalities: Zen is multimodal, and a text-only
 * default would wall off images.
 */
export function buildMirrorModels(
  liveIds: readonly string[],
  catalog: ReadonlyMap<string, Model.Info> | undefined,
): Model.Info[] {
  const providerID = Provider.ID.make(MIRROR_PROVIDER_ID)
  const models: Model.Info[] = []

  for (const modelID of liveIds) {
    if (/(?:^|-)free$/i.test(modelID)) {
      logToFile('info', `Zen mirror: "${modelID}" requires the native OpenCode session, dropping it from the pooled provider.`)
      continue
    }

    const source = catalog?.get(modelID)

    if (source?.status === 'deprecated') {
      logToFile('info', `Zen mirror: "${modelID}" is deprecated upstream, dropping it.`)
      continue
    }

    if (source) {
      const base = Model.Info.default(providerID, Model.ID.make(modelID))
      const described: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(source)) {
        if (!ROUTING.has(key) && value !== undefined) described[key] = value
      }
      models.push({ ...base, ...described, id: base.id, modelID: base.modelID, providerID: base.providerID } as Model.Info)
      continue
    }

    logToFile('info', `Zen mirror: new upstream model "${modelID}" auto-added with default metadata.`)
    const base = Model.Info.default(providerID, Model.ID.make(modelID))
    models.push({ ...base, capabilities: { ...base.capabilities, input: [...FULL_INPUT] } } as Model.Info)
  }

  return models
}

/**
 * Ids the proxy is currently serving. Returns null when the proxy is
 * unreachable so the caller can keep the previous list rather than emptying
 * the model picker.
 */
export async function fetchLiveIds(proxyPort: number): Promise<string[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/zen/v1/models`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
    if (!ids.length) throw new Error('returned no usable models')
    return [...new Set(ids)]
  } catch (err) {
    logToFile('warn', 'Zen mirror: live catalog unreachable, keeping the previous list.', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
