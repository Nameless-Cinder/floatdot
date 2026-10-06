# Developing FloatDot

Use Node.js 24 and install the locked dependencies with `npm ci`. Start the app
with `npm start`. On Windows PowerShell, use `npm.cmd` if execution policy blocks
the PowerShell shim.

## Build desktop downloads

Build on the corresponding operating system:

```sh
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Outputs go to `dist/`; `npm run pack` creates an unpacked app for the current OS.
Artifact names begin with `floatdot-`. App packages contain only application
source, metadata, and license notices. Profiles, `.smoke/`, credentials,
screenshots, test runners, and development dependencies are excluded.
Build commands never publish automatically.

The **Build desktop downloads** GitHub Actions workflow runs on Windows, macOS,
and Linux. Start it manually in Actions or push a version tag such as `v0.1.0`.
It creates workflow artifacts retained for 14 days, not a GitHub Release.
While the repository is private, artifacts require repository access.

Windows signing credentials are not configured. macOS uses ad-hoc signing;
public macOS distribution needs a Developer ID signature and notarization.
Configure release signing securely and replace the development signing settings
in `electron-builder.yml` before publishing a signed Mac release. See
[Electron's signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing).

Test each platform on its actual desktop before calling it supported. Native
Wayland cannot provide the positioning this app needs, so Linux selects X11;
Wayland desktops require XWayland. See
[Electron's platform notes](https://www.electronjs.org/docs/latest/api/browser-window#platform-notices).

## Architecture

- `src/main.js`: floating window, embedded ChatGPT page, position, navigation,
  local preferences, unread state, and animation coordination.
- `src/preload.js`: narrow IPC bridge for the local interface.
- `src/chatgpt-adapter.js`: website layout adjustments, avatar detection, and
  assistant-reply observation.
- `src/renderer/`: dot, badge, collapse bar, and animated transitions.

The dot is 48 by 48 logical pixels; the expanded window is up to 380 by 680.
Animations use a temporary in-memory image while keeping the same page alive.
Reduced motion skips animation. Windows uses software compositing for
transparent-window compatibility. Collapsed pages continue consuming memory.

The display name is FloatDot. The profile directory remains `ChatGPT Dot` and
the browser partition remains `persist:chatgpt-dot` to preserve existing user
data. Development test profile overrides are disabled in packaged applications.

## Compatibility and verification

Dot replies currently use `article.message-row[data-message-id]:not(.self)`;
regular chat replies use `[data-message-author-role="assistant"]`. The fallback
counts substantial unmarked conversation turns and can misidentify responses.

Unread detection and avatar matching are best effort. Initial history is
baselined for 1.8 seconds; responses during that period, virtualized history,
some edits, and regenerations can be missed or miscounted. Update the adapter
when website markup changes. Sign-in depends on ChatGPT and the identity
provider; the wrapper cannot bypass login restrictions or expose app-only pages.

Prior Windows verification covers real sign-in, opening/collapse, dragging,
saved position, unread counts, streaming, reversal, and live-page preservation.
macOS and Linux desktop acceptance remains pending. Historical checks do not
replace checking a new release.

The optional Windows harness uses an isolated profile and an owned Windows Job
Object. It cleans up its entire process tree after success, failure, or timeout:

```powershell
& ([scriptblock]::Create((Get-Content -LiteralPath scripts\smoke.ps1 -Raw))) -Regression
```

`-Quick` opens an isolated app for manual inspection, `-Package` builds the
Windows installer, and `-VerifyPackage` checks its file list and source contents.
Results and preserved failures stay in `.smoke/`. Never use a real account in
tests. Verify owned test processes have exited before retrying or finishing.

At initial release preparation, npm audit reported moderate advisories in
transitive build-tool dependencies; the proposed remedy downgraded the packager.
Those dependencies are not shipped in the app. Recheck dependencies before a
release; npm audit alone does not cover Electron/Chromium security or certify
the application.

## What belongs in the repository

Commit application source, build and test scripts, package metadata, workflow,
documentation, and license notices. Do not commit local browser data,
`node_modules/`, `.smoke/`, `dist/`, credentials, or private screenshots.
`.gitignore` helps with Git; it does not sanitize an archive of the entire folder.
