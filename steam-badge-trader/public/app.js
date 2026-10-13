const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n, c) => n.toLocaleString('fr-FR', { style: 'currency', currency: (c ?? st.currency) === 1 ? 'USD' : (c ?? st.currency) === 2 ? 'GBP' : 'EUR' });
const nf = (n) => Number(n).toLocaleString('fr-FR');
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let st = null, timer = null, lastSig = '', glob = null, detail = null;
const prefs = Object.assign({ view: 'sets', filter: 'all', sort: 'cost', rankTab: 'friends', rankMetric: 'level' }, lsGet('sbt.prefs', {})); // mémorisés d'une session à l'autre
const savePrefs = () => lsSet('sbt.prefs', prefs);
let filter = prefs.filter, view = prefs.view, rankTab = prefs.rankTab;
const basket = new Set(lsGet('sbt.basket', []));
const saveBasket = () => lsSet('sbt.basket', [...basket]);
const T = { source: 'bot', friendId: '', friends: [], pv: null, askSel: new Set(), giveSel: new Set() };

const THEMES = [['nuit', 'Nuit', '#66c0f4'], ['steam', 'Steam', '#1a9fff'], ['clair', 'Clair', '#f3f6fc'], ['violet', 'Violet', '#c084fc'], ['foret', 'Forêt', '#4ade80'], ['braise', 'Braise', '#fb923c'], ['ocean', 'Océan', '#22d3ee'], ['sakura', 'Sakura', '#f9a8d4'], ['noir', 'Noir', '#e5e7eb']];
const FILTERS = [
  ['all', 'Tous', () => true],
  ['near', '🎯 Presque à 100 %', (s) => s.missingCount > 0 && s.missingCount <= 2],
  ['ready', '🔨 Prêts à crafter', (s) => s.missingCount === 0],
  ['new', '🆕 Nouveaux badges', (s) => s.badgeLevel === 0],
  ['progress', '📈 Badges en cours', (s) => s.badgeLevel > 0],
  ['dupes', '♻ Avec doublons', (s) => s.dupes > 0],
  ['cheap', '💶 < 0,50 €', (s) => s.cost != null && s.cost > 0 && s.cost < 0.5],
  ['bot', '🤖 En stock chez le bot', (s) => s.botStock > 0],
  ['botfull', '🤖 Set complet dispo', (s) => s.botSets > 0],
  ['friends', '👥 Chez des amis', (s) => s.friends.length > 0],
  ['drops', '🎴 À récupérer en jouant', (s) => s.drops > 0],
  ['done', '🏆 Badges terminés', null],
];

