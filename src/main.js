const { app, BrowserWindow, WebContentsView, ipcMain, Menu, Tray, screen, shell, globalShortcut, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PHONE_CSS, AVATAR_BOUNDS } = require('./chatgpt-adapter');
const { isChatGPT, isEmbeddedURL, httpsURL, guardNavigation, installPermissions } = require('./web-policy');

app.setName('FloatDot');
const APP_ID = 'io.github.m0hamedd.floatdot';
const ICON_DIR = app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(__dirname, '..', 'assets');
const APP_ICON = path.join(ICON_DIR, 'icon.png');
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
// Keep the original profile location so rebranding preserves sign-in, the
// selected page and position. The isolated test profile overrides this below.
app.setPath('userData', path.join(app.getPath('appData'), 'ChatGPT Dot'));

// Software compositing avoids invisible/click-through transparent windows on
// Windows graphics drivers. The MVP is text-first, so reliability wins here.
if (process.platform === 'win32') app.disableHardwareAcceleration();
// Native Wayland does not allow the absolute positioning this launcher needs.
// Use X11 directly, or XWayland inside a Wayland desktop.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

const HOME = 'https://chatgpt.com/';
const SIZE = { dot: 48, width: 380, height: 680, bar: 40, setup: 32 };
const PARTITION = 'persist:chatgpt-dot';
const UI_FILE = path.join(__dirname, 'renderer', 'index.html');
const UI_URL = pathToFileURL(UI_FILE).href;
let win, chat, preferences, preferencesFile, cssKey, saveTimer, dragTimer, drag;
let tray, trayTooltip = '';
let expanded = false;
let unread = 0;
let quitting = false;
let status = '';
let chatAttached = false;
let avatar = null, capturingAvatar = false;
let transition = null;
let phoneSize = { width: SIZE.width, height: SIZE.height };
let reducedMotion = false;
let motionSequence = 0;
let lastPreview = null;
let sleepTimer, sleeping = false, resumeUrl = null, mediaInUse = false, sleepRevision = 0;
const SLEEP_AFTER_MS = 60_000;
const popups = new Set();

function pageKey(value) {
  try { const u = new URL(value); return u.origin + u.pathname.replace(/\/$/, '') + u.search; }
  catch { return ''; }
}

function isSelected() {
  return !!chat && !!preferences.dotUrl && pageKey(chat.webContents.getURL()) === pageKey(preferences.dotUrl);
}

function readPreferences() {
  try {
    const saved = JSON.parse(fs.readFileSync(preferencesFile, 'utf8'));
    return {
      dotUrl: isChatGPT(saved.dotUrl) ? saved.dotUrl : null,
      memorySaver: saved.memorySaver !== false,
      position: Number.isFinite(saved.position?.x) && Number.isFinite(saved.position?.y)
        ? { x: Math.round(saved.position.x), y: Math.round(saved.position.y) } : null,
    };
  } catch { return { dotUrl: null, position: null, memorySaver: true }; }
}

function savePreferences() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(preferencesFile), { recursive: true });
    fs.writeFileSync(preferencesFile + '.tmp', JSON.stringify(preferences, null, 2));
    fs.renameSync(preferencesFile + '.tmp', preferencesFile);
    return true;
  } catch (error) {
    console.error('Could not save Dot preferences:', error.message);
    status = 'Could not save locally. Check folder permissions.';
    broadcast();
    return false;
  }
}

function fitBounds(position, width, height) {
  const area = screen.getDisplayNearestPoint(position).workArea;
  width = Math.min(width, area.width);
  height = Math.min(height, area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(position.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(position.y, area.y + area.height - height))),
    width, height,
  };
}

function barHeight() { return SIZE.bar + (preferences.dotUrl ? 0 : SIZE.setup); }

