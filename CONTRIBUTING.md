# Contributing to FloatDot

Bug reports, documentation corrections, and focused changes are welcome.
For larger changes, open an issue describing the problem and intended behavior
before investing in an implementation.

## Report a bug

Include your operating system and desktop environment, FloatDot version,
reproduction steps, expected result, and actual result. For Linux, mention
X11 or Wayland/XWayland. Share only sanitized logs and screenshots; omit private
conversations, cookies, account details, tokens, and browser profile files.

## Submit a change

1. Read the [development guide](docs/DEVELOPMENT.md) and install with `npm ci`.
2. Make a focused change that preserves existing user sessions and preferences.
3. Check affected behavior and explain what was verified and on which platform.
4. Clean up test processes and temporary helpers. Keep diagnostics and local
   account data out of commits.
5. Open a pull request describing the problem, resulting behavior, and checks.

Do not call macOS or Linux supported based only on a successful build. Changes
to website selectors need representative, synthetic page fixtures.

FloatDot uses [PolyForm Noncommercial 1.0.0](LICENSE.md). Submit only work you
have permission to contribute under that license, and preserve third-party
notices. Commercial licensing questions go to the repository owner.
