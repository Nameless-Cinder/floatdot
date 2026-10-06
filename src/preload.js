const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dot', {
  getState: () => ipcRenderer.invoke('dot:get-state'),
  toggle: () => ipcRenderer.send('dot:toggle'),
  collapse: () => ipcRenderer.send('dot:collapse'),
  menu: () => ipcRenderer.send('dot:menu'),
  saveCurrent: () => ipcRenderer.invoke('dot:save-current'),
  startDrag: (point) => ipcRenderer.send('dot:drag-start', { x: point.x, y: point.y }),
  endDrag: (cancel) => ipcRenderer.send('dot:drag-end', cancel === true),
  setReducedMotion: (value) => ipcRenderer.send('dot:reduced-motion', value === true),
  motionReady: (id) => ipcRenderer.send('dot:motion-ready', id),
  motionFinished: (id, opening) => ipcRenderer.send('dot:motion-finished', { id, opening }),
  onMotionPrepare: (callback) => ipcRenderer.on('dot:motion-prepare', (_event, value) => callback(value)),
  onMotionPlay: (callback) => ipcRenderer.on('dot:motion-play', (_event, value) => callback(value)),
  onState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('dot:state', listener);
    return () => ipcRenderer.removeListener('dot:state', listener);
  },
});
