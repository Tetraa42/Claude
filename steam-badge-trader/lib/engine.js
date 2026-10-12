// Analyse en tâche de fond. L'état est sauvegardé sur disque : au prochain lancement (ou après une mise à jour du logiciel)
// tout est affiché immédiatement, puis rafraîchi discrètement.
const fs = require('fs');
const path = require('path');
const steam = require('./steam');
const demo = require('./demo');
const { levelFromXp, totalXpForLevel } = require('./levels');

const BOT_DEFAULT = 'https://steamcommunity.com/id/CardExchange';
const PRICE_TTL = 6 * 3600e3, BOT_TTL = 3600e3, RANK_TTL = 3600e3;
const S = {
  running: false, refreshing: false, phase: '', done: 0, total: 0, needFetch: 0, fetched: 0, error: null, profile: null, names: new Map(), myCards: [], boosters: [],
  sets: [], completed: [], updatedAt: 0, demo: false, currency: 3, botOnly: true,
  bot: { status: 'idle', error: null, id: null, name: 'CardExchange', avatar: null, map: new Map(), apps: null, count: 0, t: 0 },
  friends: { status: 'idle', error: null, done: 0, total: 0, list: [], inv: new Map() },
  rank: { status: 'idle', error: null, done: 0, total: 0, list: [], t: 0 },
};
let runId = 0;
const statsCache = new Map();

const header = (appid) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
const groupBy = (arr, f) => arr.reduce((m, x) => ((m.get(f(x)) || m.set(f(x), []).get(f(x))).push(x), m), new Map());
const stateFile = () => path.join(process.env.BADGE_DATA_DIR, 'state.json');

function buildSet({ appid, name, lvl, set, mine, t }) {
  const have = groupBy(mine, (c) => c.hash);
  const cards = set.map((s) => ({ ...s, owned: (have.get(s.hash) || []).length, assetids: (have.get(s.hash) || []).map((c) => c.assetid) }));
  const missing = cards.filter((c) => !c.owned);
  return {
    appid, name: name || set[0].game || `App ${appid}`, badgeLevel: lvl, total: cards.length, ownedUnique: cards.length - missing.length, missingCount: missing.length,
    cost: +missing.reduce((s, c) => s + c.price, 0).toFixed(2), dupes: cards.reduce((s, c) => s + Math.max(0, c.owned - 1), 0), cards, priceT: t,
    banner: header(appid), link: `https://www.steamcardexchange.net/index.php?gamepage-appid-${appid}`,
  };
}
const upsert = (set) => { const i = S.sets.findIndex((s) => s.appid === set.appid); if (i >= 0) S.sets[i] = set; else S.sets.push(set); };
const levelsMap = () => new Map((S.profile ? S.profile.badges : []).map((b) => [b.appid, b.level]));

// ---------- sauvegarde / chargement ----------
function saveState() {
  if (S.demo) return;
  try {
    const botMap = {}; for (const [h, v] of S.bot.map) botMap[h] = v.map((x) => x.assetid);
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ v: 2, t: S.updatedAt, currency: S.currency, profile: S.profile, completed: S.completed, sets: S.sets, myCards: S.myCards, boosters: S.boosters,
      bot: { id: S.bot.id, name: S.bot.name, avatar: S.bot.avatar, apps: S.bot.apps ? [...S.bot.apps] : null, count: S.bot.count, t: S.bot.t, map: botMap }, rank: S.rank.list, rankT: S.rank.t }));
  } catch {}
}
function loadSaved() {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (d.v !== 2) return false;
    Object.assign(S, { profile: d.profile, completed: d.completed || [], sets: d.sets || [], myCards: d.myCards || [], boosters: d.boosters || [], updatedAt: d.t || 0, currency: d.currency || 3 });
    const b = d.bot || {};
    Object.assign(S.bot, { id: b.id, name: b.name || 'CardExchange', avatar: b.avatar, apps: b.apps ? new Set(b.apps) : null, count: b.count || 0, t: b.t || 0,
      map: new Map(Object.entries(b.map || {}).map(([h, ids]) => [h, ids.map((assetid) => ({ assetid }))])), status: b.apps ? 'ready' : 'idle' });
    S.rank.list = d.rank || []; S.rank.t = d.rankT || 0; S.rank.status = S.rank.list.length ? 'ready' : 'idle';
    return !!S.profile;
  } catch { return false; }
}
const isFresh = (ms = 10 * 60e3) => S.updatedAt && Date.now() - S.updatedAt < ms;

