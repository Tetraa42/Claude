const fs = require('fs');
const path = require('path');
const { levelFromXp } = require('./levels');

const CDN = 'https://community.cloudflare.steamstatic.com/economy/image/';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'sets.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 steam-badge-trader' } });
  if (r.status === 429) throw new Error('Steam limite le débit (429) : réessaie dans une minute.');
  if (r.status === 403) throw new Error('Accès refusé (403) : profil ou inventaire privé ?');
  if (!r.ok) throw new Error(`Steam a répondu HTTP ${r.status}`);
  return r.json();
}

async function resolveSteamId(input, key) {
  input = String(input || '').trim();
  let m = input.match(/\/profiles\/(\d{17})/) || input.match(/^(\d{17})$/);
  if (m) return m[1];
  m = input.match(/\/id\/([^/?#]+)/) || input.match(/^([\w-]+)$/);
  if (!m) throw new Error('Profil Steam invalide');
  const d = await jget(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${key}&vanityurl=${m[1]}`);
  if (d.response.success !== 1) throw new Error('Profil introuvable');
  return d.response.steamid;
}

async function getProfile(key, id) {
  const [s, b] = await Promise.all([
    jget(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${id}`),
    jget(`https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${key}&steamid=${id}`),
  ]);
  const p = s.response.players[0] || {};
  const r = b.response || {};
  const xp = r.player_xp || 0;
  return {
    steamid: id, name: p.personaname || id, avatar: p.avatarfull, url: p.profileurl,
    level: r.player_level || 0, xp,
    intoLevel: levelFromXp(xp).intoLevel, needed: levelFromXp(xp).needed,
    badges: (r.badges || []).filter((x) => x.appid && x.border_color === 0)
      .map((x) => ({ appid: x.appid, level: x.level })),
  };
}

const isNormalCard = (d) =>
  /Trading Card/i.test(d.type || '') &&
  (d.tags || []).some((t) => t.category === 'cardborder' && t.internal_name === 'cardborder_0');

// Inventaire public des cartes (appid 753, contexte 6). Renvoie les assets avec leur description.
async function getCards(id) {
  const out = [];
  let last = '';
  for (let i = 0; i < 20; i++) {
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
    await sleep(800);
  }
  return out;
}

// Tous les cartes d'un jeu + prix (marché Steam, le moins cher en vente).
async function getSet(appid, currency) {
  const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  const hit = cache[appid + ':' + currency];
  if (hit && Date.now() - hit.t < 6 * 3600e3) return hit.set;
  const q = `https://steamcommunity.com/market/search/render/?query=&start=0&count=40&search_descriptions=0&sort_column=name&sort_dir=asc&appid=753&norender=1&currency=${currency}` +
    `&category_753_Game%5B%5D=tag_app_${appid}&category_753_cardborder%5B%5D=tag_cardborder_0&category_753_item_class%5B%5D=tag_item_class_2`;
  const d = await jget(q);
  const set = (d.results || []).map((r) => ({
    hash: r.hash_name, name: r.asset_description.market_name || r.name,
    price: r.sell_price / 100, priceText: r.sell_price_text, listings: r.sell_listings,
    img: CDN + r.asset_description.icon_url + '/192fx192f',
    game: (r.asset_description.type || '').replace(/ Trading Card$/i, ''),
  }));
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  cache[appid + ':' + currency] = { t: Date.now(), set };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  return set;
}

// Construit la liste des sets à compléter, classés du moins cher au plus cher par XP gagné.
async function buildOverview({ key, steamid, currency, extraApps = [], onProgress }) {
  const [profile, cards] = await Promise.all([getProfile(key, steamid), getCards(steamid)]);
  const badgeLevel = new Map(profile.badges.map((b) => [b.appid, b.level]));
  const byApp = new Map();
  for (const c of cards) (byApp.get(c.appid) || byApp.set(c.appid, []).get(c.appid)).push(c);
  for (const a of extraApps) if (!byApp.has(a)) byApp.set(a, []);
  const sets = [];
  let i = 0;
  for (const [appid, mine] of byApp) {
    onProgress && onProgress(++i, byApp.size);
    const lvl = badgeLevel.get(appid) || 0;
    if (lvl >= 5) continue;
    let set;
    try { set = await getSet(appid, currency); } catch (e) { if (/429/.test(e.message)) throw e; continue; }
    if (!set.length) continue;
    const have = new Map();
    for (const c of mine) (have.get(c.hash) || have.set(c.hash, []).get(c.hash)).push(c);
    const cardsOut = set.map((s) => ({ ...s, owned: (have.get(s.hash) || []).length, assetids: (have.get(s.hash) || []).map((c) => c.assetid) }));
    const missing = cardsOut.filter((c) => !c.owned);
    const cost = +missing.reduce((t, c) => t + c.price, 0).toFixed(2);
    const dupes = cardsOut.reduce((t, c) => t + Math.max(0, c.owned - 1), 0);
    sets.push({
      appid, name: set[0].game || (mine[0] && mine[0].game) || `App ${appid}`, badgeLevel: lvl,
      total: set.length, ownedUnique: cardsOut.length - missing.length, cost, dupes,
      costPerXp: +(cost / 100).toFixed(4), cards: cardsOut,
      link: `https://www.steamcardexchange.net/index.php?gamepage-appid-${appid}`,
    });
    await sleep(1500); // respecte les limites de Steam
  }
  sets.sort((a, b) => a.cost - b.cost);
  return { profile, sets, totalCards: cards.length, myCards: cards };
}

module.exports = { resolveSteamId, getProfile, getCards, getSet, buildOverview, CDN };
