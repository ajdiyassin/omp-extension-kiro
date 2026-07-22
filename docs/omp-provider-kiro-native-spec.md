# Spec: Convert `ajdiyassin/omp-provider-kiro` into an OMP-native Kiro provider extension

> **Historical specification:** the original static provider registration described here is superseded by `fetchDynamicModels` and OMP's SQLite model cache. See `README.md` and `AGENTS.md` for the current architecture.


## Goal

Convert the forked Kiro provider from a PI-oriented extension into a clean OMP-native extension that installs and loads in OMP without manual `dist/index.js` patching, dependency junctions, or runtime resolver hacks.

The MVP must support:

- OMP plugin discovery.
- `omp --list-models` showing `kiro/*` models without load errors.
- Kiro credential reuse from `kiro-cli` and Kiro IDE token files.
- `/login kiro` using simple prompt/device-code flow.
- `/model kiro/auto`.
- A smoke test prompt returning a valid response.
- No dependency on `@earendil-works/*`.
- No dependency on OMP TUI internals for MVP.

## Current problem summary

The fork currently inherits PI assumptions from upstream:

- Package name is still `pi-provider-kiro`.
- Build script externalizes `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`.
- Source imports `@earendil-works/*`.
- Custom login UI imports `pi-coding-agent` and `pi-tui`, causing OMP compiled-extension resolver failures.
- Manual patching from `@earendil-works/*` to `@oh-my-pi/*` still fails because nested OMP packages import other OMP internals such as `pi-tui` and `pi-natives`.

Therefore the correct fix is not more local patching. Build an OMP-native package with a bundled runtime and a minimal dependency surface.

## Non-goals for MVP

Do not implement these in the first pass:

- Custom TUI login selector.
- Fancy `ctx.ui.custom()` login overlays.
- Direct dependency on `@oh-my-pi/pi-tui`.
- Direct dependency on `@oh-my-pi/pi-coding-agent` at runtime.
- Publishing to npm.
- Rewriting the Kiro API protocol.
- Replacing the existing Kiro streaming implementation unless required for compatibility.

## Target package shape

Update `package.json`:

```json
{
  "name": "omp-provider-kiro",
  "version": "0.1.0",
  "description": "OMP-native provider extension for Kiro API",
  "type": "module",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ajdiyassin/omp-provider-kiro.git"
  },
  "keywords": [
    "omp",
    "oh-my-pi",
    "kiro",
    "aws",
    "codewhisperer",
    "provider",
    "extension"
  ],
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js --packages=bundle",
    "check": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepare": "npm run build",
    "prepublishOnly": "npm run check && npm run test && npm run build"
  },
  "omp": {
    "extensions": [
      "./dist/index.js"
    ]
  },
  "pi": {
    "extensions": [
      "./dist/index.js"
    ]
  }
}
```

Important notes:

- Keep `pi.extensions` only as backward-compatible metadata.
- Add `omp.extensions` as the primary manifest entry.
- Do not externalize `@earendil-works/*`.
- Do not externalize `@oh-my-pi/pi-tui`.
- Avoid any runtime import from `@oh-my-pi/pi-coding-agent`.
- Prefer fully bundled runtime output.
- Keep Node built-ins external automatically through esbuild platform `node`.

## Dependency policy

### Runtime dependencies

Keep only dependencies that are safe to bundle:

```json
"dependencies": {
  "js-tiktoken": "^1.0.21"
}
```

`esbuild` should move to `devDependencies`, not runtime dependencies.

### Dev dependencies

Use OMP packages only for type checking where absolutely required:

```json
"devDependencies": {
  "@biomejs/biome": "2.4.2",
  "@oh-my-pi/pi-ai": "15.11.0",
  "@oh-my-pi/pi-coding-agent": "15.11.0",
  "esbuild": "^0.25.0",
  "typescript": "^5.7.0",
  "vitest": "^3.0.0"
}
```

Rules:

- `@oh-my-pi/pi-ai` may be used for types and only where unavoidable.
- `@oh-my-pi/pi-coding-agent` may be used for `ExtensionAPI` type only.
- All such imports must be `import type`, never runtime imports.
- No `@oh-my-pi/pi-tui` dependency in MVP.
- No `@earendil-works/*` dependencies anywhere.

## Phase 1: Rename and manifest cleanup

### Tasks

1. Rename package from `pi-provider-kiro` to `omp-provider-kiro`.
2. Update repository metadata to `ajdiyassin/omp-provider-kiro`.
3. Add `omp.extensions`.
4. Keep `pi.extensions` for compatibility.
5. Remove all `@earendil-works/*` from `dependencies`, `devDependencies`, source imports, tests, and generated output.
6. Update README install examples to use the new package/fork name.