function state() {
  return { expanded, unread, saved: !!preferences.dotUrl, selected: isSelected(), status, avatar, sleeping, memorySaver: preferences.memorySaver,
    motion: transition ? (expanded ? 'opening' : 'closing') : null, phoneSize, barHeight: barHeight() };
}

async function refreshAppearance() {
  if (quitting || !chat || transition || !expanded || capturingAvatar || !isSelected()) return;
  capturingAvatar = true;
  const contents = chat.webContents;
  const url = contents.getURL();
  try {
    const rect = await contents.executeJavaScript(AVATAR_BOUNDS);
    if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(rect[key]))) return;
    if (rect.width < 24 || rect.width > 160 || rect.height < 24 || rect.height > 160) return;
    const picture = await contents.capturePage(rect);
    if (chat?.webContents === contents && isSelected() && contents.getURL() === url && !picture.isEmpty()) {
      avatar = picture.resize({ width: 40, height: 40 }).toDataURL();
      broadcast();
    }
  } catch { /* Keep the last colour while the avatar is loading or unavailable. */ }
  finally { capturingAvatar = false; }
}

function scheduleAppearance() {
  // Give both the page and its animated avatar time to paint. No background polling.
  for (const delay of [500, 1800, 4500]) setTimeout(refreshAppearance, delay);
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('dot:state', state());
  updateTray();
}

function updateTray() {
  if (!tray || tray.isDestroyed() || quitting) return;
  const tooltip = ['FloatDot', unread ? `${unread} unread` : '', sleeping ? 'Sleeping — unread detection paused' : '', 'Click to open · Right-click for Settings or Quit'].filter(Boolean).join('\n');
  if (tooltip !== trayTooltip) { tray.setToolTip(tooltip); trayTooltip = tooltip; }
}

