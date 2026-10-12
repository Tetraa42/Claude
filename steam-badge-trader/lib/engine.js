// Analyse en tâche de fond : les résultats apparaissent au fur et à mesure, rien n'est perdu en cas d'erreur.
const steam = require('./steam');
const demo = require('./demo');
const { levelFromXp, totalXpForLevel } = require('./levels');

const BOT_DEFAULT = 'https://steamcommunity.com/id/CardExchange';
const S = {
  running: false, phase: '', done: 0, total: 0, error: null, profile: null, names: new Map(), myCards: [], sets: [], completed: [],
  bot: { status: 'idle', error: null, id: null, name: 'CardExchange', avatar: null, map: new Map(), count: 0 },
  friends: { status: 'idle', error: null, done: 0, total: 0, list: [], inv: new Map() },
  demo: false, currency: 3,
};

const header = (appid) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
const groupBy = (arr, f) => arr.reduce((m, x) => ((m.get(f(x)) || m.set(f(x), []).get(f(x))).push(x), m), new Map());

function buildSet({ appid, name, lvl, set, mine }) {
  const have = groupBy(mine, (c) => c.hash);
  const cards = set.map((s) => ({ ...s, owned: (have.get(s.hash) || []).length, assetids: (have.get(s.hash) || []).map((c) => c.assetid) }));
  const missing = cards.filter((c) => !c.owned);
  return {
    appid, name: name || set[0].game || `App ${appid}`, badgeLevel: lvl, total: cards.length, ownedUnique: cards.length - missing.length, missingCount: missing.length,
    cost: +missing.reduce((t, c) => t + c.price, 0).toFixed(2), dupes: cards.reduce((t, c) => t + Math.max(0, c.owned - 1), 0), cards,
    banner: header(appid), link: `https://www.steamcardexchange.net/index.php?gamepage-appid-${appid}`,
  };
}

async function run(cfg) {
  if (S.running) return;
  Object.assign(S, { running: true, error: null, done: 0, total: 0, demo: false, currency: cfg.currency });
  const next = [];
  S.sets = next;
  try {
    S.phase = 'Lecture de ton profil';
    const id = await steam.resolveSteamId(cfg.profile, cfg.key);
    S.profile = await steam.getProfile(cfg.key, id);
    S.names = await steam.getOwnedNames(cfg.key, id);
    S.completed = S.profile.badges.filter((b) => b.level >= 5).map((b) => ({ appid: b.appid, name: S.names.get(b.appid) || `Jeu ${b.appid}`, level: b.level, banner: header(b.appid) }));
    S.phase = 'Lecture de ton inventaire de cartes';
    S.myCards = await steam.getCards(id);
    const lvl = new Map(S.profile.badges.map((b) => [b.appid, b.level]));
    const byApp = groupBy(S.myCards, (c) => c.appid);
    for (const a of cfg.extra) if (!byApp.has(a)) byApp.set(a, []);
    const apps = [...byApp.entries()].filter(([a]) => (lvl.get(a) || 0) < 5).sort((a, b) => b[1].length - a[1].length);
    S.total = apps.length;
    S.phase = 'Analyse des sets et des prix';
    for (const [appid, mine] of apps) {
      const { set } = await steam.getSet(appid, cfg.currency);
      S.done++;
      if (set.length) next.push(buildSet({ appid, name: S.names.get(appid), lvl: lvl.get(appid) || 0, set, mine }));
    }
    S.phase = '';
    refreshBot(cfg).catch(() => {});
  } catch (e) { S.error = e.message; S.phase = ''; }
  S.running = false;
}

async function refreshBot(cfg) {
  if (S.demo) return;
  const B = S.bot;
  B.status = 'loading'; B.error = null;
  try {
    B.id = B.id || (await steam.resolveSteamId(cfg.botProfile || BOT_DEFAULT, cfg.key));
    const [info] = await steam.getSummaries(cfg.key, [B.id]);
    if (info) { B.name = info.personaname; B.avatar = info.avatarfull; }
    const cards = (await steam.getCards(B.id)).filter((c) => c.tradable);
    B.map = groupBy(cards, (c) => c.hash); B.count = cards.length; B.status = 'ready';
  } catch (e) { B.status = 'error'; B.error = e.code === 'PRIVATE' ? 'Inventaire du bot privé' : e.message; }
}

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

function loadDemo() {
  Object.assign(S, { demo: true, running: false, error: null }, demo.demoState());
}

// Vue envoyée à l'interface : sets enrichis avec les données du bot et des amis.
function snapshot() {
  const B = S.bot, F = S.friends;
  const sets = S.sets.map((s) => {
    const missing = s.cards.filter((c) => !c.owned);
    const cards = s.cards.map((c) => ({ ...c, assetids: undefined, bot: c.owned ? 0 : (B.map.get(c.hash) || []).length }));
    const friends = F.list.map((f) => {
      const inv = F.inv.get(f.steamid); if (!inv) return null;
      const have = missing.filter((c) => inv.has(c.hash)).map((c) => c.hash);
      return have.length ? { steamid: f.steamid, name: f.name, avatar: f.avatar, have } : null;
    }).filter(Boolean).sort((a, b) => b.have.length - a.have.length);
    return { ...s, cards, botHas: cards.filter((c) => !c.owned && c.bot).length, friends, spare: undefined };
  });
  const p = S.profile;
  const gain = sets.length * 100;
  return {
    demo: S.demo, currency: S.currency, profile: p, sets, completed: S.completed,
    progress: { running: S.running, phase: S.phase, done: S.done, total: S.total, wait: Math.max(0, Math.round((steam.rate.waitUntil - Date.now()) / 1000)), error: S.error },
    bot: { status: B.status, error: B.error, name: B.name, count: B.count },
    friends: { status: F.status, error: F.error, done: F.done, total: F.total, count: F.list.length },
    projection: p && { gainXp: gain, level: levelFromXp(p.xp + gain).level, nextLevelXp: totalXpForLevel(p.level + 1) - p.xp },
  };
}

// Cartes que je peux donner : doublons, et toutes les cartes des jeux dont le badge est déjà niveau 5.
function spareCards() {
  const lvl = new Map((S.profile ? S.profile.badges : []).map((b) => [b.appid, b.level]));
  const out = [];
  for (const group of groupBy(S.myCards, (c) => c.hash).values()) {
    const maxed = (lvl.get(group[0].appid) || 0) >= 5;
    for (const c of maxed ? group : group.slice(1)) if (c.tradable !== false) out.push(c);
  }
  return out;
}
module.exports = { S, run, refreshBot, scanFriends, loadDemo, snapshot, spareCards, groupBy, BOT_DEFAULT };
