// Real Windows tray/window lifecycle, with synthetic web content and a private
// test profile. The harness owns this process and all its descendants.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async ({ app, win, chat, getTray, createMenu, setExpanded, state, preferences }) => {
  const directory = path.dirname(process.env.DOT_SMOKE_PROFILE);
  const checks = [];
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await sleep(30);
    assert.ok(predicate(), 'Tray/window state must settle');
  };
  try {
    const tray = getTray();
    assert.ok(tray && !tray.isDestroyed());
    assert.equal(win.isVisible(), true);
    assert.equal(state().expanded, false);
    // Taskbar exclusion is configured through Electron's skipTaskbar API.
    // On Windows it uses ITaskbarList.DeleteTab, not WS_EX_TOOLWINDOW styles.
    checks.push('The app starts with a visible floating dot and a live Windows tray icon');

    await chat.webContents.session.protocol.handle('https', () => new Response('<!doctype html><main>Tray test</main>', { headers: { 'content-type': 'text/html' } }));
    await chat.webContents.loadURL('https://chatgpt.com/c/tray-test');
    win.minimize();
    await waitFor(() => win.isMinimized());
    tray.emit('click');
    await waitFor(() => state().expanded && !state().motion && !win.isMinimized());
    assert.equal(win.isVisible(), true);
    tray.emit('double-click');
    await sleep(100);
    assert.equal(state().expanded, true, 'A double-click must not immediately collapse the opened page');
    checks.push('Tray click restores and opens the app; a double-click leaves it open');
    await setExpanded(false);
    assert.equal(win.isVisible(), true);
    assert.equal(win.getBounds().width, 48);
    assert.ok(!tray.isDestroyed());
    checks.push('Collapsing keeps both the floating dot and tray available');

    let shownMenu;
    tray.popUpContextMenu = menu => { shownMenu = menu; };
    tray.emit('right-click');
    const settings = shownMenu.items.find(item => item.label === 'Settings').submenu;
    const live = settings.items.find(item => item.label.startsWith('Live updates'));
    const saver = settings.items.find(item => item.label.startsWith('Memory saver'));
    live.click();
    assert.equal(preferences.memorySaver, false);
    assert.equal(createMenu().items.find(item => item.label === 'Settings').submenu.items.find(item => item.label.startsWith('Live updates')).checked, true);
    saver.click();
    assert.equal(preferences.memorySaver, true);
    checks.push('Tray right-click uses current Settings; both memory modes can be selected');

    app.once('will-quit', () => {
      assert.equal(tray.isDestroyed(), true, 'Quit must remove the tray icon');
      checks.push('Tray Quit stops the application and destroys its icon');
      fs.writeFileSync(path.join(directory, 'tray-result.json'), JSON.stringify({ passed: true, checks }, null, 2));
    });
    shownMenu.items.find(item => item.label === 'Quit FloatDot').click();
  } catch (error) {
    fs.writeFileSync(path.join(directory, `tray-failure-${Date.now()}.json`), JSON.stringify({ passed: false, checks, error: error.stack }, null, 2));
    app.exit(1);
  }
};