function showFloatDot() {
  if (quitting || !win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  void setExpanded(true);
}

function createTray() {
  if (process.platform !== 'win32') return;
  try {
    // No GUID: unsigned development builds can move between directories.
    tray = new Tray(path.join(ICON_DIR, 'icon.ico'));
    tray.on('click', showFloatDot);
    tray.on('double-click', showFloatDot);
    // Build on demand so checked settings and navigation state are current.
    tray.on('right-click', () => tray.popUpContextMenu(createMenu()));
    updateTray();
  } catch (error) {
    // Keep a conventional way to reach the app if Windows cannot create a tray.
    win.setSkipTaskbar(false);
    console.warn('Could not create the FloatDot tray icon:', error.message);
  }
}

function concealSurface() {
  // Electron does not implement window opacity on Linux.
  if (process.platform === 'linux') win.hide();
  else win.setOpacity(0);
}

function revealSurface() {
  if (process.platform === 'linux') win.showInactive();
  else win.setOpacity(1);
}

function layout() {
  if (!chat) return;
  const showPage = expanded && !transition;
  // The live page is replaced by an in-memory image during motion. Resizing a
  // native transparent window on every frame stutters on Windows.
  if (showPage) {
    if (!chatAttached) { win.contentView.addChildView(chat); chatAttached = true; }
    const bounds = { x: 0, y: barHeight(), width: phoneSize.width, height: Math.max(1, phoneSize.height - barHeight()) };
    const previous = chat.getBounds();
    if (Object.keys(bounds).some(key => bounds[key] !== previous[key])) chat.setBounds(bounds);
  } else if (chatAttached) {
    // A hidden child view can leave a transparent Windows host unpainted.
    // Detaching its native surface keeps its webContents and session alive.
    win.contentView.removeChildView(chat);
    chatAttached = false;
  }
  chat.setVisible(showPage);
}

async function capturePreview() {
  if (!chat) return null;
  let deadline;
  const contents = chat.webContents;
  const url = contents.getURL();
  try {
    const picture = await Promise.race([
      contents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
      new Promise(resolve => { deadline = setTimeout(() => resolve(null), 120); }),
    ]);
    if (picture && !picture.isEmpty() && chat?.webContents === contents && contents.getURL() === url) lastPreview = picture.toDataURL();
  } catch { /* A loading page can use the last painted preview. */ }
  finally { clearTimeout(deadline); }
  return lastPreview;
}

function setExpanded(value) {
  if (quitting) return Promise.resolve();
  sleepRevision++;
  clearTimeout(sleepTimer);
  if (value && !chat) wakeChat();
  if (value === expanded) {
    if (value) { unread = 0; broadcast(); if (!transition) chat.webContents.focus(); }
    if (!value && !transition) scheduleSleep();
    return transition?.done || Promise.resolve();
  }
  // The dot's anchor is independent of the phone's clamped/dragged position.
  if (value && !transition) {
    const { x, y } = win.getBounds();
    preferences.position = { x, y };
    savePreferences();
  }
  expanded = value;
  chat?.webContents.send('dot:visibility', expanded);
  if (expanded) unread = 0;
  // Reverse the renderer's existing timeline instead of restarting it.
  if (transition) {
    const current = transition;
    if (current.phase === 'playing') win.webContents.send('dot:motion-play', { id: current.id, opening: value });
    else current.finish(); // Nothing has moved onscreen yet.
    broadcast();
    return current.done;
  }
  const anchor = preferences.position || win.getBounds();
  const dotBounds = fitBounds(anchor, SIZE.dot, SIZE.dot);
  const phoneBounds = value ? fitBounds(anchor, SIZE.width, SIZE.height) : win.getBounds();
  phoneSize = { width: phoneBounds.width, height: phoneBounds.height };
  const stage = {
    x: Math.min(dotBounds.x, phoneBounds.x), y: Math.min(dotBounds.y, phoneBounds.y),
    width: Math.max(dotBounds.x + dotBounds.width, phoneBounds.x + phoneBounds.width) - Math.min(dotBounds.x, phoneBounds.x),
    height: Math.max(dotBounds.y + dotBounds.height, phoneBounds.y + phoneBounds.height) - Math.min(dotBounds.y, phoneBounds.y),
  };
  let resolve;
  const done = new Promise(finish => { resolve = finish; });
  const current = { id: ++motionSequence, done, resolve, timer: null, phase: 'capturing', dotBounds, phoneBounds };
  transition = current;
  broadcast();

  const finish = () => {
    if (transition !== current) return;
    clearTimeout(current.timer);
    const destination = expanded ? current.phoneBounds : current.dotBounds;
    win.setBounds(destination);
    transition = null;
    layout();
    if (!expanded) {
      preferences.position = { x: destination.x, y: destination.y };
      savePreferences();
    }
    broadcast();
    revealSurface();
    if (expanded) { chat.webContents.focus(); scheduleAppearance(); }
    else win.webContents.focus();
    if (!expanded) scheduleSleep();
    resolve();
  };
  current.finish = finish;
  if (reducedMotion) { finish(); return done; }
  current.timer = setTimeout(finish, 2000); // Recover even if the renderer fails.
  void capturePreview().then(preview => {
    if (transition !== current || quitting) return;
    current.phase = 'preparing';
    // Hide the one native resize until the renderer has painted the start pose.
    concealSurface();
    layout();
    win.setBounds(stage);
    win.webContents.send('dot:motion-prepare', {
      id: current.id, opening: value, preview, duration: 420,
      phone: { ...phoneBounds, x: phoneBounds.x - stage.x, y: phoneBounds.y - stage.y },
      dot: { ...dotBounds, x: dotBounds.x - stage.x, y: dotBounds.y - stage.y },
    });
  });
  return done;
}

async function configureAdapter() {
  if (!chat || chat.webContents.isDestroyed()) return;
  const contents = chat.webContents;
  const enabled = isSelected() && isChatGPT(chat.webContents.getURL());
  contents.send('dot:configure-observer', { enabled, expanded });
  if (enabled && expanded) scheduleAppearance();
  try {
    if (cssKey) { await contents.removeInsertedCSS(cssKey); cssKey = null; }
    if (enabled && chat?.webContents === contents) cssKey = await contents.insertCSS(PHONE_CSS);
  } catch (error) { console.warn('ChatGPT layout could not be applied:', error.message); }
  broadcast();
}

function navigate(url) {
  if (!chat) createChat();
  sleeping = false;
  resumeUrl = url;
  const contents = chat.webContents;
  lastPreview = null;
  status = 'Loading ChatGPT…';
  broadcast();
  contents.loadURL(url).catch((error) => {
    if (error.code === 'ERR_ABORTED' || chat?.webContents !== contents) return;
    status = 'ChatGPT could not load. Right-click the dot or title bar to retry.';
    broadcast();
  });
}

function scheduleSleep() {
  const revision = ++sleepRevision;
  clearTimeout(sleepTimer);
  if (quitting || expanded || transition || !preferences.memorySaver || !chat) return;
  sleepTimer = setTimeout(async () => {
    if (!await sleepChat() && revision === sleepRevision) scheduleSleep();
  }, SLEEP_AFTER_MS);
}

async function sleepChat() {
  const view = chat;
  const revision = sleepRevision;
  const eligible = () => !quitting && view && chat === view && !expanded && !transition
    && revision === sleepRevision
    && preferences.memorySaver && !mediaInUse && popups.size === 0 && isSelected()
    && !view.webContents.isDestroyed() && !view.webContents.isLoading()
    && !view.webContents.isCurrentlyAudible();
  if (!eligible()) return false;
  const url = view.webContents.getURL();
  try {
    // Do not unload drafts, file attachments or a response that is still
    // generating. Unknown/loading pages stay alive; sleep is best effort.
    const busy = await view.webContents.executeJavaScript(`(() => {
      if (document.readyState !== 'complete' || !document.querySelector('main')) return true;
      if (document.querySelector('[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], [data-testid="attachment-preview"]')) return true;
      return [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="file"]')]
        .some(el => el.files?.length || (el.value || el.textContent || '').trim());
    })()`);
    if (busy || !eligible() || view.webContents.getURL() !== url) return false;
  } catch { return false; }
  clearTimeout(sleepTimer);
  resumeUrl = url;
  if (chatAttached) win.contentView.removeChildView(view);
  chatAttached = false;
  chat = null;
  sleeping = true;
  cssKey = null;
  lastPreview = null;
  status = 'Sleeping to save memory · Unread detection paused';
  view.webContents.close();
  broadcast();
  return true;
}

function wakeChat() {
  if (chat) return;
  navigate(resumeUrl || preferences.dotUrl || HOME);
  layout();
}

function setMemorySaver(enabled) {
  sleepRevision++;
  preferences.memorySaver = enabled === true;
  savePreferences();
  if (!preferences.memorySaver) { clearTimeout(sleepTimer); wakeChat(); }
  else scheduleSleep();
  broadcast();
}

function createMenu() {
  return Menu.buildFromTemplate([
    { label: expanded ? 'Collapse to dot' : 'Open FloatDot', click: () => { if (expanded) setExpanded(false); else showFloatDot(); } },
    { label: 'Go to my Dot', enabled: !!preferences.dotUrl, click: () => { navigate(preferences.dotUrl); setExpanded(true); } },
    { label: 'ChatGPT home / choose another conversation', click: () => { navigate(HOME); setExpanded(true); } },
    { label: 'Set current page as my Dot', visible: !!preferences.dotUrl, enabled: !!chat && !isSelected(), click: saveCurrent },
    { label: 'Back', enabled: !!chat && chat.webContents.navigationHistory.canGoBack(), click: () => chat?.webContents.navigationHistory.goBack() },
    { label: 'Reload page', click: () => { if (chat) chat.webContents.reload(); else wakeChat(); scheduleSleep(); } },
    { type: 'separator' },
    { label: 'Settings', submenu: [
      { label: 'Memory saver — lower RAM; badges pause after 60 seconds', type: 'radio', checked: preferences.memorySaver, click: () => setMemorySaver(true) },
      { label: 'Live updates — higher RAM; keeps checking for replies', type: 'radio', checked: !preferences.memorySaver, click: () => setMemorySaver(false) },
    ] },
    { label: sleeping ? 'Sleeping — click the dot to reload' : 'ChatGPT is loaded', enabled: false },
    { type: 'separator' },
    { label: 'Quit FloatDot', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ]);
}

function showMenu() { createMenu().popup({ window: win }); }

function installWebGuards(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'q' && (process.platform === 'darwin' ? input.meta : input.control)) {
      event.preventDefault();
      app.quit();
      return;
    }
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      setExpanded(false);
    }
  });
  guardNavigation(contents, url => shell.openExternal(url));
  contents.setWindowOpenHandler(({ url }) => {
    if (!httpsURL(url)) return { action: 'deny' };
    if (!isEmbeddedURL(url)) { shell.openExternal(url).catch(() => {}); return { action: 'deny' }; }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520, height: 720, parent: win, autoHideMenuBar: true, icon: APP_ICON,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, preload: undefined },
      },
    };
  });
  contents.on('did-create-window', (popup) => {
    popups.add(popup);
    popup.on('closed', () => popups.delete(popup));
    installWebGuards(popup.webContents);
  });
}

