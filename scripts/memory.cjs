// Isolated lifecycle checks: synthetic content only; no real account or drafts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async ({ app, win, chat, getChat, setExpanded, state, preferences, sleepChat, setMemorySaver }) => {
  const directory = path.dirname(process.env.DOT_SMOKE_PROFILE);
  const checks = [];
  const metrics = {};
  const waitFor = async (predicate, timeout = 5000) => {
    const until = Date.now() + timeout;
    while (!predicate() && Date.now() < until) await sleep(50);
    assert.ok(predicate(), 'Lifecycle operation must finish within its deadline');
  };
  const snapshot = () => app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type, memory: p.memory }));
  try {
    const fixture = '<!doctype html><main><p>Memory test</p><textarea></textarea></main>';
    const session = chat.webContents.session;
    await session.protocol.handle('https', () => new Response(fixture, { headers: { 'content-type': 'text/html' } }));
    await chat.webContents.loadURL('https://chatgpt.com/c/memory-test');
    await setExpanded(true);
    await win.webContents.executeJavaScript('window.dot.saveCurrent()');
    setMemorySaver(true);
    await chat.webContents.executeJavaScript('localStorage.setItem("memory-session", "retained"); window.scratch = new Uint8Array(64 * 1024 * 1024); window.scratch.fill(7)');
    await session.cookies.set({ url: 'https://chatgpt.com', name: 'memory-test', value: 'retained', secure: true });
    assert.equal(await sleepChat(), false, 'An expanded page cannot sleep');
    await setExpanded(false);
    await chat.webContents.executeJavaScript('document.querySelector("textarea").value = "Unsent draft"');
    assert.equal(await sleepChat(), false, 'Sleep must preserve unsent drafts');
    await chat.webContents.executeJavaScript('document.querySelector("textarea").value = ""; document.querySelector("main").insertAdjacentHTML("beforeend", "<button data-testid=stop-button>Stop</button>")');
    assert.equal(await sleepChat(), false, 'Sleep must preserve an active response');
    await chat.webContents.executeJavaScript('document.querySelector("button").remove()');
    checks.push('Expanded pages, unsent drafts and recognized active responses are not unloaded');

    setMemorySaver(false);
    assert.equal(await sleepChat(), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DOT_SMOKE_PROFILE, 'dot-preferences.json'))).memorySaver, false);
    setMemorySaver(true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DOT_SMOKE_PROFILE, 'dot-preferences.json'))).memorySaver, true);
    checks.push('Both modes persist; Live updates prevents sleeping');
    for (const action of [
      async () => { await setExpanded(true); await setExpanded(false); },
      async () => { setMemorySaver(false); setMemorySaver(true); },
      async () => { await chat.webContents.executeJavaScript('history.pushState({}, "", location.href)'); },
    ]) {
      const execute = chat.webContents.executeJavaScript;
      let resolveProbe;
      chat.webContents.executeJavaScript = () => new Promise(resolve => { resolveProbe = resolve; });
      const oldProbe = sleepChat();
      chat.webContents.executeJavaScript = execute;
      await action();
      resolveProbe(false);
      assert.equal(await oldProbe, false, 'A stale sleep probe must not override a new idle period');
    }
    checks.push('Reopening, mode changes and navigation invalidate an already pending sleep probe');
    setMemorySaver(true);
    const anchor = { ...preferences.position };
    metrics.loaded = snapshot();
    const oldContents = chat.webContents;
    const oldId = oldContents.id;
    const oldPid = oldContents.getOSProcessId();
    const started = Date.now();
    // Exercise the actual production 60-second timer, including its full delay.
    await sleep(58_000);
    assert.equal(state().sleeping, false, 'Must not sleep before 60 seconds');
    await waitFor(() => state().sleeping, 8000);
    metrics.sleepAfterMs = Date.now() - started;
    await waitFor(() => oldContents.isDestroyed());
    await waitFor(() => !app.getAppMetrics().some(p => p.pid === oldPid));
    assert.equal(getChat(), null);
    assert.deepEqual(preferences.position, anchor);
    assert.equal(win.getBounds().width, 48);
    await sleep(500);
    metrics.sleeping = snapshot();
    checks.push('After 60 seconds the ChatGPT webContents and renderer process exit; the dot and anchor remain');

    await setExpanded(true);
    const resumed = getChat().webContents;
    await waitFor(() => !resumed.isLoading() && resumed.getURL() === 'https://chatgpt.com/c/memory-test');
    assert.notEqual(resumed.id, oldId);
    assert.equal(await resumed.executeJavaScript('localStorage.getItem("memory-session")'), 'retained');
    assert.equal((await session.cookies.get({ name: 'memory-test' }))[0].value, 'retained');
    assert.equal(await resumed.executeJavaScript('typeof window.scratch'), 'undefined');
    assert.equal(state().sleeping, false);
    assert.equal(await resumed.executeJavaScript('Notification.requestPermission()'), 'denied');
    checks.push('Opening recreates only the page, preserving URL, browser storage/cookies and permission protections');

    await setExpanded(false);
    assert.equal(await sleepChat(), true);
    setMemorySaver(false);
    await waitFor(() => !!getChat() && !getChat().webContents.isLoading());
    assert.equal(state().sleeping, false);
    assert.equal(state().expanded, false);
    assert.equal(await sleepChat(), false);
    checks.push('Switching to Live updates wakes the page in the background without expanding the dot');

    // The real close event should reach app.quit, not collapse/reopen the dot.
    const resultPath = path.join(directory, 'memory-result.json');
    const failTimer = setTimeout(() => { throw new Error('OS Close did not quit'); }, 3000);
    app.once('will-quit', () => {
      clearTimeout(failTimer);
      checks.push('Operating-system Close quits the application');
      fs.writeFileSync(resultPath, JSON.stringify({ passed: true, checks, metrics }, null, 2));
    });
    win.close();
  } catch (error) {
    fs.writeFileSync(path.join(directory, `memory-failure-${Date.now()}.json`), JSON.stringify({ passed: false, checks, metrics, error: error.stack }, null, 2));
    app.exit(1);
  }
};