// ---------- bot ----------
async function loadBot(cfg) {
  const B = S.bot;
  B.status = 'loading'; B.error = null;
  try {
    B.id = B.id || (await steam.resolveSteamId(cfg.botProfile || BOT_DEFAULT, cfg.key));
    const [info] = await steam.getSummaries(cfg.key, [B.id]);
    if (info) { B.name = info.personaname; B.avatar = info.avatarfull; }
    const cards = (await steam.getInventory(B.id)).cards.filter((c) => c.tradable);
    B.apps = new Set(cards.map((c) => c.appid)); B.count = cards.length; B.t = Date.now(); B.status = 'ready';
    return groupBy(cards, (c) => c.hash);
  } catch (e) { B.status = 'error'; B.error = e.code === 'PRIVATE' ? 'Inventaire du bot privé' : e.message; return null; }
}
function trimBot(full) { // on ne garde que les cartes utiles pour nos sets
  const wanted = new Set(S.sets.flatMap((s) => s.cards.map((c) => c.hash)));
  S.bot.map = new Map();
  for (const h of wanted) if (full.has(h)) S.bot.map.set(h, full.get(h).map((c) => ({ assetid: c.assetid })));
}
async function refreshBot(cfg) {
  if (S.demo) return;
  const full = await loadBot(cfg);
  if (full) { trimBot(full); saveState(); }
}

// ---------- analyse principale ----------
async function run(cfg) {
  if (S.running) return;
  const id = ++runId;
  Object.assign(S, { running: true, error: null, done: 0, total: 0, needFetch: 0, fetched: 0, demo: false, currency: cfg.currency, botOnly: cfg.botOnly });
  try {
    S.phase = 'Lecture de ton profil Steam';
    const sid = await steam.resolveSteamId(cfg.profile, cfg.key);
    S.profile = await steam.getProfile(cfg.key, sid);
    S.names = await steam.getOwnedNames(cfg.key, sid);
    S.completed = S.profile.badges.filter((b) => b.level >= 5).map((b) => ({ appid: b.appid, name: S.names.get(b.appid) || `Jeu ${b.appid}`, level: b.level, banner: header(b.appid) }));
    S.phase = 'Lecture de ton inventaire (cartes et boosters)';
    const inv = await steam.getInventory(sid);
    S.myCards = inv.cards; S.boosters = inv.boosters;

    let botFull = null;
    if (cfg.botOnly && !(S.bot.apps && Date.now() - S.bot.t < BOT_TTL)) { S.phase = 'Lecture de l\'inventaire du bot'; botFull = await loadBot(cfg); }
    const lvl = levelsMap();
    const byApp = groupBy(S.myCards, (c) => c.appid);
    let apps = [...byApp.entries()].filter(([a]) => (lvl.get(a) || 0) < 5);
    if (cfg.botOnly && S.bot.apps) apps = apps.filter(([a]) => S.bot.apps.has(a)); // uniquement les jeux que le bot possède
    apps.sort((a, b) => b[1].length - a[1].length); // les plus avancés d'abord
    S.total = apps.length;
    S.needFetch = apps.filter(([a]) => !steam.cachedSet(a, cfg.currency)).length;
    S.phase = 'Analyse des sets et des prix';
    const seen = new Set();
    for (const [appid, mine] of apps) {
      if (id !== runId) return;
      try {
        const { set, fromCache, t } = await steam.getSet(appid, cfg.currency, Infinity);
        if (!fromCache) S.fetched++;
        seen.add(appid);
        if (set.length) upsert(buildSet({ appid, name: S.names.get(appid), lvl: lvl.get(appid) || 0, set, mine, t }));
      } catch (e) { if (/429/.test(e.message)) throw e; }
      S.done++;
    }
    S.sets = S.sets.filter((s) => seen.has(s.appid));
    if (botFull) trimBot(botFull);
    S.updatedAt = Date.now(); S.phase = '';
    saveState();
    S.running = false;
    refreshPrices(cfg, id).catch(() => {});
    return;
  } catch (e) { S.error = e.message; S.phase = ''; if (S.sets.length) saveState(); }
  S.running = false;
}