const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
function toast(t, bad) { const e = $('#toast'); e.textContent = t; e.className = 'show' + (bad ? ' bad' : ''); setTimeout(() => (e.className = ''), 4500); }
async function api(u, o) {
  const r = await fetch(u, o !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) } : undefined);
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}
const hue = (t) => [...String(t)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
window.fb = (img) => { const d = document.createElement('div'); d.className = 'banner phb'; d.style.setProperty('--h', hue(img.dataset.n)); d.textContent = img.dataset.n || ''; if (img.dataset.detail) d.dataset.detail = img.dataset.detail; img.replaceWith(d); };
const setTheme = (t) => { document.documentElement.dataset.theme = t; lsSet('sbt.theme', t); };

async function poll() {
  clearTimeout(timer);
  try { st = await api('/api/state'); render(); } catch (e) { $('#err').hidden = false; $('#err').textContent = '⚠ ' + e.message; }
  const busy = !st || Object.values(st.tasks).some((t) => t.state === 'running') || st.progress.running || st.bot.status === 'loading' || st.friends.status === 'loading' || st.rank.status === 'loading' || ['checking', 'downloading'].includes(st.update && st.update.status);
  timer = setTimeout(poll, busy ? 1500 : 12000);
}

// ---------- boutons de scan : le bouton se remplit au fur et à mesure (% et temps restant estimé) ----------
const SCANS = [
  ['badges', '🏅', 'Badges', 'Scanner ma page de badges'],
  ['cards', '🃏', 'Cartes & sets', 'Scanner mon inventaire de cartes et leurs prix'],
  ['boosters', '📦', 'Boosters', 'Scanner mes boosters'],
  ['gems', '💎', 'Gemmes', 'Scanner mes gemmes'],
  ['bot', '🤖', 'Bot (SCE)', 'Lire l\'inventaire du bot SteamCardExchange'],
  ['friends', '👥', 'Amis', 'Scanner les inventaires de mes amis'],
  ['balance', '💳', 'Solde de crédits', 'Lire mon solde sur SteamCardExchange'],
];
const fmtEta = (s) => (s == null ? '' : s < 90 ? `~${Math.max(1, Math.round(s))} s` : `~${Math.ceil(s / 60)} min`);
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'à l\'instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`; };
function taskInfo(k) {
  const t = st.tasks[k], g = st.progress;
  if (t.state === 'running') return `${t.label || 'En cours'}${k === 'cards' && g.wait ? ` · attente Steam ${g.wait} s` : ''}${t.eta ? ' · ' + fmtEta(t.eta) + ' restantes' : ''}`;
  if (t.state === 'error') return '⚠ ' + t.error;
  if (!t.doneAt) return 'Pas encore scanné — clique pour lancer';
  const n = { badges: `${st.completed.length} badge(s) terminé(s)${st.dropsTotal ? ` · 🎴 ${st.dropsTotal} à récupérer` : ''}`, cards: `${st.sets.length} jeu(x)`, boosters: `${st.boosters.reduce((a, b) => a + b.count, 0)} booster(s)`,
    gems: `${nf(st.gems.gems + st.gems.sacks * 1000)} gemme(s)`, bot: `${nf(st.bot.games)} jeux en stock`, friends: `${st.friends.count} ami(s)`, balance: `${st.credits.balance ?? '?'} crédit(s)` }[k];
  return `✔ ${ago(t.doneAt)} · ${n}`;
}
function renderScans() {
  const box = $('#scans');
  if (!box.children.length) {
    box.innerHTML = SCANS.map(([k, ic, name, tip]) => `<button class="scan" data-scan="${k}" title="${esc(tip)}"><span class="fill"></span><span class="t"><b>${ic} ${name}</b><small></small></span><span class="pc"></span></button>`).join('');
  }
  for (const [k] of SCANS) {
    const b = box.querySelector(`[data-scan="${k}"]`), t = st.tasks[k];
    b.className = 'scan ' + t.state; b.style.setProperty('--p', t.pct + '%');
    b.querySelector('small').textContent = taskInfo(k); b.querySelector('small').title = taskInfo(k);
    b.querySelector('.pc').textContent = t.state === 'running' ? t.pct + '%' : t.state === 'done' ? '↻' : t.state === 'error' ? '⟳' : '▶';
    b.disabled = t.state === 'running';
  }
}
$('#scans').addEventListener('click', safe(async (e) => {
  const b = e.target.closest('[data-scan]'); if (!b) return;
  const k = b.dataset.scan;
  if (k === 'balance' && !st.demo && !st.credits.sce.connected && st.credits.balance == null) return openSettings();
  await api('/api/scan/' + k, {}); poll();
}));
// bouton à remplissage pour une action sans progression connue (ex. lire une page du site) : le remplissage suit le temps estimé
async function fillProgress(btn, estSec, promise) {
  btn.classList.add('running'); btn.disabled = true;
  const t0 = Date.now(), small = btn.querySelector('small'), keep = small.textContent;
  const iv = setInterval(() => { const el = (Date.now() - t0) / 1000, p = Math.min(95, Math.round((100 * el) / estSec)); btn.style.setProperty('--p', p + '%'); btn.querySelector('.pc').textContent = p + '%'; small.textContent = `~${Math.max(1, Math.round(estSec - el))} s restantes`; }, 250);
  try { return await promise; } finally { clearInterval(iv); btn.style.setProperty('--p', '100%'); btn.querySelector('.pc').textContent = '100%'; small.textContent = keep; }
}

// ---------- panier ----------
function cardIndex() { // cartes manquantes de tous les jeux, par hash
  const m = new Map();
  for (const s of st.sets) for (const c of s.cards) if (!c.owned && !c.unknown) m.set(c.hash, { ...c, appid: s.appid, game: s.name, friends: s.friends.filter((f) => f.have.includes(c.hash)) });
  return m;
}
function renderBasket() {
  const idx = cardIndex();
  if (!st.progress.running) for (const h of [...basket]) if (!idx.has(h)) basket.delete(h);
  const n = basket.size, val = [...basket].reduce((t, h) => t + (idx.get(h) ? idx.get(h).price : 0), 0);
  $('#basket').hidden = !n || $('#dlg').open; $('#bk').textContent = `🛒 ${n} carte(s) dans le panier · ${money(val)}`;
  const xg = $('#xcount'); if (xg) xg.textContent = `🛒 ${n} carte(s) dans le panier`;
  saveBasket();
}
function toggleCards(hashes, on, rerender = true) { for (const h of hashes) (on ? basket.add(h) : basket.delete(h)); renderBasket(); if (rerender && $('#xdlg').open && detail) renderDetail(); }
$('#bkclear').onclick = () => { basket.clear(); renderBasket(); if (detail && $('#xdlg').open) renderDetail(); };
$('#bkgo').onclick = () => openTrade();

// ---------- affichage principal ----------
function render() {
  setTheme(st.theme);
  const p = st.profile, g = st.progress;
  if (p) {
    $('#avatar').src = p.avatar || ''; $('#avatar').hidden = !p.avatar; $('#name').innerHTML = `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`;
    $('#sub').textContent = `${nf(p.xp)} XP · ${p.needed - p.intoLevel} XP avant le niveau ${p.level + 1}` + (st.demo ? ' · MODE DÉMO' : '');
    $('#lvl').textContent = p.level; $('#ring').style.strokeDashoffset = 390 * (1 - p.intoLevel / p.needed); $('#lvxp').textContent = `${p.intoLevel} / ${p.needed} XP`;
    $('#proj').textContent = st.projection.level; $('#gain').textContent = '+' + st.projection.gainXp;
  } else $('#name').textContent = 'Lecture de ton profil Steam…';
  $('#tot').textContent = money(st.sets.reduce((t, s) => t + (s.cost || 0), 0));
  $('#kcred').hidden = st.credits.balance == null; if (st.credits.balance != null) $('#cred').textContent = nf(st.credits.balance);
  $('#kcval').hidden = st.credits.ownedValue == null; if (st.credits.ownedValue != null) $('#cval').textContent = nf(st.credits.ownedValue);

  $('#status').hidden = !(g.wait || g.retryIn);
  if (g.wait || g.retryIn) $('#stt').textContent = g.wait ? `Steam demande de ralentir : reprise dans ${g.wait} s (rien n'est perdu)…${st.sets.length ? '' : ' Steam a limité ton adresse suite aux essais précédents : ça se débloque tout seul, souvent en moins d\'une heure.'}` : `Prochaine tentative automatique dans ${Math.ceil(g.retryIn / 60)} min.`;
  $('#err').hidden = !g.error; if (g.error) $('#err').textContent = '⚠ ' + g.error + (g.retryIn ? ` Nouvelle tentative automatique dans ${Math.ceil(g.retryIn / 60)} min.` : '');
  renderScans();
  $('#nboost').textContent = st.boosters.reduce((t, b) => t + b.count, 0) || '';
  const u = st.update, upd = $('#upd'); upd.hidden = !(u && ['available', 'downloading', 'ready'].includes(u.status));
  if (!upd.hidden) upd.textContent = u.status === 'ready' ? '↻ Redémarrer pour mettre à jour' : u.status === 'downloading' ? `⬇ Téléchargement ${u.progress}%` : '⬇ Mise à jour disponible';
  $('#meta').textContent = (st.sets.length || st.completed.length ? `${st.sets.length} jeu(x) et ${st.completed.length} badge(s) terminé(s) en mémoire` : '') + (st.dropsTotal ? ` · 🎴 ${st.dropsTotal} carte(s) à récupérer en jouant sur ${st.dropsGames} jeu(x)` : '') + (st.updatedAt ? ` · analyse du ${new Date(st.updatedAt).toLocaleString('fr-FR')} · fermer le logiciel ne perd rien` : '');
  $('#chips').innerHTML = FILTERS.map(([k, label, fn]) => {
    const n = k === 'done' ? st.completed.length : st.sets.filter(fn).length;
    return `<button class="chip ${k === filter ? 'on' : ''}" data-f="${k}">${label} <i>${n}</i></button>`;
  }).join('');
  if ($('#sdlg').open) { renderUpdate(); renderSce(); }
  renderBasket(); showView();
}

function showView() {
  document.querySelectorAll('#views button[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  $('#v-sets').hidden = view !== 'sets'; $('#v-boosters').hidden = view !== 'boosters'; $('#v-rank').hidden = view !== 'rank';
  if (view === 'sets') draw(); if (view === 'boosters') drawBoosters(); if (view === 'rank') drawRank();
}
$('#views').onclick = (e) => {
  const b = e.target.closest('button[data-v]'); if (b) { view = prefs.view = b.dataset.v; savePrefs(); lastSig = ''; showView(); if (view === 'rank' && rankTab === 'global') loadGlobal(); }
  if (e.target.closest('#upd')) { const u = st.update; if (u.status === 'ready') api('/api/update/install', {}); else openSettings(); }
};

// ---------- sets ----------
function draw() {
  const q = $('#q').value.toLowerCase(), sort = $('#sort').value;
  const sig = JSON.stringify([filter, q, sort, st.currency, st.credits.balance, st.sets.map((s) => [s.appid, s.ownedUnique, s.botStock, s.friends.length, s.cost, s.worth, s.provisional, s.botChecked, s.botHas]), st.completed.length, st.progress.running]);
  if (sig === lastSig) return; lastSig = sig;
  if (filter === 'done') {
    $('#h2').innerHTML = 'Badges terminés <small>niveau 5 — 100 % · clique pour voir le détail</small>';
    $('#grid').innerHTML = st.completed.filter((b) => b.name.toLowerCase().includes(q)).map((b) => `
      <article class="set done"><img class="banner" data-n="${esc(b.name)}" data-detail="${b.appid}" src="${esc(b.banner)}" alt="" onerror="fb(this)"><div class="body"><header><h3 data-detail="${b.appid}">${esc(b.name)}</h3><span class="pill ok">Niveau ${b.level} ✔</span></header>
      ${b.drops ? `<div class="tags"><span class="tag dr" title="Cartes qu'il te reste à obtenir en jouant à ce jeu">🎴 ${b.drops} carte(s) à récupérer en jouant</span></div>` : ''}
      <button class="cta" data-detail="${b.appid}">Voir les données</button></div></article>`).join('') || '<p class="empty">Aucun badge niveau 5 pour le moment.</p>';
    return;
  }
  $('#h2').innerHTML = 'Sets à compléter <small>' + { cost: 'du moins cher au plus cher', missing: 'les plus proches de 100 %', pct: 'les plus avancés', name: 'par nom' }[sort] + ' · clique sur un jeu pour le détail</small>';
  const fn = FILTERS.find((f) => f[0] === filter)[2];
  const cc = (x) => (x.cost == null ? 1e9 : x.cost); // prix pas encore connu : en fin de liste
  const by = { cost: (a, b) => cc(a) - cc(b), missing: (a, b) => a.missingCount - b.missingCount || cc(a) - cc(b), pct: (a, b) => b.ownedUnique / b.total - a.ownedUnique / a.total, name: (a, b) => a.name.localeCompare(b.name) }[sort];
  const list = st.sets.filter((s) => fn(s) && s.name.toLowerCase().includes(q)).sort(by);
  $('#grid').innerHTML = list.map((s) => `
  <article class="set"><img class="banner" data-n="${esc(s.name)}" data-detail="${s.appid}" src="${esc(s.banner)}" alt="" loading="lazy" onerror="fb(this)">
   <div class="body"><header><h3 data-detail="${s.appid}">${esc(s.name)}</h3><span class="pill">${s.badgeLevel ? 'Niv. ' + s.badgeLevel + ' → ' + (s.badgeLevel + 1) : 'Nouveau badge'}</span></header>
    <div class="fan">${s.cards.map((c) => c.unknown ? '<span class="ph" title="Carte pas encore connue"></span>' : `<img loading="lazy" src="${esc(c.img)}" title="${esc(c.name)} — ${esc(c.priceText || '')}${c.credits != null ? ' · ' + c.credits + ' crédit(s) chez le bot' : ''}" class="${c.owned ? '' : 'miss'}" alt="${esc(c.name)}">`).join('')}</div>
    <div class="meter"><i style="width:${(100 * s.ownedUnique) / s.total}%"></i></div>
    <div class="row"><span>${s.ownedUnique}/${s.total} cartes · ${s.dupes} doublon(s)</span><span>+100 XP</span></div>
    <div class="tags">${s.botChecked ? `<span class="tag bot" title="Vérifié carte par carte sur la page du jeu chez le bot">🤖 a ${s.botHas}/${s.missingCount} de tes cartes manquantes</span>` : s.botStock ? `<span class="tag bot" title="Cartes en stock chez le bot SteamCardExchange (pas encore vérifié carte par carte)">🤖 stock ${s.botStock} · ${s.botDistinct}/${s.total} différentes${s.botSets ? ' · ' + s.botSets + ' set(s) complet(s)' : ''}</span>` : ''}${s.friends.length ? `<span class="tag fr">👥 ${s.friends.length} ami(s)</span>` : ''}${s.drops ? `<span class="tag dr" title="Cartes qu'il te reste à obtenir en jouant à ce jeu">🎴 ${s.drops} à récupérer en jouant</span>` : ''}${s.worth != null ? `<span class="tag cr" title="Crédits que le bot te donne pour une carte de ce jeu">💳 ${s.worth} crédit(s)/carte</span>` : ''}</div>
    <div class="row"><span class="price ${s.cost === 0 ? 'free' : ''}">${s.cost == null ? '<small class="mut">prix en cours de lecture…</small>' : s.cost ? money(s.cost) : 'Prêt à crafter !'}${s.stale && !s.provisional ? ' <small title="prix en cours de rafraîchissement">~</small>' : ''}</span><a class="lnk" href="${esc(s.link)}" target="_blank" rel="noopener">Comparer sur SCE ↗</a></div>
    <button class="cta" data-app="${s.appid}">${s.cost == null ? '🔎 Voir le détail' : s.cost ? '⇄ Compléter par échange' : '🔨 Crafter le badge (Steam)'}</button></div>
  </article>`).join('') || `<p class="empty">${st.progress.running ? 'Analyse en cours, les sets apparaissent ici au fur et à mesure…' : 'Aucun set ne correspond à ce filtre.'}</p>`;
}
$('#grid').addEventListener('click', (e) => {
  const d = e.target.closest('[data-detail]'); if (d) return openDetail(Number(d.dataset.detail));
  const b = e.target.closest('.cta'); if (!b) return;
  const s = st.sets.find((x) => x.appid == b.dataset.app);
  if (s.cost == null) return openDetail(s.appid); // prix pas encore lu : la fiche le récupère
  if (!s.cost) return window.open(`${st.profile.url.replace(/\/$/, '')}/gamecards/${s.appid}/`, '_blank');
  toggleCards(s.cards.filter((c) => !c.owned).map((c) => c.hash), true); openTrade(); // « compléter » = tout le set manquant dans le panier
});

// ---------- fiche détaillée d'un badge ----------
async function openDetail(appid) {
  $('#xbody').innerHTML = '<p class="mut">Chargement…</p>'; detail = null; $('#xdlg').showModal();
  try { detail = await api('/api/game/' + appid); renderDetail(); } catch (e) { $('#xbody').innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
}
function renderDetail() {
  const d = detail, s = d.set, maxed = d.badge.level >= 5;
  const prof = st.profile.url.replace(/\/$/, '');
  const missing = s.cards.filter((c) => !c.owned);
  $('#xbody').innerHTML = `
  <div class="xhead"><img src="${esc(s.banner)}" alt="" onerror="this.remove()"><h2>${esc(s.name)}</h2></div>
  <div class="row"><span><span class="pill ${maxed ? 'ok' : ''}">Badge niveau ${d.badge.level}/5${maxed ? ' ✔' : ''}</span> ${d.badge.xp ? `· ${d.badge.xp} XP` : ''}</span>
    <span><a class="lnk" href="${prof}/gamecards/${s.appid}/" target="_blank" rel="noopener">Page du badge Steam ↗</a> · <a class="lnk" href="${esc(s.link)}" target="_blank" rel="noopener">SteamCardExchange ↗</a> · <a class="lnk" href="https://store.steampowered.com/app/${s.appid}" target="_blank" rel="noopener">Boutique ↗</a></span></div>
  <div class="stats">
    <div class="stat"><b>${s.ownedUnique}/${s.total}</b><small>cartes possédées</small></div>
    <div class="stat"><b>${s.dupes}</b><small>doublon(s)</small></div>
    <div class="stat"><b>${money(s.cost)}</b><small>pour compléter</small></div>
    <div class="stat"><b>${s.worth != null ? s.worth : '–'}</b><small>crédits par carte (ce que le bot te donne)</small></div>
    <div class="stat"><b>${s.creditsOwned != null ? s.creditsOwned : '–'}</b><small>crédits pour tes ${s.cards.reduce((t, c) => t + c.owned, 0)} carte(s) de ce jeu</small></div>
    <div class="stat"><b>${s.botStock || 0}</b><small>carte(s) en stock chez le bot</small></div>
    ${s.drops != null ? `<div class="stat"><b>${s.drops}</b><small>carte(s) encore à récupérer en jouant</small></div>` : ''}
  </div>
  ${d.boosters ? `<div class="xsec"><h4>📦 Boosters</h4><div class="bbox"><img src="${esc(d.boosters.img)}" alt=""><div class="grow"><b>${d.boosters.count} booster(s)</b> pour ce jeu<br><small class="mut">3 cartes au hasard — l'ouverture est définitive.</small></div><button class="cta" style="width:auto;padding:10px 18px" data-act="boost">📦 Ouvrir un booster</button></div></div>` : ''}
  <div class="xsec"><h4>Cartes <small class="mut">— coche celles à échanger (panier)</small></h4>
  <table class="cards"><tr><th></th><th>Carte</th><th>Possédée</th><th>Prix</th><th>Crédits</th><th>Chez le bot</th><th>Amis</th></tr>${s.cards.map((c) => `
    <tr class="${c.owned ? '' : 'miss'} ${basket.has(c.hash) ? 'sel' : ''}"><td>${c.owned ? '' : `<input type="checkbox" data-h="${esc(c.hash)}" ${basket.has(c.hash) ? 'checked' : ''}>`}</td>
    <td><img src="${esc(c.img)}" alt="" loading="lazy"><a class="lnk" href="https://steamcommunity.com/market/listings/753/${encodeURIComponent(c.hash)}" target="_blank" rel="noopener">${esc(c.name)}</a></td>
    <td>${c.owned ? '× ' + c.owned : '<span class="mut">manquante</span>'}</td><td>${esc(c.priceText || money(c.price))}</td><td>${c.credits != null ? c.credits : '–'}</td><td>${c.owned ? '' : c.botCard ? (c.botCard.stock > 0 ? `✔ ${c.botCard.stock}${c.botCard.price != null ? ' · ' + c.botCard.price + ' cr' : ''}` : '✖ rupture') : s.botChecked ? '–' : '<span class="mut" title="Pas encore vérifié">?</span>'}</td>
    <td>${c.owned ? '' : (() => { const f = s.friends.filter((x) => x.have.includes(c.hash)); return f.length ? '👥 ' + f.length : '–'; })()}</td></tr>`).join('')}</table></div>
  <div class="xsec"><h4>🔎 Vérifier ce jeu</h4>
    <div class="checks">
      <button class="scan sm" data-act="chkbot"><span class="fill"></span><span class="t"><b>🤖 Le bot a-t-il mes cartes ?</b><small>lit la page du jeu sur SteamCardExchange</small></span><span class="pc">▶</span></button>
      <button class="scan sm" data-act="chkall"><span class="fill"></span><span class="t"><b>🔄 Vérifier tout ce jeu</b><small>bot carte par carte + prix Steam à jour</small></span><span class="pc">▶</span></button>
    </div>${(detail.notes || []).map((n) => `<p class="note">⚠ ${esc(n)}</p>`).join('')}</div>
  <div class="xsec"><h4>⇄ Échanges possibles</h4>
    <div class="flist">
     <div class="frow"><span>🤖</span><div class="grow"><b>${esc(d.bot.name)}</b><br><small>${s.botChecked ? (s.botHas ? `a ${s.botHas}/${missing.length} de tes cartes manquantes : ${s.cards.filter((c) => !c.owned && c.botCard && c.botCard.stock > 0).map((c) => esc(c.name)).join(', ')}` : 'n\'a aucune de tes cartes manquantes (vérifié carte par carte)') : d.bot.status !== 'ready' ? 'inventaire du bot non chargé : clique sur le bouton « Bot SteamCardExchange » en haut' : s.botStock ? `stock : ${s.botStock} carte(s) · ${s.botDistinct}/${s.total} différentes${s.botSets ? ` · ${s.botSets} set(s) complet(s) disponible(s)` : ''} · il te donne ${s.worth} crédit(s) par carte` : 'n\'a aucune carte de ce jeu en stock'}</small></div><a class="ghost sm" href="${esc(s.link)}" target="_blank" rel="noopener">Ouvrir sur le site ↗</a></div>
     ${s.friends.map((f) => `<div class="frow"><img src="${esc(f.avatar || '')}" alt=""><div class="grow"><b>${esc(f.name)}</b><br><small>a ${f.have.length}/${missing.length} : ${f.have.map((h) => esc((s.cards.find((c) => c.hash === h) || {}).name)).join(', ')}</small></div><button class="ghost sm" data-act="selfriend" data-f="${f.steamid}">Sélectionner</button></div>`).join('') || (st.friends.status === 'ready' ? '<p class="mut small">Aucun ami n\'a tes cartes manquantes.</p>' : '<p class="mut small">Scanne tes amis (page Sets) pour voir qui a tes cartes.</p>')}
    </div>
    <div class="row" style="margin-top:10px"><span><button class="ghost sm" data-act="selall">Tout sélectionner (manquantes)</button> <button class="ghost sm" data-act="selnone">Désélectionner</button></span></div></div>
  <div class="row xfoot"><span id="xcount"></span><button class="go" style="width:auto;padding:12px 24px;margin:0" data-act="trade">⇄ Lancer l'échange</button></div>`;
  renderBasket();
}
$('#xbody').addEventListener('change', (e) => { const h = e.target.dataset && e.target.dataset.h; if (h === undefined) return; toggleCards([h], e.target.checked, false); e.target.closest('tr').classList.toggle('sel', e.target.checked); });
$('#xbody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !detail) return;
  const s = detail.set, missing = s.cards.filter((c) => !c.owned), act = b.dataset.act;
  if (act === 'selall') toggleCards(missing.map((c) => c.hash), true);
  if (act === 'selnone') toggleCards(missing.map((c) => c.hash), false);
  if (act === 'selfriend') { const f = s.friends.find((x) => x.steamid === b.dataset.f); toggleCards(f.have, true); T.friendId = f.steamid; T.pref = 'friend'; }
  if (act === 'trade') { $('#xdlg').close(); openTrade(); }
  if (act === 'boost') openBooster(s.appid, detail.boosters.assetid, s.name, b);
  if (act === 'chkbot' || act === 'chkall') {
    try { const d = await fillProgress(b, act === 'chkall' ? 16 : 9, api(`/api/game/${s.appid}/check`, act === 'chkbot' ? { only: 'bot' } : {})); detail = d; renderDetail(); poll(); }
    catch (err) { toast(err.message, true); b.disabled = false; b.classList.remove('running'); }
  }
});

// ---------- connexion Steam (échanges, boosters) ----------
$('#gcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gok').click(); });
function askGuard() {
  return new Promise((resolve) => {
    $('#gcode').value = ''; $('#gdlg').showModal();
    $('#gok').onclick = () => { const v = $('#gcode').value.trim(); $('#gdlg').close(); resolve(v || null); };
    $('#gdlg').onclose = () => resolve(null);
  });
}
async function ensureLogin() {
  const l = await api('/api/trade/login', {});
  if (l.status === 'ready') return true;
  const code = await askGuard(); if (!code) return false;
  const r = await api('/api/trade/login', { code });
  if (r.status !== 'ready') toast('Code Steam Guard refusé ou expiré : réessaie avec le nouveau code.', true);
  return r.status === 'ready';
}