function fromUI(event) {
  return event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === UI_URL;
}

function updateDrag() {
  if (!drag) return;
  const cursor = screen.getCursorScreenPoint();
  const dx = cursor.x - drag.cursor.x, dy = cursor.y - drag.cursor.y;
  if (Math.hypot(dx, dy) > 5) drag.moved = true;
  if (drag.moved) win.setBounds(fitBounds({ x: drag.bounds.x + dx, y: drag.bounds.y + dy }, drag.bounds.width, drag.bounds.height));
}

function endDrag(cancel = false) {
  clearInterval(dragTimer);
  if (!cancel) updateDrag();
  const wasClick = drag && !drag.moved && !cancel;
  drag = null;
  if (wasClick) setExpanded(!expanded);
}

function saveCurrent() {
  if (!chat) return false;
  const url = chat.webContents.getURL();
  if (!isChatGPT(url) || /^\/auth(?:\/|$)/.test(new URL(url).pathname)) {
    status = 'Open your conversation on chatgpt.com first.';
    broadcast();
    return false;
  }
  const previous = preferences.dotUrl;
  preferences.dotUrl = url;
  if (!savePreferences()) { preferences.dotUrl = previous; broadcast(); return false; }
  status = '';
  avatar = null;
  unread = 0;
  lastPreview = null;
  layout();
  void configureAdapter();
  broadcast();
  return true;
}

