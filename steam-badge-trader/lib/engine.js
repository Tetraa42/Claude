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
  sets: [], wishlist: [], alerts: [], history: [], completed: [], drops: new Map(), updatedAt: 0, demo: false, currency: 3, botOnly: true,
  bot: { status: 'idle', error: null, name: 'SteamCardExchange', count: 0, games: 0, t: 0 },
  retry: { at: 0, n: 0 }, gems: { gems: 0, sacks: 0 }, invT: 0, catalog: { t: 0, gems: { total: 0, tradable: 0, untradable: 0 }, map: {} }, gemVal: {},
  tasks: Object.fromEntries(['badges', 'cards', 'boosters', 'gems', 'bot', 'friends', 'balance', 'verify'].map((k) => [k, { state: 'idle', pct: 0, label: '', eta: null, estSec: 0, timeBased: false, t0: 0, doneAt: 0, error: null }])),
  friends: { status: 'idle', error: null, done: 0, total: 0, list: [], inv: new Map() },
  rank: { status: 'idle', error: null, done: 0, total: 0, list: [], t: 0, badges: new Map() },
  journal: [], events: null,
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
// Set provisoire : affiché tout de suite à partir de TON inventaire et du tableau du bot, avant que le marché Steam n'ait répondu (prix et cartes manquantes pas encore connus).
function provisionalSet({ appid, name, lvl, mine, bi }) {
  const owned = groupBy(mine, (c) => c.hash);
  const total = Math.max(bi ? bi.cardsInSet : 0, owned.size);
  const cards = [...owned.entries()].map(([hash, list]) => ({ hash, name: list[0].name, price: 0, priceText: '', listings: 0, img: list[0].img, game: list[0].game, owned: list.length, assetids: list.map((c) => c.assetid) }));
  for (let i = cards.length; i < total; i++) cards.push({ hash: `?${appid}-${i}`, name: 'Carte pas encore connue', price: 0, priceText: '', listings: 0, img: '', owned: 0, assetids: [], unknown: true });
  const missing = total - owned.size;
  return { appid, name: name || (mine[0] && mine[0].game) || `App ${appid}`, badgeLevel: lvl, total, ownedUnique: owned.size, missingCount: missing, cost: missing === 0 ? 0 : null,
    dupes: [...owned.values()].reduce((t, l) => t + Math.max(0, l.length - 1), 0), cards, priceT: 0, provisional: true, banner: header(appid), link: `https://www.steamcardexchange.net/index.php?gamepage-appid-${appid}` };
}
const upsert = (set) => { const i = S.sets.findIndex((s) => s.appid === set.appid); if (i >= 0) S.sets[i] = set; else S.sets.push(set); };
const levelsMap = () => new Map((S.profile ? S.profile.badges : []).map((b) => [b.appid, b.level]));

// ---------- historique de progression (niveau, XP, badges, crédits, gemmes) ----------
function recordHistory() {
  const p = S.profile; if (!p) return;
  const pt = { t: Date.now(), level: p.level, xp: p.xp, badges: p.badgeCount || (p.badges || []).length, balance: sce.status().balance ?? null, gems: S.gems.gems + S.gems.sacks * 1000 };
  const last = S.history[S.history.length - 1];
  if (last && pt.t - last.t < 6 * 3600e3 && last.xp === pt.xp && last.balance === pt.balance && last.gems === pt.gems && last.badges === pt.badges) return;
  if (last && pt.t - last.t < 30 * 60e3) S.history[S.history.length - 1] = pt; else S.history.push(pt);
  if (S.history.length > 1500) S.history.splice(0, S.history.length - 1500);
}
// rythme de gain d'XP (par jour) sur les 30 derniers jours et date estimée du prochain niveau
function pace(nextLevelXp) {
  const h = S.history.filter((x) => Date.now() - x.t < 30 * 86400e3);
  if (h.length < 2) return null;
  const a = h[0], b = h[h.length - 1], days = (b.t - a.t) / 86400e3, gain = b.xp - a.xp;
  if (days < 0.5 || gain <= 0) return { xpPerDay: 0, etaDays: null };
  const xpPerDay = gain / days;
  return { xpPerDay: +xpPerDay.toFixed(1), etaDays: nextLevelXp > 0 ? Math.ceil(nextLevelXp / xpPerDay) : null };
}
// ---------- sauvegarde / chargement ----------
// Amis : on mémorise la liste et, pour chacun, les cartes manquantes qu'il a (sinon tout est perdu à la fermeture)
function friendsDump() {
  const F = S.friends; if (!F.list.length || !F.inv.size) return null;
  return { t: F.t || 0, stats: F.stats || null, list: F.list, inv: Object.fromEntries([...F.inv].map(([id, m]) => [id, Object.fromEntries([...m].map(([h, l]) => [h, l.map((c) => ({ assetid: c.assetid, hash: c.hash, name: c.name, img: c.img, tradable: true }))]))])) };
}
function friendsRestore(d) {
  if (!d || !d.list) return;
  const F = S.friends;
  F.list = d.list; F.total = d.list.length; F.done = F.total; F.t = d.t || 0; F.stats = d.stats || null;
  F.inv = new Map(Object.entries(d.inv || {}).map(([id, o]) => [id, new Map(Object.entries(o))]));
  F.status = 'ready';
}
function saveState() {
  if (!S.demo && S.profile) recordHistory();
  if (S.demo || !S.profile) return; // rien d'utile à sauvegarder : on ne remplace surtout pas une bonne sauvegarde par un état vide
  try {
    writeJsonAtomic(stateFile(), { v: 2, t: S.updatedAt, currency: S.currency, profile: S.profile, completed: S.completed, drops: [...S.drops], sets: S.sets, myCards: S.myCards, boosters: S.boosters, gems: S.gems, catalog: S.catalog, gemVal: S.gemVal, invT: S.invT, wishlist: S.wishlist, alerts: S.alerts, history: S.history, friends: friendsDump(), journal: S.journal, events: S.events, taskAt: Object.fromEntries(Object.entries(S.tasks).map(([k, t]) => [k, t.doneAt])),
      rank: S.rank.list, rankT: S.rank.t });
  } catch {}
}
function loadSaved() {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (d.v !== 2) return false;
    Object.assign(S, { drops: new Map(d.drops || []), profile: d.profile, completed: d.completed || [], sets: d.sets || [], myCards: d.myCards || [], boosters: d.boosters || [], updatedAt: d.t || 0, currency: d.currency || 3 });
    S.gems = d.gems || { gems: 0, sacks: 0 }; S.invT = d.invT || 0; if (d.catalog) S.catalog = d.catalog; S.gemVal = d.gemVal || {}; S.wishlist = d.wishlist || []; S.alerts = d.alerts || []; friendsRestore(d.friends); S.history = d.history || []; S.journal = d.journal || []; S.events = d.events || null;
    for (const [k, at] of Object.entries(d.taskAt || {})) if (S.tasks[k] && at) Object.assign(S.tasks[k], { state: 'done', pct: 100, doneAt: at }); // « dernier scan : il y a … »
    restoreBot(); // l'inventaire du bot est mémorisé à part (sce.json)
    S.rank.list = d.rank || []; S.rank.t = d.rankT || 0; S.rank.status = S.rank.list.length ? 'ready' : 'idle';
    return !!S.profile;
  } catch { return false; }
}
const isFresh = (ms = 10 * 60e3) => S.updatedAt && Date.now() - S.updatedAt < ms;
const badgesFresh = (ms = 10 * 60e3) => !!(S.profile && S.tasks.badges.doneAt && Date.now() - S.tasks.badges.doneAt < ms);