// Rafraîchit en arrière-plan les prix devenus trop vieux (le plus intéressant d'abord), sans bloquer l'affichage.
async function refreshPrices(cfg, id) {
  const stale = S.sets.filter((s) => Date.now() - (s.priceT || 0) > PRICE_TTL).sort((a, b) => a.cost - b.cost).slice(0, 40);
  if (!stale.length) return;
  S.refreshing = true;
  const lvl = levelsMap(), byApp = groupBy(S.myCards, (c) => c.appid);
  try {
    for (const s of stale) {
      if (id !== runId) break;
      const { set, t } = await steam.getSet(s.appid, cfg.currency, 0);
      if (set.length) upsert(buildSet({ appid: s.appid, name: s.name, lvl: lvl.get(s.appid) || 0, set, mine: byApp.get(s.appid) || [], t }));
    }
    saveState();
  } catch {}
  S.refreshing = false;
}

// ---------- amis : cartes manquantes ----------
async function scanFriends(cfg) {
  const F = S.friends;
  if (F.status === 'loading') return;
  Object.assign(F, { status: 'loading', error: null, done: 0, total: 0, inv: new Map() });
  try {
    if (S.demo) { F.total = F.list.length; return demo.fillFriends(F, S); }
    F.list = await steam.getFriends(cfg.key, S.profile.steamid);
    F.total = F.list.length;
    const wanted = new Set(S.sets.flatMap((s) => s.cards.filter((c) => !c.owned).map((c) => c.hash)));
    for (const f of F.list) {
      try {
        const cards = (await steam.getCards(f.steamid)).filter((c) => c.tradable && wanted.has(c.hash));
        F.inv.set(f.steamid, groupBy(cards, (c) => c.hash));
      } catch (e) { if (e.code !== 'PRIVATE') { F.error = e.message; if (/429/.test(e.message)) break; } }
      F.done++;
    }
    F.status = 'ready';
  } catch (e) { F.status = 'error'; F.error = e.code === 'PRIVATE' ? 'Ta liste d\'amis est privée (Steam > Confidentialité > Liste d\'amis : Public).' : e.message; }
}

// ---------- classement entre amis (niveau, badges, rareté) ----------
async function scanRank(cfg) {
  const R = S.rank;
  if (R.status === 'loading') return;
  Object.assign(R, { status: 'loading', error: null, done: 0, total: 0 });
  try {
    if (S.demo) { R.list = demo.demoRank(S); R.status = 'ready'; return; }
    const friends = S.friends.list.length ? S.friends.list : await steam.getFriends(cfg.key, S.profile.steamid);
    S.friends.list = friends;
    const people = [{ steamid: S.profile.steamid, name: S.profile.name, avatar: S.profile.avatar, me: true }, ...friends];
    R.total = people.length;
    const out = [];
    for (const p of people) {
      let st = statsCache.get(p.steamid);
      if (!st || Date.now() - st.t > RANK_TTL) {
        try { st = { t: Date.now(), ...(await steam.getBadgeStats(cfg.key, p.steamid)) }; statsCache.set(p.steamid, st); await steam.sleep(120); } catch { st = null; }
      }
      if (st) out.push({ steamid: p.steamid, name: p.name, avatar: p.avatar, me: !!p.me, level: st.level, xp: st.xp, badgeCount: st.badgeCount, rareCount: st.rareCount, rarity: st.rarity });
      R.done++;
      R.list = out.slice();
    }
    R.t = Date.now(); R.status = 'ready'; saveState();
  } catch (e) { R.status = 'error'; R.error = e.message; }
}

