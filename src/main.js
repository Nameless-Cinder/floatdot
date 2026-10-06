const { app, BrowserWindow, WebContentsView, ipcMain, Menu, screen, shell, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PHONE_CSS, AVATAR_BOUNDS } = require('./chatgpt-adapter');

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
const popups = new Set();

function isChatGPT(value) {
  try { const u = new URL(value); return u.origin === 'https://chatgpt.com' && !u.username && !u.password; }
  catch { return false; }
}

function pageKey(value) {
  try { const u = new URL(value); return u.origin + u.pathname.replace(/\/$/, '') + u.search; }
  catch { return ''; }
}

function isSelected() {
  return !!preferences.dotUrl && pageKey(chat.webContents.getURL()) === pageKey(preferences.dotUrl);
}

function readPreferences() {
  try {
    const saved = JSON.parse(fs.readFileSync(preferencesFile, 'utf8'));
    return {
      dotUrl: isChatGPT(saved.dotUrl) ? saved.dotUrl : null,
      position: Number.isFinite(saved.position?.x) && Number.isFinite(saved.position?.y)
        ? { x: Math.round(saved.position.x), y: Math.round(saved.position.y) } : null,
    };
  } catch { return { dotUrl: null, position: null }; }
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
  return { expanded, unread, saved: !!preferences.dotUrl, selected: isSelected(), status, avatar,
    motion: transition ? (expanded ? 'opening' : 'closing') : null, phoneSize, barHeight: barHeight() };
}

async function refreshAppearance() {
  if (quitting || transition || !expanded || capturingAvatar || !isSelected()) return;
  capturingAvatar = true;
  const url = chat.webContents.getURL();
  try {
    const rect = await chat.webContents.executeJavaScript(AVATAR_BOUNDS);
    if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(rect[key]))) return;
    if (rect.width < 24 || rect.width > 160 || rect.height < 24 || rect.height > 160) return;
    const picture = await chat.webContents.capturePage(rect);
    if (isSelected() && chat.webContents.getURL() === url && !picture.isEmpty()) {
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
  let deadline;
  const url = chat.webContents.getURL();
  try {
    const picture = await Promise.race([
      chat.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
      new Promise(resolve => { deadline = setTimeout(() => resolve(null), 120); }),
    ]);
    if (picture && !picture.isEmpty() && chat.webContents.getURL() === url) lastPreview = picture.toDataURL();
  } catch { /* A loading page can use the last painted preview. */ }
  finally { clearTimeout(deadline); }
  return lastPreview;
}

function setExpanded(value) {
  if (value === expanded) {
    if (value) { unread = 0; broadcast(); if (!transition) chat.webContents.focus(); }
    return transition?.done || Promise.resolve();
  }
  // The dot's anchor is independent of the phone's clamped/dragged position.
  if (value && !transition) {
    const { x, y } = win.getBounds();
    preferences.position = { x, y };
    savePreferences();
  }
  expanded = value;
  chat.webContents.send('dot:visibility', expanded);
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
  if (chat.webContents.isDestroyed()) return;
  const enabled = isSelected() && isChatGPT(chat.webContents.getURL());
  chat.webContents.send('dot:configure-observer', { enabled, expanded });
  if (enabled && expanded) scheduleAppearance();
  try {
    if (cssKey) { await chat.webContents.removeInsertedCSS(cssKey); cssKey = null; }
    if (enabled) cssKey = await chat.webContents.insertCSS(PHONE_CSS);
  } catch (error) { console.warn('ChatGPT layout could not be applied:', error.message); }
  broadcast();
}

function navigate(url) {
  lastPreview = null;
  status = 'Loading ChatGPT…';
  broadcast();
  chat.webContents.loadURL(url).catch((error) => {
    if (error.code === 'ERR_ABORTED') return;
    status = 'ChatGPT could not load. Right-click the dot or title bar to retry.';
    broadcast();
  });
}