function registerIPC() {
  ipcMain.handle('dot:get-state', (event) => fromUI(event) ? state() : null);
  ipcMain.on('dot:toggle', (event) => { if (fromUI(event)) setExpanded(!expanded); });
  ipcMain.on('dot:collapse', (event) => { if (fromUI(event)) setExpanded(false); });
  ipcMain.on('dot:menu', (event) => { if (fromUI(event)) showMenu(); });
  ipcMain.on('dot:reduced-motion', (event, value) => {
    if (!fromUI(event)) return;
    reducedMotion = value === true;
    if (reducedMotion && transition) transition.finish();
  });
  ipcMain.on('dot:motion-ready', (event, id) => {
    if (!fromUI(event) || transition?.id !== id || transition.phase !== 'preparing') return;
    transition.phase = 'playing';
    revealSurface();
    win.webContents.send('dot:motion-play', { id, opening: expanded });
  });
  ipcMain.on('dot:motion-finished', (event, data) => {
    if (fromUI(event) && transition?.id === data?.id && transition.phase === 'playing' && data.opening === expanded) transition.finish();
  });
  ipcMain.handle('dot:save-current', (event) => fromUI(event) ? saveCurrent() : false);
  ipcMain.on('dot:drag-start', (event, point) => {
    if (!fromUI(event) || transition) return;
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    endDrag(true);
    drag = { cursor: { x: point.x, y: point.y }, bounds: win.getBounds(), moved: false };
    dragTimer = setInterval(updateDrag, 16);
  });
  ipcMain.on('dot:drag-end', (event, cancel) => { if (fromUI(event)) endDrag(cancel === true); });
  ipcMain.on('dot:assistant-added', (event, data) => {
    if (!chat || event.sender !== chat.webContents || event.senderFrame !== chat.webContents.mainFrame) return;
    if (!isChatGPT(event.senderFrame.url) || !isSelected() || pageKey(data?.url) !== pageKey(preferences.dotUrl)) return;
    if (expanded || !Number.isInteger(data?.count) || data.count < 1 || data.count > 20) return;
    unread = Math.min(999, unread + data.count);
    broadcast();
  });
}