function loadDemo() { Object.assign(S, { demo: true, running: false, error: null }, demo.demoState()); }

// ---------- vue envoyée à l'interface ----------
function snapshot(opt = {}) {
  const B = S.bot, F = S.friends, cpc = Number(opt.creditsPerCard) || 0;
  const sets = S.sets.map((s) => {
    const missing = s.cards.filter((c) => !c.owned);
    const cards = s.cards.map((c) => ({ ...c, assetids: undefined, bot: c.owned ? 0 : (B.map.get(c.hash) || []).length, credits: cpc || undefined }));
    const friends = F.list.map((f) => {
      const inv = F.inv.get(f.steamid); if (!inv) return null;
      const have = missing.filter((c) => inv.has(c.hash)).map((c) => c.hash);
      return have.length ? { steamid: f.steamid, name: f.name, avatar: f.avatar, have } : null;
    }).filter(Boolean).sort((a, b) => b.have.length - a.have.length);
    return { ...s, cards, botHas: cards.filter((c) => !c.owned && c.bot).length, friends, credits: cpc ? +(missing.length * cpc).toFixed(2) : null, stale: Date.now() - (s.priceT || 0) > PRICE_TTL };
  });
  const boosters = [...groupBy(S.boosters, (b) => b.appid).values()].map((g) => ({ appid: g[0].appid, name: g[0].name, game: g[0].game, img: g[0].img, count: g.length, assetid: g[0].assetid, banner: header(g[0].appid) }));
  const p = S.profile, gain = sets.length * 100;
  const fetchLeft = Math.max(0, S.needFetch - S.fetched);
  return {
    demo: S.demo, currency: S.currency, profile: p, sets, completed: S.completed, boosters, updatedAt: S.updatedAt,
    progress: { running: S.running, refreshing: S.refreshing, phase: S.phase, done: S.done, total: S.total, fetchLeft, etaMin: Math.ceil((fetchLeft * 2.6) / 60),
      wait: Math.max(0, Math.round((steam.rate.waitUntil - Date.now()) / 1000)), error: S.error },
    bot: { status: B.status, error: B.error, name: B.name, avatar: B.avatar, count: B.count, games: B.apps ? B.apps.size : 0, botOnly: S.botOnly },
    friends: { status: F.status, error: F.error, done: F.done, total: F.total, count: F.list.length },
    rank: { status: S.rank.status, error: S.rank.error, done: S.rank.done, total: S.rank.total, list: S.rank.list },
    projection: p && { gainXp: gain, level: levelFromXp(p.xp + gain).level, nextLevelXp: totalXpForLevel(p.level + 1) - p.xp },
    credits: { balance: opt.creditsBalance === '' || opt.creditsBalance == null ? null : Number(opt.creditsBalance), perCard: cpc || null },
  };
}

// Cartes que je peux donner : doublons, et toutes les cartes des jeux dont le badge est déjà niveau 5.
function spareCards() {
  const lvl = levelsMap();
  const out = [];
  for (const group of groupBy(S.myCards, (c) => c.hash).values()) {
    const maxed = (lvl.get(group[0].appid) || 0) >= 5;
    for (const c of maxed ? group : group.slice(1)) if (c.tradable !== false) out.push(c);
  }
  return out;
}
module.exports = { S, run, refreshBot, scanFriends, scanRank, loadDemo, loadSaved, isFresh, saveState, snapshot, spareCards, groupBy, BOT_DEFAULT };