// ---------- échange (panier multi-cartes) ----------
function openTrade() {
  if (!basket.size) return toast('Sélectionne d\'abord des cartes (clique sur un jeu pour le détail).', true);
  const idx = cardIndex(), hs = [...basket].filter((h) => idx.has(h));
  if (!hs.length) return toast('Ces cartes ne sont plus manquantes.', true);
  const botN = 0, fr = new Map();
  for (const h of hs) for (const f of idx.get(h).friends) fr.set(f.steamid, { id: f.steamid, name: f.name, n: (fr.get(f.steamid) ? fr.get(f.steamid).n : 0) + 1 });
  T.friends = [...fr.values()].sort((a, b) => b.n - a.n);
  if (!T.friends.find((f) => f.id === T.friendId)) T.friendId = T.friends[0] ? T.friends[0].id : '';
  T.source = T.friends.length ? 'friend' : 'url'; T.pref = null; T.botN = botN;
  $('#dsub').textContent = `${hs.length} carte(s) dans le panier — chez des amis : ${T.friends.length} ami(s)`;
  $('#note').textContent = ''; $('#pv').hidden = true; $('#go').disabled = true;
  $('#basket').hidden = true; setSource(T.source); $('#dlg').showModal();
}
$('#dlg').addEventListener('close', renderBasket);
function setSource(s) {
  T.source = s; T.pv = null;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
  const box = $('#srcbox'); $('#pv').hidden = true; $('#go').disabled = true;
  if (s === 'bot') box.innerHTML = `<div class="sbox">Le bot SteamCardExchange fait ses échanges depuis <b>son site</b> : bouton « Make Offer » sur la page Inventory.<br>Le bot te donne des crédits pour tes cartes en trop${st.credits.spareValue != null ? ` (≈ <b>${st.credits.spareValue} crédits</b> pour tes cartes en trop)` : ''}, que tu dépenses ensuite pour prendre ses cartes (max 6 cartes par côté, 100 crédits stockés au maximum).<br><br><a class="ghost" href="https://www.steamcardexchange.net/index.php?inventory" target="_blank" rel="noopener">Ouvrir l'inventaire du bot ↗</a></div>`;
  if (s === 'friend') box.innerHTML = T.friends.length ? `<label class="lab">Ami<select id="fsel">${T.friends.map((f) => `<option value="${f.id}" ${f.id === T.friendId ? 'selected' : ''}>${esc(f.name)} — ${f.n} carte(s) du panier</option>`).join('')}</select></label>`
    : '<p class="mut">Aucun ami n\'a les cartes du panier (clique d\'abord sur « Scanner mes amis »).</p>';
  if (s === 'url') box.innerHTML = '<label class="lab">Lien d\'échange du partenaire<input id="turl" placeholder="https://steamcommunity.com/tradeoffer/new/?partner=…&token=…"></label>';
  if (s === 'friend' && T.friends.length) { $('#fsel').onchange = () => { T.friendId = $('#fsel').value; preview(); }; T.friendId = $('#fsel').value; }
  if (s === 'friend' && T.friends.length) preview();
  if (st.demo && $('#turl')) $('#turl').value = 'https://steamcommunity.com/tradeoffer/new/?partner=123456&token=demo';
}
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) setSource(b.dataset.s); };
async function preview() {
  try {
    const pv = T.pv = await api('/api/trade/preview', { hashes: [...basket], source: T.source, friendId: T.friendId, tradeUrl: $('#turl') ? $('#turl').value : '' });
    T.askSel = new Set(pv.ask.map((c) => c.assetid)); T.giveSel = new Set(pv.give.map((c) => c.assetid));
    drawPreview();
    $('#note').textContent = pv.notFound.length ? `Introuvable chez cette source : ${pv.notFound.join(', ')}.` : '';
  } catch (e) { toast(e.message, true); }
}
function drawPreview() {
  const pv = T.pv, im = (l, sel, k) => l.map((c) => `<img data-${k}="${esc(c.assetid)}" class="${sel.has(c.assetid) ? 'on' : 'off'}" src="${esc(c.img)}" title="${esc(c.name)}${c.game ? ' — ' + esc(c.game) : ''}" alt="${esc(c.name)}">`).join('') || '<small>–</small>';
  $('#askl').innerHTML = im(pv.ask, T.askSel, 'a'); $('#givel').innerHTML = im([...pv.give, ...pv.giveMore], T.giveSel, 'g'); $('#pv').hidden = false;
  $('#askn').textContent = `(${T.askSel.size})`; $('#givn').textContent = `(${T.giveSel.size})`;
  $('#go').disabled = !T.askSel.size;
  const warn = T.giveSel.size < T.askSel.size ? 'Tu donnes moins de cartes que tu n\'en demandes : l\'offre risque d\'être refusée. ' : '';
  $('#note').textContent = (T.pv.notFound.length ? `Introuvable chez cette source : ${T.pv.notFound.join(', ')}. ` : '') + warn + 'Clique sur une carte pour l\'inclure ou l\'exclure.';
}
$('#pv').addEventListener('click', (e) => {
  const i = e.target.closest('img'); if (!i) return;
  const [set, id] = i.dataset.a !== undefined ? [T.askSel, i.dataset.a] : [T.giveSel, i.dataset.g];
  set.has(id) ? set.delete(id) : set.add(id); drawPreview();
});
$('#srcbox').addEventListener('change', (e) => { if (e.target.id === 'turl') preview(); });
$('#go').onclick = async () => {
  $('#go').disabled = true;
  try {
    if (!(await ensureLogin())) { $('#go').disabled = false; return; }
    const r = await api('/api/trade/send', { source: T.source, friendId: T.friendId, tradeUrl: $('#turl') ? $('#turl').value : '', give: [...T.giveSel], ask: [...T.askSel] });
    for (const c of T.pv.ask) if (T.askSel.has(c.assetid)) basket.delete(c.hash);
    toast('✅ ' + r.note); $('#dlg').close(); renderBasket();
  } catch (e) { toast(e.message, true); $('#go').disabled = false; }
};