// ---------- tâches : chaque scan a sa progression (% et temps estimé), affichée dans un bouton qui se remplit ----------
const begin = (k, label, estSec = 0) => Object.assign(S.tasks[k], { state: 'running', pct: 0, label, eta: null, estSec, timeBased: estSec > 0, t0: Date.now(), error: null, note: null, stopped: false });
function prog(k, pct, label) {
  const t = S.tasks[k];
  t.timeBased = false; t.pct = Math.max(t.pct, Math.min(99, Math.round(pct)));
  if (label) t.label = label;
  const el = (Date.now() - t.t0) / 1000;
  t.eta = t.pct >= 4 ? Math.max(0, Math.round((el * (100 - t.pct)) / t.pct)) : null; // temps restant estimé d'après la vitesse déjà observée
}
function finish(k, err) {
  const t = S.tasks[k];
  if (t.state !== 'running') return; // arrêtée entre-temps : on ne touche plus à son état
  if (err) Object.assign(t, { state: 'error', error: err, eta: null });
  else Object.assign(t, { state: 'done', pct: 100, eta: 0, timeBased: false, doneAt: Date.now(), error: null });
}
const running = (k) => S.tasks[k].state === 'running';
const gens = {}; const bump = (k) => (gens[k] = (gens[k] || 0) + 1); // numéro de lancement : si il change, la tâche a été arrêtée

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
  const B = S.bot, gen = bump('bot');
  B.status = 'loading'; B.error = null;
  begin('bot', 'Lecture du tableau d\'inventaire du bot', 30);
  try {
    await sce.readInventory(force);
    if (gens.bot !== gen) return false; // arrêté
    try { prog('bot', 55, 'Lecture des prix des badges'); await sce.readBadgePrices(force); } catch { /* facultatif */ }
    if (gens.bot !== gen) return false;
    restoreBot(); finish('bot'); saveState(); return true;
  } catch (e) { if (gens.bot !== gen) return false; B.status = 'error'; B.error = e.message; finish('bot', e.message); return false; }
}
async function refreshBot() { if (!S.demo && !running('bot')) await loadBot(true); }

// ---------- 1) badges : lu au lancement (profil + page de badges) ----------
const scanBadges = (cfg) => steam.inTask('badges', () => scanBadgesBody(cfg));
async function scanBadgesBody(cfg) {
  if (running('badges')) return;
  const id = runId, gen = bump('badges'), dead = () => id !== runId || gens.badges !== gen;
  begin('badges', 'Lecture du profil Steam');
  S.error = null;
  try {
    const sid = await steam.resolveSteamId(cfg.profile, cfg.key); prog('badges', 8);
    const profile = await steam.getProfile(cfg.key, sid); prog('badges', 20, 'Lecture de la liste de tes jeux');
    const names = await steam.getOwnedNames(cfg.key, sid);
    if (dead()) return;
    Object.assign(S, { profile, names, demo: false, currency: cfg.currency, botOnly: cfg.botOnly });
    S.completed = profile.badges.filter((b) => b.level >= 5).map((b) => ({ appid: b.appid, name: names.get(b.appid) || `Jeu ${b.appid}`, level: b.level, banner: header(b.appid) }));
    prog('badges', 30, 'Lecture de ta page de badges'); saveState();
    const pages = Math.max(1, Math.ceil((profile.badgeCount || 1) / 150));
    try {
      const drops = await steam.getBadgeDrops(sid, (p) => prog('badges', 30 + 68 * Math.min(1, p / pages), `Page de badges ${p}`));
      if (dead()) return;
      if (drops.size) S.drops = drops;
    } catch (e) { S.tasks.badges.note = 'Cartes à récupérer en jouant : page des badges illisible (' + e.message + ')'; }
    saveState(); finish('badges');
  } catch (e) { if (dead() || e.code === 'CANCELLED') return; finish('badges', e.message); S.error = e.message; }
}

// ---------- 2) inventaire Steam : une seule requête alimente cartes, boosters et gemmes ----------
let invPromise = null;
function ensureInventory(cfg) {
  if (S.invT && Date.now() - S.invT < 5 * 60e3) return Promise.resolve();
  if (invPromise) return invPromise;
  const id = runId, g0 = gens.inv || 0, group = ['boosters', 'gems'], dead = () => id !== runId || (gens.inv || 0) !== g0;
  invPromise = steam.inTask('inv', async () => {
    group.forEach((k) => begin(k, 'Lecture de ton inventaire Steam'));
    if (!running('cards')) begin('cards', 'Lecture de ton inventaire Steam');
    try {
      const sid = S.profile ? S.profile.steamid : await steam.resolveSteamId(cfg.profile, cfg.key);
      let inv;
      try { inv = await steam.getInventory(sid, (loaded, total) => { const pct = total ? (100 * loaded) / total : 50; group.forEach((k) => prog(k, pct)); prog('cards', pct * 0.15); }); }
      catch (e) { throw e.code === 'PRIVATE' ? new Error('Ton inventaire Steam est privé : passe-le en Public (Steam > Profil > Confidentialité > Inventaire).') : e; }
      if (dead()) return;
      S.myCards = inv.cards; S.boosters = inv.boosters; S.gems = { ...S.gems, ...inv.gems }; S.invT = Date.now();
      group.forEach((k) => finish(k)); saveState();
    } catch (e) { group.forEach((k) => finish(k, e.message)); throw e; }
    finally { invPromise = null; }
  });
  return invPromise;
}
async function scanBoosters(cfg) { if (running('boosters')) return; try { await ensureInventory(cfg); } catch (e) { S.error = e.message; } }
const scanGems = scanBoosters; // même requête Steam : boosters et gemmes se remplissent ensemble

// ---------- 3) cartes : inventaire + sets + prix (long, avec progression et temps restant) ----------
const scanCards = (cfg) => steam.inTask('cards', () => scanCardsBody(cfg));
async function scanCardsBody(cfg) {
  if (S.running) return;
  const id = runId, gen = bump('cards'), dead = () => id !== runId || gens.cards !== gen;
  Object.assign(S, { running: true, error: null, done: 0, total: 0, needFetch: 0, fetched: 0, demo: false, currency: cfg.currency, botOnly: cfg.botOnly });
  begin('cards', 'Lecture de ton inventaire Steam');
  try {
    if (!S.profile) { await scanBadges(cfg); if (!S.profile) throw new Error(S.error || 'Profil introuvable : vérifie tes Réglages.'); }
    await ensureInventory(cfg);
    if (dead()) return;
    prog('cards', 15, 'Lecture de l\'inventaire du bot');
    if (cfg.botOnly && !(S.bot.status === 'ready' && Date.now() - S.bot.t < BOT_TTL)) { await loadBot(); if (dead()) return; }
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
    for (const [appid, mine] of apps) { // tes jeux apparaissent tout de suite, les prix arrivent ensuite jeu après jeu
      if (!S.sets.some((x) => x.appid === appid) && !steam.cachedSet(appid, cfg.currency)) upsert(provisionalSet({ appid, name: S.names.get(appid), lvl: lvl.get(appid) || 0, mine, bi: sce.lookup(appid, mine[0].game) }));
    }
    prog('cards', 16, `Prix : 0/${apps.length} jeux`);
    const seen = new Set();
    let sinceSave = 0;
    for (const [appid, mine] of apps) {
      if (dead()) return;
      try {
        const { set, fromCache, t } = await steam.getSet(appid, cfg.currency, Infinity);
        if (dead()) return;
        if (!fromCache) S.fetched++;
        seen.add(appid);
        if (set.length) upsert(buildSet({ appid, name: S.names.get(appid), lvl: lvl.get(appid) || 0, set, mine, t }));
      } catch (e) {
        if (/429/.test(e.message)) throw e;
        if (S.sets.some((x) => x.appid === appid)) seen.add(appid); // erreur ponctuelle : on garde ce qu'on avait
      }
      S.done++;
      prog('cards', 16 + (84 * S.done) / Math.max(1, S.total), `Prix : ${S.done}/${S.total} jeux`);
      S.tasks.cards.eta = Math.ceil(Math.max(0, S.needFetch - S.fetched) * 3.1); // le reste vient de la mémoire : seuls les jeux jamais lus coûtent du temps
      if (++sinceSave >= 5) { sinceSave = 0; saveState(); } // rien n'est perdu si on ferme le logiciel en cours d'analyse
    }
    S.sets = S.sets.filter((x) => seen.has(x.appid));
    S.updatedAt = Date.now(); S.retry = { at: 0, n: 0 };
    finish('cards'); saveState();
    if (gens.cards === gen) S.running = false;
    if (cfg.onDone) { try { cfg.onDone(); } catch {} }
    refreshPrices(cfg, id).catch(() => {});
    return;
  } catch (e) {
    if (dead() || e.code === 'CANCELLED') return;
    S.error = e.message; finish('cards', e.message);
    saveState();
    if (/429/.test(e.message) && S.retry.n < 6) { // Steam nous a freinés : on réessaie tout seul dans 5 minutes (le travail déjà fait est conservé)
      S.retry = { at: Date.now() + 5 * 60e3, n: S.retry.n + 1 };
      setTimeout(() => { if (!S.running && !S.demo && S.retry.at) scanCards(cfg); }, 5 * 60e3).unref();
    }
  }
  if (gens.cards === gen) S.running = false;
}
// « Tout actualiser » : badges puis cartes
async function run(cfg) { await scanBadges(cfg); if (S.profile && !S.demo) await scanCards(cfg); }

