// Lecture de steamcardexchange.net : inventaire du bot (stock, valeur en crédits) et solde de crédits.
// L'app ouvre le site dans une fenêtre (tu te connectes avec Steam), puis lit les pages avec cette session.
// Remplace la lecture de l'inventaire Steam du bot (trop gros : Steam bloquait avec des erreurs 429).
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./fsutil');

const dir = () => process.env.BADGE_DATA_DIR;
const file = () => path.join(dir(), 'sce.json');
const HOME = 'https://www.steamcardexchange.net/';
const INV_URL = HOME + 'index.php?inventory';
const BP_URL = HOME + 'index.php?badgeprices';
const PROFILE_URL = HOME + 'index.php?profile';
const INV_TTL = 30 * 60e3;

let D = null, bridge = null, saveTimer = null, demoOn = false;
const empty = () => ({ balance: null, balanceT: 0, candidates: [], connected: false, debug: '', inv: null, games: {} });
const load = () => { if (!D) { try { D = Object.assign(empty(), JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch { D = empty(); } } return D; };
function flush() { clearTimeout(saveTimer); if (!D || demoOn) return; try { writeJsonAtomic(file(), D); } catch {} }
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 800); };
const num = (t) => { const x = String(t).replace(/[\s\u00a0]/g, ''); return x === '' ? NaN : Number(x.replace(/,(?=\d{3}\b)/g, '').replace(',', '.')); }; // chaîne vide = pas un nombre
const setBridge = (b) => { bridge = b; };
const NO_SITE = 'Connexion SteamCardExchange disponible uniquement dans le logiciel installé.';

// ---- « 15 credits », « Credits: 15 », « Credits\n15 » : on ignore les phrases de règles (maximum, limite…) ----
const RULE = /maximum|up to|limit|store|more than|per card|decline|donat|purchase|before trade|after trade|worth|offer/i; // règlement, dons, historique des échanges…
function findCredits(text) {
  const out = [], seen = new Set();
  const re = /(\d+(?:[.,]\d+)?)\s*(?:credits?|crédits?)\b|(?:credits?|crédits?)\s*[:=\-]?\s*\n?\s*(\d+(?:[.,]\d+)?)/gi;
  let m;
  while ((m = re.exec(text))) {
    const value = num(m[1] || m[2]);
    const ctx = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
    const ls = text.lastIndexOf('\n', m.index) + 1, le = text.indexOf('\n', m.index + m[0].length);
    const line = text.slice(ls, le < 0 ? undefined : le);
    if (isNaN(value) || RULE.test(line) || seen.has(value + ctx)) continue; // on ne juge que la ligne : les phrases de règles (« maximum 100 credits ») sont écartées
    seen.add(value + ctx); out.push({ value, ctx });
  }
  return out;
}

// Historique des échanges avec le bot (page Profile) : « ID  date - heure  crédits avant  tes cartes  cartes du bot  crédits après  statut »
function parseTrades(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    const m = /^\s*(\d{6,})\s+(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2}):(\d{2})\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?|-+)\s+(\w+)/.exec(l);
    if (m) out.push({ id: m[1], t: Date.UTC(+m[4], +m[3] - 1, +m[2], +m[5], +m[6]), before: num(m[7]), yours: num(m[8]), bots: num(m[9]), after: /^\d/.test(m[10]) ? num(m[10]) : null, status: m[11] });
  }
  return out;
}
const OUT = /logout|log ?out|sign ?out|déconnex/i;
async function refreshBalance() {
  if (!bridge) throw new Error(NO_SITE);
  const d = load();
  const home = await bridge.scrape(HOME);
  d.connected = (home.links || []).some((l) => OUT.test(l.t) || OUT.test(l.h)); // le lien « Logout » n'existe que connecté
  const prof = await bridge.scrape(PROFILE_URL); // la page Profile affiche le solde
  d.candidates = findCredits(prof.text).slice(0, 8);
  const pick = d.candidates.find((c) => /\d\s*credits/i.test(c.ctx)) || d.candidates[0]; // « 15 CREDITS » affiché sous ton pseudo
  if (pick) { d.balance = pick.value; d.balanceT = Date.now(); d.connected = true; } else { d.balance = null; d.balanceT = 0; } // pas de valeur lisible : on n'invente pas un ancien solde
  d.trades = parseTrades(prof.text);
  d.debug = `CONNECTÉ: ${d.connected}\n\n--- PAGE PROFILE (début)\n${prof.text.slice(0, 3500)}\n\nVALEURS TROUVÉES: ${JSON.stringify(d.candidates)}`;
  save();
  if (!pick) throw new Error(d.connected ? 'Solde illisible sur la page Profile : copie le diagnostic dans les Réglages.' : 'Pas connecté à SteamCardExchange : clique sur « Se connecter » dans les Réglages.');
  return status();
}
async function login() {
  if (!bridge) throw new Error(NO_SITE);
  await bridge.open(); // se termine quand la fenêtre est fermée
  return refreshBalance();
}

