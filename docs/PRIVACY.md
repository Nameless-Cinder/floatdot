# Privacy and local data

FloatDot loads ChatGPT's real website. It has no separate account system,
application backend, or added analytics service. ChatGPT and any sign-in
provider still receive normal website requests and handle them under their own
policies. FloatDot does not make the website private or offline.

## What stays on your computer

- `dot-preferences.json` contains the selected page URL and floating dot position.
- The `persist:chatgpt-dot` browser partition stores the website's normal cookies,
  session, cache, and local storage.
- The local page observer examines page structure and message elements to detect
  assistant replies. It sends the selected URL and reply counts to the app's
  main process locally, not to a FloatDot server.
- Temporary page images used for animation and avatar samples stay in memory.
  FloatDot does not deliberately save those images as screenshot files.

The profile directory retains the original **ChatGPT Dot** name so existing
users keep their sign-in, selected page, and position after the FloatDot rename:

| Platform | Typical profile location |
| --- | --- |
| Windows | `%APPDATA%\ChatGPT Dot` |
| macOS | `~/Library/Application Support/ChatGPT Dot` |
| Linux | `$XDG_CONFIG_HOME/ChatGPT Dot`, or `~/.config/ChatGPT Dot` |

Each operating-system user has separate data. People sharing one OS login share
this browser profile. Anyone with access to that profile may be able to access
its session data; do not commit or share the profile directory.

## Sign out or reset

Sign out using ChatGPT's own account controls. To remove FloatDot's local
preferences and browser data completely, quit FloatDot first, then remove the
profile directory above. This resets the local sign-in, selected URL, and
position. It does not delete conversations held by ChatGPT.

The Windows installer preserves application data on uninstall. A reinstall can
therefore retain the existing session unless you clear the local profile.

## Source and downloads

Browser profiles, credentials, test evidence, and development screenshots are
excluded from Git and packaged app files. Renderers use sandboxing and context
isolation with Node integration disabled; web security and certificate checks
remain enabled. These settings do not constitute an independent security audit.
