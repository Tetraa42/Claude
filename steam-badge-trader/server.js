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
const { S } = engine;

const base = { ...process.env };
let env = {};
const reloadEnv = () => { env = { ...base, ...config.load(DATA_DIR) }; };
reloadEnv();
const isDemo = () => base.DEMO === '1' || !env.STEAM_API_KEY;
const cfg = () => ({ key: env.STEAM_API_KEY, profile: env.STEAM_PROFILE, currency: Number(env.CURRENCY || 3), botProfile: env.BOT_PROFILE || engine.BOT_DEFAULT, extra: [] });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/art/avatar.svg', (_, res) => res.type('svg').send(demo.svgAvatar()));
app.get('/art/banner/:appid.svg', (req, res) => res.type('svg').send(demo.svgBanner(req.params.appid)));
app.get('/art/:appid/:i.svg', (req, res) => res.type('svg').set('Cache-Control', 'public,max-age=86400').send(demo.svgCard(req.params.appid, Number(req.params.i))));

let started = false;
function ensureStarted() {
  if (started) return;
  started = true;
  if (isDemo()) engine.loadDemo(); else engine.run(cfg());
}
app.get('/api/state', (_, res) => { ensureStarted(); res.json(engine.snapshot()); });
app.post('/api/refresh', (_, res) => {
  started = true;
  if (isDemo()) engine.loadDemo(); else engine.run(cfg()); // les sets déjà analysés sont relus depuis le cache
  res.json({ ok: true });
});
app.post('/api/bot/refresh', (_, res) => { engine.refreshBot(cfg()); res.json({ ok: true }); });
app.post('/api/friends/scan', (_, res) => { engine.scanFriends(cfg()); res.json({ ok: true }); });

const parseTrade = (u) => {
  const m = String(u).match(/partner=(\d+)/);
  if (!m) throw new Error('Lien d\'échange invalide (il doit contenir partner=… et token=…)');
  return (BigInt(m[1]) + 76561197960265728n).toString();
};

// Prépare l'échange : cartes manquantes que la source possède / cartes en trop que je donne en retour.
app.post('/api/trade/preview', async (req, res) => {
  try {
    const { appid, source, tradeUrl, friendId } = req.body;
    const set = S.sets.find((s) => s.appid === Number(appid));
    if (!set) throw new Error('Set inconnu');
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
    const missing = set.cards.filter((c) => !c.owned);
    const ask = missing.flatMap((c) => (theirs.get(c.hash) || []).slice(0, 1).map((t) => ({ name: c.name, img: c.img, assetid: t.assetid, price: c.price })));
    const give = engine.spareCards().slice(0, ask.length).map((c) => ({ name: c.name, img: c.img, assetid: c.assetid }));
    res.json({ set: set.name, ask, give, notFound: missing.length - ask.length, spare: engine.spareCards().length });
  } catch (e) { res.status(400).json({ error: e.code === 'PRIVATE' ? 'Inventaire privé' : e.message }); }
});

app.get('/api/trade/status', (_, res) => res.json({ ready: trader.state.ready, needGuard: trader.state.needGuard, error: trader.state.error, demo: isDemo() }));
app.post('/api/trade/login', async (req, res) => {
  try {
    if (isDemo()) return res.json({ status: 'ready' });
    if (req.body.code && trader.state.needGuard) { trader.submitGuard(req.body.code); await new Promise((r) => setTimeout(r, 4000)); return res.json({ status: trader.state.ready ? 'ready' : 'guard' }); }
    res.json({ status: await trader.login(env) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/trade/send', async (req, res) => {
  try {
    const { source, tradeUrl, friendId, give, ask } = req.body;
    if (isDemo()) return res.json({ id: '000000', status: 'sent', note: 'Mode démo : aucune offre réelle envoyée.' });
    if (!ask.length) throw new Error('Rien à demander : aucune carte manquante chez cette source.');
    const partner = source === 'friend' ? friendId : source === 'bot' ? (tradeUrl || env.BOT_TRADE_URL) : tradeUrl;
    if (!partner) throw new Error('Il manque le lien d\'échange du bot (Réglages) ou du partenaire.');
    res.json(await trader.sendOffer(env, { tradeUrl: partner, give, ask }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const PUBLIC_KEYS = ['STEAM_PROFILE', 'STEAM_API_KEY', 'CURRENCY', 'STEAM_ACCOUNT', 'BOT_PROFILE', 'BOT_TRADE_URL'];
app.get('/api/settings', (_, res) => {
  const out = {};
  for (const k of PUBLIC_KEYS) out[k] = env[k] || '';
  for (const k of config.SECRET) out[k + '_SET'] = !!env[k];
  res.json(out);
});
app.post('/api/settings', (req, res) => {
  try { config.save(DATA_DIR, req.body || {}); reloadEnv(); started = false; Object.assign(S, { profile: null, sets: [], completed: [], error: null }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

function start(port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv.address().port));
    srv.on('error', reject);
  });
}
module.exports = { start };
if (require.main === module) start(Number(env.PORT || 3000)).then((p) => console.log(`Steam Badge Trader → http://localhost:${p} ${isDemo() ? '(MODE DÉMO)' : ''}`));