// ---------- boosters ----------
async function openBooster(appid, assetid, game, btn) {
  if (!confirm(`Ouvrir un booster « ${game} » ? Cette action est définitive.`)) return;
  if (btn) btn.disabled = true;
  try {
    if (!(await ensureLogin())) { if (btn) btn.disabled = false; return; }
    const r = await api('/api/boosters/open', { appid, assetid });
    $('#bt').textContent = `Booster ${game} : tu as reçu`;
    $('#bres').innerHTML = r.cards.map((c) => `<img src="${esc(c.img)}" title="${esc(c.name)}${c.foil ? ' (foil)' : ''}" alt="${esc(c.name)}">`).join('');
    if ($('#xdlg').open) $('#xdlg').close();
    $('#bdlg').showModal(); poll();
  } catch (err) { toast(err.message, true); if (btn) btn.disabled = false; }
}
let bSig = '', rSig = '';
function drawBoosters() {
  $('#gemsbar').innerHTML = st.tasks.gems.doneAt || st.gems.gems || st.gems.sacks ? `<div class="gem"><b>💎 ${nf(st.gems.gems)}</b><small>gemmes en vrac</small></div><div class="gem"><b>🎒 ${nf(st.gems.sacks)}</b><small>sac(s) de 1 000 gemmes</small></div><div class="gem"><b>∑ ${nf(st.gems.gems + st.gems.sacks * 1000)}</b><small>gemmes au total</small></div>` : '<p class="mut">Clique sur le bouton « 💎 Gemmes » en haut pour scanner tes gemmes.</p>';
  const sig = JSON.stringify([st.boosters, st.gems]); if (sig === bSig) return; bSig = sig;
  $('#bgrid').innerHTML = st.boosters.map((b) => `
  <article class="set"><img class="banner" data-n="${esc(b.game)}" data-detail="${b.appid}" src="${esc(b.banner)}" alt="" onerror="fb(this)"><div class="body"><header><h3 data-detail="${b.appid}">${esc(b.game)}</h3><span class="pill">× ${b.count}</span></header>
    <div class="fan"><img src="${esc(b.img)}" alt="" style="width:96px;height:96px"></div>
    <button class="cta" data-boost="${b.appid}" data-asset="${b.assetid}">📦 Ouvrir un booster</button></div></article>`).join('') || '<p class="empty">Aucun booster dans ton inventaire.</p>';
}
$('#bgrid').addEventListener('click', (e) => {
  const d = e.target.closest('[data-detail]'); if (d) return openDetail(Number(d.dataset.detail));
  const b = e.target.closest('[data-boost]'); if (!b) return;
  const bo = st.boosters.find((x) => String(x.appid) === b.dataset.boost); openBooster(bo.appid, b.dataset.asset, bo.game, b);
});

