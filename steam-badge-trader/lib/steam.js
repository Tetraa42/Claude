const fs = require('fs');
const path = require('path');
const { levelFromXp } = require('./levels');
const { writeJsonAtomic } = require('./fsutil');

const CDN = 'https://community.cloudflare.steamstatic.com/economy/image/';
const dataDir = () => process.env.BADGE_DATA_DIR || path.join(__dirname, '..', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Annulation : chaque scan s'exécute dans un « contexte de tâche » ; si on clique sur Arrêter, ses requêtes en attente s'interrompent aussitôt.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const cancelled = new Set();
const cancelError = () => Object.assign(new Error('Arrêté'), { code: 'CANCELLED' });
const isCancelled = () => { const c = als.getStore(); return !!c && cancelled.has(c.name); };
const inTask = (name, fn) => { cancelled.delete(name); return als.run({ name }, fn); };
const cancelTask = (name) => { cancelled.add(name); };
async function csleep(ms) { // attente interruptible
  const end = Date.now() + ms;
  while (Date.now() < end) { if (isCancelled()) throw cancelError(); await sleep(Math.min(500, end - Date.now())); }
}

// Quand Steam limite le débit (429) on attend puis on reprend : rien n'est perdu.
const rate = { waitUntil: 0 };
let lastCommunity = 0;
const gapFor = (url) => (url.includes('/market/search') ? 3000 : url.includes('/inventory/') ? 3000 : 1500); // Steam bloque (429) si on va plus vite

// Dans le logiciel installé, les requêtes vers steamcommunity.com partent avec ta session Steam (celle de la connexion à SteamCardExchange) :
// Steam est bien moins strict avec un compte connecté qu'avec une adresse anonyme.
let authFetch = null;
const setAuthFetch = (f) => { authFetch = f; };

async function jget(url, asText = false) {
  const community = url.includes('steamcommunity.com');
  for (let attempt = 0; ; attempt++) {
    if (isCancelled()) throw cancelError();
    if (community) {
      const gap = gapFor(url) - (Date.now() - lastCommunity);
      if (gap > 0) await csleep(gap);
      lastCommunity = Date.now();
    }
    let r;
    if (authFetch && community) { try { r = await authFetch(url); } catch { r = null; } }
    if (!r) r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 steam-badge-trader' } });
    if (r.status === 429) {
      if (attempt >= 4) throw new Error('Steam limite toujours le débit (429). Patiente 5 minutes puis clique sur Actualiser : ce qui est déjà analysé est conservé.');
      const wait = [45, 90, 180, 300][attempt];
      rate.waitUntil = Date.now() + wait * 1000;
      try { await csleep(wait * 1000); } finally { rate.waitUntil = 0; }
      continue;
    }
    if (r.status === 403 || r.status === 401) { const e = new Error('Profil ou inventaire privé'); e.code = 'PRIVATE'; throw e; }
    if (!r.ok) throw new Error(`Steam a répondu HTTP ${r.status}`);
    const t = await r.text();
    if (asText) return t;
    return t ? JSON.parse(t) : null;
  }
}

async function resolveSteamId(input, key) {
  input = String(input || '').trim();
  let m = input.match(/\/profiles\/(\d{17})/) || input.match(/^(\d{17})$/);
  if (m) return m[1];
  m = input.match(/\/id\/([^/?#]+)/) || input.match(/^([\w-]+)$/);
  if (!m) throw new Error('Profil Steam invalide');
  const d = await jget(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${key}&vanityurl=${m[1]}`);
  if (!d || d.response.success !== 1) throw new Error('Profil introuvable : ' + input);
  return d.response.steamid;
}

async function getSummaries(key, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const d = await jget(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${ids.slice(i, i + 100).join(',')}`);
    out.push(...d.response.players);
  }
  return out;
}

// Rareté : plus un badge est possédé par peu de joueurs (scarcity), plus il rapporte de points.
const rarityPoints = (scarcity) => (scarcity > 0 ? Math.max(0.5, 7 - Math.log10(scarcity)) : 1);

async function getBadgeStats(key, id) {
  const d = await jget(`https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${key}&steamid=${id}`);
  const r = (d && d.response) || {};
  const all = r.badges || [];
  const xp = r.player_xp || 0;
  return {
    level: r.player_level || 0, xp, badgeCount: all.length,
    rareCount: all.filter((b) => b.scarcity > 0 && b.scarcity < 10000).length,
    rarity: +all.reduce((t, b) => t + rarityPoints(b.scarcity), 0).toFixed(1),
    badges: all.filter((b) => b.appid && b.border_color === 0).map((b) => ({ appid: b.appid, level: b.level, xp: b.xp, scarcity: b.scarcity || 0 })),
  };
}

async function getProfile(key, id) {
  const [[p = {}], b] = await Promise.all([getSummaries(key, [id]), getBadgeStats(key, id)]);
  const L = levelFromXp(b.xp);
  return { steamid: id, name: p.personaname || id, avatar: p.avatarfull, url: p.profileurl, ...b, intoLevel: L.intoLevel, needed: L.needed };
}

// Cartes encore à récupérer en jouant (« N card drops remaining ») : lues sur la page publique de tes badges.
async function getBadgeDrops(id, onPage) {
  const out = new Map();
  let prevFirst = null;
  for (let page = 1; page <= 10; page++) {
    const html = await jget(`https://steamcommunity.com/profiles/${id}/badges/?l=english&p=${page}`, true);
    const rows = String(html).split(/<div class="badge_row\b/).slice(1);
    if (!rows.length) break;
    const first = (/gamecards\/(\d+)/.exec(rows[0]) || [])[1];
    if (first && first === prevFirst) break; // la page ne change plus
    prevFirst = first;
    if (onPage) onPage(page);
    for (const r of rows) {
      const a = /gamecards\/(\d+)/.exec(r);
      if (!a) continue;
      const m = /(\d+)\s+card drops?\s+remaining/i.exec(r);
      out.set(Number(a[1]), m ? Number(m[1]) : 0);
    }
  }
  return out;
}

async function getOwnedNames(key, id) {
  try {
    const d = await jget(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${id}&include_appinfo=1&include_played_free_games=1`);
    return new Map(((d && d.response && d.response.games) || []).map((g) => [g.appid, g.name]));
  } catch { return new Map(); }
}

async function getFriends(key, id) {
  const d = await jget(`https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${key}&steamid=${id}&relationship=friend`);
  const ids = ((d && d.friendslist && d.friendslist.friends) || []).map((f) => f.steamid);
  const sums = await getSummaries(key, ids);
  return sums.map((s) => ({ steamid: s.steamid, name: s.personaname, avatar: s.avatarfull }));
}

const isNormalCard = (d) =>
  /Trading Card/i.test(d.type || '') &&
  (d.tags || []).some((t) => t.category === 'cardborder' && t.internal_name === 'cardborder_0');
const isBooster = (d) => /Booster Pack/i.test(d.type || '') || /Booster Pack$/i.test(d.name || '');

// Inventaire Steam (appid 753, contexte 6) : cartes normales + boosters.
async function getInventory(id, onProgress) {
  const cards = [], boosters = [], gems = { gems: 0, sacks: 0 };
  let last = '', seen = 0;
  for (let i = 0; i < 60; i++) {
    let d;
    for (const count of [2000, 500, 75]) { // l'inventaire d'un autre joueur est parfois refusé (HTTP 400) avec un gros « count » : on réessaie plus petit
      try { d = await jget(`https://steamcommunity.com/inventory/${id}/753/6?l=english&count=${count}${last ? '&start_assetid=' + last : ''}`); break; }
      catch (e) { if (!/HTTP 400/.test(e.message) || count === 75) throw e; }
    }
    if (!d || !d.assets) break;
    const desc = new Map(d.descriptions.map((x) => [x.classid + '_' + x.instanceid, x]));
    seen += d.assets.length;
    if (onProgress) onProgress(seen, Number(d.total_inventory_count) || 0);
    for (const a of d.assets) {
      const x = desc.get(a.classid + '_' + a.instanceid);
      if (!x) continue;
      if (x.market_hash_name === '753-Gems') { gems.gems += Number(a.amount) || 1; continue; }              // gemmes (en vrac)
      if (x.market_hash_name === '753-Sack of Gems') { gems.sacks += Number(a.amount) || 1; continue; }     // sacs de 1000 gemmes
      if (isNormalCard(x)) cards.push({
        assetid: a.assetid, hash: x.market_hash_name, name: x.name, appid: Number(x.market_fee_app),
        game: (x.type || '').replace(/ Trading Card$/i, ''), img: CDN + x.icon_url + '/192fx192f', tradable: !!x.tradable,
      });
      else if (isBooster(x)) boosters.push({
        assetid: a.assetid, appid: Number(x.market_fee_app), name: x.name, game: (x.name || '').replace(/ Booster Pack$/i, ''),
        img: CDN + x.icon_url + '/192fx192f', tradable: !!x.tradable, hash: x.market_hash_name,
      });
    }
    if (!d.more_items) break;
    last = d.last_assetid;
  }
  return { cards, boosters, gems };
}
const getCards = async (id) => (await getInventory(id)).cards;

// ---- cache persistant des sets : la composition ne change (presque) jamais, le prix est rafraîchi à part ----
let setCache = null, saveTimer = null;
const cacheFile = () => path.join(dataDir(), 'sets.json');
function loadCache() { if (!setCache) { try { setCache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { setCache = {}; } } return setCache; }
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { writeJsonAtomic(cacheFile(), setCache); } catch {} }, 1500);
}
function flushCache() { // appelé à la fermeture de l'application
  clearTimeout(saveTimer);
  if (!setCache) return;
  try { writeJsonAtomic(cacheFile(), setCache); } catch {}
}
const cachedSet = (appid, currency) => loadCache()[appid + ':' + currency] || null;

// maxAge : âge maximal accepté (ms). Infinity = toujours utiliser le cache s'il existe.
async function getSet(appid, currency, maxAge = Infinity) {
  const hit = cachedSet(appid, currency);
  const EMPTY_TTL = 12 * 3600e3; // un jeu sans cartes ne doit pas être redemandé à chaque analyse
  if (hit && Date.now() - hit.t <= maxAge && (hit.set.length || Date.now() - hit.t < EMPTY_TTL)) return { set: hit.set, fromCache: true, t: hit.t };
  const q = `https://steamcommunity.com/market/search/render/?query=&start=0&count=40&search_descriptions=0&sort_column=name&sort_dir=asc&appid=753&norender=1&currency=${currency}` +
    `&category_753_Game%5B%5D=tag_app_${appid}&category_753_cardborder%5B%5D=tag_cardborder_0&category_753_item_class%5B%5D=tag_item_class_2`;
  const d = await jget(q);
  const set = ((d && d.results) || []).map((r) => ({
    hash: r.hash_name, name: r.asset_description.market_name || r.name,
    price: r.sell_price / 100, priceText: r.sell_price_text, listings: r.sell_listings,
    img: CDN + r.asset_description.icon_url + '/192fx192f',
    game: (r.asset_description.type || '').replace(/ Trading Card$/i, ''),
  }));
  loadCache()[appid + ':' + currency] = { t: Date.now(), set }; saveCache();
  return { set, fromCache: false, t: Date.now() };
}

module.exports = { inTask, cancelTask, isCancelled, rate, setAuthFetch, getBadgeDrops, resolveSteamId, getSummaries, getProfile, getBadgeStats, getOwnedNames, getFriends, getInventory, getCards, getSet, cachedSet, flushCache, CDN, sleep, rarityPoints };
