# omp-provider-kiro

OMP-native provider extension for the [Kiro](https://kiro.dev) API — 13 models including Claude Opus/Sonnet/Haiku, DeepSeek, MiniMax, GLM, and Qwen via AWS CodeWhisperer/Q.

Fork of [mikeyobrien/pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro), converted to a self-contained OMP extension with no runtime dependency on `@earendil-works/*` or OMP TUI internals.

## Requirements

- **OMP** ≥ 15.11.0
- **Kiro CLI** (recommended for credential reuse) — [install guide](https://kiro.dev/docs/cli/)

## Install

From the cloned repo directory:

```powershell
bun install
bun run build
omp plugin install .
```

Or from a parent directory:

```powershell
omp plugin install .\omp-provider-kiro
```

Or via tarball:

```powershell
npm pack
omp plugin install .\omp-provider-kiro-0.1.0.tgz
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