// Remise à zéro complète (changement de compte) : annule les scans en cours.
function reset() {
  runId++; invPromise = null;
  Object.assign(S, { drops: new Map(), demo: false, running: false, refreshing: false, phase: '', done: 0, total: 0, error: null, profile: null, names: new Map(), myCards: [], boosters: [], sets: [], completed: [], updatedAt: 0, gems: { gems: 0, sacks: 0 }, invT: 0, catalog: { t: 0, gems: { total: 0, tradable: 0, untradable: 0 }, map: {} }, gemVal: {} });
  for (const t of Object.values(S.tasks)) Object.assign(t, { state: 'idle', pct: 0, label: '', eta: null, doneAt: 0, error: null, note: null });
  Object.assign(S.bot, { status: 'idle', error: null, apps: null, count: 0, games: 0, t: 0 });
  S.retry = { at: 0, n: 0 };
  Object.assign(S.friends, { status: 'idle', error: null, done: 0, total: 0, list: [], inv: new Map() });
  Object.assign(S.rank, { status: 'idle', error: null, done: 0, total: 0, list: [], t: 0 });
}

// Rafraîchit en arrière-plan les prix devenus trop vieux (le plus intéressant d'abord), sans bloquer l'affichage.
async function refreshPrices(cfg, id) { // (id = numéro du scan qui l'a lancé)
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
const scanFriends = (cfg) => steam.inTask('friends', () => scanFriendsBody(cfg));
async function scanFriendsBody(cfg) {
  const F = S.friends;
  if (F.status === 'loading') return;
  const gen = bump('friends'), dead = () => gens.friends !== gen;
  Object.assign(F, { status: 'loading', error: null, done: 0, total: 0, inv: new Map(), stats: { scanned: 0, private: 0, errors: 0, withCards: 0, cards: 0 } });
  begin('friends', 'Lecture de ta liste d\'amis', 8);
  try {
    if (S.demo) { F.total = F.list.length; demo.fillFriends(F, S); F.stats = { scanned: F.total, private: 0, errors: 0, withCards: F.total, cards: 12 }; finish('friends'); return; }
    F.list = await steam.getFriends(cfg.key, S.profile.steamid);
    F.total = F.list.length;
    prog('friends', 2, `Amis : 0/${F.total}`);
    while (S.running) await steam.sleep(2000); // on n'envoie pas deux rafales à Steam en même temps
    const wanted = new Set(S.sets.flatMap((s) => s.cards.filter((c) => !c.owned).map((c) => c.hash)));
    for (const f of F.list) {
      if (dead()) return;
      try {
        const cards = (await steam.getCards(f.steamid)).filter((c) => c.tradable && wanted.has(c.hash));
        F.inv.set(f.steamid, groupBy(cards, (c) => c.hash));
        F.stats.scanned++; if (cards.length) { F.stats.withCards++; F.stats.cards += cards.length; }
      } catch (e) { if (e.code === 'CANCELLED') return; if (e.code === 'PRIVATE') F.stats.private++; else { F.stats.errors++; F.error = e.message; if (/429/.test(e.message)) break; } }
      F.done++;
      prog('friends', (100 * F.done) / Math.max(1, F.total), `Amis : ${F.done}/${F.total}`);
      S.tasks.friends.eta = Math.ceil((F.total - F.done) * 3.2);
    }
    F.status = 'ready'; F.t = Date.now(); finish('friends'); saveState();
  } catch (e) {
    if (dead() || e.code === 'CANCELLED') return;
    F.status = 'error'; F.error = e.code === 'PRIVATE' ? 'Ta liste d\'amis est privée (Steam > Confidentialité > Liste d\'amis : Public).' : e.message;
    finish('friends', F.error);
  }
}

// ---------- classement entre amis (niveau, badges, rareté) ----------
async function scanRank(cfg) {
  const R = S.rank;
  if (R.status === 'loading') return;
  Object.assign(R, { status: 'loading', error: null, done: 0, total: 0 });
  try {
    if (S.demo) { R.list = demo.demoRank(S); R.badges = demo.demoBadges(S); R.badges.set(S.profile.steamid, S.sets.map((x) => ({ appid: x.appid, level: x.badgeLevel, xp: 100, scarcity: 50000 }))); R.status = 'ready'; return; }
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
      if (st && st.badges) R.badges.set(p.steamid, st.badges);
      if (st) out.push({ steamid: p.steamid, name: p.name, avatar: p.avatar, me: !!p.me, level: st.level, xp: st.xp, badgeCount: st.badgeCount, rareCount: st.rareCount, rarity: st.rarity });
      R.done++;
      R.list = out.slice();
    }
    R.t = Date.now(); R.status = 'ready'; saveState();
  } catch (e) { R.status = 'error'; R.error = e.message; }
}

async function scanBalance() {
  if (running('balance')) return;
  const gen = bump('balance');
  begin('balance', 'Lecture de ton profil SteamCardExchange', 14);
  try { await sce.refreshBalance(); try { importSceTrades(); } catch { /* facultatif */ } if (gens.balance === gen) finish('balance'); } catch (e) { if (gens.balance === gen) finish('balance', e.message); }
}
// ---------- gemmes : catalogue des boosters (prix en gemmes) et valeur d'une carte ----------
function setCatalog(r) {
  const map = {};
  for (const a of Object.values(r.catalog || {})) map[a.appid] = { name: a.name, price: a.price, unavailable: !!a.unavailable, availableAtTime: a.availableAtTime ? new Date(a.availableAtTime).getTime() : null };
  S.catalog = { t: Date.now(), gems: { total: r.totalGems, tradable: r.tradableGems, untradable: r.untradableGems }, map };
  saveState();
}
// Rentabilité d'un booster : 3 cartes au prix moyen du marché du jeu (valeur ≈ ce qu'on récupère) rapportée à 1 000 gemmes
const catalogList = () => Object.entries(S.catalog.map).map(([appid, v]) => {
  const a = Number(appid), set = S.sets.find((x) => x.appid === a), prices = set ? set.cards.map((c) => c.price).filter((p) => p > 0) : [];
  const avg = prices.length ? prices.reduce((t, p) => t + p, 0) / prices.length : null, w = (sce.lookup(a, v.name) || {}).worth || null;
  return { appid: a, ...v, ev: avg != null ? +(3 * avg).toFixed(3) : null, evCredits: w ? +(3 * w).toFixed(1) : null, perK: avg != null && v.price ? +((3 * avg * 1000) / v.price).toFixed(3) : null };
}).sort((a, b) => a.price - b.price);
function setGemValue(appid, v) { S.gemVal[appid] = v; saveState(); }
function demoCatalog() {
  const names = ['Starfall Odyssey', 'Neon Samurai', 'Cave of Embers', 'Pixel Pirates', 'Mecha Garden', 'Frost Kingdom', 'Void Runners', 'Candy Rally'];
  const map = {}; names.forEach((n, i) => { map[900000 + i] = { name: n, price: 1100 + i * 90, unavailable: i === 3, availableAtTime: i === 3 ? Date.now() + 5 * 3600e3 : null }; S.gemVal[900000 + i] = 9 + i * 3; });
  S.catalog = { t: Date.now(), gems: { total: 4250 + 2000, tradable: 6250, untradable: 0 }, map };
}