// ---- inventaire du bot : une ligne par jeu (nom, valeur d'une carte en crédits, stock, cartes dans le set, sets complets / cartes différentes en stock) ----
// Les noms de jeux du tableau ne sont pas toujours des liens : l'identifiant (appid) est cherché dans le code de la ligne,
// et à défaut on rapproche les jeux par leur nom.
function parseRow(r) {
  const c = r.c || [];
  if (c.length < 4) return null;
  const m0 = /(\d{3,9})/.exec(String(r.h || ''));
  const appid = m0 ? Number(m0[1]) : null;
  const t = c.slice(-4); // worth, stock, cardsInSet, sets
  const worth = num(t[0]), stock = num(t[1]), cardsInSet = num(t[2]);
  const m = /(\d+)\s*\((\d+)\s*\/\s*(\d+)\)/.exec(t[3] || '');
  if ([worth, stock, cardsInSet].some(isNaN)) return null;
  const name = c.length >= 5 ? c[c.length - 5] : c[0];
  if (!appid && !name) return null;
  return { appid, name, worth, stock, cardsInSet, setsAvail: m ? Number(m[1]) : parseInt(t[3], 10) || 0, distinct: m ? Number(m[2]) : 0 };
}
async function readInventory(force = false) {
  const d = load();
  if (!force && d.inv && Date.now() - d.inv.t < INV_TTL) return d.inv;
  if (!bridge) throw new Error(NO_SITE);
  const r = await bridge.scrape(INV_URL, { table: true });
  const rows = (r.rows || []).map(parseRow).filter(Boolean);
  const withId = rows.filter((x) => x.appid).length;
  d.debug = `INVENTAIRE: ${(r.rows || []).length} lignes lues, ${rows.length} comprises, ${withId} avec identifiant de jeu\nEXEMPLE HTML D'UNE LIGNE:\n${String(r.sample || '').slice(0, 1500)}\n\nEXEMPLE LIGNE: ${JSON.stringify((r.rows || [])[0] || null)}\n\n--- TEXTE\n${String(r.text || '').slice(0, 1200)}`;
  if (!rows.length) { save(); throw new Error('Inventaire SteamCardExchange illisible (tableau introuvable) : copie le diagnostic dans les Réglages.'); }
  d.inv = { t: Date.now(), total: rows.length, rows };
  save();
  return d.inv;
}
// ---- prix des badges (set complet) affichés sur le site ----
const price = (t) => num(String(t).replace(/[^\d.,-]/g, ''));
async function readBadgePrices(force = false) {
  const d = load();
  if (!force && d.bp && Date.now() - d.bp.t < 6 * 3600e3) return d.bp;
  if (!bridge) throw new Error(NO_SITE);
  const r = await bridge.scrape(BP_URL, { table: true });
  const head = r.head || [];
  const iPrice = head.findIndex((h) => /price/i.test(h));
  const rows = [];
  for (const x of r.rows || []) {
    const c = x.c || [];
    const m0 = /(\d{3,9})/.exec(String(x.h || ''));
    const iName = c.findIndex((v) => v && isNaN(num(v)) && !/^[$€£]/.test(v));
    if (iName < 0) continue;
    const p = price(iPrice >= 0 ? c[iPrice] : (c.find((v) => /^[$€£]\s*[\d.,]+/.test(v)) || ''));
    if (isNaN(p)) continue;
    rows.push({ appid: m0 ? Number(m0[1]) : null, name: c[iName], price: p });
  }
  d.bp = { t: Date.now(), rows };
  d.debug = (d.debug || '') + `\n\nPRIX DES BADGES: ${rows.length} lignes · en-têtes ${JSON.stringify(head)} · exemple ${JSON.stringify(rows[0] || null)}`;
  save();
  if (!rows.length) throw new Error('Prix des badges illisibles');
  return d.bp;
}
const norm = (n) => String(n || '').toLowerCase().replace(/\(non-marketable\)/g, '').normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
let idx = { inv: null, byApp: new Map(), byName: new Map(), stocked: 0 }; // la table fait ~15 000 lignes : on ne l'indexe que si elle change
function index() {
  const inv = load().inv;
  if (idx.inv !== inv) {
    const byApp = new Map(), byName = new Map(); let stocked = 0;
    for (const r of (inv && inv.rows) || []) { if (r.appid) byApp.set(r.appid, r); const k = norm(r.name); if (k && !byName.has(k)) byName.set(k, r); if (r.stock > 0) stocked++; }
    idx = { inv, byApp, byName, stocked };
  }
  return idx;
}
const lookup = (appid, name) => { const i = index(); return i.byApp.get(appid) || (name ? i.byName.get(norm(name)) : null) || null; };
let bpIdx = { bp: null, byApp: new Map(), byName: new Map() };
function bpIndex() {
  const bp = load().bp;
  if (bpIdx.bp !== bp) { const byApp = new Map(), byName = new Map(); for (const r of (bp && bp.rows) || []) { if (r.appid) byApp.set(r.appid, r); const k = norm(r.name); if (k && !byName.has(k)) byName.set(k, r); } bpIdx = { bp, byApp, byName }; }
  return bpIdx;
}
const badgePrice = (appid, name) => { const i = bpIndex(); return i.byApp.get(appid) || (name ? i.byName.get(norm(name)) : null) || null; };
const hasData = () => { const inv = load().inv; return !!(inv && inv.rows.length); };
const totals = () => { const i = index(); return { games: i.stocked, cards: ((i.inv && i.inv.rows) || []).reduce((t, r) => t + (r.stock || 0), 0) }; };

