// Lecture des crédits sur steamcardexchange.net.
// L'app ouvre le site dans une fenêtre (tu te connectes avec Steam), puis lit le texte des pages avec cette session.
// ⚠ La structure du site n'a pas pu être vérifiée : la lecture est heuristique, et un diagnostic est gardé pour l'ajuster.
const fs = require('fs');
const path = require('path');

const dir = () => process.env.BADGE_DATA_DIR;
const file = () => path.join(dir(), 'sce.json');
const HOME = 'https://www.steamcardexchange.net/';
const gameUrl = (appid) => `${HOME}index.php?gamepage-appid-${appid}`;

let D = null, bridge = null, saveTimer = null;
const job = { running: false, done: 0, total: 0, error: null };
let demoOn = false;
const load = () => { if (!D) { try { D = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { D = { balance: null, balanceT: 0, candidates: [], connected: false, games: {}, debug: '' }; } } return D; };
function flush() { clearTimeout(saveTimer); if (!D || demoOn) return; try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(D)); } catch {} }
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 800); };
const num = (t) => Number(String(t).replace(/\s/g, '').replace(',', '.'));

const setBridge = (b) => { bridge = b; };

// ---- extraction du texte ----
function findCredits(text) { // tous les nombres collés au mot « credit(s) »
  const out = [], seen = new Set();
  const re = /(\d+(?:[.,]\d+)?)\s*(?:credits?|crédits?)\b|(?:credits?|crédits?)\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)/gi;
  let m;
  while ((m = re.exec(text))) {
    const value = num(m[1] || m[2]);
    const ctx = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ').trim();
    const k = value + ctx;
    if (!isNaN(value) && !seen.has(k)) { seen.add(k); out.push({ value, ctx }); }
  }
  return out;
}

const NAV = /inventor|profile|account|credit|wallet|balance|\bmy\b|user|bot|trade|exchange/i;
const OUT = /logout|log ?out|sign ?out|déconnex/i;
const uniqLinks = (links) => { const seen = new Set(); return (links || []).filter((l) => l.h && !seen.has(l.h) && seen.add(l.h)); };

async function refreshBalance() {
  if (!bridge) throw new Error('Connexion SteamCardExchange disponible uniquement dans le logiciel installé.');
  const d = load();
  const home = await bridge.scrape(HOME);
  const links = uniqLinks(home.links);
  d.connected = links.some((l) => OUT.test(l.t) || OUT.test(l.h)); // un lien « déconnexion » n'existe que si on est connecté
  // pages susceptibles d'afficher les crédits : on visite celles du menu dont le nom/adresse évoque un compte, un inventaire…
  const here = links.filter((l) => /steamcardexchange\.net/i.test(l.h) && l.h !== HOME && NAV.test(l.t + ' ' + l.h) && !OUT.test(l.t + l.h) && !/gamepage|games?list|news|event|privacy|disclaimer/i.test(l.h)).slice(0, 6);
  const pages = [{ url: HOME, text: home.text }];
  for (const l of here) { try { pages.push({ url: l.h, text: (await bridge.scrape(l.h)).text }); } catch {} }
  d.candidates = [];
  for (const pg of pages) for (const c of findCredits(pg.text)) d.candidates.push({ ...c, src: pg.url.replace(HOME, '') });
  d.candidates = d.candidates.slice(0, 10);
  if (d.candidates.length) d.connected = true;
  const mine = d.candidates.find((c) => /your|my\b|mes\b|solde|balance|credits?\s*[:=]/i.test(c.ctx)) || d.candidates[0]; // on préfère « Your credits : N »
  if (mine) { d.balance = mine.value; d.balanceT = Date.now(); }
  d.debug = `CONNECTÉ: ${d.connected} (lien déconnexion trouvé: ${links.some((l) => OUT.test(l.t) || OUT.test(l.h))})\nPAGES LUES: ${pages.map((p) => p.url).join(' | ')}\n\nLIENS DU SITE:\n` +
    links.filter((l) => /steamcardexchange\.net/i.test(l.h)).slice(0, 80).map((l) => `${l.t || '(sans texte)'} -> ${l.h.replace(HOME, '/')}`).join('\n') +
    '\n\n' + pages.slice(1).map((p) => `--- ${p.url}\n${p.text.slice(0, 1200)}`).join('\n\n') + '\n\nACCUEIL\n' + home.text.slice(0, 1500);
  save();
  return status();
}
async function login() {
  if (!bridge) throw new Error('Connexion SteamCardExchange disponible uniquement dans le logiciel installé.');
  await bridge.open(); // se termine quand la fenêtre est fermée
  return refreshBalance();
}

