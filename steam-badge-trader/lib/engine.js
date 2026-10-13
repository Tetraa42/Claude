// Analyse en tâche de fond. L'état est sauvegardé sur disque : au prochain lancement (ou après une mise à jour du logiciel)
// tout est affiché immédiatement, puis rafraîchi discrètement.
const fs = require('fs');
const path = require('path');
const steam = require('./steam');
const demo = require('./demo');
const sce = require('./sce');
const { writeJsonAtomic } = require('./fsutil');
const { levelFromXp, totalXpForLevel } = require('./levels');

const BOT_DEFAULT = 'https://steamcommunity.com/id/CardExchange';
const PRICE_TTL = 6 * 3600e3, BOT_TTL = 30 * 60e3, RANK_TTL = 3600e3;
const S = {
  running: false, refreshing: false, phase: '', done: 0, total: 0, needFetch: 0, fetched: 0, error: null, profile: null, names: new Map(), myCards: [], boosters: [],
  sets: [], completed: [], updatedAt: 0, demo: false, currency: 3, botOnly: true,
  bot: { status: 'idle', error: null, name: 'SteamCardExchange', count: 0, games: 0, t: 0 },
  retry: { at: 0, n: 0 },
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
  if (S.demo || !S.profile) return; // rien d'utile à sauvegarder : on ne remplace surtout pas une bonne sauvegarde par un état vide
  try {
    writeJsonAtomic(stateFile(), { v: 2, t: S.updatedAt, currency: S.currency, profile: S.profile, completed: S.completed, sets: S.sets, myCards: S.myCards, boosters: S.boosters,
      rank: S.rank.list, rankT: S.rank.t });
  } catch {}
}
function loadSaved() {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (d.v !== 2) return false;
    Object.assign(S, { profile: d.profile, completed: d.completed || [], sets: d.sets || [], myCards: d.myCards || [], boosters: d.boosters || [], updatedAt: d.t || 0, currency: d.currency || 3 });
    restoreBot(); // l'inventaire du bot est mémorisé à part (sce.json)
    S.rank.list = d.rank || []; S.rank.t = d.rankT || 0; S.rank.status = S.rank.list.length ? 'ready' : 'idle';
    return !!S.profile;
  } catch { return false; }
}
const isFresh = (ms = 10 * 60e3) => S.updatedAt && Date.now() - S.updatedAt < ms;

// ---------- bot (SteamCardExchange) ----------
// L'inventaire Steam du bot est gigantesque (des centaines de pages → Steam répond « 429 »). On lit à la place le tableau
// « Inventory » du site : une ligne par jeu avec la valeur en crédits, le stock et le nombre de cartes différentes en stock.
function restoreBot() {
  const B = S.bot;
  if (!sce.hasData()) return;
  const t = sce.totals();
  Object.assign(B, { count: t.cards, games: t.games, t: sce.status().invAge, status: 'ready', error: null });
}
async function loadBot(force = false) {
  const B = S.bot;
  B.status = 'loading'; B.error = null;
  try { await sce.readInventory(force); restoreBot(); return true; }
  catch (e) { B.status = 'error'; B.error = e.message; return false; }
}
async function refreshBot() { if (!S.demo) { await loadBot(true); saveState(); } }

