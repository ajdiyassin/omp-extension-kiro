# omp-provider-kiro

OMP-native provider extension for the [Kiro](https://kiro.dev) API. Models and capabilities are discovered live from Kiro's `ListAvailableModels` endpoint, including Claude adaptive thinking and GPT reasoning controls when advertised by each model's schema.

Fork of [mikeyobrien/pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro), converted to a self-contained OMP extension with no runtime dependency on `@earendil-works/*` or OMP TUI internals.

## Requirements

- **OMP** ≥ 17.0.9
- **Kiro CLI** (recommended for credential reuse) — [install guide](https://kiro.dev/docs/cli/)

## Install

```powershell
omp plugin install github:ajdiyassin/omp-extension-kiro
```

The extension is self-contained: `dist/index.js` is committed and has no runtime dependencies beyond Node builtins.

### Verify

```powershell
omp --list-models 2>&1 | Select-String -Pattern "kiro|Failed to load extension"
```

### Update or uninstall

```powershell
omp plugin install github:ajdiyassin/omp-extension-kiro
omp plugin uninstall omp-provider-kiro
```

Installation enables the plugin automatically. Toggle it manually with:

```powershell
omp plugin enable omp-provider-kiro
omp plugin disable omp-provider-kiro
```

### Development install

```powershell
bun install
bun run build
omp plugin install .
```

## Authentication

### Recommended: Kiro CLI credential reuse

If Kiro CLI is installed and logged in, the extension reuses its valid local bearer for discovery and streaming; no separate `/login` is required.

```powershell
kiro-cli whoami
omp
```

### API key

Set `KIRO_API_KEY` to use paid-tier API-key authentication. API keys do not require a profile ARN and default to `us-east-1`; override routing with `KIRO_API_REGION` when needed.

```powershell
$env:KIRO_API_KEY = "<your-key>"
omp
```

### Manual OAuth login

```text
/login kiro
```

Prompt: `Paste IAM Identity Center URL, or blank for Builder ID`

- Blank → AWS Builder ID device-code flow
- URL → IAM Identity Center with auto-region detection
- Google/GitHub → delegated to Kiro CLI social login

## Dynamic models

Use `/model` and select the `kiro` provider. Kiro's `auto` model is normally the default entry:

```text
/model kiro/auto
```

The extension does not maintain a model allowlist. It asks Kiro for the models available to the current credential/profile and preserves the returned IDs exactly. Examples from the sanitized Kiro CLI 2.13.1 fixture include:

```text
kiro/claude-sonnet-5
kiro/claude-opus-4.8
kiro/gpt-5.6-sol
kiro/deepseek-3.2
kiro/auto
```

This is important for IDs such as `gpt-5.6-sol`: numeric dots are not rewritten. A small explicit alias map remains only for selectors emitted by older extension releases, such as `claude-opus-4-8` → `claude-opus-4.8`.

OMP owns the discovery lifecycle:

- 15-second extension discovery timeout
- 24-hour SQLite model cache
- Background startup refresh
- Provider refresh from `/model`
- Cached-catalog retention when a refresh fails

A first discovery requires `KIRO_API_KEY`, a valid Kiro CLI session, or credentials saved by `/login kiro`.

## Reasoning and adaptive thinking

Reasoning controls are derived from each live `additionalModelRequestFieldsSchema`, not from model IDs. Schema-less models receive no configurable reasoning fields; this does not claim that they cannot reason internally.

### Claude adaptive thinking

For models advertising Anthropic adaptive thinking, requests use:

```json
{
  "thinking": { "type": "adaptive", "display": "summarized" },
  "output_config": { "effort": "high" },
  "max_tokens": 128000
}
```

Supported effort tiers and defaults come from Kiro's live schema. The 2.13.1 fixture reports:

| Model | Efforts | Kiro default | Combined `max_tokens` cap |
|---|---|---:|---:|
| Claude Sonnet 5 | low, medium, high, xhigh, max | high | 128,000 |
| Claude Opus 4.8 | low, medium, high, xhigh, max | high | 128,000 |
| Claude Opus 4.7 | low, medium, high, xhigh, max | xhigh | 128,000 |
| Claude Opus 4.6 | low, medium, high, max | high | 64,000 |
| Claude Sonnet 4.6 | low, medium, high, max | high | 64,000 |

OMP `minimal` maps to the lowest advertised Claude tier. If OMP requests an unsupported intermediate tier, it clamps upward to the next supported tier (`xhigh` → `max` on a four-tier model).

`max_tokens` is one hard ceiling for **internal thinking plus visible text/tool-call output**. It is not a separate thinking budget. For Sonnet 5, Kiro's generic catalog simultaneously reports `tokenLimits.maxOutputTokens: 64000` while its model-specific adaptive schema accepts `max_tokens` through 128,000. The extension uses the schema maximum as the combined adaptive request cap; it does not promise 128K of visible text.

### GPT reasoning

Models advertising Kiro's GPT reasoning schema use:

```json
{
  "reasoning": {
    "mode": "standard",
    "effort": "high"
  }
}
```

OMP `minimal` maps to GPT `none`; other advertised levels are preserved. Kiro's separate `pro` mode is not exposed yet because OMP's thinking selector has no second mode control.

### Compatibility/debugging overrides

| Variable | Default | Behavior |
|---|---|---|
| `KIRO_ADAPTIVE_THINKING` | enabled | `0`/`false` disables Claude adaptive fields; GPT reasoning is unaffected |
| `KIRO_ADAPTIVE_FIELDS` | `full` | Claude only: `full` or `effort-only` |
| `KIRO_ADAPTIVE_PAYLOAD_SHAPE` | `top-level-wrapper` | `top-level-wrapper`, `top-level-direct`, `user-input-message`, or `user-input-context` |

The Kiro runtime accepts `windows`, `macos`, or `linux` for `envState.operatingSystem`; the extension maps Node's `win32` value to `windows`.

## Native usage telemetry

When Kiro reports stream metrics, the extension maps real input, output, cache-read, cache-creation, and reasoning-token counts into OMP's native usage metadata. OMP uses the measured full-call duration and time to first model output to render TTFT and tokens/second. Missing input/output metrics retain the existing context-percentage/tokenizer fallbacks; cache hits are never estimated, so the cache indicator appears only for provider-reported cache reads.

## API endpoints

The extension follows the current Kiro management/runtime API used by the captured Kiro CLI 2.13.1 behavior:

- Streaming: `https://runtime.{region}.kiro.dev/` — `GenerateAssistantResponse`
- Models/profile: `https://management.{region}.kiro.dev/` — `ListAvailableModels`, `ListAvailableProfiles`

`{region}` is derived from the validated OAuth profile or API-key configuration. `us-east-1` and `eu-central-1` are bootstrap regions when profile discovery has no routing hint; they are not an allowlist, so a valid future profile region passes through unchanged. OAuth profile identifiers remain in memory and are never written to the model fixture. The legacy `q.{region}.amazonaws.com` endpoint is not used for requests.

## Cross-provider session compatibility

Kiro requires tool-use IDs to match `^[a-zA-Z0-9_-]+$`. When resuming sessions from providers that emit other characters, the extension rewrites IDs to deterministic `call_<hash>` values only while serializing the outgoing request. Tool-call/result pairing is preserved and stored OMP sessions are not modified. Set `KIRO_DEBUG=1` to inspect normalization diagnostics.

## Windows Kiro CLI DB paths

The extension checks both locations:

1. `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3` (newer installations)
2. `%APPDATA%\kiro-cli\data.sqlite3` (older installations)

No symlinks or junctions are required.

## Architecture

- **OMP-native discovery** — `fetchDynamicModels` plus OMP's SQLite cache and `/model` refresh.
- **Fail-closed management parsing** — unknown response fields/schema families reject a refresh rather than publishing a partial catalog.
- **Canonical thinking metadata** — Kiro schemas are converted to OMP `thinking` metadata so controls survive cache/restart.
- **Self-contained bundle** — `dist/index.js` bundles runtime dependencies; only `node:*` imports remain external.
- **Type-only OMP imports** — OMP packages are development dependencies.
- **No TUI dependency** — login uses OMP's built-in prompt mechanism.

## Development

```powershell
bun install
bun run check
bun run test
bun run build
```

Capture a new identity-free fixture only when intentionally updating discovery research:

```powershell
bun run probe:models
```

The probe never writes request headers, bearer/refresh tokens, profile identifiers, account identifiers, emails, ARNs, or machine paths.

## Troubleshooting

### Verify credentials

```powershell
kiro-cli whoami
```

If the provider has no models on first install, authenticate and refresh the Kiro provider from `/model`. A failed refresh should leave OMP's previous cached catalog available.

### Clean reinstall

```powershell
omp plugin uninstall omp-provider-kiro
Remove-Item "$env:USERPROFILE\.omp\plugins\node_modules\omp-provider-kiro" -Recurse -Force -ErrorAction SilentlyContinue
omp plugin install .
```

### Remove the old upstream plugin

```powershell
omp plugin uninstall pi-provider-kiro
Remove-Item "$env:USERPROFILE\.omp\plugins\node_modules\pi-provider-kiro" -Recurse -Force -ErrorAction SilentlyContinue
```

## Differences from upstream

| Feature | upstream `pi-provider-kiro` | this extension |
|---|---|---|
| Models | Maintained catalog | Live Kiro discovery with OMP cache |
| Package imports | `@earendil-works/*` externalized | Self-contained bundle |
| Login UI | Custom TUI | OMP prompt fallback |
| Windows DB path | `%APPDATA%` only | `%LOCALAPPDATA%` + `%APPDATA%` |
| Build output | Relies on PI runtime resolution | Fully bundled ESM |
| OMP manifest | `pi.extensions` only | `omp.extensions` + `pi.extensions` |

## License

MIT
