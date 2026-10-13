const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

// lecteur .env minimal (utile en mode développeur)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*([^#]*?)\s*(#.*)?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const DATA_DIR = process.env.BADGE_DATA_DIR || path.join(os.homedir(), '.steam-badge-trader');
process.env.BADGE_DATA_DIR = DATA_DIR;
const config = require('./lib/config');
const steam = require('./lib/steam');
const demo = require('./lib/demo');
const trader = require('./lib/trader');
const engine = require('./lib/engine');
const sce = require('./lib/sce');
const { S } = engine;

const base = { ...process.env };
let env = {};
const lbUrl = () => String(env.LEADERBOARD_URL || '').replace(/\/+$/, '');
const reloadEnv = () => { env = { ...base, ...config.load(DATA_DIR) }; };
reloadEnv();
const isDemo = () => base.DEMO === '1' || !env.STEAM_API_KEY;
const cfg = () => ({ key: env.STEAM_API_KEY, profile: env.STEAM_PROFILE, currency: Number(env.CURRENCY || 3), botProfile: env.BOT_PROFILE || engine.BOT_DEFAULT, botOnly: env.BOT_ONLY !== '0', onDone: submitIfJoined });
// Si tu as rejoint le classement, tes stats sont renvoyées au serveur après chaque analyse.
function submitIfJoined() {
  if (env.LB_JOINED !== '1' || !lbUrl() || !S.profile) return;
  fetch(lbUrl() + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steamid: S.profile.steamid }), signal: AbortSignal.timeout(8000) }).catch(() => {});
}
let updater = null;
const setUpdater = (u) => { updater = u; };
const setSce = (b) => { sce.setBridge(b); if (b.fetch) steam.setAuthFetch(b.fetch); };