// ---------- analyse principale ----------
async function run(cfg, force = false) {
  if (S.running && !force) return;
  const id = ++runId; // une analyse plus récente annule l'ancienne (ex. changement de compte dans les Réglages)
  const stale = () => id !== runId;
  Object.assign(S, { running: true, refreshing: false, error: null, done: 0, total: 0, needFetch: 0, fetched: 0, demo: false, currency: cfg.currency, botOnly: cfg.botOnly });
  try {
    S.phase = 'Lecture de ton profil Steam';
    const sid = await steam.resolveSteamId(cfg.profile, cfg.key);
    const profile = await steam.getProfile(cfg.key, sid);
    const names = await steam.getOwnedNames(cfg.key, sid);
    if (stale()) return;
    S.profile = profile; S.names = names;
    S.completed = profile.badges.filter((b) => b.level >= 5).map((b) => ({ appid: b.appid, name: names.get(b.appid) || `Jeu ${b.appid}`, level: b.level, banner: header(b.appid) }));
    saveState();
    S.phase = 'Lecture de ton inventaire (cartes et boosters)';
    let inv;
    try { inv = await steam.getInventory(sid); } catch (e) { throw e.code === 'PRIVATE' ? new Error('Ton inventaire Steam est privé : passe-le en Public (Steam > Profil > Confidentialité > Inventaire).') : e; }
    if (stale()) return;
    S.myCards = inv.cards; S.boosters = inv.boosters;
    saveState();

    if (cfg.botOnly && !(S.bot.status === 'ready' && Date.now() - S.bot.t < BOT_TTL)) { S.phase = 'Lecture de l\'inventaire du bot (SteamCardExchange)'; await loadBot(); if (stale()) return; }
    const lvl = levelsMap();
    const byApp = groupBy(S.myCards, (c) => c.appid);
    let apps = [...byApp.entries()].filter(([a]) => (lvl.get(a) || 0) < 5);
    if (cfg.botOnly && S.bot.status === 'ready') { // uniquement les jeux que le bot a en stock (si aucun nom ne correspond, on garde tout plutôt que de ne rien montrer)
      const inStock = apps.filter(([a, mine]) => { const r = sce.lookup(a, mine[0].game); return r && r.stock > 0; });
      if (inStock.length) apps = inStock;
    }
    apps.sort((a, b) => b[1].length - a[1].length); // les plus avancés d'abord
    S.total = apps.length;
    S.needFetch = apps.filter(([a]) => !steam.cachedSet(a, cfg.currency)).length;
    S.phase = 'Analyse des sets et des prix';
    const seen = new Set();
    let sinceSave = 0;
    for (const [appid, mine] of apps) {
      if (stale()) return;
      try {
        const { set, fromCache, t } = await steam.getSet(appid, cfg.currency, Infinity);
        if (stale()) return;
        if (!fromCache) S.fetched++;
        seen.add(appid);
        if (set.length) upsert(buildSet({ appid, name: S.names.get(appid), lvl: lvl.get(appid) || 0, set, mine, t }));
      } catch (e) {
        if (/429/.test(e.message)) throw e;
        if (S.sets.some((x) => x.appid === appid)) seen.add(appid); // erreur ponctuelle : on garde ce qu'on avait
      }
      S.done++;
      if (++sinceSave >= 5) { sinceSave = 0; saveState(); } // rien n'est perdu si on ferme le logiciel en cours d'analyse
    }
    S.sets = S.sets.filter((x) => seen.has(x.appid));
    S.updatedAt = Date.now(); S.phase = ''; S.retry = { at: 0, n: 0 };
    saveState();
    S.running = false;
    if (cfg.onDone) { try { cfg.onDone(); } catch {} }
    refreshPrices(cfg, id).catch(() => {});
    return;
  } catch (e) {
    if (stale()) return;
    S.error = e.message; S.phase = '';
    saveState();
    if (/429/.test(e.message) && S.retry.n < 6) { // Steam nous a freinés : on réessaie tout seul dans 5 minutes (l'analyse déjà faite est conservée)
      S.retry = { at: Date.now() + 5 * 60e3, n: S.retry.n + 1 };
      setTimeout(() => { if (!S.running && !S.demo && S.retry.at) run(cfg); }, 5 * 60e3).unref();
    }
  }
  S.running = false;
}

