// Basic sanity checks only. Uses an isolated profile and synthetic DOM after
// checking the public ChatGPT page; this does not claim real-account acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async ({ app, win, chat, setExpanded, state, preferences, savePreferences, configureAdapter }) => {
  const directory = path.dirname(process.env.DOT_SMOKE_PROFILE);
  const checks = [];
  let failed = false;
  const report = (name) => { checks.push(name); fs.writeFileSync(path.join(directory, 'progress.json'), JSON.stringify(checks, null, 2)); };
  const runJS = (code) => chat.webContents.executeJavaScript(code);
  const settleMotion = async () => {
    await sleep(20); // Let the local bridge deliver the click first.
    const deadline = Date.now() + 3000;
    while (state().motion && Date.now() < deadline) await sleep(20);
    assert.equal(state().motion, null, 'Window transition must finish');
  };
  const capture = async (contents, name) => {
    try { fs.writeFileSync(path.join(directory, name + '.png'), (await contents.capturePage()).toPNG()); }
    catch (error) { fs.writeFileSync(path.join(directory, name + '-capture-error.txt'), String(error)); }
  };
  try {
    if (process.env.DOT_SMOKE_QUICK === '1') {
      const end = Date.now() + 180000;
      while (!fs.existsSync(path.join(directory, 'finish-ui')) && Date.now() < end) {
        fs.writeFileSync(path.join(directory, 'native-state.json'), JSON.stringify({ bounds: win.getBounds(), visible: win.isVisible(), topmost: win.isAlwaysOnTop(), state: state() }, null, 2));
        await sleep(500);
      }
      return;
    }
    if (process.env.DOT_SMOKE_RESTART === '1') {
      assert.equal(preferences.dotUrl, 'https://chatgpt.com/c/dot-smoke');
      assert.deepEqual(preferences.position, { x: 140, y: 140 });
      const storageFile = path.join(chat.webContents.session.storagePath, 'Local Storage');
      assert.ok(fs.existsSync(storageFile));
      await chat.webContents.session.protocol.handle('https', () => new Response('<html><body>Restart probe</body></html>', { headers: { 'content-type': 'text/html' } }));
      await chat.webContents.loadURL(preferences.dotUrl);
      assert.equal(await runJS('localStorage.getItem("dot-smoke-persistence")'), 'persisted');
      report('Restart restored selected URL, position and persistent web storage (not a real login)');
    } else {
      await sleep(900);
      assert.equal(win.getBounds().width, 48);
      assert.equal(win.getBounds().height, 48);
      fs.writeFileSync(path.join(directory, 'native-state.json'), JSON.stringify({ bounds: win.getBounds(), visible: win.isVisible(), topmost: win.isAlwaysOnTop(), focused: win.isFocused() }, null, 2));
      assert.ok(win.isAlwaysOnTop());
      assert.equal(chat.getVisible(), false);
      await sleep(300);
      await capture(win.webContents, 'dot');
      await win.webContents.executeJavaScript('document.querySelector("#dot").click()');
      await settleMotion();
      assert.equal(state().expanded, true);
      assert.equal(win.getBounds().width, 380);
      assert.equal(win.getBounds().height, 680);
      report('48px always-on-top dot, local bridge and 380×680 expansion');

      const deadline = Date.now() + 25000;
      while (chat.webContents.isLoading() && Date.now() < deadline) await sleep(300);
      const publicPage = { url: chat.webContents.getURL(), title: chat.webContents.getTitle(), loading: chat.webContents.isLoading() };
      fs.writeFileSync(path.join(directory, 'public-page.json'), JSON.stringify(publicPage, null, 2));
      await capture(chat.webContents, 'chatgpt');
      report('Attempted live ChatGPT load; inspect public-page.json and chatgpt.png');
      assert.ok(chat.webContents.session.isPersistent());
      for (const contents of [win.webContents, chat.webContents]) {
        const web = contents.getLastWebPreferences();
        assert.equal(web.contextIsolation, true);
        assert.equal(web.nodeIntegration, false);
        assert.equal(web.sandbox, true);
      }
      report('Persistent session and sandboxed, isolated renderers');

      const fixture = '<!doctype html><html><body><main><article data-testid="conversation-turn-0"><div data-message-author-role="assistant" data-message-id="old">Existing response</div></article></main></body></html>';
      await chat.webContents.session.protocol.handle('https', () => new Response(fixture, { headers: { 'content-type': 'text/html' } }));
      await chat.webContents.loadURL('https://chatgpt.com/c/dot-smoke');
      await win.webContents.executeJavaScript('window.dot.saveCurrent()');
      assert.equal(preferences.dotUrl, 'https://chatgpt.com/c/dot-smoke');
      assert.deepEqual(await runJS('[typeof require, typeof window.dot]'), ['undefined', 'undefined']);
      await runJS('window.liveSentinel = 123; localStorage.setItem("dot-smoke-persistence", "persisted")');
      await sleep(2300);
      await setExpanded(false);
      await sleep(300);
      assert.equal(state().unread, 0);
      await runJS('document.querySelector("main").insertAdjacentHTML("beforeend", \'<article data-testid="conversation-turn-1"><div data-message-author-role="assistant" data-message-id="new"></div></article>\')');
      await sleep(250);
      assert.equal(state().unread, 0);
      await runJS('document.querySelector("[data-message-id=new]").textContent = "First streaming token"');
      await sleep(350);
      assert.equal(state().unread, 1);
      await runJS('document.querySelector("[data-message-id=new]").textContent += " and more tokens"');
      await sleep(350);
      assert.equal(state().unread, 1);
      await runJS('document.querySelector("main").insertAdjacentHTML("afterbegin", \'<article data-testid="conversation-turn-older"><div data-message-author-role="assistant" data-message-id="older">Older history</div></article>\')');
      await sleep(350);
      assert.equal(state().unread, 1);
      await runJS('document.querySelector("main").insertAdjacentHTML("beforeend", \'<article data-testid="conversation-turn-2"><div data-message-author-role="user">My message</div></article><article data-testid="conversation-turn-3"><div data-message-author-role="assistant" data-message-id="newer">Second response</div></article>\')');
      await sleep(350);
      assert.equal(state().unread, 2);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("#badge").textContent'), '2');
      report('Hidden-page MutationObserver → IPC → badge; streaming counted once; prepended history ignored');
      await capture(win.webContents, 'badge');
      await win.webContents.executeJavaScript('document.querySelector("#dot").click()');
      await settleMotion();
      assert.equal(state().unread, 0);
      assert.equal(await runJS('window.liveSentinel'), 123);
      report('Expand clears unread and preserves the exact live page');
      chat.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' });
      await settleMotion();
      assert.equal(state().expanded, false);
      await setExpanded(true);
      await win.webContents.executeJavaScript('document.querySelector("#titlebar").click()');
      await settleMotion();
      assert.equal(state().expanded, false);
      report('Escape in web contents and title-bar activation both collapse');

      const area = screen.getPrimaryDisplay().workArea;
      win.setPosition(area.x + area.width - 48, area.y + area.height - 48);
      await setExpanded(true);
      const bounds = win.getBounds();
      assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);
      report('Expansion at monitor edge stays inside work area');

      // Exercise navigation reset and documented fallback independently.
      await chat.webContents.loadURL('https://chatgpt.com/c/other');
      await runJS('document.querySelector("main").innerHTML = "<article data-testid=conversation-turn-0>" + "x".repeat(90) + "</article>"');
      await win.webContents.executeJavaScript('window.dot.saveCurrent()');
      await sleep(2200);
      await setExpanded(false);
      await runJS('document.querySelector("main").insertAdjacentHTML("beforeend", "<article data-testid=conversation-turn-1>" + "y".repeat(90) + "</article>")');
      await sleep(350);
      assert.equal(state().unread, 1);
      report('Route change resets observer; substantial-turn heuristic works');

      preferences.dotUrl = 'https://chatgpt.com/c/dot-smoke';
      win.setPosition(140, 140);
      await sleep(350);
      savePreferences();
      await chat.webContents.session.flushStorageData();
      if (process.env.DOT_SMOKE_INTERACTIVE === '1') {
        report('Ready for manual Windows drag/click check; create finish-ui file to end');
        const end = Date.now() + 180000;
        while (!fs.existsSync(path.join(directory, 'finish-ui')) && Date.now() < end) await sleep(500);
        await setExpanded(false);
        win.setPosition(140, 140);
        await sleep(350);
        savePreferences();
      }
    }
    fs.writeFileSync(path.join(directory, process.env.DOT_SMOKE_RESTART ? 'restart-result.json' : 'result.json'), JSON.stringify({ passed: true, checks }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ passed: false, checks, error: error.stack }, null, 2));
    failed = true;
  } finally {
    if (failed) app.exit(1);
    else app.quit();
  }
};
