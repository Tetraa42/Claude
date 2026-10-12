// Petit serveur de classement pour les utilisateurs de Steam Badge Trader.
// Il récupère LUI-MÊME les stats publiques via l'API Steam : impossible de tricher en envoyant de faux chiffres.
// Lancer : STEAM_API_KEY=xxxx node server.js   (nécessite Node 18+, aucune dépendance)
const http = require('http');
const fs = require('fs');
const KEY = process.env.STEAM_API_KEY, PORT = process.env.PORT || 8080, FILE = process.env.DATA_FILE || 'players.json';
if (!KEY) { console.error('STEAM_API_KEY manquante'); process.exit(1); }
let db = {}; try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const last = new Map();
const rarityPoints = (s) => (s > 0 ? Math.max(0.5, 7 - Math.log10(s)) : 1);
const get = async (u) => (await fetch(u)).json();

async function fetchStats(id) {
  const [s, b] = await Promise.all([
    get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${KEY}&steamids=${id}`),
    get(`https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${KEY}&steamid=${id}`),
  ]);
  const p = s.response.players[0], r = b.response || {};
  if (!p) throw new Error('Profil introuvable');
  if (p.communityvisibilitystate !== 3) throw new Error('Profil Steam privé : passe-le en public pour apparaître au classement');
  const all = r.badges || [];
  return { steamid: id, name: p.personaname, avatar: p.avatarfull, level: r.player_level || 0, xp: r.player_xp || 0, badgeCount: all.length,
    rareCount: all.filter((x) => x.scarcity > 0 && x.scarcity < 10000).length, rarity: +all.reduce((t, x) => t + rarityPoints(x.scarcity), 0).toFixed(1), updated: Date.now() };
}
const send = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/top') {
      const key = { level: 'level', badges: 'badgeCount', rarity: 'rarity' }[url.searchParams.get('metric')] || 'level';
      const list = Object.values(db).sort((a, b) => b[key] - a[key]).slice(0, Math.min(200, Number(url.searchParams.get('limit')) || 100));
      return send(res, 200, { list });
    }
    if (req.method === 'POST' && url.pathname === '/submit') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 2000) break; }
      const id = String(JSON.parse(body).steamid || '');
      if (!/^\d{17}$/.test(id)) return send(res, 400, { error: 'steamid invalide' });
      if (Date.now() - (last.get(id) || 0) < 60e3) return send(res, 429, { error: 'Réessaie dans une minute' });
      last.set(id, Date.now());
      db[id] = await fetchStats(id);
      fs.writeFileSync(FILE, JSON.stringify(db));
      return send(res, 200, { ok: true, me: db[id] });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 400, { error: e.message }); }
}).listen(PORT, () => console.log('Classement sur le port ' + PORT));
