// Focused regressions for the actual Dot markup and the collapsed position.
// All messages below are synthetic and only loaded into the isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async ({ app, win, chat, setExpanded, state, preferences }) => {
  const checks = [];
  const animationTimings = [];
  const directory = path.dirname(process.env.DOT_SMOKE_PROFILE);
  const run = (code) => chat.webContents.executeJavaScript(code);
  let failed = false;
  try {
    const fixture = '<!doctype html><main><main id="messages"><article class="message-row" data-message-id="old"><div class="message-body" data-message-id="old"><div class="message-text">Earlier reply</div></div></article></main></main>';
    await chat.webContents.session.protocol.handle('https', () => new Response(fixture, { headers: { 'content-type': 'text/html' } }));
    await chat.webContents.loadURL('https://chatgpt.com/dots/regression');
    await run('window.liveSentinel = 123');
    // Exercise motion even on a machine whose OS preference disables it.
    await win.webContents.executeJavaScript('window.dot.setReducedMotion(false)');
    await sleep(50);
    const area = screen.getPrimaryDisplay().workArea;
    const anchor = { x: area.x + area.width - 58, y: area.y + area.height - 58 };
    win.setPosition(anchor.x, anchor.y);
    await sleep(350);
    for (let cycle = 0; cycle < 3; cycle++) {
      await win.webContents.executeJavaScript(`
        window.motionFrames = []; window.probeMotion = true;
        requestAnimationFrame(function measure(time) {
          if (document.body.dataset.motion === 'opening') window.motionFrames.push({ time, transform: getComputedStyle(document.querySelector('#phone')).transform });
          if (window.probeMotion) requestAnimationFrame(measure);
        });
      `);
      const samples = [];
      const sample = setInterval(() => samples.push({ window: win.getBounds(), page: chat.getBounds() }), 16);
      try { await setExpanded(true); }
      finally { clearInterval(sample); }
      const frames = await win.webContents.executeJavaScript('window.probeMotion = false; window.motionFrames');
      assert.ok(new Set(frames.map(frame => frame.transform)).size >= 8, 'The renderer must animate intermediate transforms');
      const gaps = frames.slice(1).map((frame, i) => frame.time - frames[i].time).sort((a, b) => a - b);
      animationTimings.push({ frames: frames.length, medianFrameMs: gaps[Math.floor(gaps.length / 2)], maxFrameMs: Math.max(...gaps) });
      assert.ok(new Set(samples.map(frame => JSON.stringify(frame.window))).size <= 2, 'Native bounds must remain fixed during playback');
      for (let i = 1; i < samples.length; i++) {
        assert.deepEqual(samples[i].page, samples[0].page, 'Chat viewport must not reflow during animation');
      }
      assert.equal(await run('window.liveSentinel'), 123);
      assert.equal(chat.getVisible(), true);
      assert.equal(win.getOpacity(), 1);
      win.setPosition(area.x + 30 + cycle * 10, area.y + 30);
      await sleep(150);
      await setExpanded(false);
      const bounds = win.getBounds();
      assert.deepEqual({ x: bounds.x, y: bounds.y }, anchor);
      assert.deepEqual(preferences.position, anchor);
    }
    checks.push('Dot anchor survives monitor-edge clamping and dragging the expanded phone across three cycles');
    checks.push('Renderer transforms animate while native window and ChatGPT viewport remain fixed; the same live page returns');

    const interrupted = setExpanded(true);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await win.webContents.executeJavaScript('document.body.dataset.motion') === 'opening') break;
      await sleep(20);
    }
    await sleep(80);
    const beforeReverse = win.getBounds();
    const reversed = setExpanded(false);
    assert.deepEqual(win.getBounds(), beforeReverse, 'Reversing must start at the current frame');
    await Promise.all([interrupted, reversed]);
    assert.deepEqual(win.getBounds(), { ...anchor, width: 48, height: 48 });
    assert.equal(state().motion, null);
    assert.equal(chat.getVisible(), false);
    checks.push('Rapid reversal returns to the anchor and detaches the chat surface');
    const preparing = setExpanded(true);
    await setExpanded(false);
    await preparing;
    await sleep(180);
    assert.deepEqual(win.getBounds(), { ...anchor, width: 48, height: 48 });
    assert.equal(win.getOpacity(), 1);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#dot").hidden'), false);
    checks.push('Cancelling before the first frame cannot flash the full phone or leave the window invisible');

    await win.webContents.executeJavaScript('window.dot.setReducedMotion(true)');
    await sleep(50);
    await setExpanded(true);
    assert.equal(state().motion, null);
    assert.equal(win.getBounds().width, 380);
    await setExpanded(false);
    assert.deepEqual(win.getBounds(), { ...anchor, width: 48, height: 48 });
    await win.webContents.executeJavaScript('window.dot.setReducedMotion(false)');
    await sleep(50);
    checks.push('Reduced motion skips the transition and preserves the final bounds');

    await setExpanded(true);
    await win.webContents.executeJavaScript('window.dot.saveCurrent()');
    await sleep(2200);
    const add = async (id, text, self = false, prepend = false) => {
      const markup = `<article class="message-row${self ? ' self' : ''}" data-message-id="${id}"><div class="message-body" data-message-id="${id}"><div class="message-text">${text}</div></div></article>`;
      await run(`document.querySelector('#messages').insertAdjacentHTML(${JSON.stringify(prepend ? 'afterbegin' : 'beforeend')}, ${JSON.stringify(markup)})`);
      await sleep(350);
    };
    await add('stream', 'First token');
    assert.equal(state().unread, 0);
    await setExpanded(false);
    await sleep(100);
    await run('document.querySelector("[data-message-id=stream] .message-text").textContent += " continues after collapse"');
    await sleep(350);
    assert.equal(state().unread, 1);
    await run('document.querySelector("[data-message-id=stream] .message-text").textContent += " with more tokens"');
    await sleep(350);
    assert.equal(state().unread, 1);
    checks.push('Reply starting while expanded produces one badge when streaming continues while collapsed');
    await add('user', 'My message', true);
    assert.equal(state().unread, 1);
    await add('reply', '');
    assert.equal(state().unread, 1);
    await run('document.querySelector("[data-message-id=reply] .message-text").textContent = "OK"');
    await sleep(350);
    assert.equal(state().unread, 2);
    await add('older', 'Older loaded history', false, true);
    assert.equal(state().unread, 2);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#badge").textContent'), '2');
    checks.push('Actual Dot row selectors count short replies once, excluding self messages, empty rows, nested duplicate IDs and prepended history');
    await setExpanded(true);
    assert.equal(state().unread, 0);
    await add('visible-reply', 'Already read');
    await setExpanded(false);
    await sleep(350);
    assert.equal(state().unread, 0);
    checks.push('Opening clears unread; collapsing without new text does not count an already visible reply');
    await sleep(300);
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.DOT_SMOKE_PROFILE, 'dot-preferences.json'), 'utf8'));
    assert.deepEqual(saved.position, anchor);
    checks.push('Persisted coordinates remain the dot anchor');
    fs.writeFileSync(path.join(directory, 'regression-result.json'), JSON.stringify({ passed: true, checks, animationTimings }, null, 2));
  } catch (error) {
    failed = true;
    fs.writeFileSync(path.join(directory, `regression-failure-${Date.now()}.json`), JSON.stringify({ passed: false, checks, animationTimings, error: error.stack }, null, 2));
  } finally {
    if (failed) app.exit(1);
    else app.quit();
  }
};