// ---------- classement ----------
async function loadGlobal() { try { glob = await api('/api/rank/global'); } catch (e) { glob = { error: e.message, list: [] }; } rSig = ''; drawRank(); }
function drawRank() {
  const sig = JSON.stringify([rankTab, $('#rmetric').value, st.rank, glob, st.leaderboard]); if (sig === rSig) return; rSig = sig;
  document.querySelectorAll('#rtabs button').forEach((b) => b.classList.toggle('on', b.dataset.r === rankTab));
  const m = $('#rmetric').value, box = $('#rbody');
  const table = (list) => `<table class="rank"><tr><th></th><th>Joueur</th><th>Niveau</th><th>Badges</th><th>Rareté</th></tr>${[...list].sort((a, b) => (b[m] || 0) - (a[m] || 0)).map((p, i) => `
    <tr class="${p.me ? 'me' : ''}"><td class="n">${['🥇', '🥈', '🥉'][i] || i + 1}</td><td><img src="${esc(p.avatar || '')}" alt="">${esc(p.name)}${p.me ? ' (toi)' : ''}</td>
    <td class="${m === 'level' || m === 'xp' ? 'hl' : ''}">${p.level}</td><td class="${m === 'badgeCount' ? 'hl' : ''}">${nf(p.badgeCount)}</td><td class="${m === 'rarity' ? 'hl' : ''}">${nf(p.rarity)}${p.rareCount != null ? ` <small class="mut">· ${p.rareCount} rares</small>` : ''}</td></tr>`).join('')}</table>`;
  if (rankTab === 'friends') {
    const r = st.rank;
    const head = `<div class="row" style="margin-bottom:12px"><span class="mut">${r.status === 'loading' ? `Analyse ${r.done}/${r.total}…` : r.status === 'error' ? '⚠ ' + esc(r.error) : r.list.length ? `${r.list.length} joueurs` : 'Pas encore analysé'}</span><button class="ghost" id="rscan">${r.list.length ? '↻ Réanalyser' : '👥 Analyser mes amis'}</button></div>`;
    box.innerHTML = head + (r.list.length ? table(r.list) : '<div class="sbox">Clique sur « Analyser mes amis » : l\'app lit le niveau et les badges publics de tes amis (leurs badges doivent être visibles).</div>');
    $('#rscan').onclick = safe(async () => { await api('/api/rank/scan', {}); poll(); });
  } else {
    if (!glob) { box.innerHTML = '<p class="empty">Chargement…</p>'; return; }
    if (glob.missing) { box.innerHTML = '<div class="sbox">Le classement entre utilisateurs de l\'app a besoin d\'un serveur. Héberge <code>leaderboard-server</code> (voir son README), puis colle son adresse dans ⚙ Réglages.</div>'; return; }
    if (glob.error) { box.innerHTML = `<div class="errbox">${esc(glob.error)}</div>`; return; }
    const joined = st.leaderboard.joined;
    box.innerHTML = `<div class="row" style="margin-bottom:12px"><span class="mut">${glob.list.length} joueur(s)${glob.demo ? ' · données de démonstration' : ''}</span>${joined ? '<span class="tag fr">✔ Tu participes</span>' : '<button class="ghost" id="rjoin">Rejoindre le classement</button>'}</div>` + table(glob.list);
    if (!joined) $('#rjoin').onclick = async () => { if (!confirm('Ton pseudo, ton avatar, ton niveau et tes badges (publics) seront visibles par les autres utilisateurs. Continuer ?')) return; try { await api('/api/rank/join', {}); toast('Tu es dans le classement !'); await loadGlobal(); poll(); } catch (e) { toast(e.message, true); } };
  }
}
$('#rtabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { rankTab = prefs.rankTab = b.dataset.r; savePrefs(); if (rankTab === 'global') loadGlobal(); else { rSig = ''; drawRank(); } } };
$('#rmetric').onchange = () => { prefs.rankMetric = $('#rmetric').value; savePrefs(); rSig = ''; drawRank(); };

// ---------- barre d'outils ----------
$('#chips').onclick = (e) => { const b = e.target.closest('.chip'); if (b) { filter = prefs.filter = b.dataset.f; savePrefs(); lastSig = ''; render(); } };
$('#q').oninput = () => st && draw(); $('#sort').onchange = () => { prefs.sort = $('#sort').value; savePrefs(); st && draw(); };
$('#refresh').onclick = safe(async () => { const r = await api('/api/refresh', {}); if (r.already) toast('Une analyse est déjà en cours : elle continue.'); lastSig = ''; poll(); });

// ---------- réglages ----------
function renderUpdate() {
  const u = st.update || {}; $('#ver').textContent = st.version ? 'Version installée : ' + st.version : '';
  const b = $('#updbtn');
  b.textContent = u.status === 'ready' ? '↻ Redémarrer et installer' : u.status === 'downloading' ? `⬇ Téléchargement ${u.progress}%…` : u.status === 'checking' ? 'Recherche…' : '⬇ Mettre à jour le logiciel';
  b.disabled = ['checking', 'downloading'].includes(u.status);
  $('#updst').textContent = { none: '✔ Tu as déjà la dernière version.', available: `Version ${u.latest} trouvée, téléchargement…`, ready: `Version ${u.latest} prête : le logiciel va redémarrer.`, error: '⚠ ' + (u.error || ''), dev: 'Disponible uniquement dans le logiciel installé.' }[u.status] || '';
}
function renderSce() {
  const sc = st.credits.sce; if (!sc) return;
  const found = sc.candidates.length > 1 ? ' Autres valeurs vues : ' + sc.candidates.slice(1, 4).map((c) => `${c.value} (« ${c.ctx} »)`).join(' ; ') : '';
  $('#sceInfo').textContent = !sc.available ? 'Disponible dans le logiciel installé.' : sc.connected || sc.balance != null ? `✔ Solde lu : ${sc.balance ?? '?'} crédit(s) · bot : ${sc.games} jeux en stock.${found}` : 'Pas encore connecté.';
}
$('#updbtn').onclick = async () => {
  try {
    if (st.update && st.update.status === 'ready') return api('/api/update/install', {});
    await api('/api/update/check', {}); poll();
  } catch (e) { $('#updst').textContent = '⚠ ' + e.message; }
};
$('#sceLogin').onclick = async () => { $('#sceInfo').textContent = 'Une fenêtre SteamCardExchange s\'est ouverte : connecte-toi avec Steam puis ferme-la.'; try { await api('/api/sce/login', {}); } catch (e) { $('#sceInfo').textContent = '⚠ ' + e.message; } await poll(); renderSce(); };
$('#sceBal').onclick = async () => { $('#sceInfo').textContent = 'Lecture…'; try { await api('/api/sce/balance', {}); } catch (e) { $('#sceInfo').textContent = '⚠ ' + e.message; } await poll(); renderSce(); };
$('#sceScan').onclick = safe(async () => { await api('/api/sce/scan', {}); toast('Lecture de l\'inventaire du bot lancée…'); poll(); });
$('#sceDbg').onclick = async () => { const t = await (await fetch('/api/sce/debug')).text(); try { await navigator.clipboard.writeText(t); toast('Diagnostic copié : colle-le dans la discussion'); } catch { prompt('Copie ce diagnostic :', t.slice(0, 3000)); } };
$('#themes').innerHTML = THEMES.map(([k, n, c]) => `<button class="ghost sw" data-t="${k}"><i style="background:${c}"></i>${n}</button>`).join('');
$('#themes').onclick = safe(async (e) => { const b = e.target.closest('[data-t]'); if (!b) return; setTheme(b.dataset.t); st.theme = b.dataset.t; await api('/api/settings', { THEME: b.dataset.t }); markTheme(); });
const markTheme = () => document.querySelectorAll('.sw').forEach((b) => b.classList.toggle('on', b.dataset.t === document.documentElement.dataset.theme));

async function openSettings() {
  const c = await api('/api/settings');
  $('#s_profile').value = c.STEAM_PROFILE; $('#s_key').value = c.STEAM_API_KEY; $('#s_cur').value = c.CURRENCY || '3'; $('#s_acc').value = c.STEAM_ACCOUNT;
  $('#s_botonly').checked = c.BOT_ONLY !== '0'; $('#s_autocards').checked = c.AUTO_CARDS === '1';
  $('#s_cbal').value = c.CREDITS_BALANCE; $('#s_lb').value = c.LEADERBOARD_URL;
  for (const [id, k] of [['s_pwd', 'STEAM_PASSWORD'], ['s_shared', 'STEAM_SHARED_SECRET'], ['s_ident', 'STEAM_IDENTITY_SECRET']]) { $('#' + id).value = ''; $('#' + id).placeholder = c[k + '_SET'] ? '••••••• (enregistré)' : ''; }
  markTheme(); renderUpdate(); renderSce(); $('#sdlg').showModal();
}
$('#ssave').onclick = async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', { STEAM_PROFILE: $('#s_profile').value, STEAM_API_KEY: $('#s_key').value, CURRENCY: $('#s_cur').value, STEAM_ACCOUNT: $('#s_acc').value,
      BOT_ONLY: $('#s_botonly').checked ? '1' : '0', AUTO_CARDS: $('#s_autocards').checked ? '1' : '0', CREDITS_BALANCE: $('#s_cbal').value.replace(',', '.'), LEADERBOARD_URL: $('#s_lb').value,
      STEAM_PASSWORD: $('#s_pwd').value, STEAM_SHARED_SECRET: $('#s_shared').value, STEAM_IDENTITY_SECRET: $('#s_ident').value });
    $('#sdlg').close(); toast('Réglages enregistrés'); lastSig = ''; glob = null; poll();
  } catch (err) { toast(err.message, true); }
};
const cfgBtn = document.createElement('button'); cfgBtn.id = 'cfg'; cfgBtn.className = 'ghost'; cfgBtn.textContent = '⚙ Réglages'; $('#views').appendChild(cfgBtn); cfgBtn.onclick = openSettings;

document.querySelectorAll('dialog').forEach((dlg) => dlg.addEventListener('click', (e) => { // un clic à l'extérieur de la fenêtre la ferme
  if (e.target !== dlg || dlg.id === 'gdlg') return;
  const r = dlg.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
}));
// restaure l'interface comme à la dernière fermeture
$('#sort').value = prefs.sort; $('#rmetric').value = prefs.rankMetric;
poll().then(() => { if (view === 'rank' && rankTab === 'global') loadGlobal(); if (st && st.demo && !st.seenSetup) { api('/api/settings', { SEEN_SETUP: '1' }); openSettings(); } });
