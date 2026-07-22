# omp-provider-kiro

OMP-native provider extension for the [Kiro](https://kiro.dev) API — Claude Opus/Sonnet/Haiku (with official adaptive thinking on Opus 4.8/4.7/4.6 and Sonnet 4.6), plus DeepSeek, MiniMax, GLM, and Qwen.

Fork of [mikeyobrien/pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro), converted to a self-contained OMP extension with no runtime dependency on `@earendil-works/*` or OMP TUI internals.

## Requirements

- **OMP** ≥ 17.0.7
- **Kiro CLI** (recommended for credential reuse) — [install guide](https://kiro.dev/docs/cli/)

## Install

One command, no cloning or building required:

```powershell
omp plugin install github:ajdiyassin/omp-extension-kiro
```

The extension is self-contained — `dist/index.js` is committed and has no runtime dependencies beyond Node builtins.

### Verify

```powershell
omp --list-models 2>&1 | Select-String -Pattern "kiro|Failed to load extension"
```

### Update

```powershell
omp plugin install github:ajdiyassin/omp-extension-kiro
```

### Uninstall

```powershell
omp plugin uninstall omp-provider-kiro
```

### Enable / Disable

Installation enables the plugin automatically. To toggle manually:

```powershell
omp plugin enable omp-provider-kiro
omp plugin disable omp-provider-kiro
```

### Development install (local clone)

If you're working on the extension itself:

```powershell
bun install
bun run build
omp plugin install .
```

## Authentication

### Recommended: Kiro CLI credential reuse

If Kiro CLI is installed and logged in, OMP automatically reuses credentials — no `/login` needed.

```powershell
kiro-cli whoami
omp
```

### Manual login

```text
/login kiro
```

Prompt: `Paste IAM Identity Center URL, or blank for Builder ID`

- Blank → AWS Builder ID device-code flow
- URL → IAM Identity Center with auto-region detection

### Supported auth methods

- AWS Builder ID (device code)
- IAM Identity Center / SSO (device code with region probing)
- Google / GitHub (via `kiro-cli login --license free`)

## Usage

```text
/model kiro/auto
```

Available models: `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4`, `claude-haiku-4-5`, `deepseek-3-2`, `minimax-m2-5`, `minimax-m2-1`, `glm-5`, `qwen3-coder-next`, `auto`

## Adaptive thinking

Reasoning for the supported Claude models uses Kiro's official **adaptive-thinking** fields,
sent in the request's top-level `additionalModelRequestFields`:

- `thinking.type = adaptive`, `thinking.display = summarized`
- `output_config.effort` = reasoning depth (`low | medium | high | xhigh | max`)
- `max_tokens` = total output cap (thinking + text + tool calls), **not** a thinking budget

OMP thinking levels (set via the `kiro/<model>:<level>` selector or model roles) are mapped to
Kiro effort per model:

| OMP level | Opus 4.8 / 4.7 | Opus 4.6 / Sonnet 4.6 |
|-----------|----------------|------------------------|
| minimal   | low            | low                    |
| low       | medium         | low                    |
| medium    | high           | medium                 |
| high      | xhigh          | high                   |
| xhigh     | max            | max                    |

Adaptive thinking is supported only on **Opus 4.8, Opus 4.7, Opus 4.6, and Sonnet 4.6**
(`max_tokens` caps: 128000 for Opus 4.8/4.7, 64000 for Opus 4.6 / Sonnet 4.6). All other
models work as plain Kiro models and receive no adaptive fields. It is enabled by default
and sends the full payload at the request's top-level `additionalModelRequestFields`.

Override env vars (kill-switch + debugging; every combination below is live-verified):

| Variable | Default | Values |
|----------|---------|--------|
| `KIRO_ADAPTIVE_THINKING` | enabled | `0`/`false` disables all adaptive fields |
| `KIRO_ADAPTIVE_FIELDS` | `full` | `full` = `thinking`+`output_config`+`max_tokens`; `effort-only` = just `output_config.effort` |
| `KIRO_ADAPTIVE_PAYLOAD_SHAPE` | `top-level-wrapper` | `top-level-wrapper`, `top-level-direct`, `user-input-message`, `user-input-context` |

> Note: the Kiro runtime validates `userInputMessageContext.envState.operatingSystem` against
> `windows`/`macos`/`linux`. Sending the raw Node `process.platform` (e.g. `win32`) is rejected
> with `400 REQUEST_BODY_INVALID`; the extension maps it to the correct value.

## API endpoints

This extension targets the current Kiro API (matching Kiro CLI 2.6.x):

- Chat (streaming): `https://runtime.{region}.kiro.dev/` — `GenerateAssistantResponse`
- Models / profile: `https://management.{region}.kiro.dev/` — `ListAvailableModels`, `GetProfile`, `ListAvailableProfiles`

`{region}` is `us-east-1` or `eu-central-1` (auto-detected from your credentials). The legacy
`q.{region}.amazonaws.com` CodeWhisperer endpoint is no longer used.

## Cross-provider session compatibility

When resuming an OMP session created by another provider, the Kiro provider normalizes foreign
tool-call IDs to Kiro-compatible IDs while preserving tool-call/tool-result pairing. The stored
OMP session is not modified.

Kiro requires tool-use IDs to match `^[a-zA-Z0-9_-]+$`. Other providers (e.g. Fireworks/Kimi,
which emits IDs like `functions.find:4`) use characters Kiro rejects with
`ValidationException / TOOL_SCHEMA_INVALID`. The provider rewrites such IDs to a deterministic
`call_<hash>` form only while serializing the outgoing Kiro request — the same normalized value
is used for both a tool call and its matching result, so pairing is preserved. Valid Kiro IDs pass
through unchanged. Set `KIRO_DEBUG=1` to log the `tool_ids.normalized` mappings for a request.

## Windows Kiro CLI DB paths

The extension checks both locations:

1. `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3` (newer installations)
2. `%APPDATA%\kiro-cli\data.sqlite3` (older installations)

No symlinks or junctions required.

## Architecture

- **Self-contained bundle** — `dist/index.js` bundles all runtime deps. Only `node:*` imports at runtime.
- **Type-only OMP imports** — `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-coding-agent` are dev-only.
- **No TUI dependency** — Login uses OMP's built-in prompt mechanism.

## Development

```powershell
bun install
bun run check     # TypeScript type check
bun run test      # Run all tests (297 tests)
bun run build     # Build dist/index.js
```

## Troubleshooting

### Check if the extension loaded

```powershell
omp --list-models 2>&1 | Select-String -Pattern "kiro|Failed to load extension"
```

### Clean reinstall

```powershell
omp plugin uninstall omp-provider-kiro
Remove-Item "$env:USERPROFILE\.omp\plugins\node_modules\omp-provider-kiro" -Recurse -Force -ErrorAction SilentlyContinue
omp plugin install .
```

### Clean old upstream plugin

```powershell
omp plugin uninstall pi-provider-kiro
Remove-Item "$env:USERPROFILE\.omp\plugins\node_modules\pi-provider-kiro" -Recurse -Force -ErrorAction SilentlyContinue
```

### Verify credentials

```powershell
kiro-cli whoami
```

## Differences from upstream

| Feature | upstream (pi-provider-kiro) | this fork (omp-provider-kiro) |
|---------|---------------------------|-------------------------------|
| Package imports | `@earendil-works/*` externalized | Self-contained bundle, no externals |
| Login UI | Custom TUI (SelectList, Input) | Simple prompt fallback |
| Windows DB path | `%APPDATA%` only | `%LOCALAPPDATA%` + `%APPDATA%` fallback |
| Build output | Relies on PI runtime resolution | Fully bundled ESM, node:* only |
| OMP manifest | `pi.extensions` only | `omp.extensions` + `pi.extensions` |

## License

MIT
