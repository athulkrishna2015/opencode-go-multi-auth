// Verifies the built plugin satisfies the OpenCode v2 plugin contract and that
// its model inventory matches what the host's Zen catalog says.
//
//   bun check-v2-plugin.mjs
//
// Checks the three things the v2 loader actually enforces, plus the one thing
// that silently breaks routing: a model carrying the upstream `package`.

import { readFileSync } from "node:fs"

const RUNTIME_DEFAULTS = new Set(["@opencode/ai/providers/openai", "@opencode/ai/providers/anthropic"])

const mod = await import("./dist/opencode-plugin.js")
const plugin = mod.default

let failed = 0
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed++
}

// 1. The default export must be an object carrying id + setup: that is exactly
//    what V2's schema rejected on the V1 build ("Expected object at default").
check(typeof plugin === "object" && plugin !== null, "default export is an object", `(${typeof plugin})`)
check(typeof plugin?.id === "string" && plugin.id.length > 0, "has a non-empty id", plugin?.id)
check(typeof plugin?.setup === "function", "has a setup function")

// 2. The mirror helpers must emit routable models, not upstream ones.
const { buildMirrorModels, mirrorProviderInfo } = await import("./dist/plugin/zen-mirror.js")
const info = mirrorProviderInfo(18905)
check(info.package === "aisdk:@ai-sdk/openai-compatible", "provider package is the local proxy SDK", info.package)
check(String(info.settings?.baseURL).includes("localhost"), "baseURL points at the local proxy", info.settings?.baseURL)

const { Model, Provider } = await import("@opencode/plugin")
const catalog = new Map([
  [
    "probe-reasoner",
    {
      ...Model.Info.default(Provider.ID.make("opencode"), Model.ID.make("probe-reasoner")),
      name: "Probe Reasoner",
      package: "@opencode/ai/providers/openai",
      settings: { provider: "opencode" },
      variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
      limit: { context: 1050000, output: 128000 },
      cost: [{ input: 2, output: 10, cache: { read: 0, write: 0 } }],
    },
  ],
  [
    "probe-retired",
    { ...Model.Info.default(Provider.ID.make("opencode"), Model.ID.make("probe-retired")), status: "deprecated" },
  ],
])

const models = buildMirrorModels(["probe-reasoner", "probe-retired", "probe-unknown"], catalog)
const byId = new Map(models.map((m) => [m.modelID, m]))

check(models.length === 2, "deprecated model dropped, unknown kept", `${models.length} models`)

const reasoner = byId.get("probe-reasoner")
check(reasoner?.limit?.context === 1050000, "keeps the catalog context limit", String(reasoner?.limit?.context))
check(reasoner?.cost?.length === 1, "keeps catalog cost", JSON.stringify(reasoner?.cost?.[0]))
check(reasoner?.variants?.[0]?.settings?.reasoningEffort === "high", "keeps the model-specific variant shape")
check(reasoner?.package !== "@opencode/ai/providers/openai", "upstream package stripped", String(reasoner?.package))
check(reasoner?.settings?.provider !== "opencode", "upstream settings stripped", JSON.stringify(reasoner?.settings))
check(reasoner?.providerID === "multi-auth-zen", "repointed at the mirror provider", String(reasoner?.providerID))

const unknown = byId.get("probe-unknown")
check(unknown?.capabilities?.input?.includes("image") === true, "unknown model fails open to multimodal")

// 3. The V1 named exports are gone: they were the shape V2 rejects.
check(mod.server === undefined, "V1 `server` export removed")
check(mod.pluginModule === undefined, "V1 `pluginModule` export removed")

console.log(failed === 0 ? "\nOK" : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