### Search commands

```bash
rg "@earendil-works|pi-provider-kiro|pi\\.extensions|omp\\.extensions"
```

### Acceptance criteria

```bash
rg "@earendil-works" .
```

Expected: no results.

```bash
npm run build
```

Expected: success.

## Phase 2: Remove custom TUI login UI from MVP

### Reason

The current `src/login-ui.ts` imports `DynamicBorder` from `pi-coding-agent` and `Container`, `Input`, `SelectList`, and `Text` from `pi-tui`. This caused dependency-resolution failures inside OMP’s compiled extension loader.

### Tasks

1. Delete `src/login-ui.ts`, or replace it with a tiny no-op module:

```ts
export type LoginChoice =
  | { method: "builder-id" }
  | { method: "idc"; startUrl: string }
  | { method: "google" }
  | { method: "github" }
  | null;

export function setExtensionContext(_ctx: unknown): void {
  // No-op in OMP-native MVP.
}

export async function showLoginUI(): Promise<LoginChoice> {
  return null;
}
```

2. Remove the `session_start` handler from `src/index.ts` if it only exists to store UI context.
3. Keep `interactiveLogin()` fallback in `src/login.ts`.
4. Make `interactiveLogin()` use a single `onPrompt` path:
   - blank input = Builder ID
   - HTTP URL = IAM Identity Center start URL
   - optionally support literal `google` or `github` values later, but not required for MVP

### Required login behavior

`/login kiro` should prompt:

```text
Paste IAM Identity Center URL, or blank for Builder ID
```

Then:

- Blank: run Builder ID device-code flow.
- URL: detect Identity Center region and run device-code flow.
- Existing Kiro CLI or IDE token: reuse silently before prompting.

### Acceptance criteria

```bash
rg "pi-tui|DynamicBorder|SelectList|Container|Input" src package.json
```

Expected: no results, except harmless lowercase variable names unrelated to imports.

## Phase 3: Convert source imports to OMP-native type imports

### Current imports to change

Change source imports like:

```ts
import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

To:

```ts
import type { Api, Model, OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
```

Rules:

- Use `import type` wherever possible.
- If any import from `@oh-my-pi/*` survives in emitted `dist/index.js`, that is a bug for MVP unless there is a deliberate reason.
- The built `dist/index.js` should not contain bare runtime imports from `@oh-my-pi/*`.

### Validation

```bash
npm run build
rg "@earendil-works|@oh-my-pi/pi-tui|@oh-my-pi/pi-coding-agent" dist/index.js
```

Expected:

- No `@earendil-works`.
- No `@oh-my-pi/pi-tui`.
- No runtime `@oh-my-pi/pi-coding-agent`.

If `@oh-my-pi/pi-ai` appears in `dist/index.js`, inspect whether it is a runtime import. If it is only type-only in source, it should not be emitted. If it is runtime, either bundle it or replace usage with local structural types.

## Phase 4: Build configuration

### Required build behavior

The extension should produce a self-contained ESM file:

```bash
dist/index.js
```

It should bundle local source files and small runtime dependencies.

Use:

```json
"build": "esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js --packages=bundle"
```

Do not use:

```bash
--external:@earendil-works/pi-ai
--external:@earendil-works/pi-coding-agent
--external:@earendil-works/pi-tui
```

Do not add:

```bash
--external:@oh-my-pi/pi-tui
--external:@oh-my-pi/pi-coding-agent
```

### Inspect emitted imports

After build:

```bash
rg "^import .*from" dist/index.js
```

Allowed:

- Node built-ins such as `node:fs`, `node:path`, `node:os`, `node:child_process`.
- Possibly bundled-safe package internals if esbuild emits them.

Not allowed:

- `@earendil-works/*`
- `@oh-my-pi/pi-tui`
- `@oh-my-pi/pi-coding-agent`
- `@oh-my-pi/pi-natives`

## Phase 5: Entry point cleanup

### `src/index.ts`

Keep the provider registration, but remove UI context capture.

Target shape:

```ts
import type { Api, Model, OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getKiroCliCredentials } from "./kiro-cli.js";
import { getCachedModels, kiroModels, resolveApiRegion } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiro, refreshKiroToken } from "./oauth.js";
import { streamKiro } from "./stream.js";
import { fetchKiroUsage } from "./usage.js";

export default function ompKiroProvider(pi: ExtensionAPI) {
  pi.registerProvider("kiro", {
    baseUrl: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    api: "kiro-api",
    models: kiroModels,
    oauth: {
      name: "Kiro",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      getCliCredentials: getKiroCliCredentials,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        const apiRegion = resolveApiRegion((cred as KiroCredentials).region);
        const cachedKiro = getCachedModels(apiRegion);
        const nonKiro = models.filter((m: Model<Api>) => m.provider !== "kiro");
        const modifiedKiro = cachedKiro.map((m: Model<Api>) => ({
          ...m,
          baseUrl: `https://q.${apiRegion}.amazonaws.com/generateAssistantResponse`,
        }));

        return [...nonKiro, ...modifiedKiro];
      },
      fetchUsage: fetchKiroUsage,
    } as any,
    streamSimple: streamKiro,
  });
}
```

Notes:

- If type imports create build friction, replace OMP/PI imported types with local minimal structural types.
- Runtime correctness matters more than perfect upstream typing for MVP.

## Phase 6: Kiro CLI credential path fix for Windows

### Problem

The upstream provider checks Windows Kiro CLI DB at:

```text
%APPDATA%\kiro-cli\data.sqlite3
```

But current Kiro CLI installations may store it at:

```text
%LOCALAPPDATA%\Kiro-Cli\data.sqlite3
```

### Tasks

Update `getKiroCliDbPath()` to check both locations on Windows.

Order:

1. `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`
2. `%APPDATA%\kiro-cli\data.sqlite3`
3. Any existing legacy fallback

Pseudo-code:

```ts
if (p === "win32") {
  const candidates = [
    join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Kiro-Cli", "data.sqlite3"),
    join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
```

### Acceptance criteria

On Windows with Kiro CLI logged in:

```powershell
kiro-cli whoami
```

Then OMP should be able to use Kiro credentials without needing a junction from Roaming to Local.

## Phase 7: Preserve existing Kiro auth behavior

Keep the existing credential lookup order:

1. Kiro IDE token from AWS SSO cache.
2. Kiro CLI social token.
3. Kiro CLI IDC token.
4. Expired IDE token refresh.
5. Expired CLI token refresh.
6. Interactive device-code login.

Preserve:

- Builder ID flow.
- IAM Identity Center device-code flow with region probing.
- Google/GitHub via `kiro-cli login --license free`.
- Token refresh.
- Writing refreshed tokens back to Kiro CLI DB when possible.
- Region-based model cache update.

Do not simplify token logic unless tests prove it is broken.

## Phase 8: Preserve streaming behavior

Keep the existing `streamKiro` implementation and related modules:

- `stream.ts`
- `transform.ts`
- `event-parser.ts`
- `history.ts`
- `retry.ts`
- `thinking-parser.ts`
- `truncation.ts`
- `tokenizer.ts`
- `usage.ts`

But update imports from `@earendil-works/pi-ai` to either:

1. `import type` from `@oh-my-pi/pi-ai`, or
2. local structural types if bundling/type-checking is problematic.

Important:

- `stream.ts` currently has both type imports and runtime namespace import from PI AI.
- If `import * as PiAi from "@oh-my-pi/pi-ai"` is used at runtime, confirm it bundles into `dist/index.js` or replace the needed helpers with local implementations.
- The MVP must not rely on OMP resolving bare `@oh-my-pi/*` runtime imports at plugin load.

## Phase 9: Tests

Add or update tests for:

### Package/build tests

1. `npm run check`
2. `npm run build`
3. `dist/index.js` exists.
4. `dist/index.js` has no forbidden imports.

Forbidden import test:

```bash
rg "@earendil-works|@oh-my-pi/pi-tui|@oh-my-pi/pi-coding-agent|@oh-my-pi/pi-natives" dist/index.js
```

Expected: no results.

### Windows Kiro DB path tests

Mock environment variables:

- `LOCALAPPDATA`
- `APPDATA`

Verify `getKiroCliDbPath()` prefers:

```text
%LOCALAPPDATA%\Kiro-Cli\data.sqlite3
```

and falls back to:

```text
%APPDATA%\kiro-cli\data.sqlite3
```

### Login tests

Mock callbacks:

- `onPrompt`
- `onAuth`
- `onProgress`
- `signal`

Verify:

- blank prompt triggers Builder ID start URL.
- URL prompt triggers IAM Identity Center region probing.
- existing CLI creds avoid prompt.
- existing IDE creds avoid prompt.
- expired creds attempt refresh before prompt.

### Model tests

Verify:

- `kiroModels` includes `auto`.
- `resolveKiroModel("claude-sonnet-4-6")` maps to Kiro API format correctly.
- region mapping works for `us-east-1` and `eu-central-1`.
- unknown region does not crash the entire provider registration.

## Phase 10: Local install/test flow

The agent must document and verify this local workflow.

### Clean old plugin

```powershell
omp plugin uninstall pi-provider-kiro
Remove-Item "$env:USERPROFILE\.omp\plugins\node_modules\pi-provider-kiro" -Recurse -Force -ErrorAction SilentlyContinue
```

### Build fork

```powershell
git clone https://github.com/ajdiyassin/omp-provider-kiro.git
cd omp-provider-kiro
bun install
bun run check
bun run test
bun run build
```

### Install local fork into OMP

Use one of these, depending on what OMP supports best:

```powershell
omp plugin install .
```

or from the parent directory:

```powershell
omp plugin install .\omp-provider-kiro
```

If local directory install is unreliable, use an explicit package tarball:

```powershell
npm pack
omp plugin install .\omp-provider-kiro-0.1.0.tgz
```

### Verify plugin registration

```powershell
omp plugin list | Select-String -Pattern "omp-provider-kiro|kiro"
omp plugin doctor
omp --list-models | Select-String -Pattern "kiro"
```

Expected:

- no `Failed to load extension`
- `kiro/auto` appears
- Kiro provider models appear

### Verify auth

First ensure Kiro CLI is logged in:

```powershell
kiro-cli whoami
```

Then:

```powershell
omp
```

Inside OMP:

```text
/model kiro/auto
Say exactly: KIRO_PROVIDER_OK
```

If CLI credential reuse works, this should not require `/login`.

If it does require login:

```text
/login kiro
```

Then follow the prompt.

## Phase 11: README updates

Update README to clearly say:

- This is an OMP-native fork of the original Kiro provider.
- Minimum tested OMP version: `15.11.0`.
- Kiro CLI credential reuse is the recommended auth path.
- Windows Kiro CLI DB lookup supports both Local and Roaming paths.
- Custom TUI login UI is intentionally removed for MVP.
- Login flow uses the built-in OMP OAuth callback/prompt mechanisms.
- Troubleshooting command:

```powershell
omp --list-models 2>&1 | Select-String -Pattern "kiro|Failed to load extension"
```

- Clean reinstall command:

```powershell
omp plugin uninstall omp-provider-kiro
Remove-Item "$env:USERPROFILE\.omp\plugins\node_modules\omp-provider-kiro" -Recurse -Force -ErrorAction SilentlyContinue
omp plugin install .
```

## Phase 12: Done definition

The implementation is done when all of these pass on Windows:

```powershell
bun install
bun run check
bun run test
bun run build
omp plugin uninstall pi-provider-kiro
omp plugin uninstall omp-provider-kiro
omp plugin install .
omp plugin doctor
omp --list-models | Select-String -Pattern "kiro"
kiro-cli whoami
```

And inside OMP:

```text
/model kiro/auto
Say exactly: KIRO_PROVIDER_OK
```

Expected:

- No extension load errors.
- Kiro provider appears in model list.
- Kiro CLI credentials are reused if present.
- `/login kiro` does not show “No OAuth login is waiting for a manual callback.”
- `kiro/auto` can send at least one successful request.
- No manual patching of `dist/index.js`.
- No junctions/symlinks required.
- No `@earendil-works/*` anywhere in source or build output.
- No runtime OMP TUI dependency in MVP.

## Suggested implementation order for the agent

1. Clean package metadata and manifest.
2. Remove custom TUI login dependency.
3. Convert imports from `@earendil-works/*` to `@oh-my-pi/*` type-only imports.
4. Fix build script to bundle runtime dependencies.
5. Fix Windows Kiro CLI DB path lookup.
6. Build and inspect `dist/index.js`.
7. Add tests for forbidden imports and DB path.
8. Install locally into OMP and verify `omp --list-models`.
9. Verify credential reuse with `kiro-cli whoami`.
10. Update README with exact local install and troubleshooting commands.

## Reference notes

- OMP extension modules are loaded via dynamic import.
- OMP plugin extension entries can come from `omp.extensions` or legacy `pi.extensions`.
- OMP extension failures are captured per extension and do not abort all extension loading.
- Extensions are not sandboxed, so runtime imports and dependency resolution must be kept simple.
- The provider should be self-contained at load time and avoid importing OMP TUI internals in the MVP.
