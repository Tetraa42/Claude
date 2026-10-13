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
const PROFILE_URL = HOME + 'index.php?profile';
const INV_TTL = 30 * 60e3;

let D = null, bridge = null, saveTimer = null, demoOn = false;
const empty = () => ({ balance: null, balanceT: 0, candidates: [], connected: false, debug: '', inv: null });
const load = () => { if (!D) { try { D = Object.assign(empty(), JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch { D = empty(); } } return D; };
function flush() { clearTimeout(saveTimer); if (!D || demoOn) return; try { writeJsonAtomic(file(), D); } catch {} }
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 800); };
const num = (t) => Number(String(t).replace(/[\s ]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
const setBridge = (b) => { bridge = b; };
const NO_SITE = 'Connexion SteamCardExchange disponible uniquement dans le logiciel installé.';

// ---- « 15 credits », « Credits: 15 », « Credits\n15 » : on ignore les phrases de règles (maximum, limite…) ----
const RULE = /maximum|up to|limit|store|more than|per card|decline/i;
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

const OUT = /logout|log ?out|sign ?out|déconnex/i;
async function refreshBalance() {
  if (!bridge) throw new Error(NO_SITE);
  const d = load();
  const home = await bridge.scrape(HOME);
  d.connected = (home.links || []).some((l) => OUT.test(l.t) || OUT.test(l.h)); // le lien « Logout » n'existe que connecté
  const prof = await bridge.scrape(PROFILE_URL); // la page Profile affiche le solde
  d.candidates = findCredits(prof.text).slice(0, 8);
  const pick = d.candidates.find((c) => /your|my\b|balance|credits?\s*[:=]/i.test(c.ctx)) || d.candidates[0];
  if (pick) { d.balance = pick.value; d.balanceT = Date.now(); d.connected = true; }
  d.debug = `CONNECTÉ: ${d.connected}\n\n--- PAGE PROFILE (début)\n${prof.text.slice(0, 3500)}\n\nVALEURS TROUVÉES: ${JSON.stringify(d.candidates)}`;
  save();
  return status();
}
async function login() {
  if (!bridge) throw new Error(NO_SITE);
  await bridge.open(); // se termine quand la fenêtre est fermée
  return refreshBalance();
}

// ---- inventaire du bot : une ligne par jeu (nom, valeur d'une carte en crédits, stock, cartes dans le set, sets complets / cartes différentes en stock) ----
function parseRow(r) {
  const c = r.c || [];
  const a = /appid-(\d+)/.exec(r.h || '');
  if (!a || c.length < 5) return null;
  const t = c.slice(-4); // worth, stock, cardsInSet, sets
  const worth = num(t[0]), stock = num(t[1]), cardsInSet = num(t[2]);
  const m = /(\d+)\s*\((\d+)\s*\/\s*(\d+)\)/.exec(t[3] || '');
  if ([worth, stock, cardsInSet].some(isNaN)) return null;
  return { appid: Number(a[1]), name: c[c.length - 5] || c[0], worth, stock, cardsInSet, setsAvail: m ? Number(m[1]) : parseInt(t[3], 10) || 0, distinct: m ? Number(m[2]) : 0 };
}
async function readInventory(force = false) {
  const d = load();
  if (!force && d.inv && Date.now() - d.inv.t < INV_TTL) return d.inv;
  if (!bridge) throw new Error(NO_SITE);
  const r = await bridge.scrape(INV_URL, { table: true });
  const rows = (r.rows || []).map(parseRow).filter(Boolean);
  if (!rows.length) { d.debug = 'INVENTAIRE ILLISIBLE\n' + String(r.text || '').slice(0, 3000); save(); throw new Error('Inventaire SteamCardExchange illisible (tableau introuvable) : copie le diagnostic dans les Réglages.'); }
  d.inv = { t: Date.now(), total: rows.length, rows: rows.map(({ name, ...r }) => r) }; // sans les noms : fichier plus léger
  save();
  return d.inv;
}
let mapCache = { inv: null, map: new Map(), stocked: 0 }; // la table fait ~15 000 lignes : on ne la reconstruit que si elle change
const invMap = () => {
  const inv = load().inv;
  if (mapCache.inv !== inv) mapCache = { inv, map: new Map(((inv && inv.rows) || []).map((r) => [r.appid, r])), stocked: ((inv && inv.rows) || []).filter((r) => r.stock > 0).length };
  return mapCache.map;
};
const botInfo = (appid) => invMap().get(appid) || null;

const setDemo = (rows) => { // données fictives, jamais écrites sur le disque
  demoOn = true; D = empty();
  Object.assign(D, { balance: 12.5, connected: true, balanceT: Date.now(), candidates: [{ value: 12.5, ctx: 'Your credits: 12.5' }], inv: { t: Date.now(), total: rows.length, rows } });
};
const status = () => { const d = load(); return { available: !!bridge || demoOn, connected: d.connected, balance: d.balance, balanceT: d.balanceT, candidates: d.candidates,
  games: (invMap(), mapCache.stocked), invAge: d.inv ? d.inv.t : 0, hasDebug: !!d.debug }; };
const debug = () => load().debug || '';
const reset = () => { if (demoOn) { demoOn = false; D = null; } };
module.exports = { setBridge, login, refreshBalance, readInventory, botInfo, invMap, status, debug, flush, setDemo, reset, findCredits, parseRow };
