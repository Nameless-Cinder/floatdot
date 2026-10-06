// Generate platform icons from the vector master with Electron's renderer.
// No image library, remote request or account profile is required.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');
app.setPath('userData', path.join(root, '.smoke', 'icon-profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('data:text/html,<html></html>');
    const svg = fs.readFileSync(path.join(assets, 'floatdot.svg'), 'utf8');
    const imageUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const pngUrl = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image(); image.src = ${JSON.stringify(imageUrl)};
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
      canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024);
      return canvas.toDataURL('image/png');
    })()`);
    const master = nativeImage.createFromDataURL(pngUrl);
    if (master.isEmpty()) throw new Error('Icon render is empty');
    const png = size => master.resize({ width: size, height: size, quality: 'best' }).toPNG();
    fs.writeFileSync(path.join(assets, 'icon.png'), png(1024));

    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
    const frames = sizes.map(png);
    const header = Buffer.alloc(6 + 16 * sizes.length);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    frames.forEach((frame, index) => {
      const entry = 6 + index * 16;
      header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
      header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(frame.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
      offset += frame.length;
    });
    fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, ...frames]));

    const types = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
    const chunks = Object.entries(types).map(([type, size]) => {
      const data = png(size), chunkHeader = Buffer.alloc(8);
      chunkHeader.write(type); chunkHeader.writeUInt32BE(8 + data.length, 4);
      return Buffer.concat([chunkHeader, data]);
    });
    const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns');
    icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    fs.writeFileSync(path.join(assets, 'icon.icns'), Buffer.concat([icnsHeader, ...chunks]));
    fs.writeFileSync(path.join(root, '.smoke', 'icon-preview.png'), png(256));
    console.log('Generated FloatDot PNG, Windows ICO and macOS ICNS icons from assets/floatdot.svg');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
