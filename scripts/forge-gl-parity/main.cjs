// The parity run's Electron app: a hidden offscreen window (as the app's render page) with Node integration, which
// loads <data>/page.html (run.mjs bundles page.ts there) and quits with its exit code.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const dir = path.resolve(process.argv[process.argv.length - 1]);
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', (e) => console.log(e.message));
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('renderer gone', JSON.stringify(d));
    app.exit(3);
  });
  ipcMain.on('done', (_e, code) => app.exit(code));
  setTimeout(() => {
    console.log('timed out');
    app.exit(2);
  }, 15 * 60 * 1000);
  void win.loadFile(path.join(dir, 'page.html'), { query: { dir } });
});