// Remise à zéro complète (changement de compte) : annule l'analyse en cours.
function reset() {
  runId++;
  Object.assign(S, { demo: false, running: false, refreshing: false, phase: '', done: 0, total: 0, error: null, profile: null, names: new Map(), myCards: [], boosters: [], sets: [], completed: [], updatedAt: 0 });
  Object.assign(S.bot, { status: 'idle', error: null, apps: null, count: 0, games: 0, t: 0 });
  S.retry = { at: 0, n: 0 };
  Object.assign(S.friends, { status: 'idle', error: null, done: 0, total: 0, list: [], inv: new Map() });
  Object.assign(S.rank, { status: 'idle', error: null, done: 0, total: 0, list: [], t: 0 });
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
      if (id !== runId) break;
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
    while (S.running) await steam.sleep(2000); // on n'envoie pas deux rafales à Steam en même temps
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

function loadDemo() { Object.assign(S, { demo: true, running: false, error: null }, demo.demoState()); demo.demoCredits(sce); }

// ---------- vue envoyée à l'interface ----------
// Ajoute au set les infos du bot SteamCardExchange (stock, valeur en crédits), des amis et des crédits.
function enrichSet(s, cpc = 0) {
  const F = S.friends;
  const bi = sce.lookup(s.appid, s.name); // { worth, stock, cardsInSet, setsAvail, distinct }
  const missing = s.cards.filter((c) => !c.owned);
  const worth = bi ? bi.worth : cpc || null; // crédits que le bot donne pour une carte de ce jeu
  const cards = s.cards.map((c) => ({ ...c, assetids: undefined, credits: worth }));
  const friends = F.list.map((f) => {
    const inv = F.inv.get(f.steamid); if (!inv) return null;
    const have = missing.filter((c) => inv.has(c.hash)).map((c) => c.hash);
    return have.length ? { steamid: f.steamid, name: f.name, avatar: f.avatar, have } : null;
  }).filter(Boolean).sort((a, b) => b.have.length - a.have.length);
  const ownedCount = s.cards.reduce((t, c) => t + c.owned, 0);
  return { ...s, cards, friends, worth, creditsOwned: worth != null ? +(worth * ownedCount).toFixed(2) : null,
    botStock: bi ? bi.stock : 0, botDistinct: bi ? Math.min(bi.distinct, s.total) : 0, botSets: bi ? bi.setsAvail : 0, botHas: bi ? Math.min(bi.distinct, missing.length) : 0,
    stale: Date.now() - (s.priceT || 0) > PRICE_TTL };
}

function snapshot(opt = {}) {
  const B = S.bot, F = S.friends, cpc = Number(opt.creditsPerCard) || 0;
  const sets = S.sets.map((s) => enrichSet(s, cpc));
  const boosters = [...groupBy(S.boosters, (b) => b.appid).values()].map((g) => ({ appid: g[0].appid, name: g[0].name, game: g[0].game, img: g[0].img, count: g.length, assetid: g[0].assetid, banner: header(g[0].appid) }));
  const p = S.profile, gain = sets.length * 100;
  const fetchLeft = Math.max(0, S.needFetch - S.fetched);
  const manual = opt.creditsBalance === '' || opt.creditsBalance == null ? null : Number(opt.creditsBalance);
  const scest = sce.status(), hasInv = sce.hasData();
  const valueOf = (cards) => +cards.reduce((t, c) => t + ((sce.lookup(c.appid, c.game) || {}).worth || 0), 0).toFixed(2);
  const ownedValue = hasInv ? valueOf(S.myCards) : null;        // ce que le bot te donnerait pour toutes tes cartes
  const spareValue = hasInv ? valueOf(spareCards()) : null;      // … pour tes seules cartes en trop
  return {
    demo: S.demo, currency: S.currency, profile: p, sets, completed: S.completed, boosters, updatedAt: S.updatedAt,
    progress: { running: S.running, refreshing: S.refreshing, phase: S.phase, done: S.done, total: S.total, fetchLeft, etaMin: Math.ceil((fetchLeft * 3.1) / 60),
      wait: Math.max(0, Math.round((steam.rate.waitUntil - Date.now()) / 1000)), retryIn: S.retry.at ? Math.max(0, Math.round((S.retry.at - Date.now()) / 1000)) : 0, error: S.error },
    bot: { status: B.status, error: B.error, name: B.name, count: B.count, games: B.games, botOnly: S.botOnly },
    friends: { status: F.status, error: F.error, done: F.done, total: F.total, count: F.list.length },
    rank: { status: S.rank.status, error: S.rank.error, done: S.rank.done, total: S.rank.total, list: S.rank.list },
    projection: p && { gainXp: gain, level: levelFromXp(p.xp + gain).level, nextLevelXp: totalXpForLevel(p.level + 1) - p.xp },
    credits: { balance: scest.balance != null ? scest.balance : manual, perCard: cpc || null, sce: scest, ownedValue, spareValue },
  };
}

// Détails d'un jeu (même s'il n'est pas dans la liste des sets, ex. badge déjà niveau 5).
async function gameDetail(appid, cfg, cpc) {
  const lvl = levelsMap();
  let set = S.sets.find((s) => s.appid === appid);
  if (!set) {
    const { set: cards, t } = await steam.getSet(appid, cfg.currency, Infinity);
    if (!cards.length) throw new Error('Aucune carte trouvée pour ce jeu');
    set = buildSet({ appid, name: S.names.get(appid) || cards[0].game, lvl: lvl.get(appid) || 0, set: cards, mine: S.myCards.filter((c) => c.appid === appid), t });
  }
  const badge = S.profile && S.profile.badges.find((b) => b.appid === appid);
  const boosters = S.boosters.filter((b) => b.appid === appid);
  return { set: enrichSet(set, cpc), badge: badge ? { level: badge.level, xp: badge.xp } : { level: 0, xp: 0 },
    boosters: boosters.length ? { count: boosters.length, assetid: boosters[0].assetid, img: boosters[0].img, name: boosters[0].name } : null,
    bot: { status: S.bot.status, name: S.bot.name } };
}

// Cartes manquantes (tous jeux confondus) retrouvées par leur hash, pour le panier d'échange.
function missingByHash() {
  const m = new Map();
  for (const s of S.sets) for (const c of s.cards) if (!c.owned) m.set(c.hash, { ...c, appid: s.appid, game: s.name });
  return m;
}
function flush() { saveState(); steam.flushCache(); sce.flush(); }

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
module.exports = { S, run, reset, refreshBot, scanFriends, scanRank, loadDemo, loadSaved, isFresh, saveState, snapshot, spareCards, groupBy, gameDetail, missingByHash, flush, BOT_DEFAULT };
