# Release review — 2026-10-06

Scope: FloatDot 0.1.0, Electron 44.6.0, Windows x64. This is a source review and
local verification record, not a security certification or a claim that every
ChatGPT feature has been tested.

## Recommendation

The reviewed source can be shared as an early source-available MVP. The Windows
build passed the automated checks below. Before presenting its installer as a
stable release, perform a clean-machine install/uninstall and real-account
sign-in check on the final build. Windows downloads are unsigned. macOS and
Linux remain experimental and need builds plus real desktop acceptance; macOS
also needs release signing/notarization for a normal public distribution.

Nothing was published or made public during this review.

## Findings fixed

- Remote browser permissions previously relied on Electron's permissive
  defaults. Check/request handlers now deny capabilities by default. Only the
  visible main ChatGPT page can request microphone/camera access, with a native
  consent dialog defaulting to Deny. Clipboard writing is allowed for Copy;
  clipboard reading, notifications, location, display capture and hardware
  access are denied. Delayed consent is revalidated against navigation and
  window lifetime. See [Electron's permission guidance](https://www.electronjs.org/docs/latest/tutorial/security/#5-handle-session-permission-requests-from-remote-content).
- Any HTTPS origin could previously replace the page in the address-bar-free
  widget. Embedded navigation now uses exact ChatGPT/authentication origins.
  Other HTTPS links open in the browser; unlisted redirects and unsafe schemes
  are blocked. Enterprise identity providers outside the allowlist may fail.
- The base smoke test still expected the removed generic unread heuristic.
  It now checks that unknown content fails quietly.
- System Close used to collapse the app, leaving its processes running. It now
  quits. The top bar and Escape still collapse; Ctrl+Q / Command+Q also quit.
- A collapsed page retained its full browser memory. Settings now offers
  Memory saver (default, unload after 60 seconds; unread detection pauses) and
  Live updates (higher memory use; keep checking for replies). Mode changes
  persist. Sleep preserves recognized drafts/attachments/active responses and
  conservatively defers for audio, granted media access and sign-in popups.
  Pending sleep probes are invalidated by activity, mode changes or navigation.

## Verification performed

All executable local test/build runs used the owned Windows Job Object harness;
cleanup confirmed zero remaining owned processes after each run. Account data
was not used for tests.

| Check | Result |
| --- | --- |
| Security policy | 6 groups passed: origin spoofing, unsafe URLs, frame/worker/popup boundaries, default denial, media scope and consent races |
| Windows smoke | 9 checks passed, including live permission denial, sandbox/IPC isolation, streaming badges, collapse and position |
| Restart | Saved URL/position and synthetic browser storage restored |
| Regression | 13 checks passed for animation/reversal, anchor, unread scope and streaming |
| Memory lifecycle | 7 checks passed: real 60-second timer, draft/response guards, both saved modes, stale-probe races, renderer process exit, storage/cookies retained on wake, and system Close quitting |
| Windows packaging | Installer built; 10 app/license files matched the reviewed source; icons, executable identity and Electron/Chromium notices present; no profiles, screenshots, test runners or development dependencies in the app archive |
| Repository history | Reachable file history contained application/docs/assets only; scoped token/private-key/private-conversation-URL pattern scan found no matches |
| Build workflow | YAML parsed; security, Windows behavior, package verification and checksum steps added. Workflow execution itself was not validated here |

The memory test uses synthetic content with a deliberately allocated 64 MiB
buffer. Summed process private bytes decreased from 328.5 MiB loaded to 93.1 MiB
asleep; the page renderer exited after 60,011 ms. These are controlled test
results, not a measurement or guarantee for a signed-in ChatGPT account.

## Dependencies and remaining limits

- Electron was updated from 44.5.1 to the then-current stable 44.6.0. The
  production-only npm audit returned zero findings. This does not independently
  audit the bundled Electron/Chromium runtime.
- Full npm audit reported eight moderate build-tool dependency advisories,
  zero high and zero critical. They trace to the unpatched
  [sprintf-js denial-of-service advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
  The affected build dependencies are excluded from the packaged app. The
  suggested packager downgrade was not applied blindly.
- Real microphone/camera approval and ChatGPT voice use were not exercised.
  Screen sharing is deliberately unavailable. New sign-in restrictions need
  an actual login check; synthetic tests do not establish provider compatibility.
- Unread and draft detection depend on website markup. Slow history hydration,
  virtualization and edits can still cause missed or miscounted replies. Sleep
  pauses detection; reopening baselines the loaded history.
- No clean-machine installer lifecycle, macOS desktop or Linux desktop test was
  performed. No claim of universally supported platforms is made.

## Reviewed Windows artifact

Local output: `dist/memory-update/floatdot-0.1.0-win-x64.exe`.
Older artifacts in `dist/` predate this review; use the files in `memory-update`
and its current checksums when preparing downloads.

SHA-256:

```text
d318d6afefe560f6a54abbdf12169cee91cd9d7ecda6c84eb19372112227f6b0
```

The app retains the chosen PolyForm Noncommercial 1.0.0 license and third-party
notices. It is source-available under those terms, not unrestricted open source.
