# Release Process

This project lives at
[ajdiyassin/omp-extension-kiro](https://github.com/ajdiyassin/omp-extension-kiro)
and the package is named `omp-provider-kiro`.

Most users install straight from GitHub, which needs no registry at all:

```powershell
omp plugin install github:ajdiyassin/omp-extension-kiro
```

`dist/index.js` is committed, so a GitHub install works without a build step.

## npm publishing

`omp-provider-kiro` has **not been published to npm yet** — the name is
currently unclaimed. [`publish.yml`](.github/workflows/publish.yml) runs
`npm publish --provenance --access public` when a GitHub Release is published,
so the first release you publish will also create the npm package.

If you do not intend to distribute via npm, delete that workflow rather than
leaving a publish step that never runs successfully.

## Versioning

Follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- **patch** (0.3.x) — bug fixes
- **minor** (0.x.0) — new features, backward-compatible
- **major** (x.0.0) — breaking changes

Version numbers are this project's own. The `## Pre-fork history` section of
`CHANGELOG.md` records releases made under the `pi-provider-kiro` name before
this extension became standalone; those numbers run higher than the current
version and are unrelated to it.

## Steps

### 1. Prepare the release commit

Bump the version in `package.json` and `package-lock.json`:

```powershell
npm version <patch|minor|major> --no-git-tag-version
```

Rebuild the committed bundle. CI fails the build if `dist/index.js` does not
match the committed sources, so this is not optional whenever `src/` changed:

```powershell
npm run build
```

Move the `## [Unreleased]` entries in `CHANGELOG.md` under a new
`## [<VERSION>] - <YYYY-MM-DD>` heading, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Commit:

```powershell
git add package.json package-lock.json bun.lock CHANGELOG.md dist/index.js
git commit -m "chore(release): v<VERSION>"
git push
```

### 2. Tag and push

```powershell
git tag v<VERSION>
git push origin v<VERSION>
```

### 3. Create a GitHub Release

Go to [Releases](https://github.com/ajdiyassin/omp-extension-kiro/releases) →
**Draft a new release**:

- Select the `v<VERSION>` tag
- Title: `v<VERSION>`
- Copy the changelog section into the release notes
- Click **Publish release**

### 4. Automated publish

The publish workflow runs on `release: [published]` events. It checks out the
tagged commit, runs `npm ci`, type checking, and tests, then publishes to npm
with provenance. No manual `npm publish` is needed.

## CI

[`ci.yml`](.github/workflows/ci.yml) runs on every push and PR to `main`:

- Type checking (`npm run check`)
- Linting (`npm run lint`)
- Tests (`npm test`)
- Build (`npm run build`)
- A stale-bundle gate (`git diff --exit-code -- dist/index.js`)

## Pre-release checklist

- [ ] Tests pass (`npm test`)
- [ ] Type check passes (`npm run check`)
- [ ] Lint passes (`npm run lint`)
- [ ] `dist/index.js` rebuilt and committed if `src/` changed
- [ ] `CHANGELOG.md` updated, with `[Unreleased]` emptied into the new version
- [ ] Version bumped in `package.json` / `package-lock.json`
