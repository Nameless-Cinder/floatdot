// The remote session is shared with sign-in windows. Grant no capability merely
// because a page belongs to that session or has an HTTPS URL.
const EMBEDDED_ORIGINS = new Set([
  'https://chatgpt.com', 'https://auth.openai.com', 'https://auth0.openai.com',
  'https://accounts.google.com', 'https://appleid.apple.com', 'https://account.apple.com',
  'https://login.live.com', 'https://login.microsoftonline.com',
]);

function httpsURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function isChatGPT(value) { return httpsURL(value)?.origin === 'https://chatgpt.com'; }
function isEmbeddedURL(value) { return EMBEDDED_ORIGINS.has(httpsURL(value)?.origin); }

function guardNavigation(contents, openExternal) {
  const navigate = (event, url) => {
    if (isEmbeddedURL(url)) return;
    event.preventDefault();
    if (httpsURL(url)) void openExternal(url).catch(() => {});
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    // Embedded frames may use other service origins; they never replace the UI.
    if (isMainFrame && !isEmbeddedURL(url)) event.preventDefault();
  });
}

function installPermissions(contents, { canPrompt, askMedia, onMediaAllowed = () => {} }) {
  const session = contents.session;
  const grants = new Set();
  let documentVersion = 0;
  let pending = false;
  contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) { documentVersion++; grants.clear(); }
  });
  const trusted = (sender, details) => sender === contents && !contents.isDestroyed()
    && details?.isMainFrame === true && isChatGPT(contents.getURL())
    && isChatGPT(details.requestingUrl)
    && (!details.securityOrigin || isChatGPT(details.securityOrigin));

  session.setPermissionCheckHandler((sender, permission, origin, details) => {
    if (!trusted(sender, details) || !isChatGPT(origin)) return false;
    if (permission === 'clipboard-sanitized-write') return true;
    return permission === 'media' && grants.has(details.mediaType);
  });
  session.setPermissionRequestHandler((sender, permission, callback, details) => {
    if (!trusted(sender, details)) return callback(false);
    if (permission === 'clipboard-sanitized-write') return callback(true);
    const types = details.mediaTypes;
    if (permission !== 'media' || !Array.isArray(types) || !types.length
      || types.some(type => type !== 'audio' && type !== 'video')) return callback(false);
    if (types.every(type => grants.has(type))) return callback(true);
    if (pending || !canPrompt()) return callback(false);
    pending = true;
    const version = documentVersion;
    const url = contents.getURL();
    void (async () => {
      let allowed = false;
      try {
        allowed = await askMedia([...new Set(types)]);
        allowed = allowed === true && version === documentVersion && trusted(sender, details)
          && contents.getURL() === url && canPrompt();
        if (allowed) { types.forEach(type => grants.add(type)); onMediaAllowed(); }
      } catch { allowed = false; }
      finally { pending = false; callback(allowed); }
    })();
  });
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback(null));
}

module.exports = { isChatGPT, isEmbeddedURL, httpsURL, guardNavigation, installPermissions };