function showMenu() {
  Menu.buildFromTemplate([
    { label: expanded ? 'Collapse to dot' : 'Open FloatDot', click: () => setExpanded(!expanded) },
    { label: 'Go to my Dot', enabled: !!preferences.dotUrl, click: () => { navigate(preferences.dotUrl); setExpanded(true); } },
    { label: 'ChatGPT home / choose another conversation', click: () => { navigate(HOME); setExpanded(true); } },
    { label: 'Set current page as my Dot', visible: !!preferences.dotUrl, enabled: !isSelected(), click: saveCurrent },
    { label: 'Back', enabled: chat.webContents.navigationHistory.canGoBack(), click: () => chat.webContents.navigationHistory.goBack() },
    { label: 'Reload page', click: () => chat.webContents.reload() },
    { type: 'separator' },
    { label: 'Quit FloatDot', click: () => app.quit() },
  ]).popup({ window: win });
}

function installWebGuards(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      setExpanded(false);
    }
  });
  // Permit ordinary HTTPS login redirects, but never load privileged local URLs.
  contents.on('will-navigate', (event, url) => { if (!url.startsWith('https://')) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!url.startsWith('https://')) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    let hostname;
    try { const target = new URL(url); if (target.protocol !== 'https:') return { action: 'deny' }; hostname = target.hostname; }
    catch { return { action: 'deny' }; }
    const loginHost = hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')
      || hostname === 'openai.com' || hostname.endsWith('.openai.com')
      || ['accounts.google.com', 'appleid.apple.com', 'account.apple.com', 'login.live.com', 'login.microsoftonline.com'].includes(hostname);
    if (!loginHost) { shell.openExternal(url).catch(console.error); return { action: 'deny' }; }
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
    if (event.sender !== chat.webContents || event.senderFrame !== chat.webContents.mainFrame) return;
    if (!isChatGPT(event.senderFrame.url) || !isSelected() || pageKey(data?.url) !== pageKey(preferences.dotUrl)) return;
    if (expanded || !Number.isInteger(data?.count) || data.count < 1 || data.count > 20) return;
    unread = Math.min(999, unread + data.count);
    broadcast();
  });
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
  chat = new WebContentsView({
    webPreferences: {
      partition: PARTITION, preload: path.join(__dirname, 'chatgpt-adapter.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    },
  });
  chat.setBackgroundColor('#ffffff');
  chat.setBounds({ x: 0, y: barHeight(), width: SIZE.width, height: SIZE.height - barHeight() });
  chat.setVisible(false);
  registerIPC();
  installWebGuards(chat.webContents);
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); setExpanded(false); }
  });
  chat.webContents.on('dom-ready', () => { cssKey = null; lastPreview = null; void configureAdapter(); });
  chat.webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) { status = ''; void configureAdapter(); }
  });
  chat.webContents.on('did-finish-load', () => { status = ''; broadcast(); scheduleAppearance(); });
  chat.webContents.on('render-process-gone', () => { status = 'ChatGPT stopped. Right-click the dot or title bar to reload.'; broadcast(); });
  win.on('resize', layout);
  win.on('move', () => {
    if (expanded || transition) return;
    const { x, y } = win.getBounds();
    preferences.position = { x, y };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePreferences, 250);
  });
  win.on('blur', () => { endDrag(true); keepOnTop(); });
  win.on('close', (event) => { if (!quitting) { event.preventDefault(); setExpanded(false); } });
  win.on('closed', () => {
    for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
    if (!chat.webContents.isDestroyed()) chat.webContents.close();
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
  keepOnTop();
  // Windows may finish applying transparent-window styles after the first show.
  setTimeout(keepOnTop, 500);
  navigate(preferences.dotUrl || HOME);
  globalShortcut.register('CommandOrControl+Shift+D', () => { win.show(); setExpanded(!expanded); });
}

// The smoke runner uses an isolated profile; normal launches have no test hooks.
if (!app.isPackaged && process.env.DOT_SMOKE_PROFILE) app.setPath('userData', process.env.DOT_SMOKE_PROFILE);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.show(); setExpanded(true); } });
  app.whenReady().then(createWindow).then(async () => {
    if (!app.isPackaged && process.env.DOT_SMOKE_PROFILE && process.env.DOT_SMOKE_RUNNER) {
      await require(process.env.DOT_SMOKE_RUNNER)({ app, win, chat, setExpanded, state, preferences, savePreferences, fitBounds, configureAdapter });
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
app.on('activate', () => { if (win && !win.isDestroyed()) { win.show(); setExpanded(true); } });
app.on('before-quit', () => {
  quitting = true;
  clearInterval(dragTimer);
  if (transition) { clearTimeout(transition.timer); transition.resolve(); }
  if (preferences) savePreferences();
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => app.quit());
