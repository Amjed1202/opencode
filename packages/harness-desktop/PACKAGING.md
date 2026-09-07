# Harness portable Windows development package

The package is a Windows x64 folder containing `Harness.exe`, Electron **42.3.3**, Bun **1.3.14** (revision `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`), and the built main, preload, renderer and host. Copy the whole folder to a directory owned by your Windows account and open `Harness.exe`. Launching needs no separately installed Node.js, Bun, package manager, administrator access or development tools. Windows 10 version 1809 or later and an x64 CPU compatible with the standard Bun Windows x64 build are required; this build has been smoke-tested only on the recorded development machine.

This is an **unsigned Harness development package**. There is no Harness signing certificate, installer, Start-menu registration, uninstaller or automatic updater. Windows may show an unknown-publisher warning. The renamed upstream Electron binary retains its upstream icon, PE metadata and any upstream signature; that does not authenticate the Harness application resources. A SHA-256 manifest detects changes relative to the supplied manifest, but is not a publisher signature. No signing key is available in this checkout.

## First launch and native runtimes

Harness launches its bundled Bun host through an absolute path under `resources/runtime`. The default private per-user application data is `%APPDATA%\Harness`; development launches use `%APPDATA%\Harness-development`. SQLite journals, encrypted review artifacts and the OS-wrapped review key are written to the application data directory, not to the package or selected repository. Copying the portable application folder does not migrate this data. Do not put this data inside a repository or share it with another Windows account. A fresh package contains no user data, runtime account homes, authentication files, tokens, native runtime binaries or selected repositories.

Install native **Codex 0.153.4** and/or **Claude Code 2.1.251** separately and sign in through their native applications. Use Harness's native file/folder pickers to explicitly select the runtime executable, native account home and repository. Version mismatches remain blocked. Runtime execution and Skills activation remain subject to the implemented subscription, native policy and compatibility checks; a successful connection alone does not start a provider task. Model selection and review decisions remain explicit. The original OpenCode desktop and its accounts are separate.

Keep the entire package together, including DLLs, locale files, resources and license notices. To replace this development package, close Harness, retain the old folder if needed, and extract the new package into a separate empty folder. Removing that application folder does not remove private application data. Never delete native `.codex` or `.claude` account directories as part of a Harness update.

## Build the portable folder

Run from `packages/harness-desktop` after the checkout's locked dependencies and pinned Electron distribution have been installed. The packaging step makes no network requests and does not install dependencies. Build inputs must already exist.

```powershell
bun run typecheck
bun test test/unit
bun run build
bun run package:windows `
  --output-root 'C:\absolute\task\outputs' `
  --bun 'C:\absolute\tools\bun.exe' `
  --electron 'C:\absolute\electron\dist\electron.exe'
```

The existing, canonical `--output-root` is the explicit boundary for all package writes. The default result is `Harness-windows-x64` beneath it. An existing output is refused, without overwriting or deleting it; use `--name Harness-windows-x64-REVIEW2` for a second build. A failed assembly leaves a uniquely named `.partial-…` directory for inspection. The script never recursively deletes anything. Its only directory move promotes that new staging directory to the checked final path.

The script executes the selected binaries with a minimal environment to check the pinned Electron version and exact Bun revision, architecture and platform. It copies an allowlist from the installed Electron distribution, excluding Electron's default app. It includes only built assets from the application; source maps, unexpected files, symbolic links, native account/cache directories and unresolved runtime package imports are rejected. Build and distribution trees also reject hard links. Installed dependency notices may be hard-linked by Bun; their bytes are copied into new independent package files, and every copied destination is checked to have one link. No checkout, source worktree, `node_modules`, shell history or user profile is copied. `artifacts.json` records sorted relative paths, byte sizes and SHA-256 hashes for all package files other than itself, plus the observed runtime versions. The command prints the manifest's own SHA-256. Identical input bytes produce identical manifest bytes; the complete binary/toolchain build is not claimed to be reproducible.

The script also creates a uniquely named ZIP beside the folder, preserves the package folder structure, and writes the archive's SHA-256 in a matching `.zip.sha256` file. It uses Windows PowerShell's built-in .NET ZIP support and never uploads either artifact. ZIP filenames include a random suffix to avoid overwrites; archive timestamps and compression are not claimed to be reproducible. Extract the ZIP completely before launching. Do not run the executable inside Explorer's archive view.

## Verify the assembled application

From the same package directory:

```powershell
$env:HARNESS_PACKAGE_ROOT = 'C:\absolute\task\outputs\Harness-windows-x64'
$env:HARNESS_SMOKE_ROOT = 'C:\absolute\task\outputs\packaged-smoke'
bun x --no-install playwright test --config test/electron/packaged.config.ts
```

This development check verifies every manifest hash and required license, starts the actual packaged executable twice with only Windows system directories on `PATH` and without Bun/Node selection variables, confirms a clean unconfigured state and isolated renderer, and checks the OS-wrapped key. It creates and removes only its own verified scratch child directory. No native provider is started, account is used, or provider task is sent. The test requires the checkout's Playwright dependency; end users do not need it.

## Preserved notices and source information

- Electron's upstream `LICENSE` and `LICENSES.chromium.html` remain at the package root. They cover Electron and bundled Chromium/Node/third-party components as shipped by the upstream release.
- `licenses/HARNESS-MIT.txt` preserves this repository's MIT notice, including the OpenCode copyright. `licenses/SOLID-MIT.txt` preserves the installed Solid **1.9.10** MIT notice.
- The host bundles the published **Claude Agent SDK 0.3.251** JavaScript. `licenses/CLAUDE-AGENT-SDK-LICENSE.md` and `CLAUDE-AGENT-SDK-README.md` preserve its upstream legal notice and usage terms; this SDK is not represented as MIT-licensed. The SDK uses the explicitly selected native Claude executable, so the package includes no optional platform CLI or duplicate native runtime. `licenses/THIRD-PARTY.json` records installed build dependency versions and notice paths, including declared peers **@anthropic-ai/sdk 0.93.0**, **@modelcontextprotocol/sdk 1.29.0**, and **zod 4.1.8**. Their MIT notices, the upstream SDK's embedded license comments, and the MIME types/database MIT notices are retained. Installed peer versions are build inventory; the upstream SDK ships its own bundled dependency code.
- `licenses/BUN-LICENSE.md` is copied unchanged from the [Bun 1.3.14 upstream notice](https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/LICENSE.md). Bun identifies its own code as MIT and lists its linked libraries and embedded polyfills, including JavaScriptCore/WebKit under LGPL. The notice retains upstream source/relinking instructions. [Bun's pinned source](https://github.com/oven-sh/bun/tree/bun-v1.3.14) and [its WebKit source](https://github.com/oven-sh/WebKit) are available upstream; the separate `resources/runtime/bun.exe` can be replaced with a compatible rebuilt binary for local use (changing it invalidates the supplied manifest). This local development packaging does not certify fulfillment of every source-distribution obligation for a future public release; preserve notices and review corresponding-source/relinking availability before public redistribution.

The layout follows Electron's documented [manual packaging and executable renaming](https://www.electronjs.org/docs/latest/tutorial/application-distribution). No signing, publishing, native installer or public distribution occurs in this workflow.
