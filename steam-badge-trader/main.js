const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

process.env.BADGE_DATA_DIR = path.join(app.getPath('userData'), 'data');
if (!app.requestSingleInstanceLock()) app.quit();

let win;
async function createWindow() {
  const { start } = require('./server');
  const port = await start(0);
  win = new BrowserWindow({ width: 1320, height: 900, minWidth: 900, minHeight: 600, backgroundColor: '#0b1220',
    title: 'Steam Badge Trader', icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}/`);
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); });
app.on('window-all-closed', () => app.quit());