function createChat() {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION, preload: path.join(__dirname, 'chatgpt-adapter.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    },
  });
  chat = view;
  mediaInUse = false;
  const contents = view.webContents;
  installPermissions(contents, {
    canPrompt: () => !quitting && !win.isDestroyed() && expanded && win.isVisible(),
    onMediaAllowed: () => { if (chat === view) mediaInUse = true; },
    askMedia: async types => {
      const devices = types.map(type => type === 'audio' ? 'microphone' : 'camera').join(' and ');
      const result = await dialog.showMessageBox(win, {
        type: 'question', title: 'FloatDot permission',
        message: `Allow chatgpt.com to use your ${devices}?`,
        detail: 'Only allow this if you started a voice or camera feature. This choice lasts until the page navigates or FloatDot quits.',
        buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1;
    },
  });
  view.setBackgroundColor('#ffffff');
  view.setBounds({ x: 0, y: barHeight(), width: SIZE.width, height: SIZE.height - barHeight() });
  view.setVisible(false);
  installWebGuards(contents);
  contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (chat === view && isMainFrame) { sleepRevision++; clearTimeout(sleepTimer); }
  });
  // Same-document route changes can leave a microphone stream running. Only
  // a committed replacement document ends that conservative sleep exemption.
  contents.on('did-navigate', () => { if (chat === view) mediaInUse = false; });
  contents.on('dom-ready', () => {
    if (chat !== view) return;
    cssKey = null; lastPreview = null; void configureAdapter();
  });
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (chat === view && isMainFrame) { status = ''; void configureAdapter(); scheduleSleep(); }
  });
  contents.on('did-finish-load', () => {
    if (chat !== view) return;
    status = ''; broadcast(); scheduleAppearance(); scheduleSleep();
  });
  contents.on('render-process-gone', () => {
    if (chat !== view || quitting) return;
    status = 'ChatGPT stopped. Right-click the dot or title bar to reload.'; broadcast();
  });
  return view;
}

