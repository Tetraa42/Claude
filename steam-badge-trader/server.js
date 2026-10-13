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
const setSce = (b) => sce.setBridge(b);

const app = express();
// L'app n'écoute qu'en local ; on refuse aussi les requêtes venant d'un autre site (DNS rebinding / CSRF).
app.use((req, res, next) => {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).end('forbidden');
  const origin = req.headers.origin;
  if (origin && origin.replace(/^https?:\/\//, '') !== host) return res.status(403).end('forbidden');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/art/avatar.svg', (_, res) => res.type('svg').send(demo.svgAvatar()));
app.get('/art/banner/:appid.svg', (req, res) => res.type('svg').send(demo.svgBanner(req.params.appid)));
app.get('/art/:appid/:i.svg', (req, res) => res.type('svg').set('Cache-Control', 'public,max-age=86400').send(demo.svgCard(req.params.appid, Number(req.params.i))));

let started = false;
function ensureStarted() {
  if (started) return;
  started = true;
  if (isDemo()) return engine.loadDemo();
  sce.reset();
  const had = engine.loadSaved(); // affichage immédiat des analyses mémorisées
  if (!had || !engine.isFresh()) engine.run(cfg());
}
const settingsView = () => ({ creditsBalance: env.CREDITS_BALANCE, creditsPerCard: env.CREDITS_PER_CARD });
app.get('/api/state', (_, res) => {
  ensureStarted();
  res.json({ ...engine.snapshot(settingsView()), theme: env.THEME || 'nuit', seenSetup: env.SEEN_SETUP === '1', version: updater ? updater.status().version : null,
    update: updater ? updater.status() : null, leaderboard: { url: !!env.LEADERBOARD_URL, joined: env.LB_JOINED === '1' } });
});
app.post('/api/refresh', (_, res) => {
  started = true;
  const already = S.running && !isDemo();
  if (isDemo()) engine.loadDemo(); else engine.run(cfg()); // les sets déjà analysés sont relus depuis le cache
  res.json({ ok: true, already });
});
app.post('/api/update/check', async (_, res) => {
  if (!updater) return res.status(400).json({ error: 'Les mises à jour automatiques ne fonctionnent que dans le logiciel installé (pas en mode développeur).' });
  try { await updater.check(); res.json(updater.status()); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/update/install', (_, res) => { if (!updater) return res.status(400).json({ error: 'Indisponible' }); res.json({ ok: true }); setTimeout(() => updater.install(), 400); });

// ---- boosters ----
app.post('/api/boosters/open', async (req, res) => {
  try {
    const { assetid, appid } = req.body;
    if (isDemo()) return res.json({ cards: ['Héros', 'Mage', 'Dragon'].map((n, i) => ({ name: n, img: `/art/${appid}/${i}.svg`, foil: false })), left: 0 });
    const cards = await trader.openBooster(Number(appid), assetid);
    const i = S.boosters.findIndex((b) => String(b.assetid) === String(assetid));
    if (i >= 0) S.boosters.splice(i, 1);
    engine.saveState();
    res.json({ cards });
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

app.post('/api/bot/refresh', (_, res) => { engine.refreshBot(cfg()); res.json({ ok: true }); });
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
      if (S.bot.status !== 'ready') throw new Error('Inventaire du bot pas encore chargé : ' + (S.bot.error || 'patiente quelques secondes'));
      theirs = S.bot.map;
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
  try { res.json(await engine.gameDetail(Number(req.params.appid), cfg(), Number(env.CREDITS_PER_CARD) || 0)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- SteamCardExchange : crédits ----
app.get('/api/sce/status', (_, res) => res.json(sce.status()));
app.post('/api/sce/login', async (_, res) => { try { res.json(await sce.login()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/sce/balance', async (_, res) => { try { res.json(await sce.refreshBalance()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/sce/scan', (req, res) => {
  const only = req.body && req.body.appid ? S.sets.filter((x) => x.appid === Number(req.body.appid)) : [...S.sets].sort((a, b) => a.cost - b.cost);
  if (isDemo()) return res.json({ ok: true });
  sce.scanGames(only); res.json({ ok: true });
});
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
    if (isDemo()) return res.json({ id: '000000', status: 'sent', note: 'Mode démo : aucune offre réelle envoyée.' });
    if (!Array.isArray(ask) || !ask.length) throw new Error('Rien à demander : aucune carte manquante chez cette source.');
    if (!Array.isArray(give)) throw new Error('Liste de cartes à donner invalide.');
    const mine = new Set(S.myCards.map((c) => String(c.assetid)));
    if (give.some((id) => !mine.has(String(id)))) throw new Error('Une carte à donner n\'est plus dans ton inventaire : clique sur Actualiser puis recommence.');
    const partner = source === 'friend' ? friendId : source === 'bot' ? (tradeUrl || env.BOT_TRADE_URL) : tradeUrl;
    if (!partner) throw new Error('Il manque le lien d\'échange du bot (Réglages) ou du partenaire.');
    res.json(await trader.sendOffer(env, { tradeUrl: partner, give, ask }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const PUBLIC_KEYS = ['STEAM_PROFILE', 'STEAM_API_KEY', 'CURRENCY', 'STEAM_ACCOUNT', 'BOT_PROFILE', 'BOT_TRADE_URL', 'THEME', 'BOT_ONLY', 'CREDITS_BALANCE', 'CREDITS_PER_CARD', 'LEADERBOARD_URL'];
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

function start(port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv.address().port));
    srv.on('error', reject);
  });
}
module.exports = { start, setUpdater, setSce, flush: () => engine.flush() };
if (require.main === module) start(Number(env.PORT || 3000)).then((p) => console.log(`Steam Badge Trader → http://localhost:${p} ${isDemo() ? '(MODE DÉMO)' : ''}`));