// ---------- Arrêter un scan ----------
const demoTimers = {};
function cancel(k) {
  const group = ['cards', 'boosters', 'gems'].includes(k) ? ['cards', 'boosters', 'gems'] : [k];
  if (demoTimers[k]) { clearInterval(demoTimers[k]); delete demoTimers[k]; }
  if (group.includes('cards')) { steam.cancelTask('cards'); steam.cancelTask('inv'); bump('cards'); bump('inv'); S.running = false; invPromise = null; }
  else if (k === 'badges' || k === 'friends') { steam.cancelTask(k); bump(k); }
  else bump(k); // bot, solde, vérification : la lecture déjà lancée se termine mais son résultat est ignoré
  for (const g of group) if (running(g)) Object.assign(S.tasks[g], { state: 'idle', pct: 0, eta: null, label: '', error: null, stopped: true });
  if (k === 'friends') S.friends.status = S.friends.inv.size ? 'ready' : 'idle';
  if (k === 'bot') { S.bot.status = sce.hasData() ? 'ready' : 'idle'; restoreBot(); }
}
// Mode démo : simule la progression d'un scan (pour voir le bouton se remplir)
function demoScan(k) {
  if (running(k)) return;
  begin(k, 'Simulation (mode démo)');
  let p = 0;
  const iv = demoTimers[k] = setInterval(() => { p += 7 + Math.random() * 9; prog(k, p); S.tasks[k].eta = Math.max(1, Math.round(((100 - p) / 12) * 0.45)); if (p >= 100) { clearInterval(iv); delete demoTimers[k]; finish(k); } }, 450);
  if (iv.unref) iv.unref();
}
// Vérifie tout ce qu'on peut savoir d'UN jeu : cartes en stock chez le bot (page du jeu sur SteamCardExchange) + prix actuels du marché Steam.
async function checkGameAll(appid, cfg, cpc, only) {
  const notes = [];
  if (S.demo) { await steam.sleep(3000); const cur = S.sets.find((x) => x.appid === appid); if (cur) sce.demoGame(appid, cur.cards.map((c) => c.name)); } // démo : réponse simulée après quelques secondes
  else try { await sce.checkGame(appid); } catch (e) { notes.push('Bot : ' + e.message); }
  if (!S.demo && only !== 'bot') {
    try {
      const { set, t } = await steam.getSet(appid, cfg.currency, 0);
      const cur = S.sets.find((x) => x.appid === appid);
      if (set.length && cur) upsert(buildSet({ appid, name: cur.name, lvl: levelsMap().get(appid) || 0, set, mine: S.myCards.filter((c) => c.appid === appid), t }));
    } catch (e) { notes.push('Prix Steam : ' + e.message); }
  }
  const d = await gameDetail(appid, cfg, cpc);
  d.notes = notes;
  return d;
}

// ---------- vérification de tous les jeux candidats (page du jeu chez le bot) ----------
const VERIFY_TTL = 6 * 3600e3, VERIFY_MAX = 60;
// Jeux à vérifier : ceux où il manque des cartes ET où le bot a au moins une carte en stock (les moins chers d'abord).
function verifyCandidates() {
  return S.sets.filter((s) => !s.provisional && s.missingCount > 0 && (sce.lookup(s.appid, s.name) || {}).stock > 0)
    .sort((a, b) => (a.missingCount - b.missingCount) || ((a.cost || 0) - (b.cost || 0))).slice(0, VERIFY_MAX);
}
const verified = (appid) => sce.hasGame(appid) && sce.gameAge(appid) < VERIFY_TTL;
async function scanVerify() {
  if (running('verify')) return;
  const gen = bump('verify'), list = verifyCandidates().filter((s) => !verified(s.appid));
  begin('verify', `Vérification des jeux : 0/${list.length}`);
  if (!list.length) { finish('verify'); return; }
  let done = 0, failed = 0;
  for (const s of list) {
    if (gens.verify !== gen) return;
    try { if (S.demo) { await steam.sleep(350); sce.demoGame(s.appid, s.cards.map((c) => c.name)); } else await sce.checkGame(s.appid); } catch { failed++; }
    done++;
    prog('verify', (100 * done) / list.length, `Vérification des jeux : ${done}/${list.length}`);
    S.tasks.verify.eta = Math.ceil((list.length - done) * (S.demo ? 0.4 : 5));
  }
  if (gens.verify !== gen) return;
  if (failed === list.length) finish('verify', 'Aucune page de jeu lisible : connecte-toi au site dans les Réglages (section SteamCardExchange).');
  else { S.tasks.verify.note = failed ? `${failed} page(s) illisible(s)` : null; finish('verify'); saveState(); }
}

// ---------- bouton « prêt à échanger » : conditions + plan d'échanges ----------
function readiness() {
  const T = S.tasks, ok = (k) => T[k].doneAt > 0 && T[k].state !== 'error';
  const cand = verifyCandidates(), vOk = cand.filter((s) => verified(s.appid)).length;
  const balanceKnown = sce.status().balance != null;
  const conds = [
    { key: 'badges', label: 'Badges lus', ok: ok('badges'), pct: ok('badges') ? 100 : 0 },
    { key: 'cards', label: 'Cartes & sets scannés', ok: ok('cards') && S.sets.length > 0 && !S.sets.some((s) => s.provisional), pct: ok('cards') ? 100 : T.cards.state === 'running' ? T.cards.pct : 0 },
    { key: 'bot', label: 'Inventaire du bot lu', ok: sce.hasData(), pct: sce.hasData() ? 100 : 0 },
    { key: 'balance', label: 'Solde de crédits lu', ok: balanceKnown, pct: balanceKnown ? 100 : 0 },
    { key: 'verify', label: `Jeux vérifiés chez le bot (${vOk}/${cand.length})`, ok: cand.length > 0 && vOk === cand.length, pct: cand.length ? Math.round((100 * vOk) / cand.length) : (ok('cards') && sce.hasData() ? 100 : 0) },
  ];
  // le dernier test (jeux vérifiés) n'a de sens que si les précédents sont remplis
  const pct = Math.round(conds.reduce((t, c) => t + c.pct, 0) / conds.length);
  const met = conds.filter((c) => c.ok).length;
  const level = met === conds.length ? 'green' : met === 0 ? 'red' : 'orange';
  return { level, pct, conds, plan: met === conds.length ? buildPlan() : [] };
}
// Plan : pour chaque jeu dont le bot a TOUTES les cartes manquantes, combien de crédits il faut, et avec quoi les payer
// (solde d'abord, puis revente de tes doublons au bot). Les jeux les moins chers passent en premier.
function buildPlan() {
  let bal = sce.status().balance || 0;
  const pool = spareCards().map((c) => ({ c, w: (sce.lookup(c.appid, c.game) || {}).worth || 0 })).filter((x) => x.w > 0).sort((a, b) => b.w - a.w);
  const out = [];
  const games = S.sets.filter((s) => !s.provisional && s.missingCount > 0 && verified(s.appid)).map((s) => enrichSet(s));
  const full = games.map((s) => {
    const miss = s.cards.filter((c) => !c.owned);
    const buy = miss.map((c) => (c.botCard && c.botCard.stock > 0 && c.botCard.price != null ? { name: c.name, price: c.botCard.price, hash: c.hash, quick: c.botCard.quick !== false } : null));
    return { s, buy, ok: buy.every(Boolean) };
  }).filter((x) => x.ok).sort((a, b) => a.buy.reduce((t, c) => t + c.price, 0) - b.buy.reduce((t, c) => t + c.price, 0));
  for (const { s, buy } of full) {
    const total = +buy.reduce((t, c) => t + c.price, 0).toFixed(2);
    let need = Math.max(0, total - bal), sell = [], fund = 0;
    const used = [];
    for (const x of pool) { if (need - fund <= 0.0001) break; if (x.c.appid === s.appid && !x.c.tradable) continue; used.push(x); fund += x.w; }
    const feasible = need - fund <= 0.0001;
    if (feasible) { for (const x of used) { pool.splice(pool.indexOf(x), 1); sell.push({ name: x.c.name, game: x.c.game, worth: x.w, assetid: x.c.assetid }); } bal = +(bal + fund - total).toFixed(2); }
    out.push({ appid: s.appid, name: s.name, banner: s.banner, url: sce.gameUrl(s.appid), buy, total, sell, feasible, short: feasible ? 0 : +(need - fund).toFixed(2), missing: buy.length });
  }
  return out;
}

