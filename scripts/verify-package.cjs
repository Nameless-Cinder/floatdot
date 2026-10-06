// Inspect the distributable, not the working directory: no local browser data
// or diagnostics may accidentally reach someone who downloads the app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

(async () => {
  const asar = await import('@electron/asar');
  const root = path.resolve(__dirname, '..');
  const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
  const archivePath = file => file.split('/').join(path.sep);
  const expected = [
    'LICENSE.md', 'NOTICE.md', 'package.json', 'src/main.js',
    'src/chatgpt-adapter.js', 'src/preload.js', 'src/renderer/app.js',
    'src/renderer/index.html', 'src/renderer/style.css',
  ].sort();
  const files = asar.listPackage(archive, { isPack: false })
    .map(file => file.replaceAll('\\', '/').replace(/^\/+/, ''))
    .filter(file => !asar.statFile(archive, archivePath(file)).files).sort();
  assert.deepEqual(files, expected, 'Packaged files must match the public app allowlist');
  for (const file of files.filter(file => file !== 'package.json')) {
    assert.ok(asar.extractFile(archive, archivePath(file)).equals(fs.readFileSync(path.join(root, file))), `${file} differs from the reviewed source`);
  }
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(metadata.name, 'floatdot');
  assert.equal(metadata.productName, 'FloatDot');
  assert.equal(metadata.license, 'PolyForm-Noncommercial-1.0.0');
  assert.equal(metadata.main, 'src/main.js');
  assert.ok(!metadata.dependencies || Object.keys(metadata.dependencies).length === 0);
  for (const icon of ['icon.png', 'icon.ico']) {
    assert.ok(fs.readFileSync(path.join(root, 'dist', 'win-unpacked', 'resources', 'icons', icon))
      .equals(fs.readFileSync(path.join(root, 'assets', icon))), `Packaged ${icon} differs from the source`);
  }
  assert.ok(fs.existsSync(path.join(root, 'dist', 'win-unpacked', 'FloatDot.exe')), 'The Windows executable must be named FloatDot');
  const installer = `floatdot-${metadata.version}-win-x64.exe`;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(path.join(root, 'dist', installer))) hash.update(chunk);
  const result = { passed: true, files, installer, sha256: hash.digest('hex') };
  fs.writeFileSync(path.join(root, '.smoke', 'package-audit.json'), JSON.stringify(result, null, 2));
  console.log(`Package verified: ${files.length} app/license files; no profiles, screenshots, test runners or development dependencies.`);
})().catch(error => {
  fs.writeFileSync(path.join(__dirname, '..', '.smoke', `package-failure-${Date.now()}.json`), JSON.stringify({ passed: false, error: error.stack }, null, 2));
  console.error(error.message);
  process.exitCode = 1;
});