const setDemo = (rows) => { // données fictives, jamais écrites sur le disque
  demoOn = true; D = empty();
  Object.assign(D, { balance: 12.5, connected: true, balanceT: Date.now(), candidates: [{ value: 12.5, ctx: 'Your credits: 12.5' }], inv: { t: Date.now(), total: rows.length, rows } });
};
// ---- page d'un jeu chez le bot (« inventorygame ») : quelles cartes il a, en quelle quantité et à quel prix ----
function parseGameRows(rows, head) {
  const idx = (re) => head.findIndex((h) => re.test(h));
  const iStock = idx(/stock|amount|available|qty|quantity/i), iPrice = idx(/price|cost|pay|buy/i), iWorth = idx(/worth|get|sell/i);
  const out = {};
  for (const r of rows) {
    const c = r.c || [];
    const nameIdx = c.findIndex((x) => x && isNaN(num(x))); // la première cellule qui n'est pas un nombre = le nom de la carte
    if (nameIdx < 0) continue;
    const nums = c.map((x, i) => (i === nameIdx || x === '' ? NaN : num(x)));
    const pick = (i) => (i >= 0 && !isNaN(nums[i]) ? nums[i] : null);
    let stock = pick(iStock);
    if (stock == null) { const only = nums.filter((n) => !isNaN(n)); stock = only.length ? only[only.length - 1] : null; } // à défaut : dernier nombre de la ligne
    if (stock == null) continue;
    out[norm(c[nameIdx])] = { stock, price: pick(iPrice), worth: pick(iWorth) };
  }
  return out;
}
// La page d'un jeu n'est pas un tableau : chaque carte est un bloc de lignes
//   NOM / Stock: 1 (Last Card) / Worth (You Get): 6c / Price (You Pay): 9c (ou « - ») / Quick-Trade | Not available
function parseGameText(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let qn = 0;
  const out = {}, val = (l) => { const m = /(\d+(?:[.,]\d+)?)\s*c\b/i.exec(l); return m ? num(m[1]) : null; };
  for (let i = 1; i < lines.length; i++) {
    const m = /^stock\s*:\s*(\d+)/i.exec(lines[i]);
    if (!m) continue;
    const name = lines[i - 1];
    let worth = null, price = null, quick = false, over = /overstock/i.test(lines[i]);
    for (let j = i + 1; j < Math.min(lines.length, i + 6) && !/^stock\s*:/i.test(lines[j]); j++) {
      if (/^stock\s*:/i.test(lines[j + 1] || '')) break; // cette ligne est le NOM de la carte suivante, pas un détail de celle-ci
      if (/^worth/i.test(lines[j])) worth = val(lines[j]);
      else if (/^price/i.test(lines[j])) price = val(lines[j]);
      else if (/quick-?trade/i.test(lines[j])) quick = true;
      else if (/overstock/i.test(lines[j])) over = true;
    }
    if (!name || /^(worth|price|stock)/i.test(name)) continue;
    out[norm(name)] = { stock: Number(m[1]), price, worth, quick, over, last: /last card/i.test(lines[i]), name, qi: quick ? qn++ : -1 };
  }
  return out;
}
async function checkGame(appid) {
  if (!bridge) throw new Error(NO_SITE);
  const d = load();
  const r = await bridge.scrape(`${HOME}index.php?inventorygame-appid-${appid}`, { table: true });
  const rows = r.rows || [], head = r.head || [];
  let cards = parseGameRows(rows, head);
  const fromText = parseGameText(r.text); // le site actuel affiche des blocs de texte, pas un tableau
  if (Object.keys(fromText).length >= Object.keys(cards).length) cards = fromText;
  // liens « Quick-Trade » : le n-ième lien correspond à la n-ième carte qui en a un (même ordre que dans la page)
  const qlinks = (r.links || []).filter((l) => /quick-?trade/i.test(l.t || '')).map((l) => l.h), qcards = Object.values(cards).filter((c) => c.qi >= 0);
  if (qlinks.length && qlinks.length === qcards.length) for (const c of qcards) c.tradeUrl = qlinks[c.qi];
  d.games = d.games || {};
  d.games[appid] = { t: Date.now(), cards };
  d.debug = `PAGE JEU ${appid}\nEN-TÊTES: ${JSON.stringify(head)}\nLIGNES: ${rows.length}\nEXEMPLES: ${JSON.stringify(rows.slice(0, 3))}\nLIENS D'ÉCHANGE: ${JSON.stringify((r.links || []).filter((l) => /trade|offer|quick/i.test((l.t || '') + l.h)).slice(0, 10))}\nRÉSULTAT: ${JSON.stringify(cards).slice(0, 800)}\n\n--- TEXTE\n${String(r.text || '').slice(0, 1500)}`;
  save();
  if (!Object.keys(cards).length) throw new Error('Page du jeu illisible côté bot : copie le diagnostic dans les Réglages.');
  return cards;
}
const demoGame = (appid, names) => { D.games = D.games || {}; D.games[appid] = { t: Date.now(), cards: Object.fromEntries(names.map((n, i) => [norm(n), { stock: i % 3, price: 7 + (i % 4), worth: 3 }])) }; };
const gameData = (appid) => (load().games || {})[appid] || null;
// Ouvre la page du jeu chez le bot dans une fenêtre (déjà connectée) avec les cartes voulues surlignées
function openGame(appid, names, mode) {
  const url = mode === 'sell' ? PROFILE_URL : gameUrl(appid); // vente : la page Profile a le bouton « Make Offer »
  if (bridge && bridge.openGame) { bridge.openGame(url, names || [], mode || 'buy'); return { opened: true, url }; }
  return { opened: false, url };
}
function openSteamTrade(url, payload) {
  if (bridge && bridge.openTrade) { bridge.openTrade(url, payload); return { opened: true, url }; }
  return { opened: false, url };
}
const gameUrl = (appid) => `${HOME}index.php?inventorygame-appid-${appid}`;
const gameAge = (appid) => { const g = gameData(appid); return g ? Date.now() - g.t : Infinity; };
const hasGame = (appid) => { const g = gameData(appid); return !!g && Object.keys(g.cards).length > 0; };
const cardInfo = (appid, name) => {
  const g = gameData(appid); if (!g) return null;
  const k = norm(name); if (g.cards[k]) return g.cards[k];
  // à défaut : préfixe ajouté par le site (ex. « Gal DONALD MORDEN »), accepté seulement s'il est court et sans ambiguïté
  const hits = Object.keys(g.cards).filter((x) => x.length > 3 && k.length > 3 && Math.abs(x.length - k.length) <= 4 && (x.endsWith(k) || k.endsWith(x)));
  return hits.length === 1 ? g.cards[hits[0]] : null;
};

const trades = () => load().trades || [];
const status = () => { const d = load(); return { available: !!bridge || demoOn, connected: d.connected, balance: d.balance, balanceT: d.balanceT, candidates: d.candidates,
  games: index().stocked, invAge: d.inv ? d.inv.t : 0, hasDebug: !!d.debug }; };
const debug = () => load().debug || '';
const reset = () => { if (demoOn) { demoOn = false; D = null; } };
module.exports = { setBridge, login, refreshBalance, readInventory, readBadgePrices, badgePrice, checkGame, parseGameText, parseTrades, trades, openGame, openSteamTrade, gameUrl, gameAge, demoGame, hasGame, cardInfo, lookup, hasData, totals, status, debug, flush, setDemo, reset, findCredits, parseRow };