// ---------- liste de souhaits : cartes surveillées chez le bot et chez les amis ----------
function wishAdd(hash) {
  if (S.wishlist.some((w) => w.hash === hash)) return;
  const set = S.sets.find((s) => s.cards.some((c) => c.hash === hash)); const c = set && set.cards.find((x) => x.hash === hash);
  if (!c) throw new Error('Carte inconnue : scanne d\'abord tes cartes.');
  S.wishlist.push({ hash, name: c.name, img: c.img, appid: set.appid, game: set.name, t: Date.now() }); saveState();
}
const wishRemove = (hash) => { S.wishlist = S.wishlist.filter((w) => w.hash !== hash); saveState(); };
function wishState() {
  return S.wishlist.map((w) => {
    const bc = sce.cardInfo(w.appid, w.name), set = S.sets.find((s) => s.appid === w.appid), mine = set ? (set.cards.find((c) => c.hash === w.hash) || {}).owned : 0;
    const friends = S.friends.list.filter((f) => (S.friends.inv.get(f.steamid) || new Map()).has(w.hash)).map((f) => ({ name: f.name, avatar: f.avatar, steamid: f.steamid }));
    const cur = set && set.cards.find((c) => c.hash === w.hash), price = cur && cur.price > 0 ? cur.price : null, priceHit = !!(w.target && price != null && price <= w.target);
    return { ...w, price, priceHit, owned: mine || 0, bot: bc ? { stock: bc.stock, price: bc.price } : null, botChecked: !!bc, friends, available: !!(bc && bc.stock > 0) || friends.length > 0 || priceHit, url: sce.gameUrl(w.appid) };
  });
}
// Vérifie les cartes souhaitées (page du jeu chez le bot, au plus une fois par heure et par jeu)
async function checkWishes() {
  for (const appid of new Set([...S.wishlist.map((w) => w.appid), ...S.alerts.map((a) => a.appid)])) { // prix du marché des jeux surveillés (au plus une fois par heure)
    if (S.demo) continue;
    try {
      const cur = S.sets.find((x) => x.appid === appid); if (!cur || Date.now() - (cur.priceT || 0) < 3600e3) continue;
      const { set, t } = await steam.getSet(appid, S.currency, 3600e3);
      if (set.length) upsert(buildSet({ appid, name: cur.name, lvl: levelsMap().get(appid) || 0, set, mine: S.myCards.filter((c) => c.appid === appid), t }));
    } catch { /* prochain tour */ }
  }
  for (const appid of new Set(S.wishlist.map((w) => w.appid))) {
    if (sce.gameAge(appid) < 3600e3) continue;
    try { if (S.demo) sce.demoGame(appid, (S.sets.find((s) => s.appid === appid) || { cards: [] }).cards.map((c) => c.name)); else await sce.checkGame(appid); } catch { /* prochain tour */ }
  }
}

// ---------- bons plans : acheter une carte sur le marché Steam et la revendre au bot en crédits ----------
function deals(creditValue) {
  const cv = Number(creditValue) > 0 ? Number(creditValue) : 0, cards = [];
  for (const s of S.sets) {
    if (s.provisional) continue;
    const bi = sce.lookup(s.appid, s.name), worth = bi ? bi.worth : null; if (!worth) continue;
    for (const c of s.cards) if (c.price > 0) cards.push({ appid: s.appid, game: s.name, name: c.name, img: c.img, price: c.price, priceText: c.priceText, worth, ratio: +(worth / c.price).toFixed(1), net: cv ? +(worth * cv - c.price).toFixed(3) : null, owned: c.owned });
  }
  cards.sort((a, b) => b.ratio - a.ratio);
  // comparaison pour compléter un set : marché Steam (€) ou bot (crédits)
  const sets = S.sets.filter((s) => !s.provisional && s.missingCount > 0 && verified(s.appid)).map((s) => enrichSet(s)).filter((s) => s.botBuy != null && s.botHas === s.missingCount)
    .map((s) => ({ appid: s.appid, name: s.name, missing: s.missingCount, market: s.cost, bot: s.botBuy, botEuro: cv ? +(s.botBuy * cv).toFixed(2) : null, cheaper: cv ? (s.botBuy * cv < s.cost ? 'bot' : 'market') : null })).sort((a, b) => a.market - b.market);
  return { creditValue: cv || null, cards: cards.slice(0, 40), sets };
}

