// All assumptions about ChatGPT's DOM live here. No tokens, message text, or
// network requests leave this isolated preload; IPC carries only URL + count.
const SELECTORS = {
  assistant: '[data-message-author-role="assistant"], article.message-row[data-message-id]:not(.self)',
  dotMessage: 'article.message-row[data-message-id]',
  dotContent: '.message-text, .message-bubble',
  message: '[data-message-id]',
  turn: '[data-testid^="conversation-turn-"]',
  user: '[data-message-author-role="user"], article.message-row.self',
  conversation: 'main',
};

const PHONE_CSS = `
  html, body { max-width: 100vw !important; overflow-x: hidden !important; }
  #stage-slideover-sidebar, [data-testid="sidebar"] { display: none !important; }
  main { min-width: 0 !important; max-width: 100vw !important; }
  [data-testid^="conversation-turn-"] { min-width: 0 !important; overflow-wrap: anywhere; }
  pre { max-width: 100%; overflow-x: auto; }
`;

function installObserver(ipcRenderer) {
  if (location.origin !== 'https://chatgpt.com' || window.top !== window) return;
  let enabled = false, route = '', initialized = false, timer, settleTimer;
  let seen = new Set(), tail = null, mode = null;
  let expanded = false;
  let lengths = new Map(), notifiedWhileHidden = new Set();

  function reset() {
    clearTimeout(timer);
    timer = null;
    clearTimeout(settleTimer);
    route = location.href;
    initialized = false;
    seen = new Set();
    tail = null;
    mode = null;
    lengths.clear();
    notifiedWhileHidden.clear();
    // Hydrating old history must not produce unread badges. This deliberately
    // misses responses that arrive during the initial settling period.
    if (enabled) settleTimer = setTimeout(() => { scan(true); initialized = true; }, 1800);
  }

  function snapshot() {
    const root = document.querySelector(SELECTORS.conversation);
    if (!root) return { kind: 'none', messages: [] };
    const assistants = [...root.querySelectorAll(SELECTORS.assistant)];
    if (assistants.length) {
      return { kind: 'assistant', messages: assistants.map((element, index) => {
        const holder = element.closest(SELECTORS.message);
        const turn = element.closest(SELECTORS.turn);
        const content = element.matches(SELECTORS.dotMessage) ? element.querySelector(SELECTORS.dotContent) : element;
        const length = content?.textContent.trim().length || 0;
        return {
          key: holder?.getAttribute('data-message-id') || turn?.getAttribute('data-testid') || `assistant-slot-${index}`,
          ready: length > 0 || !!content?.querySelector('img, audio, video, canvas'),
          length,
        };
      }) };
    }
    // Fallback: substantial new conversation turns, excluding recognizable
    // user turns. This can count non-assistant content if roles disappear.
    return { kind: 'heuristic', messages: [...root.querySelectorAll(SELECTORS.turn)]
      .filter((element) => !element.querySelector(SELECTORS.user))
      .map((element, index) => ({
        key: element.getAttribute('data-testid') || `turn-slot-${index}`,
        ready: element.textContent.trim().length >= 80,
        length: element.textContent.trim().length,
      })) };
  }

  function scan(baseline = false) {
    if (!enabled) return;
    if (location.href !== route) { reset(); return; }
    const { kind, messages } = snapshot();
    if (kind === 'none') return;
    if (mode && mode !== kind) baseline = true;
    mode = kind;
    if (baseline || !initialized) {
      for (const item of messages) {
        if (item.ready) seen.add(item.key);
        lengths.set(item.key, item.length);
      }
      tail = messages.filter((item) => item.ready).at(-1)?.key || null;
      return;
    }
    const tailIndex = messages.findIndex((item) => item.key === tail);
    let count = 0;
    for (let i = 0; i < messages.length; i++) {
      const item = messages[i];
      const grewWhileHidden = !expanded && item.key === tail && item.length > (lengths.get(item.key) ?? item.length);
      lengths.set(item.key, item.length);
      if (!item.ready) continue;
      if (seen.has(item.key)) {
        if (grewWhileHidden && !notifiedWhileHidden.has(item.key)) {
          count++;
          notifiedWhileHidden.add(item.key);
        }
        continue;
      }
      // Prepending history is not a new response. If the previous tail vanished,
      // rebaseline conservatively rather than count a virtualized history page.
      if (tail === null || (tailIndex >= 0 && i > tailIndex)) {
        count++;
        if (!expanded) notifiedWhileHidden.add(item.key);
      }
      seen.add(item.key);
    }
    tail = messages.filter((item) => item.ready).at(-1)?.key || tail;
    if (count) ipcRenderer.send('dot:assistant-added', { url: location.href, count: Math.min(20, count) });
  }

  const observer = new MutationObserver(() => {
    if (!enabled) return;
    if (location.href !== route) reset();
    // Throttle, rather than debounce, so continuously streaming text is seen.
    if (!timer) timer = setTimeout(() => { timer = null; scan(); }, 160);
  });
  const setVisibility = (value) => {
    if (expanded === value) return;
    expanded = value;
    notifiedWhileHidden.clear();
    // Start measuring further streamed text at the moment of collapse.
    if (!expanded && initialized) {
      for (const item of snapshot().messages) lengths.set(item.key, item.length);
    }
  };
  ipcRenderer.on('dot:visibility', (_event, value) => setVisibility(value === true));
  ipcRenderer.on('dot:configure-observer', (_event, options) => {
    setVisibility(options?.expanded === true);
    const next = options?.enabled === true;
    if (next !== enabled || location.href !== route) { enabled = next; reset(); }
  });
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-message-author-role', 'data-message-id', 'class'] });
    reset();
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  window.addEventListener('pagehide', () => { observer.disconnect(); clearTimeout(timer); clearTimeout(settleTimer); }, { once: true });
}

if (typeof process !== 'undefined' && process.type === 'renderer') {
  const { ipcRenderer } = require('electron');
  installObserver(ipcRenderer);
}
// Dot's animated avatar lives in its own site-managed frame. Read only the
// visible avatar bounds; Electron can sample its rendered colour without
// accessing that frame's implementation, assets, or authentication.
const AVATAR_BOUNDS = `(() => {
  const profile = document.querySelector('[data-orbit-profile-trigger]');
  const avatar = profile?.parentElement.querySelector('[role="presentation"]');
  if (!avatar) return null;
  const rect = avatar.getBoundingClientRect();
  if (rect.width < 24 || rect.width > 160 || Math.abs(rect.width - rect.height) > 2) return null;
  if (rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return null;
  return { x:Math.round(rect.x), y:Math.round(rect.y), width:Math.round(rect.width), height:Math.round(rect.height) };
})()`;
if (typeof module !== 'undefined') module.exports = { PHONE_CSS, SELECTORS, installObserver, AVATAR_BOUNDS };