// ---- crédits par carte ----
function parseGame(text, cards) {
  const out = {};
  const low = text.toLowerCase();
  for (const name of cards) {
    const i = low.indexOf(name.toLowerCase());
    if (i < 0) continue;
    const win = text.slice(i, i + 160);
    const m = win.match(/(\d+(?:[.,]\d+)?)\s*(?:credits?|crédits?)/i) || win.match(/(?:credits?|crédits?)\D{0,6}(\d+(?:[.,]\d+)?)/i);
    if (m) out[name.toLowerCase()] = num(m[1]);
  }
  return out;
}
async function readGame(appid, cardNames) {
  if (!bridge) throw new Error('Indisponible');
  const d = load();
  const text = (await bridge.scrape(gameUrl(appid))).text;
  const cards = parseGame(text, cardNames);
  d.games[appid] = { t: Date.now(), cards };
  if (!Object.keys(cards).length) d.debug = `JEU ${appid}\n` + text.slice(0, 6000);
  save();
  return Object.keys(cards).length;
}
async function scanGames(sets) { // sets : [{appid, cards:[{name}]}]
  if (job.running) return;
  Object.assign(job, { running: true, done: 0, total: sets.length, error: null });
  let fails = 0;
  try {
    for (const s of sets) {
      if (!(await readGame(s.appid, s.cards.map((c) => c.name)).catch(() => 0))) { if (++fails >= 6 && !Object.keys(load().games).some((a) => Object.keys(load().games[a].cards).length)) { job.error = 'Aucun crédit lu : format du site non reconnu (voir le diagnostic dans les Réglages).'; break; } }
      job.done++;
      await new Promise((r) => setTimeout(r, 800));
    }
  } catch (e) { job.error = e.message; }
  job.running = false;
}

const cardCredits = (appid, name) => { const g = load().games[appid]; return g && g.cards[String(name).toLowerCase()] != null ? g.cards[String(name).toLowerCase()] : null; };
const hasGame = (appid) => { const g = load().games[appid]; return !!g && Object.keys(g.cards).length > 0; };
const setDemo = (appids, names) => { // données fictives (en mémoire seulement, jamais écrites sur le disque)
  demoOn = true; D = { balance: null, balanceT: 0, candidates: [], connected: false, games: {}, debug: '' };
  const d = D; d.balance = 12.5; d.connected = true; d.candidates = [{ value: 12.5, ctx: 'Your credits: 12.5' }]; d.balanceT = Date.now();
  for (const a of appids) d.games[a] = { t: Date.now(), cards: Object.fromEntries(names.map((n, i) => [n.toLowerCase(), 0.5 + (i % 3) * 0.25])) };
};
const status = () => { const d = load(); return { available: !!bridge || demoOn, connected: d.connected, balance: d.balance, balanceT: d.balanceT, candidates: d.candidates, games: Object.keys(d.games).filter((a) => Object.keys(d.games[a].cards).length).length,
  scan: { ...job }, hasDebug: !!d.debug }; };
const debug = () => load().debug || '';
const reset = () => { if (demoOn) { demoOn = false; D = null; } };
module.exports = { setBridge, login, refreshBalance, readGame, scanGames, cardCredits, hasGame, status, debug, flush, setDemo, reset, gameUrl, parseGame, findCredits };