// ---------- alertes de prix : cartes de la liste de souhaits et sets entiers ----------
function wishTarget(hash, target) {
  const w = S.wishlist.find((x) => x.hash === hash); if (!w) throw new Error('Carte absente de la liste de souhaits');
  const t = Number(String(target).replace(',', '.')); w.target = t > 0 ? t : null; saveState();
}
function alertSet(appid, target) {
  const set = S.sets.find((s) => s.appid === appid); if (!set) throw new Error('Jeu inconnu');
  const t = Number(String(target).replace(',', '.'));
  S.alerts = S.alerts.filter((a) => a.appid !== appid);
  if (t > 0) S.alerts.push({ appid, name: set.name, target: t, t: Date.now() });
  saveState();
}
const alertsState = () => S.alerts.map((a) => { const s = S.sets.find((x) => x.appid === a.appid); const cost = s && s.cost != null ? s.cost : null; return { ...a, cost, hit: cost != null && cost > 0 && cost <= a.target, banner: header(a.appid) }; });
// ---------- sauvegarde / export ----------
function exportData() { return { wishlist: S.wishlist, alerts: S.alerts, history: S.history, journal: S.journal, events: S.events, gemVal: S.gemVal }; }
function importData(d) {
  if (!d || typeof d !== 'object') throw new Error('Fichier invalide');
  if (Array.isArray(d.wishlist)) S.wishlist = d.wishlist.filter((w) => w && w.hash && w.name);
  if (Array.isArray(d.alerts)) S.alerts = d.alerts.filter((a) => a && a.appid && a.target > 0);
  if (Array.isArray(d.history)) S.history = d.history.filter((h) => h && h.t && h.xp != null).slice(-1500);
  if (Array.isArray(d.journal)) S.journal = d.journal.filter((j) => j && j.id && j.t).slice(0, 1000);
  if (Array.isArray(d.events)) S.events = d.events.filter((e) => e && e.name && e.start && e.end);
  if (d.gemVal && typeof d.gemVal === 'object') S.gemVal = d.gemVal;
  saveState();
}
const csvCell = (v) => { const t = v == null ? '' : String(v); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
function setsCsv() {
  const head = ['AppID', 'Jeu', 'Niveau badge', 'Cartes possédées', 'Cartes du set', 'Manquantes', 'Doublons', 'Coût (monnaie)', 'Valeur carte (crédits)', 'Stock bot', 'Achat chez le bot (crédits)', 'Prix du badge (crédits)'];
  const rows = S.sets.map((s) => { const e = enrichSet(s); return [s.appid, s.name, s.badgeLevel, s.ownedUnique, s.total, s.missingCount, s.dupes, s.cost, e.worth, e.botStock, e.botBuy, e.badgePrice]; });
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
}

// ---------- 🎯 objectif de niveau : les badges les moins chers pour atteindre le niveau X ----------
function goalPlan(target) {
  const p = S.profile; if (!p) throw new Error('Profil non chargé : lance le scan « Badges ».');
  target = Math.floor(Number(target));
  if (!(target > p.level)) throw new Error(`Choisis un niveau supérieur au tien (${p.level}).`);
  const need = totalXpForLevel(target) - p.xp;
  const lvl = levelsMap();
  const cand = S.sets.filter((s) => !s.provisional && s.cost != null && (lvl.get(s.appid) || 0) < 5)
    .map((s) => ({ appid: s.appid, name: s.name, banner: s.banner, cost: s.cost, missing: s.missingCount, badgeLevel: s.badgeLevel }))
    .sort((a, b) => a.cost - b.cost || a.missing - b.missing);
  const steps = []; let xp = 0, cost = 0;
  for (const c of cand) { if (xp >= need) break; xp += 100; cost += c.cost; steps.push({ ...c, cumXp: xp, cumCost: +cost.toFixed(2) }); }
  return { target, level: p.level, need, steps, totalCost: +cost.toFixed(2), feasible: xp >= need, missingXp: Math.max(0, need - xp), candidates: cand.length, provisional: S.sets.some((s) => s.provisional) };
}
// ---------- ♻ doublons à revendre pour financer le prochain set ----------
function spareReport() {
  const bal = sce.status().balance || 0;
  const groups = [...groupBy(spareCards(), (c) => c.hash).values()].map((l) => {
    const w = (sce.lookup(l[0].appid, l[0].game) || {}).worth || 0;
    return { hash: l[0].hash, name: l[0].name, game: l[0].game, appid: l[0].appid, img: l[0].img, count: l.length, worth: w, total: +(w * l.length).toFixed(2), assetids: l.map((c) => c.assetid) };
  }).sort((a, b) => b.total - a.total);
  const totalValue = +groups.reduce((t, g) => t + g.total, 0).toFixed(2);
  const first = buildPlan()[0]; // le set complétable le moins cher
  let target = null;
  if (first) {
    const shortfall = Math.max(0, +(first.total - bal).toFixed(2)), sell = []; let got = 0;
    for (const g of groups) { for (let i = 0; i < g.count && got < shortfall; i++) { sell.push({ name: g.name, game: g.game, worth: g.worth, img: g.img }); got += g.worth; } if (got >= shortfall) break; }
    target = { appid: first.appid, name: first.name, total: first.total, url: first.url, balance: bal, shortfall, sell, covered: got >= shortfall };
  }
  return { groups, totalValue, target, balance: bal, home: 'https://www.steamcardexchange.net/index.php?inventory' };
}
// ---------- 🎴 cartes à récupérer en jouant ----------
function dropsList() {
  return [...S.drops.entries()].filter(([, n]) => n > 0).map(([appid, n]) => ({ appid, drops: n, name: S.names.get(appid) || (sce.lookup(appid) || {}).name || `Jeu ${appid}`, banner: header(appid) })).sort((a, b) => b.drops - a.drops);
}
// ---------- 📅 soldes et événements Steam (dates indicatives, modifiables) ----------
const DEFAULT_EVENTS = [
  { id: 'd1', name: 'Soldes d\'automne Steam', start: '2026-11-25', end: '2026-12-02', approx: true },
  { id: 'd2', name: 'Soldes d\'hiver Steam', start: '2026-12-17', end: '2027-01-04', approx: true },
];
const eventsList = () => (S.events || DEFAULT_EVENTS).map((e) => ({ ...e, startMs: new Date(e.start + 'T18:00:00Z').getTime(), endMs: new Date(e.end + 'T18:00:00Z').getTime() })).filter((e) => e.endMs > Date.now()).sort((a, b) => a.startMs - b.startMs);
function eventAdd(name, start, end) {
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('Nom et dates (AAAA-MM-JJ) requis.');
  S.events = [...(S.events || DEFAULT_EVENTS), { id: 'e' + Date.now(), name: String(name).slice(0, 80), start, end, approx: false }]; saveState();
}
const eventRemove = (id) => { S.events = (S.events || DEFAULT_EVENTS).filter((e) => e.id !== id); saveState(); };
// ---------- ⚔ comparaison avec un ami et 💎 badges rares à viser ----------
function myBadgeMap() { return new Map((S.profile ? S.profile.badges : []).map((b) => [b.appid, b])); }
const gameName = (appid) => S.names.get(appid) || (sce.lookup(appid) || {}).name || `Jeu ${appid}`;
function compareFriend(steamid) {
  const fb = S.rank.badges.get(steamid); if (!fb) throw new Error('Lance d\'abord « Analyser mes amis » (onglet Classement).');
  const me = myBadgeMap(), fm = new Map(fb.map((b) => [b.appid, b]));
  const row = (appid, mine, theirs) => ({ appid, name: gameName(appid), mine, theirs });
  const onlyFriend = [], onlyMe = [], higherFriend = [], higherMe = [];
  for (const [a, b] of fm) { const m = me.get(a); if (!m) onlyFriend.push(row(a, 0, b.level)); else if (b.level > m.level) higherFriend.push(row(a, m.level, b.level)); else if (m.level > b.level) higherMe.push(row(a, m.level, b.level)); }
  for (const [a, m] of me) if (!fm.has(a)) onlyMe.push(row(a, m.level, 0));
  const person = S.rank.list.find((x) => x.steamid === steamid) || {}, mine = S.rank.list.find((x) => x.me) || {};
  const cap = (l) => l.slice(0, 80);
  return { friend: { name: person.name, level: person.level, badgeCount: person.badgeCount, rarity: person.rarity }, me: { level: mine.level, badgeCount: mine.badgeCount, rarity: mine.rarity },
    onlyFriend: cap(onlyFriend), onlyMe: cap(onlyMe), higherFriend: cap(higherFriend), higherMe: cap(higherMe), counts: { onlyFriend: onlyFriend.length, onlyMe: onlyMe.length, higherFriend: higherFriend.length, higherMe: higherMe.length } };
}
function rareTargets() {
  if (!S.rank.badges.size) throw new Error('Lance d\'abord « Analyser mes amis » (onglet Classement) : l\'app lit la rareté des badges de tes amis.');
  const me = myBadgeMap(), best = new Map();
  for (const [id, list] of S.rank.badges) { if (S.profile && id === S.profile.steamid) continue; for (const b of list) if (b.scarcity > 0 && !(me.get(b.appid) || {}).level) { const cur = best.get(b.appid); if (!cur || b.scarcity < cur.scarcity) best.set(b.appid, { appid: b.appid, scarcity: b.scarcity }); } }
  return [...best.values()].map((x) => { const s = S.sets.find((y) => y.appid === x.appid); return { ...x, name: gameName(x.appid), points: +steam.rarityPoints(x.scarcity).toFixed(1), banner: header(x.appid), progress: s ? { owned: s.ownedUnique, total: s.total, cost: s.cost } : null }; })
    .sort((a, b) => b.points - a.points || (a.progress && a.progress.cost != null ? a.progress.cost : 1e9) - (b.progress && b.progress.cost != null ? b.progress.cost : 1e9)).slice(0, 40);
}
// ---------- 📒 journal des échanges, achats et ventes ----------
function journalAdd({ type, text, credits, auto }) {
  const c = Number(String(credits == null ? 0 : credits).replace(',', '.')) || 0;
  S.journal.unshift({ id: 'j' + Date.now() + Math.floor(Math.random() * 1000), t: Date.now(), type: ['trade', 'buy', 'sell', 'craft', 'other'].includes(type) ? type : 'other', text: String(text || '').slice(0, 300), credits: c, auto: !!auto });
  if (S.journal.length > 1000) S.journal.length = 1000; saveState();
}
const journalRemove = (id) => { S.journal = S.journal.filter((j) => j.id !== id); saveState(); };

// ---------- tous les badges du profil (pas seulement ceux au niveau 5) ----------
function allBadges() {
  if (!S.profile) return [];
  const seen = new Set(), out = [];
  for (const b of S.profile.badges || []) { if (!b.appid || seen.has(b.appid)) continue; seen.add(b.appid); out.push({ appid: b.appid, level: b.level, name: gameName(b.appid), banner: header(b.appid), drops: S.drops.has(b.appid) ? S.drops.get(b.appid) : null }); }
  const add = (appid, level) => { if (!appid || seen.has(appid)) return; seen.add(appid); out.push({ appid, level, name: gameName(appid), banner: header(appid), drops: S.drops.has(appid) ? S.drops.get(appid) : null }); };
  for (const b of S.completed) add(b.appid, b.level || 5);           // au cas où la liste du profil serait incomplète
  for (const x of S.sets) if (x.badgeLevel > 0) add(x.appid, x.badgeLevel);
  return out.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
}
// ---------- 🤖 mode auto : cartes voulues (bot / amis), cartes à donner, échanges de 6 cartes maximum de chaque côté ----------
const MAXC = 6;
function autoData() {
  const bal = sce.status().balance || 0, wanted = [];
  for (const s of S.sets) {
    if (s.provisional || !s.missingCount) continue;
    const e = enrichSet(s), miss = e.cards.filter((c) => !c.owned && !c.unknown);
    const src = (c) => ({ bot: c.botCard && c.botCard.stock > 0 && c.botCard.price != null ? { price: c.botCard.price, worth: c.botCard.worth, stock: c.botCard.stock, tradeUrl: c.botCard.tradeUrl || null } : null,
      friends: e.friends.filter((f) => f.have.includes(c.hash)).map((f) => ({ steamid: f.steamid, name: f.name, assetid: ((S.friends.inv.get(f.steamid) || new Map()).get(c.hash) || [{}])[0].assetid })) });
    const comp = miss.every((c) => { const x = src(c); return x.bot || x.friends.length; });
    for (const c of miss) { const x = src(c); if (x.bot || x.friends.length) wanted.push({ hash: c.hash, name: c.name, img: c.img, appid: s.appid, game: s.name, price: c.price, ...x, completable: comp, setCost: s.cost, setMissing: s.missingCount }); }
  }
  wanted.sort((a, b) => (b.completable - a.completable) || (a.setCost || 0) - (b.setCost || 0) || a.appid - b.appid);
  const give = spareCards().map((c) => ({ assetid: c.assetid, hash: c.hash, name: c.name, game: c.game, appid: c.appid, img: c.img, worth: (sce.lookup(c.appid, c.game) || {}).worth || 0, price: (S.sets.find((x) => x.appid === c.appid) || { cards: [] }).cards.find((x) => x.hash === c.hash)?.price || 0 })).sort((a, b) => b.worth - a.worth);
  return { balance: bal, wanted, give, verified: S.tasks.verify.doneAt, friendsAge: S.friends.t || 0 };
}
// asks : [{ hash, src: 'bot' | steamid }] · giveIds : assetids choisis (vide = choix automatique)
function autoPlan(asks, giveIds) {
  const data = autoData(), byHash = new Map(data.wanted.map((w) => [w.hash, w])), sel = new Set((giveIds || []).map(String));
  const pool = (sel.size ? data.give.filter((g) => sel.has(String(g.assetid))) : data.give).filter((g) => g.worth > 0 || g.price > 0);
  let bal = data.balance; const trades = [];
  const pickCover = (need) => { // cartes les moins gaspilleuses pour couvrir `need` crédits (6 au maximum)
    const picked = []; let got = 0;
    while (got < need && picked.length < MAXC) {
      const rest = need - got, avail = pool.filter((g) => !picked.includes(g));
      if (!avail.length) break;
      const exact = avail.filter((g) => g.worth >= rest).sort((a, b) => a.worth - b.worth)[0] || avail.sort((a, b) => b.worth - a.worth)[0];
      picked.push(exact); got += exact.worth;
    }
    return { picked, got };
  };
  const botAsks = (asks || []).filter((a) => a.src === 'bot').map((a) => byHash.get(a.hash)).filter((w) => w && w.bot).sort((a, b) => a.appid - b.appid || b.bot.price - a.bot.price);
  for (let i = 0; i < botAsks.length; i += MAXC) {
    const chunk = botAsks.slice(i, i + MAXC), need = +chunk.reduce((t, w) => t + w.bot.price, 0).toFixed(2), toCover = Math.max(0, +(need - bal).toFixed(2));
    const { picked, got } = toCover ? pickCover(toCover) : { picked: [], got: 0 }, feasible = got >= toCover;
    if (feasible) { for (const g of picked) pool.splice(pool.indexOf(g), 1); bal = +(bal + got - need).toFixed(2); }
    const games = [...new Map(chunk.map((w) => [w.appid, { appid: w.appid, name: w.game, url: sce.gameUrl(w.appid), cards: [] }])).values()];
    for (const w of chunk) games.find((g) => g.appid === w.appid).cards.push(w.name);
    trades.push({ id: 'b' + i, kind: 'bot', asks: chunk.map((w) => ({ hash: w.hash, name: w.name, img: w.img, game: w.game, appid: w.appid, price: w.bot.price, tradeUrl: w.bot.tradeUrl })), gives: picked.map((g) => ({ assetid: g.assetid, name: g.name, img: g.img, game: g.game, worth: g.worth })),
      askTotal: need, giveTotal: +got.toFixed(2), balanceAfter: bal, feasible, short: feasible ? 0 : +(toCover - got).toFixed(2), games });
  }
  const byFriend = new Map();
  for (const a of asks || []) { if (a.src === 'bot') continue; const w = byHash.get(a.hash), f = w && w.friends.find((x) => x.steamid === a.src); if (f) (byFriend.get(f.steamid) || byFriend.set(f.steamid, { f, list: [] }).get(f.steamid)).list.push({ w, assetid: f.assetid }); }
  for (const { f, list } of byFriend.values()) {
    for (let i = 0; i < list.length; i += MAXC) {
      const chunk = list.slice(i, i + MAXC), gives = [];
      for (const g of [...pool].sort((a, b) => b.price - a.price)) { if (gives.length >= chunk.length) break; gives.push(g); } // échange carte contre carte : autant que demandé (6 max)
      for (const g of gives) pool.splice(pool.indexOf(g), 1);
      trades.push({ id: 'f' + f.steamid + i, kind: 'friend', friend: { steamid: f.steamid, name: f.name }, asks: chunk.map((x) => ({ hash: x.w.hash, name: x.w.name, img: x.w.img, game: x.w.game, appid: x.w.appid, price: x.w.price, assetid: x.assetid })),
        gives: gives.map((g) => ({ assetid: g.assetid, name: g.name, img: g.img, game: g.game, worth: g.price })), askTotal: +chunk.reduce((t, x) => t + (x.w.price || 0), 0).toFixed(2), giveTotal: +gives.reduce((t, g) => t + (g.price || 0), 0).toFixed(2), feasible: gives.length > 0, short: 0 });
    }
  }
  return { balance: data.balance, trades };
}
// importe l'historique des échanges lu sur SteamCardExchange dans le journal (une seule fois par échange)
function importSceTrades() {
  let n = 0;
  for (const t of sce.trades()) {
    if (t.status !== 'Accepted' || S.journal.some((j) => j.id === 'sce-' + t.id)) continue;
    const net = t.after != null ? t.after - t.before : 0;
    S.journal.push({ id: 'sce-' + t.id, t: t.t, type: t.yours && t.bots ? 'trade' : t.bots ? 'buy' : 'sell', text: `Échange SteamCardExchange n°${t.id} : tes cartes ${t.yours} cr · cartes du bot ${t.bots} cr`, credits: net, auto: true }); n++;
  }
  if (n) { S.journal.sort((a, b) => b.t - a.t); if (S.journal.length > 1000) S.journal.length = 1000; saveState(); }
}

function loadDemo() {
  Object.assign(S, { demo: true, running: false, error: null }, demo.demoState()); demo.demoCredits(sce);
  S.gems = { gems: 4250, sacks: 2 }; demoCatalog();
  S.wishlist = []; S.alerts = []; S.journal = [{ id: 'j1', t: Date.now() - 86400e3 * 2, type: 'sell', text: 'Revente de 4 doublons au bot', credits: 24, auto: false }, { id: 'j2', t: Date.now() - 86400e3, type: 'buy', text: 'Set « Cave of Embers » (2 cartes)', credits: -15, auto: false }];
  S.history = Array.from({ length: 30 }, (_, i) => ({ t: Date.now() - (29 - i) * 86400e3, level: 23 + (i > 14 ? 1 : 0), xp: 3500 + i * 28 + (i % 4) * 9, badges: 40 + Math.floor(i / 4), balance: 4 + i * 0.3, gems: 3000 + i * 40 }));
  for (const k of ['badges', 'cards', 'boosters', 'gems', 'bot', 'balance']) Object.assign(S.tasks[k], { state: 'done', pct: 100, doneAt: Date.now() - (k.length * 4 + 3) * 60e3, error: null });
}

// ---------- vue envoyée à l'interface ----------
// Ajoute au set les infos du bot SteamCardExchange (stock, valeur en crédits), des amis et des crédits.
function enrichSet(s, cpc = 0) {
  const F = S.friends;
  const bi = sce.lookup(s.appid, s.name); // { worth, stock, cardsInSet, setsAvail, distinct }
  const missing = s.cards.filter((c) => !c.owned);
  const worth = bi ? bi.worth : cpc || null; // crédits que le bot donne pour une carte de ce jeu
  const cards = s.cards.map((c) => ({ ...c, assetids: undefined, credits: worth, botCard: c.unknown ? null : sce.cardInfo(s.appid, c.name) }));
  const checked = sce.hasGame(s.appid); // vérifié carte par carte sur la page du jeu chez le bot ?
  const friends = F.list.map((f) => {
    const inv = F.inv.get(f.steamid); if (!inv) return null;
    const have = missing.filter((c) => inv.has(c.hash)).map((c) => c.hash);
    return have.length ? { steamid: f.steamid, name: f.name, avatar: f.avatar, have } : null;
  }).filter(Boolean).sort((a, b) => b.have.length - a.have.length);
  const ownedCount = s.cards.reduce((t, c) => t + c.owned, 0);
  const inStock = cards.filter((c) => !c.owned && c.botCard && c.botCard.stock > 0);
  const bp = sce.badgePrice(s.appid, s.name), cat = S.catalog.map[s.appid];
  return { ...s,
    botBuy: checked ? +inStock.reduce((t, c) => t + (c.botCard.price || 0), 0).toFixed(2) : null,                       // ce que le bot te vendrait tes cartes manquantes (crédits)
    dupesValue: worth != null ? +cards.reduce((t, c) => t + Math.max(0, c.owned - 1) * ((c.botCard && c.botCard.worth != null) ? c.botCard.worth : worth), 0).toFixed(2) : null, // ce que le bot te donne pour tes doublons
    botUrl: sce.gameUrl(s.appid), badgePrice: bp ? bp.price : null,                                                                                      // prix du badge complet affiché sur SteamCardExchange
    gemValue: S.gemVal[s.appid] != null ? S.gemVal[s.appid] : null, boosterGems: cat ? cat.price : null, boosterUnavail: cat ? cat.unavailable : false, boosterAt: cat ? cat.availableAtTime : null, drops: S.drops.has(s.appid) ? S.drops.get(s.appid) : null, cards, friends, worth, creditsOwned: worth != null ? +(worth * ownedCount).toFixed(2) : null,
    botStock: bi ? bi.stock : 0, botDistinct: bi ? Math.min(bi.distinct, s.total) : 0, botSets: bi ? bi.setsAvail : 0,
    friendsHave: new Set(friends.flatMap((f) => f.have)).size, nobody: missing.filter((c) => !c.unknown && !(c.botCard && c.botCard.stock > 0) && !friends.some((f) => f.have.includes(c.hash))).length,
    botChecked: checked, botHas: checked ? cards.filter((c) => !c.owned && c.botCard && c.botCard.stock > 0).length : bi ? Math.min(bi.distinct, missing.length) : 0,
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
  const ownedValue = hasInv && S.myCards.length ? valueOf(S.myCards) : null;        // ce que le bot te donnerait pour toutes tes cartes
  const spareValue = hasInv && S.myCards.length ? valueOf(spareCards()) : null;      // … pour tes seules cartes en trop
  return {
    demo: S.demo, currency: S.currency, profile: p, sets, boosters,
    completed: S.completed.map((b) => ({ ...b, name: /^Jeu \d+$/.test(b.name) ? ((sce.lookup(b.appid) || {}).name || b.name) : b.name, drops: S.drops.has(b.appid) ? S.drops.get(b.appid) : null })), // nom manquant chez Steam : on prend celui de SteamCardExchange
    dropsTotal: [...S.drops.values()].reduce((t, n) => t + n, 0), dropsGames: [...S.drops.values()].filter((n) => n > 0).length, updatedAt: S.updatedAt,
    gems: { ...S.gems, total: S.catalog.t ? S.catalog.gems.total : S.gems.gems + S.gems.sacks * 1000, tradable: S.catalog.t ? S.catalog.gems.tradable : null }, catalogAt: S.catalog.t, catalogCount: Object.keys(S.catalog.map).length,
    tasks: Object.fromEntries(Object.entries(S.tasks).map(([k, t]) => {
      const el = (Date.now() - t.t0) / 1000, on = t.state === 'running';
      const pct = on && t.timeBased ? Math.min(95, Math.max(t.pct, Math.round((100 * el) / t.estSec))) : t.pct; // pas de progression réelle connue : on suit le temps estimé
      const eta = !on ? null : t.timeBased ? Math.max(1, Math.round(t.estSec - el)) : t.eta;
      return [k, { state: t.state, pct, label: t.label, eta, doneAt: t.doneAt, error: t.error, note: t.note || null, stopped: !!t.stopped }];
    })),
    progress: { running: S.running, refreshing: S.refreshing, phase: S.tasks.cards.label, done: S.done, total: S.total, fetchLeft, etaMin: Math.ceil((fetchLeft * 3.1) / 60),
      wait: Math.max(0, Math.round((steam.rate.waitUntil - Date.now()) / 1000)), retryIn: S.retry.at ? Math.max(0, Math.round((S.retry.at - Date.now()) / 1000)) : 0, error: S.error },
    bot: { status: B.status, error: B.error, name: B.name, count: B.count, games: B.games, botOnly: S.botOnly },
    friends: { status: F.status, error: F.error, done: F.done, total: F.total, count: F.list.length, stats: F.stats || null, t: F.t || 0 },
    allBadges: allBadges(),
    rank: { status: S.rank.status, error: S.rank.error, done: S.rank.done, total: S.rank.total, list: S.rank.list },
    ready: readiness(), dropsList: dropsList(), events: eventsList(), journal: S.journal, wishlist: wishState(), alerts: alertsState(), history: S.history, pace: p ? pace(totalXpForLevel(p.level + 1) - p.xp) : null,
    projection: p && { gainXp: gain, level: levelFromXp(p.xp + gain).level, nextLevelXp: totalXpForLevel(p.level + 1) - p.xp },
    credits: { balance: scest.balance != null ? scest.balance : manual, perCard: cpc || null, sce: scest, ownedValue, spareValue },
  };
}

// Détails d'un jeu (même s'il n'est pas dans la liste des sets, ex. badge déjà niveau 5).
async function gameDetail(appid, cfg, cpc) {
  const lvl = levelsMap();
  let set = S.sets.find((s) => s.appid === appid);
  const wasListed = !!set;
  if (!set || set.provisional) {
    const { set: cards, t } = await steam.getSet(appid, cfg.currency, Infinity);
    if (!cards.length) throw new Error('Aucune carte trouvée pour ce jeu');
    set = buildSet({ appid, name: S.names.get(appid) || cards[0].game, lvl: lvl.get(appid) || 0, set: cards, mine: S.myCards.filter((c) => c.appid === appid), t });
    if (wasListed) upsert(set);
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
  for (const s of S.sets) for (const c of s.cards) if (!c.owned && !c.unknown) m.set(c.hash, { ...c, appid: s.appid, game: s.name });
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
module.exports = { S, autoData, autoPlan, goalPlan, spareReport, eventAdd, eventRemove, compareFriend, rareTargets, journalAdd, journalRemove, deals, wishTarget, alertSet, exportData, importData, setsCsv, scanVerify, wishAdd, wishRemove, checkWishes, readiness, run, reset, cancel, setCatalog, catalogList, setGemValue, demoCatalog, refreshBot, scanBadges, scanCards, scanBoosters, scanGems, scanBalance, demoScan, checkGameAll, scanFriends, scanRank, loadDemo, loadSaved, isFresh, badgesFresh, saveState, snapshot, spareCards, groupBy, gameDetail, missingByHash, flush, BOT_DEFAULT };