const app = express();
// L'app n'écoute qu'en local ; on refuse aussi les requêtes venant d'un autre site (DNS rebinding / CSRF).
app.use((req, res, next) => {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).end('forbidden');
  const origin = req.headers.origin;
  if (origin && origin.replace(/^https?:\/\//, '') !== host) return res.status(403).end('forbidden');
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/art/avatar.svg', (_, res) => res.type('svg').send(demo.svgAvatar()));
app.get('/art/banner/:appid.svg', (req, res) => res.type('svg').send(demo.svgBanner(req.params.appid)));
app.get('/art/:appid/:i.svg', (req, res) => res.type('svg').set('Cache-Control', 'public,max-age=86400').send(demo.svgCard(req.params.appid, Number(req.params.i))));

let started = false;
setInterval(() => { if (S.wishlist.length) engine.checkWishes().catch(() => {}); }, 30 * 60e3).unref(); // liste de souhaits : revérifiée toutes les 30 min
function ensureStarted() {
  if (started) return;
  started = true;
  if (isDemo()) return engine.loadDemo();
  sce.reset();
  engine.loadSaved(); // affichage immédiat de tout ce qui est en mémoire
  if (!engine.badgesFresh()) { // au lancement : seule la page de badges du profil est lue ; cartes, boosters, gemmes… se lancent avec les boutons de scan
    engine.scanBadges(cfg()).then(() => { if (env.AUTO_CARDS === '1' && S.profile) engine.scanCards(cfg()); });
  } else if (env.AUTO_CARDS === '1' && !engine.isFresh()) engine.scanCards(cfg());
}
const settingsView = () => ({ creditsBalance: env.CREDITS_BALANCE, creditsPerCard: env.CREDITS_PER_CARD, creditValue: env.CREDIT_VALUE });
app.get('/api/state', (_, res) => {
  ensureStarted();
  res.json({ ...engine.snapshot(settingsView()), theme: env.THEME || 'nuit', seenSetup: env.SEEN_SETUP === '1', version: updater ? updater.status().version : null,
    update: updater ? updater.status() : null, leaderboard: { url: !!env.LEADERBOARD_URL, joined: env.LB_JOINED === '1' } });
});
app.post('/api/refresh', (_, res) => { // « Tout actualiser » : badges puis cartes
  started = true;
  const already = S.running && !isDemo();
  if (isDemo()) engine.loadDemo(); else engine.run(cfg()); // les sets déjà analysés sont relus depuis le cache
  res.json({ ok: true, already });
});
// Boutons de scan : chacun lance une tâche indépendante dont la progression est dans /api/state (tasks)
const scanFn = (k) => { const c = cfg(); return { badges: () => engine.scanBadges(c), cards: () => engine.scanCards(c), boosters: () => engine.scanBoosters(c), gems: () => engine.scanGems(c),
  bot: () => engine.refreshBot(), friends: () => engine.scanFriends(c), balance: () => engine.scanBalance(), verify: () => engine.scanVerify({ cfg: c }), prices: () => engine.scanPrices() }[k]; };
app.post('/api/scan/:task', (req, res) => {
  const k = req.params.task, fn = scanFn(k);
  if (!fn) return res.status(400).json({ error: 'Scan inconnu' });
  if (isDemo() && !['verify', 'friends', 'prices'].includes(k)) engine.demoScan(k); else Promise.resolve(fn()).catch((e) => { S.error = e.message; });
  res.json({ ok: true });
});
// ---- planificateur : lance les scans choisis une fois par jour à l'heure indiquée (l'app doit être ouverte) ----
const SCHED_DEFAULT = 'badges,cards,bot,balance,verify', sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let schedBusy = false;
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
async function runScheduled() {
  schedBusy = true;
  try {
    ensureStarted();
    for (const k of (env.SCHED_TASKS || SCHED_DEFAULT).split(',').filter(Boolean)) {
      const fn = scanFn(k); if (!fn) continue;
      try { await fn(); } catch { /* on passe au suivant */ }
      while (S.tasks[k] && S.tasks[k].state === 'running') await sleepMs(2000);
    }
  } finally { schedBusy = false; }
}
setInterval(() => {
  if (schedBusy || isDemo() || env.SCHED_ON !== '1') return;
  const [h, m] = String(env.SCHED_TIME || '03:00').split(':').map(Number), now = new Date();
  if (env.SCHED_LAST === todayStr() || now.getHours() * 60 + now.getMinutes() < h * 60 + (m || 0)) return;
  config.save(DATA_DIR, { SCHED_LAST: todayStr() }); reloadEnv(); // « fait aujourd'hui » avant de commencer : pas de double lancement
  runScheduled().catch(() => {});
}, 60e3).unref();
app.get('/api/auto/data', (_, res) => { try { res.json(engine.autoData()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/auto/plan', (req, res) => { try { res.json(engine.autoPlan(req.body.asks || [], req.body.gives || [], req.body.mode)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/auto/open', (req, res) => { try { res.json(sce.openGame(Number(req.body.appid), (req.body.names || []).map(String).slice(0, 60), req.body.mode === 'sell' ? 'sell' : 'buy')); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/friends/needs', (_, res) => { try { res.json(engine.friendNeeds()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/botcheck', (_, res) => { if (isDemo()) { Promise.resolve(engine.scanVerify({ all: true, force: true, cfg: cfg() })).catch(() => {}); } else Promise.resolve(engine.scanVerify({ all: true, force: true, cfg: cfg() })).catch((e) => { S.error = e.message; }); res.json({ ok: true }); });
app.get('/api/goal', (req, res) => { try { res.json(engine.goalPlan(req.query.level)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/spare', (_, res) => { try { res.json(engine.spareReport()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/event/add', (req, res) => { try { engine.eventAdd(req.body.name, req.body.start, req.body.end); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/event/remove', (req, res) => { engine.eventRemove(String(req.body.id)); res.json({ ok: true }); });
app.get('/api/compare/:id', (req, res) => { try { res.json(engine.compareFriend(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/rare', (_, res) => { try { res.json({ list: engine.rareTargets() }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/journal/add', (req, res) => { try { engine.journalAdd(req.body || {}); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/journal/remove', (req, res) => { engine.journalRemove(String(req.body.id)); res.json({ ok: true }); });
app.post('/api/wish/add', (req, res) => { try { engine.wishAdd(String(req.body.hash)); engine.checkWishes().catch(() => {}); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/wish/remove', (req, res) => { engine.wishRemove(String(req.body.hash)); res.json({ ok: true }); });
app.post('/api/wish/check', async (_, res) => { await engine.checkWishes(); res.json({ ok: true }); });
app.post('/api/wish/target', (req, res) => { try { engine.wishTarget(String(req.body.hash), req.body.target); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/alert/set', (req, res) => { try { engine.alertSet(Number(req.body.appid), req.body.target); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/deals', (_, res) => res.json(engine.deals(env.CREDIT_VALUE)));
// ---- sauvegarde / export ----
const EXPORT_KEYS = ['STEAM_PROFILE', 'CURRENCY', 'THEME', 'BOT_ONLY', 'AUTO_CARDS', 'CREDITS_BALANCE', 'CREDITS_PER_CARD', 'CREDIT_VALUE', 'LEADERBOARD_URL']; // jamais de clé API ni de mot de passe dans l'export
app.get('/api/export', (_, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="steam-badge-trader-sauvegarde.json"');
  res.json({ app: 'steam-badge-trader', v: 1, exportedAt: new Date().toISOString(), settings: Object.fromEntries(EXPORT_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])), ...engine.exportData() });
});
app.get('/api/export.csv', (_, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="steam-badge-trader-sets.csv"');
  res.send(engine.setsCsv());
});
app.post('/api/import', (req, res) => {
  try {
    const d = req.body && req.body.data; if (!d || d.app !== 'steam-badge-trader') throw new Error('Ce fichier n\'est pas une sauvegarde de Steam Badge Trader.');
    engine.importData(d);
    if (d.settings) { const ok = {}; for (const k of EXPORT_KEYS) if (k in d.settings && !['STEAM_PROFILE', 'CURRENCY', 'LEADERBOARD_URL'].includes(k)) ok[k] = String(d.settings[k]).slice(0, 200); config.save(DATA_DIR, ok); reloadEnv(); }
    res.json({ ok: true, wishlist: S.wishlist.length, alerts: S.alerts.length, history: S.history.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/scan/:task/cancel', (req, res) => { engine.cancel(req.params.task); res.json({ ok: true }); });
app.post('/api/game/:appid/check', async (req, res) => { // vérification manuelle d'un jeu : stock du bot carte par carte + prix
  try { res.json(await engine.checkGameAll(Number(req.params.appid), cfg(), Number(env.CREDITS_PER_CARD) || 0, req.body && req.body.only)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/update/check', async (_, res) => {
  if (!updater) return res.status(400).json({ error: 'Les mises à jour automatiques ne fonctionnent que dans le logiciel installé (pas en mode développeur).' });
  try { await updater.check(); res.json(updater.status()); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/update/install', (_, res) => { if (!updater) return res.status(400).json({ error: 'Indisponible' }); res.json({ ok: true }); setTimeout(() => updater.install(), 400); });

// ---- boosters ----
app.post('/api/boosters/open', async (req, res) => {
  try {
    if (req.body.confirmed !== true) throw new Error('Ouverture non validée.');
    const { assetid, appid } = req.body;
    if (isDemo()) return res.json({ cards: ['Héros', 'Mage', 'Dragon'].map((n, i) => ({ name: n, img: `/art/${appid}/${i}.svg`, foil: false })), left: 0 });
    const cards = await trader.openBooster(Number(appid), assetid);
    const i = S.boosters.findIndex((b) => String(b.assetid) === String(assetid));
    if (i >= 0) S.boosters.splice(i, 1);
    engine.saveState();
    res.json({ cards });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- gemmes : prix des boosters, valeur d'une carte, fabrication d'un booster ----
app.post('/api/gems/catalog', async (_, res) => {
  try {
    if (isDemo()) { engine.demoCatalog(); return res.json({ ok: true }); }
    engine.setCatalog(await trader.boosterCatalog()); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/gems/list', (_, res) => res.json({ t: S.catalog.t, gems: S.catalog.gems, list: engine.catalogList() }));
app.post('/api/gems/value', async (req, res) => {
  try {
    const appid = Number(req.body.appid);
    if (isDemo()) { if (S.gemVal[appid] == null) engine.setGemValue(appid, 12); return res.json({ gemValue: S.gemVal[appid] }); }
    const card = S.myCards.find((c) => c.appid === appid);
    if (!card) throw new Error('Aucune carte de ce jeu dans ton inventaire : lance d\'abord le scan « Cartes & sets ».');
    const r = await trader.gemValue(appid, card.assetid);
    engine.setGemValue(appid, r.gemValue); res.json({ gemValue: r.gemValue });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/gems/craft', async (req, res) => {
  try {
    const appid = Number(req.body.appid), cat = S.catalog.map[appid];
    if (req.body.confirmed !== true) throw new Error('Fabrication non validée : confirme-la dans l\'application.');
    if (isDemo()) { if (cat) { if (S.catalog.gems.total < cat.price) throw new Error(`Pas assez de gemmes : il en faut ${cat.price}, tu en as ${S.catalog.gems.total}.`); S.catalog.gems.total -= cat.price; } return res.json({ ok: true, totalGems: S.catalog.gems.total, demo: true }); }
    if (!cat) throw new Error('Prix inconnu : charge d\'abord le catalogue de boosters.');
    if (cat.unavailable) throw new Error('Ce booster n\'est pas disponible pour le moment (délai après une fabrication).');
    if (S.catalog.gems.total < cat.price) throw new Error(`Pas assez de gemmes : il en faut ${cat.price}, tu en as ${S.catalog.gems.total}.`);
    const r = await trader.createBooster(appid);
    S.catalog.gems = { total: r.totalGems, tradable: r.tradableGems, untradable: r.untradableGems };
    engine.journalAdd({ type: 'craft', text: `Booster fabriqué : ${cat.name || 'jeu ' + appid} (${cat.price} gemmes)`, auto: true });
    S.invT = 0; engine.saveState(); // l'inventaire a changé : le prochain scan le relira
    res.json({ ok: true, totalGems: r.totalGems, item: r.resultItem || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- classements ----
app.post('/api/rank/scan', (_, res) => { engine.scanRank(cfg()); res.json({ ok: true }); });
let globalCache = { t: 0, list: [] };
app.get('/api/rank/global', async (_, res) => {
  try {
    if (isDemo()) return res.json({ list: ['Zed', 'Mia', 'Kai', 'Lou', 'Noa'].map((n, i) => ({ name: n, avatar: '/art/avatar.svg', level: 80 - i * 9, badgeCount: 400 - i * 50, rarity: 900 - i * 120, steamid: 'g' + i })), demo: true });
    if (!lbUrl()) return res.json({ list: [], missing: true });
    if (Date.now() - globalCache.t > 30e3) globalCache = { t: Date.now(), list: (await (await fetch(lbUrl() + '/top?limit=100', { signal: AbortSignal.timeout(8000) })).json()).list || [] };
    res.json({ list: globalCache.list });
  } catch (e) { res.status(400).json({ error: 'Serveur de classement injoignable : ' + e.message }); }
});
app.post('/api/rank/join', async (_, res) => {
  try {
    if (isDemo()) return res.json({ ok: true });
    if (!lbUrl()) throw new Error('Renseigne l\'adresse du serveur de classement dans les Réglages.');
    if (!S.profile) throw new Error('Profil pas encore chargé : patiente la fin de la lecture.');
    const r = await fetch(lbUrl() + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steamid: S.profile.steamid }), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Refusé par le serveur');
    config.save(DATA_DIR, { LB_JOINED: '1' }); reloadEnv(); globalCache.t = 0;
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/bot/refresh', (_, res) => { engine.refreshBot(); res.json({ ok: true }); });
app.post('/api/friends/scan', (_, res) => { engine.scanFriends(cfg()); res.json({ ok: true }); });

const parseTrade = (u) => {
  const m = String(u).match(/partner=(\d+)/);
  if (!m) throw new Error('Lien d\'échange invalide (il doit contenir partner=… et token=…)');
  return (BigInt(m[1]) + 76561197960265728n).toString();
};

// Prépare l'échange à partir du panier : cartes (hash) de n'importe quels jeux ; la source (bot / ami / lien) fournit ce qu'elle a.
app.post('/api/trade/preview', async (req, res) => {
  try {
    const { source, tradeUrl, friendId } = req.body;
    let hashes = Array.isArray(req.body.hashes) ? req.body.hashes : [];
    if (req.body.appid) { const set = S.sets.find((x) => x.appid === Number(req.body.appid)); hashes = set ? set.cards.filter((c) => !c.owned).map((c) => c.hash) : []; } // compat : « tout le set »
    if (!hashes.length) throw new Error('Le panier est vide : sélectionne des cartes.');
    const wanted = engine.missingByHash();
    let theirs;
    if (source === 'bot') {
      throw new Error('Le bot SteamCardExchange s\'utilise depuis son site (bouton « Make Offer »).');
    } else if (source === 'friend') {
      theirs = S.friends.inv.get(friendId);
      if (!theirs) throw new Error('Ami inconnu : lance d\'abord « Scanner mes amis »');
    } else {
      theirs = engine.groupBy((await steam.getCards(parseTrade(tradeUrl))).filter((c) => c.tradable), (c) => c.hash);
    }
    const ask = [], notFound = [];
    for (const h of [...new Set(hashes)]) {
      const c = wanted.get(h); if (!c) continue;
      const t = (theirs.get(h) || [])[0];
      if (t) ask.push({ hash: h, name: c.name, img: c.img, assetid: t.assetid, price: c.price, game: c.game }); else notFound.push(c.name);
    }
    const spare = engine.spareCards().filter((c) => !hashes.includes(c.hash));
    const give = spare.slice(0, ask.length).map((c) => ({ name: c.name, img: c.img, assetid: c.assetid, game: c.game }));
    const giveMore = spare.slice(ask.length, ask.length + 60).map((c) => ({ name: c.name, img: c.img, assetid: c.assetid, game: c.game }));
    res.json({ ask, give, giveMore, notFound, spare: spare.length });
  } catch (e) { res.status(400).json({ error: e.code === 'PRIVATE' ? 'Inventaire privé' : e.message }); }
});

// Fiche détaillée d'un badge / jeu : cartes, prix, crédits, boosters, bot, amis.
app.get('/api/game/:appid', async (req, res) => {
  const appid = Number(req.params.appid);
  try {
    if (isDemo() && !S.sets.some((x) => x.appid === appid)) throw new Error('Pas de détails pour ce jeu fictif en mode démo.');
    res.json(await engine.gameDetail(appid, cfg(), Number(env.CREDITS_PER_CARD) || 0));
  } catch (e) { res.status(400).json({ error: /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(e.message) ? 'Connexion à Steam impossible : vérifie ta connexion internet.' : e.message }); }
});

// ---- SteamCardExchange : crédits ----
app.get('/api/sce/status', (_, res) => res.json(sce.status()));
app.post('/api/sce/login', async (_, res) => { try { res.json(await sce.login()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/sce/balance', async (_, res) => { try { await engine.scanBalance(); if (S.tasks.balance.error) throw new Error(S.tasks.balance.error); res.json(sce.status()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/sce/scan', (_, res) => { engine.refreshBot(); res.json({ ok: true }); }); // relit l'inventaire du bot sur le site
app.get('/api/sce/debug', (_, res) => res.type('text').send(sce.debug() || 'Aucun diagnostic pour le moment.'));

app.get('/api/trade/status', (_, res) => res.json({ ready: trader.state.ready, needGuard: trader.state.needGuard, error: trader.state.error, demo: isDemo() }));
app.post('/api/trade/login', async (req, res) => {
  try {
    if (isDemo()) return res.json({ status: 'ready' });
    if (req.body.code && trader.state.needGuard) { trader.submitGuard(req.body.code); return res.json({ status: await trader.waitAfterGuard() }); }
    res.json({ status: await trader.login(env) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/trade/send', async (req, res) => {
  try {
    const { source, tradeUrl, friendId, give, ask } = req.body;
    if (req.body.confirmed !== true) throw new Error('Échange non validé : aucune offre n\'est envoyée sans ta validation sur la page de confirmation.');
    if (isDemo()) return res.json({ id: '000000', status: 'sent', note: 'Mode démo : aucune offre réelle envoyée.' });
    if (!Array.isArray(give)) throw new Error('Liste de cartes à donner invalide.');
    if (!Array.isArray(ask) || (!ask.length && !(req.body.gift && give.length))) throw new Error('Rien à demander : aucune carte manquante chez cette source.');
    const mine = new Set(S.myCards.filter((c) => c.tradable !== false).map((c) => String(c.assetid)));
    if (new Set(give.map(String)).size !== give.length || new Set((ask || []).map(String)).size !== (ask || []).length) throw new Error('Une carte est présente deux fois dans l\'offre.');
    if (give.some((id) => !mine.has(String(id)))) throw new Error('Une carte à donner n\'est plus dans ton inventaire : clique sur Actualiser puis recommence.');
    const partner = source === 'friend' ? friendId : source === 'bot' ? (tradeUrl || env.BOT_TRADE_URL) : tradeUrl;
    if (!partner) throw new Error('Il manque le lien d\'échange du bot (Réglages) ou du partenaire.');
    const r = await trader.sendOffer(env, { tradeUrl: partner, give, ask });
    engine.journalAdd({ type: 'trade', text: `Offre envoyée (${ask.length} carte(s) demandée(s), ${give.length} donnée(s)) — ${source === 'friend' ? 'ami' : source === 'bot' ? 'bot' : 'lien'}`, auto: true });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const PUBLIC_KEYS = ['STEAM_PROFILE', 'STEAM_API_KEY', 'CURRENCY', 'STEAM_ACCOUNT', 'BOT_PROFILE', 'BOT_TRADE_URL', 'THEME', 'BOT_ONLY', 'AUTO_CARDS', 'CREDITS_BALANCE', 'CREDITS_PER_CARD', 'CREDIT_VALUE', 'SCHED_ON', 'SCHED_TIME', 'SCHED_TASKS', 'LEADERBOARD_URL'];
app.get('/api/settings', (_, res) => {
  const out = {};
  for (const k of PUBLIC_KEYS) out[k] = env[k] || '';
  for (const k of config.SECRET) out[k + '_SET'] = !!env[k];
  res.json(out);
});
const RESCAN = ['STEAM_PROFILE', 'STEAM_API_KEY', 'CURRENCY', 'BOT_PROFILE', 'BOT_ONLY'];
app.post('/api/settings', (req, res) => {
  try {
    const before = RESCAN.map((k) => env[k] || '').join('|');
    config.save(DATA_DIR, req.body || {}); reloadEnv();
    if (RESCAN.map((k) => env[k] || '').join('|') !== before) { sce.reset(); started = false; engine.reset(); try { fs.unlinkSync(path.join(DATA_DIR, 'state.json')); } catch {} } // seuls les réglages d'analyse relancent tout
    res.json({ ok: true });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Démarrage robuste : si le port est encore occupé (ancienne fenêtre qui se ferme), on réessaie un peu puis on prend un port libre.
let httpServer = null;
function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const srv = require('http').createServer(app);
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => { srv.removeListener('error', reject); httpServer = srv; resolve(srv.address().port); });
  });
}
async function start(port) {
  for (let i = 0; i < 4 && port; i++) {
    try { return await listenOnce(port); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; await new Promise((r) => setTimeout(r, 800)); }
  }
  return listenOnce(0);
}
const stop = () => { try { if (httpServer) httpServer.close(); } catch {} };
module.exports = { start, stop, setUpdater, setSce, flush: () => engine.flush() };
if (require.main === module) start(Number(env.PORT || 3000)).then((p) => console.log(`Steam Badge Trader → http://localhost:${p} ${isDemo() ? '(MODE DÉMO)' : ''}`));
