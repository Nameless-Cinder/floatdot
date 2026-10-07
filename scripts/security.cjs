// Exercise origin boundaries and asynchronous permission decisions without
// accessing an account, microphone, camera, clipboard or external browser.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { isEmbeddedURL, isChatGPT, guardNavigation, installPermissions } = require('../src/web-policy');

async function run() {
  const checks = [];
  const trustedURL = 'https://chatgpt.com/c/test';
  for (const url of [trustedURL, 'https://auth.openai.com/authorize', 'https://accounts.google.com/']) assert.ok(isEmbeddedURL(url));
  for (const url of ['https://chatgpt.com.evil.test/', 'https://evil.chatgpt.com/', 'https://chatgpt.com:444/',
    'https://user:pass@chatgpt.com/', 'http://chatgpt.com/', 'file:///secret', 'javascript:alert(1)',
    'data:text/html,test', 'https://openai.com/', 'https://example.com/', 'invalid']) assert.ok(!isEmbeddedURL(url), url);
  assert.ok(!isChatGPT('https://auth.openai.com/'));
  checks.push('Exact origin allowlist rejects lookalikes, credentials, alternate ports and unsafe schemes');

  const contents = new EventEmitter();
  const opened = [];
  guardNavigation(contents, async url => { opened.push(url); });
  function navigate(name, url, main = true) {
    let blocked = false;
    contents.emit(name, { preventDefault() { blocked = true; } }, url, false, main);
    return blocked;
  }
  assert.equal(navigate('will-navigate', trustedURL), false);
  assert.equal(navigate('will-navigate', 'https://example.com/'), true);
  assert.deepEqual(opened, ['https://example.com/']);
  assert.equal(navigate('will-navigate', 'file:///secret'), true);
  assert.equal(navigate('will-redirect', 'https://evil.test/'), true);
  assert.equal(navigate('will-redirect', 'https://accounts.google.com/'), false);
  assert.equal(navigate('will-redirect', 'https://cdn.test/', false), false);
  assert.equal(opened.length, 1, 'Blocked redirects and unsafe schemes must not launch other apps');
  checks.push('External navigation leaves the widget; unrelated redirects and unsafe schemes are blocked');

  let url = trustedURL, destroyed = false, visible = true, decision = false, prompts = 0;
  const handlers = {};
  contents.getURL = () => url;
  contents.isDestroyed = () => destroyed;
  contents.session = {
    setPermissionCheckHandler(fn) { handlers.check = fn; },
    setPermissionRequestHandler(fn) { handlers.request = fn; },
    setDevicePermissionHandler(fn) { handlers.device = fn; },
    setDisplayMediaRequestHandler(fn) { handlers.display = fn; },
  };
  installPermissions(contents, { canPrompt: () => visible, askMedia: async () => { prompts++; return typeof decision === 'function' ? decision() : decision; } });
  const details = { requestingUrl: trustedURL, isMainFrame: true, securityOrigin: 'https://chatgpt.com', mediaTypes: ['audio'], mediaType: 'audio' };
  const check = (permission = 'media', sender = contents, overrides = {}, origin = 'https://chatgpt.com') => handlers.check(sender, permission, origin, { ...details, ...overrides });
  const request = (permission = 'media', sender = contents, overrides = {}) => new Promise(resolve => handlers.request(sender, permission, resolve, { ...details, ...overrides }));
  for (const permission of ['notifications', 'geolocation', 'clipboard-read', 'display-capture', 'fileSystem', 'usb', 'hid', 'serial', 'openExternal', 'unknown', 'local-network', 'loopback-network']) {
    assert.equal(check(permission), false, permission);
    assert.equal(await request(permission), false, permission);
  }
  assert.equal(handlers.device({ origin: 'https://chatgpt.com' }), false);
  handlers.display({}, value => assert.equal(value, null));
  assert.equal(check('clipboard-sanitized-write'), true);
  assert.equal(await request('clipboard-sanitized-write'), true);
  assert.equal(prompts, 0);
  checks.push('Permissions, devices, screen capture and unknown capabilities are denied; safe copy remains available');

  for (const sender of [null, {}]) {
    assert.equal(check('media', sender), false);
    assert.equal(await request('media', sender), false);
  }
  for (const overrides of [{ isMainFrame: false }, { requestingUrl: 'https://evil.test/' }, { securityOrigin: 'https://evil.test' }, { requestingUrl: undefined }]) {
    assert.equal(check('media', contents, overrides), false);
    assert.equal(await request('media', contents, overrides), false);
  }
  assert.equal(check('media', contents, {}, 'https://evil.test'), false);
  for (const mediaTypes of [undefined, [], ['unknown'], ['audio', 'display']]) assert.equal(await request('media', contents, { mediaTypes }), false);
  visible = false;
  assert.equal(await request(), false);
  visible = true;
  assert.equal(prompts, 0);
  checks.push('Popups, workers, subframes, foreign origins, hidden requests and malformed media requests are denied');

  assert.equal(check(), false);
  assert.equal(await request(), false);
  decision = true;
  assert.equal(await request(), true);
  assert.equal(check(), true);
  assert.equal(check('media', contents, { mediaType: 'video' }), false);
  assert.equal(check('media', contents, { mediaType: 'unknown' }), false);
  const prior = prompts;
  assert.equal(await request(), true);
  assert.equal(prompts, prior);
  contents.emit('did-start-navigation', {}, trustedURL, false, true);
  assert.equal(check(), false);
  checks.push('Media requires explicit approval; microphone consent cannot grant camera; navigation clears consent');

  let finish;
  decision = () => new Promise(resolve => { finish = resolve; });
  let pending = request();
  assert.equal(await request(), false, 'Concurrent prompts must be denied');
  // Navigate away and back while the consent dialog is pending.
  contents.emit('did-start-navigation', {}, 'https://auth.openai.com/', false, true);
  contents.emit('did-start-navigation', {}, trustedURL, false, true);
  finish(true);
  assert.equal(await pending, false);
  pending = request();
  destroyed = true;
  finish(true);
  assert.equal(await pending, false);
  destroyed = false;
  pending = request();
  visible = false;
  finish(true);
  assert.equal(await pending, false);
  visible = true;
  decision = () => { throw new Error('Dialog closed'); };
  assert.equal(await request(), false);
  checks.push('Navigation races, destroyed pages, hidden windows, duplicate prompts and dialog errors fail closed');
  console.log(`Security policy: ${checks.length} groups passed.`);
  const out = path.join(__dirname, '..', '.smoke');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'security-result.json'), JSON.stringify({ passed: true, checks }, null, 2));
}
run().catch(error => {
  const out = path.join(__dirname, '..', '.smoke');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `security-failure-${Date.now()}.json`), JSON.stringify({ error: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
});
