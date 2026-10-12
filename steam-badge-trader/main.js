const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

process.env.BADGE_DATA_DIR = path.join(app.getPath('userData'), 'data'); // survit aux mises à jour du logiciel
if (!app.requestSingleInstanceLock()) app.quit();

// ---- mise à jour depuis les Releases GitHub ----
const u = { status: 'idle', version: app.getVersion(), latest: null, progress: 0, error: null };
let autoUpdater = null;
if (app.isPackaged) {
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = false;
    autoUpdater.allowPrerelease = true;
    autoUpdater.on('checking-for-update', () => { u.status = 'checking'; });
    autoUpdater.on('update-available', (i) => { u.status = 'available'; u.latest = i.version; });
    autoUpdater.on('update-not-available', () => { u.status = 'none'; });
    autoUpdater.on('download-progress', (p) => { u.status = 'downloading'; u.progress = Math.round(p.percent); });
    autoUpdater.on('update-downloaded', () => { u.status = 'ready'; u.progress = 100; });
    autoUpdater.on('error', (e) => { u.status = 'error'; u.error = e.message; });
  } catch (e) { u.error = e.message; }
}
const updater = autoUpdater && {
  status: () => ({ ...u }),
  async check() {
    u.error = null;
    if (u.status === 'downloading' || u.status === 'ready') return;
    await autoUpdater.checkForUpdates();
    if (u.status === 'available') autoUpdater.downloadUpdate().catch((e) => { u.status = 'error'; u.error = e.message; }); // le bouton fait tout : chercher, télécharger, puis proposer l'installation
  },
  install: () => autoUpdater.quitAndInstall(true, true),
};

let win;
async function createWindow() {
  const server = require('./server');
  if (updater) server.setUpdater(updater); else server.setUpdater({ status: () => ({ ...u, status: 'dev' }), check: async () => { throw new Error('Mises à jour disponibles uniquement dans le logiciel installé.'); }, install() {} });
  const port = await server.start(38217).catch(() => server.start(0)); // port fixe : les préférences du navigateur intégré sont conservées
  win = new BrowserWindow({ width: 1320, height: 900, minWidth: 900, minHeight: 600, backgroundColor: '#0b1220',
    title: 'Steam Badge Trader', icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}/`);
  if (autoUpdater) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000); // simple vérification discrète au démarrage
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); });
app.on('window-all-closed', () => app.quit());
