const { app, BrowserWindow, shell, Menu, dialog, session } = require('electron');
const path = require('path');

process.env.BADGE_DATA_DIR = path.join(app.getPath('userData'), 'data'); // survit aux mises à jour du logiciel
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit(); // une 2e fenêtre ne doit pas démarrer un 2e serveur

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

// ---- SteamCardExchange : fenêtre de connexion + lecture du texte des pages (session persistante) ----
// Pages Steam / SteamCardExchange : ouvertes dans une fenêtre de l'application (avec ta session déjà connectée), le reste dans le navigateur
const APP_HOSTS = /(^|\.)(steamcommunity\.com|steampowered\.com|steamcardexchange\.net)$/i;
function openInApp(url, title) {
  const w = new BrowserWindow({ width: 1200, height: 900, title: title || 'Steam', webPreferences: { partition: 'persist:sce' }, autoHideMenuBar: true });
  w.webContents.setWindowOpenHandler(({ url: u }) => routeUrl(u, w));
  w.loadURL(url);
  return w;
}
function routeUrl(u, from) {
  let host = '', proto = '';
  try { const x = new URL(u); host = x.hostname; proto = x.protocol; } catch { return { action: 'deny' }; }
  if ((proto === 'https:' || proto === 'http:') && APP_HOSTS.test(host)) { if (from) from.loadURL(u); else openInApp(u); return { action: 'deny' }; }
  if (proto === 'https:' || proto === 'http:' || proto === 'steam:') shell.openExternal(u);
  return { action: 'deny' };
}
// Exécuté dans la page du bot : panneau avec un bouton par carte (un clic = « Quick-Trade » de cette carte) ; rien n'est cliqué sans toi
function highlightCards(names, mode) {
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;z-index:99999;right:12px;top:12px;width:340px;max-height:85vh;overflow:auto;padding:12px;background:#0f172af2;color:#fff;font:13px/1.4 sans-serif;border:2px solid #22c55e;border-radius:12px;box-shadow:0 8px 30px #000a';
  const title = document.createElement('div'); title.style.cssText = 'font-weight:700;margin-bottom:8px';
  title.textContent = mode === 'sell' ? 'Cartes à vendre au bot (Make Offer)' : 'Cartes à prendre — un clic = Quick-Trade de la carte'; bar.appendChild(title);
  document.body.appendChild(bar);
  const row = (txt, ok, fn) => { const b = document.createElement('button'); b.textContent = txt; b.disabled = !fn; b.style.cssText = 'display:block;width:100%;margin:4px 0;padding:8px;border-radius:8px;border:1px solid ' + (ok ? '#22c55e' : '#64748b') + ';background:' + (ok ? '#14532d' : '#1e293b') + ';color:#fff;cursor:' + (fn ? 'pointer' : 'default') + ';text-align:left'; if (fn) b.onclick = () => fn(b); bar.appendChild(b); return b; };
  if (mode === 'sell') {
    for (const n of names) { const d = document.createElement('div'); d.textContent = '• ' + n; bar.appendChild(d); }
    const note = document.createElement('div'); note.style.cssText = 'margin-top:8px;color:#94a3b8'; note.textContent = 'Clique sur « Make Offer », choisis ces cartes dans ton inventaire puis valide.'; bar.appendChild(note);
    return;
  }
  const want = new Map(names.map((n) => [norm(n), n])), done = new Set();
  for (const e of document.querySelectorAll('body *')) {
    if (e.children.length || !e.textContent) continue;
    const k = norm(e.textContent); if (!want.has(k) || done.has(k)) continue;
    let box = e, btn = null;
    for (let i = 0; i < 6 && box.parentElement; i++) { box = box.parentElement; btn = [...box.querySelectorAll('a,button')].find((x) => /quick-?trade/i.test(x.textContent || '')); if (btn && (box.innerText || '').length < 500) break; btn = null; }
    done.add(k); box.style.outline = '4px solid #22c55e'; box.style.background = '#22c55e22';
    row((btn ? '⚡ Quick-Trade — ' : '⚠ bouton introuvable — ') + want.get(k), !!btn, btn ? (b) => { btn.click(); b.textContent = '✔ demandé — ' + want.get(k); b.disabled = true; } : null);
  }
  for (const [k, n] of want) if (!done.has(k)) row('⚠ carte introuvable sur la page — ' + n, false, null);
}
const sceBridge = {
  openGame(url, names, mode) {
    const w = openInApp(url, 'SteamCardExchange');
    w.webContents.on('did-finish-load', () => { setTimeout(() => w.webContents.executeJavaScript(`(${highlightCards.toString()})(${JSON.stringify(names)}, ${JSON.stringify(mode || 'buy')})`).catch(() => {}), 1800); });
  },
  fetch: (url) => session.fromPartition('persist:sce').fetch(url, { credentials: 'include', headers: { 'Accept-Language': 'en' } }), // requêtes avec ta session Steam
  open: () => new Promise((resolve) => {
    const w = new BrowserWindow({ width: 1100, height: 800, title: 'SteamCardExchange — connecte-toi avec Steam puis ferme cette fenêtre', webPreferences: { partition: 'persist:sce' }, autoHideMenuBar: true });
    w.loadURL('https://www.steamcardexchange.net/'); w.on('closed', resolve);
  }),
  async scrape(url, opts = {}) { // texte visible + liens ; avec { table: true } : affiche « All » dans le tableau et renvoie ses lignes
    const w = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:sce' } });
    try {
      await w.loadURL(url); await new Promise((r) => setTimeout(r, 2500));
      if (opts.table) {
        await w.webContents.executeJavaScript(`(async () => {
          const sel = document.querySelector('select[name$="_length"]');
          if (sel) { const all = [...sel.options].find((o) => /all|tous/i.test(o.text) || o.value === '-1') || sel.options[sel.options.length - 1]; sel.value = all.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          await new Promise((r) => setTimeout(r, 4000));
        })()`);
      }
      return await w.webContents.executeJavaScript(`({
        text: document.body.innerText.slice(0, 20000),
        links: [...document.querySelectorAll('a[href]')].slice(0, 400).map((a) => ({ t: (a.innerText || a.title || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60), h: a.href })),
        head: ${opts.table ? "[...document.querySelectorAll('table thead th')].map((th) => th.innerText.trim().replace(/\\s+/g, ' '))" : '[]'},
        sample: ${opts.table ? "(document.querySelector('table tbody tr') || {}).outerHTML || ''" : "''"},
        rows: ${opts.table ? "[...document.querySelectorAll('table tbody tr')].map((tr) => ({ c: [...tr.children].map((td) => td.innerText.trim().replace(/\\s+/g, ' ')), h: ((tr.outerHTML.match(/(?:appid[-=_:\"\\s]*|\\/apps\\/|\\/app\\/)(\\d{3,9})/i)) || [])[1] || '' }))" : 'null'}
      })`);
    } finally { w.destroy(); }
  },
};