async function createWindow() {
  app.setAboutPanelOptions({
    applicationName: 'FloatDot', applicationVersion: app.getVersion(),
    copyright: 'Copyright (c) 2026 M0hamedd', iconPath: APP_ICON,
    credits: 'Your ChatGPT Dot, one click away.',
  });
  preferencesFile = path.join(app.getPath('userData'), 'dot-preferences.json');
  preferences = readPreferences();
  const area = screen.getPrimaryDisplay().workArea;
  const position = preferences.position || { x: area.x + area.width - 88, y: area.y + 100 };
  win = new BrowserWindow({
    ...fitBounds(position, SIZE.dot, SIZE.dot), title: 'FloatDot', icon: APP_ICON,
    frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true,
    resizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    autoHideMenuBar: true, show: false,
    skipTaskbar: process.platform === 'win32',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  if (process.platform === 'win32') {
    win.setAppDetails({
      appId: APP_ID, appIconPath: path.join(ICON_DIR, 'icon.ico'), appIconIndex: 0,
      relaunchDisplayName: 'FloatDot',
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
    });
  }
  if (process.platform === 'darwin') {
    app.dock.setIcon(APP_ICON);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu', label: 'FloatDot' },
      { role: 'editMenu' },
      { label: 'Window', submenu: [{ label: 'Show FloatDot', click: () => { win.show(); setExpanded(true); } }] },
    ]));
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else win.setMenu(null);
  const keepOnTop = () => {
    if (!quitting && !win.isDestroyed() && !win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(false);
      win.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating');
    }
  };
  if (process.platform === 'win32') {
    win.on('always-on-top-changed', (_event, onTop) => { if (!onTop) setImmediate(keepOnTop); });
  }
  win.on('show', keepOnTop);
  win.on('focus', keepOnTop);
  createChat();
  registerIPC();
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'q' && (process.platform === 'darwin' ? input.meta : input.control)) {
      event.preventDefault(); app.quit(); return;
    }
    if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); setExpanded(false); }
  });
  win.on('resize', layout);
  win.on('move', () => {
    if (expanded || transition) return;
    const { x, y } = win.getBounds();
    preferences.position = { x, y };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePreferences, 250);
  });
  win.on('blur', () => { endDrag(true); keepOnTop(); });
  // The collapse bar and Escape keep the dot alive. An operating-system Close
  // command (including Alt+F4 / taskbar Close) means quit the entire app.
  win.on('close', (event) => { if (!quitting) { event.preventDefault(); app.quit(); } });
  win.on('closed', () => {
    for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
    if (chat && !chat.webContents.isDestroyed()) chat.webContents.close();
    chat = null;
  });
  screen.on('display-removed', () => {
    if (transition) {
      transition.dotBounds = fitBounds(preferences.position || win.getBounds(), SIZE.dot, SIZE.dot);
      transition.phoneBounds = fitBounds(preferences.position || win.getBounds(), SIZE.width, SIZE.height);
      phoneSize = { width: transition.phoneBounds.width, height: transition.phoneBounds.height };
      transition.finish();
    }
    const bounds = win.getBounds();
    win.setBounds(fitBounds(bounds, bounds.width, bounds.height));
  });
  const uiReady = new Promise((resolve) => win.once('ready-to-show', resolve));
  await win.loadFile(UI_FILE);
  await uiReady;
  win.show();
  createTray();
  keepOnTop();
  // Windows may finish applying transparent-window styles after the first show.
  setTimeout(keepOnTop, 500);
  navigate(preferences.dotUrl || HOME);
  scheduleSleep();
  globalShortcut.register('CommandOrControl+Shift+D', () => { win.show(); setExpanded(!expanded); });
}

// The smoke runner uses an isolated profile; normal launches have no test hooks.
if (!app.isPackaged && process.env.DOT_SMOKE_PROFILE) app.setPath('userData', process.env.DOT_SMOKE_PROFILE);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showFloatDot);
  app.whenReady().then(createWindow).then(async () => {
    if (!app.isPackaged && process.env.DOT_SMOKE_PROFILE && process.env.DOT_SMOKE_RUNNER) {
      await require(process.env.DOT_SMOKE_RUNNER)({ app, win, chat, getChat: () => chat, getTray: () => tray, createMenu, setExpanded, state, preferences, savePreferences, fitBounds, configureAdapter, sleepChat, setMemorySaver });
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
app.on('activate', showFloatDot);
app.on('before-quit', () => {
  quitting = true;
  if (tray && !tray.isDestroyed()) tray.destroy();
  clearInterval(dragTimer);
  sleepRevision++;
  clearTimeout(sleepTimer);
  if (transition) { clearTimeout(transition.timer); transition.resolve(); }
  if (preferences) savePreferences();
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => app.quit());
