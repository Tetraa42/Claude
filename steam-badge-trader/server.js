const fs = require('fs');
const path = require('path');
const express = require('express');

// mini lecteur .env (sans dépendance)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*([^#]*?)\s*(#.*)?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const env = process.env;
const DEMO = env.DEMO === '1' || !env.STEAM_API_KEY;
const currency = Number(env.CURRENCY || 3);
const steam = require('./lib/steam');
const demo = require('./lib/demo');
const trader = require('./lib/trader');
const { totalXpForLevel, levelFromXp } = require('./lib/levels');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/art/avatar.svg', (_, res) => res.type('svg').send(demo.svgAvatar()));
app.get('/art/:appid/:i.svg', (req, res) => res.type('svg').set('Cache-Control', 'public,max-age=86400').send(demo.svgCard(req.params.appid, Number(req.params.i))));

let cache = null, progress = { done: 0, total: 0, busy: false };

app.get('/api/overview', async (req, res) => {
  try {
    if (DEMO) return res.json(withProjection(demo.demoOverview()));
    if (req.query.refresh || !cache) {
      progress = { done: 0, total: 0, busy: true };
      const id = await steam.resolveSteamId(env.STEAM_PROFILE, env.STEAM_API_KEY);
      const extra = String(req.query.apps || '').split(',').map(Number).filter(Boolean);
      const o = await steam.buildOverview({ key: env.STEAM_API_KEY, steamid: id, currency, extraApps: extra,
        onProgress: (d, t) => (progress = { done: d, total: t, busy: true }) });
      cache = o;
      progress.busy = false;
    }
    const { myCards, ...rest } = cache;
    res.json(withProjection(rest));
  } catch (e) { progress.busy = false; res.status(500).json({ error: e.message }); }
});
app.get('/api/progress', (_, res) => res.json(progress));

// niveau atteignable si on complète tous les sets listés (+100 XP chacun)
function withProjection(o) {
  const gain = o.sets.length * 100;
  const proj = levelFromXp(o.profile.xp + gain).level;
  const cheap = [];
  let spent = 0, xp = o.profile.xp;
  for (const s of o.sets) { spent += s.cost; xp += 100; cheap.push({ appid: s.appid, spent: +spent.toFixed(2), level: levelFromXp(xp).level }); }
  return { ...o, demo: DEMO, currency, projection: { gainXp: gain, level: proj, steps: cheap, nextLevelXp: totalXpForLevel(o.profile.level + 1) - o.profile.xp } };
}

const parseTrade = (u) => {
  const m = String(u).match(/partner=(\d+)/);
  if (!m) throw new Error('Lien d\'échange invalide (il doit contenir partner=… & token=…)');
  return (BigInt(m[1]) + 76561197960265728n).toString();
};

// Prépare l'échange : cartes manquantes que le partenaire possède / doublons que je donne en retour.
app.post('/api/trade/preview', async (req, res) => {
  try {
    const { appid, tradeUrl } = req.body;
    const set = (DEMO ? demo.demoOverview() : cache).sets.find((s) => s.appid === Number(appid));
    if (!set) throw new Error('Set inconnu');
    const missing = set.cards.filter((c) => !c.owned);
    let partner = [];
    if (DEMO) partner = missing.slice(0, Math.max(1, missing.length - 1)).map((c, i) => ({ ...c, assetid: 'p' + i }));
    else {
      const theirs = await steam.getCards(parseTrade(tradeUrl));
      partner = missing.flatMap((c) => theirs.filter((t) => t.hash === c.hash && t.tradable).slice(0, 1).map((t) => ({ ...c, assetid: t.assetid })));
    }
    const mySpare = [];
    for (const s of (DEMO ? demo.demoOverview() : cache).sets)
      for (const c of s.cards) for (const id of c.assetids.slice(1)) mySpare.push({ name: c.name, img: c.img, assetid: id, game: s.name, price: c.price });
    const ask = partner.map((c) => ({ name: c.name, img: c.img, assetid: c.assetid, price: c.price }));
    res.json({ set: set.name, ask, give: mySpare.slice(0, ask.length), notFound: missing.length - ask.length, spare: mySpare.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/trade/status', (_, res) => res.json({ ready: trader.state.ready, needGuard: trader.state.needGuard, error: trader.state.error, demo: DEMO }));
app.post('/api/trade/login', async (req, res) => {
  try {
    if (DEMO) return res.json({ status: 'ready' });
    if (req.body.code && trader.state.needGuard) { trader.submitGuard(req.body.code); await new Promise((r) => setTimeout(r, 4000)); return res.json({ status: trader.state.ready ? 'ready' : 'guard' }); }
    res.json({ status: await trader.login(env) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/trade/send', async (req, res) => {
  try {
    const { tradeUrl, give, ask } = req.body;
    if (DEMO) return res.json({ id: '000000', status: 'sent', note: 'Mode démo : aucune offre réelle envoyée.' });
    if (!ask.length) throw new Error('Rien à demander : le partenaire n\'a aucune carte manquante.');
    res.json(await trader.sendOffer(env, { tradeUrl, give, ask }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const port = Number(env.PORT || 3000);
app.listen(port, '127.0.0.1', () => console.log(`Steam Badge Trader → http://localhost:${port}  ${DEMO ? '(MODE DÉMO)' : ''}`));