let win, serverMod = null;
app.on('before-quit', () => { try { if (serverMod) serverMod.flush(); } catch {} }); // sauvegarde tout à la fermeture
async function createWindow() {
  const server = serverMod = require('./server');
  server.setSce(sceBridge);
  if (updater) server.setUpdater(updater); else server.setUpdater({ status: () => ({ ...u, status: 'dev' }), check: async () => { throw new Error('Mises à jour disponibles uniquement dans le logiciel installé.'); }, install() {} });
  const port = await server.start(38217); // port fixe si possible (préférences conservées), sinon un port libre
  win = new BrowserWindow({ width: 1320, height: 900, minWidth: 900, minHeight: 600, backgroundColor: '#0b1220',
    title: 'Steam Badge Trader', icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true });
  win.webContents.setWindowOpenHandler(({ url }) => routeUrl(url, null));
  win.on('closed', () => { for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch {} } }); // les fenêtres de pages Steam se ferment avec la fenêtre principale
  win.loadURL(`http://127.0.0.1:${port}/`);
  if (autoUpdater) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000); // simple vérification discrète au démarrage
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
if (gotLock) app.whenReady().then(() => { Menu.setApplicationMenu(null); return createWindow(); }).catch((e) => { dialog.showErrorBox('Steam Badge Trader', 'Démarrage impossible : ' + e.message); app.quit(); });
app.on('will-quit', () => { try { if (serverMod) serverMod.stop(); } catch {} });
app.on('window-all-closed', () => { app.quit(); setTimeout(() => process.exit(0), 4000).unref(); }); // garantit que le processus se termine vraiment
