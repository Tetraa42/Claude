const fs = require('fs');
const path = require('path');
const { levelFromXp } = require('./levels');

const CDN = 'https://community.cloudflare.steamstatic.com/economy/image/';
const dataDir = () => process.env.BADGE_DATA_DIR || path.join(__dirname, '..', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// État partagé : quand Steam limite le débit, on attend au lieu d'échouer.
const rate = { waitUntil: 0 };
let lastCommunity = 0;

async function jget(url) {
  const community = url.includes('steamcommunity.com');
  for (let attempt = 0; ; attempt++) {
    if (community) { // 1 requête max toutes les ~2 s vers steamcommunity
      const gap = 2000 - (Date.now() - lastCommunity);
      if (gap > 0) await sleep(gap);
      lastCommunity = Date.now();
    }
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 steam-badge-trader' } });
    if (r.status === 429) {
      if (attempt >= 4) throw new Error('Steam limite toujours le débit (429). Patiente 5 minutes puis clique sur Actualiser : ce qui est déjà analysé est conservé.');
      const wait = [45, 90, 180, 300][attempt];
      rate.waitUntil = Date.now() + wait * 1000;
      await sleep(wait * 1000);
      rate.waitUntil = 0;
      continue;
    }
    if (r.status === 403 || r.status === 401) { const e = new Error('Profil ou inventaire privé'); e.code = 'PRIVATE'; throw e; }
    if (!r.ok) throw new Error(`Steam a répondu HTTP ${r.status}`);
    const t = await r.text();
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

async function getProfile(key, id) {
  const [[p = {}], b] = await Promise.all([
    getSummaries(key, [id]),
    jget(`https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${key}&steamid=${id}`),
  ]);
  const r = (b && b.response) || {};
  const xp = r.player_xp || 0, L = levelFromXp(xp);
  return {
    steamid: id, name: p.personaname || id, avatar: p.avatarfull, url: p.profileurl,
    level: r.player_level || 0, xp, intoLevel: L.intoLevel, needed: L.needed,
    badges: (r.badges || []).filter((x) => x.appid && x.border_color === 0).map((x) => ({ appid: x.appid, level: x.level, xp: x.xp })),
  };
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

// Cartes normales de l'inventaire Steam (appid 753, contexte 6) d'un compte public.
async function getCards(id) {
  const out = [];
  let last = '';
  for (let i = 0; i < 40; i++) {
    const d = await jget(`https://steamcommunity.com/inventory/${id}/753/6?l=english&count=2000${last ? '&start_assetid=' + last : ''}`);
    if (!d || !d.assets) break;
    const desc = new Map(d.descriptions.map((x) => [x.classid + '_' + x.instanceid, x]));
    for (const a of d.assets) {
      const x = desc.get(a.classid + '_' + a.instanceid);
      if (x && isNormalCard(x)) out.push({
        assetid: a.assetid, hash: x.market_hash_name, name: x.name, appid: Number(x.market_fee_app),
        game: (x.type || '').replace(/ Trading Card$/i, ''), img: CDN + x.icon_url + '/192fx192f', tradable: !!x.tradable,
      });
    }
    if (!d.more_items) break;
    last = d.last_assetid;
  }
  return out;
}

const readCache = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir(), 'sets.json'), 'utf8')); } catch { return {}; } };

// Cartes d'un jeu + prix (le moins cher en vente). Mis en cache 12 h sur le disque.
async function getSet(appid, currency) {
  const cache = readCache();
  const hit = cache[appid + ':' + currency];
  if (hit && Date.now() - hit.t < 12 * 3600e3) return { set: hit.set, fromCache: true };
  const q = `https://steamcommunity.com/market/search/render/?query=&start=0&count=40&search_descriptions=0&sort_column=name&sort_dir=asc&appid=753&norender=1&currency=${currency}` +
    `&category_753_Game%5B%5D=tag_app_${appid}&category_753_cardborder%5B%5D=tag_cardborder_0&category_753_item_class%5B%5D=tag_item_class_2`;
  const d = await jget(q);
  const set = ((d && d.results) || []).map((r) => ({
    hash: r.hash_name, name: r.asset_description.market_name || r.name,
    price: r.sell_price / 100, priceText: r.sell_price_text, listings: r.sell_listings,
    img: CDN + r.asset_description.icon_url + '/192fx192f',
    game: (r.asset_description.type || '').replace(/ Trading Card$/i, ''),
  }));
  const fresh = readCache();
  fresh[appid + ':' + currency] = { t: Date.now(), set };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), 'sets.json'), JSON.stringify(fresh));
  return { set, fromCache: false };
}

module.exports = { rate, resolveSteamId, getSummaries, getProfile, getOwnedNames, getFriends, getCards, getSet, CDN, sleep };
