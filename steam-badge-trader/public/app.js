const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n, c) => n.toLocaleString('fr-FR', { style: 'currency', currency: c === 1 ? 'USD' : c === 2 ? 'GBP' : 'EUR' });
const nf = (n) => Number(n).toLocaleString('fr-FR');
let st = null, filter = 'all', view = 'sets', rankTab = 'friends', cur = null, pv = null, source = 'bot', friendId = '', timer = null, lastSig = '', glob = null;

const THEMES = [['nuit', 'Nuit', '#66c0f4'], ['steam', 'Steam', '#1a9fff'], ['clair', 'Clair', '#f3f6fc'], ['violet', 'Violet', '#c084fc'], ['foret', 'Forêt', '#4ade80'], ['braise', 'Braise', '#fb923c'], ['ocean', 'Océan', '#22d3ee'], ['sakura', 'Sakura', '#f9a8d4'], ['noir', 'Noir', '#e5e7eb']];

function toast(t, bad) { const e = $('#toast'); e.textContent = t; e.className = 'show' + (bad ? ' bad' : ''); setTimeout(() => (e.className = ''), 4500); }
async function api(u, o) {
  const r = await fetch(u, o !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) } : undefined);
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}
const setTheme = (t) => { document.documentElement.dataset.theme = t; };

const FILTERS = [
  ['all', 'Tous', () => true],
  ['near', '🎯 Presque à 100 %', (s) => s.missingCount > 0 && s.missingCount <= 2],
  ['ready', '🔨 Prêts à crafter', (s) => s.missingCount === 0],
  ['new', '🆕 Nouveaux badges', (s) => s.badgeLevel === 0],
  ['progress', '📈 Badges en cours', (s) => s.badgeLevel > 0],
  ['dupes', '♻ Avec doublons', (s) => s.dupes > 0],
  ['cheap', '💶 < 0,50 €', (s) => s.cost > 0 && s.cost < 0.5],
  ['bot', '🤖 Chez le bot', (s) => s.botHas > 0],
  ['botfull', '🤖 Complet via le bot', (s) => s.missingCount > 0 && s.botHas === s.missingCount],
  ['friends', '👥 Chez des amis', (s) => s.friends.length > 0],
  ['done', '🏆 Badges terminés', null],
];

async function poll() {
  clearTimeout(timer);
  try { st = await api('/api/state'); render(); } catch (e) { $('#err').hidden = false; $('#err').textContent = '⚠ ' + e.message; }
  const busy = !st || st.progress.running || st.bot.status === 'loading' || st.friends.status === 'loading' || st.rank.status === 'loading' || ['checking', 'downloading'].includes(st.update && st.update.status);
  timer = setTimeout(poll, busy ? 1500 : 12000);
}

function render() {
  setTheme(st.theme);
  const p = st.profile, g = st.progress;
  if (p) {
    $('#avatar').src = p.avatar || ''; $('#avatar').hidden = !p.avatar; $('#name').innerHTML = `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`;
    $('#sub').textContent = `${nf(p.xp)} XP · ${p.needed - p.intoLevel} XP avant le niveau ${p.level + 1}` + (st.demo ? ' · MODE DÉMO' : '');
    $('#lvl').textContent = p.level; $('#ring').style.strokeDashoffset = 327 * (1 - p.intoLevel / p.needed);
    $('#proj').textContent = st.projection.level; $('#gain').textContent = '+' + st.projection.gainXp;
  } else $('#name').textContent = 'Lecture de ton profil Steam…';
  $('#tot').textContent = money(st.sets.reduce((t, s) => t + s.cost, 0), st.currency);
  $('#kcred').hidden = st.credits.balance == null; if (st.credits.balance != null) $('#cred').textContent = nf(st.credits.balance);

  $('#status').hidden = !(g.running || g.refreshing);
  if (g.running || g.refreshing) {
    $('#stt').textContent = g.wait ? `Steam demande de ralentir : reprise dans ${g.wait} s (rien n'est perdu)…`
      : g.running ? `${g.phase}${g.total ? ` — ${g.done}/${g.total} jeux` : ''}` : 'Mise à jour des prix en arrière-plan…';
    $('#stbar').style.width = (g.running ? (g.total ? (100 * g.done) / g.total : 5) : 100) + '%';
    $('#sts').textContent = g.running && g.total ? (g.fetchLeft ? `${g.fetchLeft} jeu(x) à récupérer chez Steam (~${g.etaMin} min) — les autres viennent de la mémoire` : 'Tout vient de la mémoire : instantané') : '';
  }
  $('#err').hidden = !g.error; if (g.error) $('#err').textContent = '⚠ ' + g.error;
  $('#botst').textContent = { idle: 'pas chargé', loading: 'chargement…', error: '⚠ ' + (st.bot.error || ''), ready: `✔ ${nf(st.bot.count)} cartes · ${nf(st.bot.games)} jeux${st.bot.botOnly ? ' · scan limité à ses jeux' : ''}` }[st.bot.status];
  $('#frst').textContent = st.friends.status === 'loading' ? `analyse ${st.friends.done}/${st.friends.total}…`
    : st.friends.status === 'ready' ? `✔ ${st.friends.count} amis analysés` : st.friends.status === 'error' ? '⚠ ' + st.friends.error : 'non analysés';
  $('#nboost').textContent = st.boosters.reduce((t, b) => t + b.count, 0) || '';
  const u = st.update, upd = $('#upd'); upd.hidden = !(u && ['available', 'downloading', 'ready'].includes(u.status));
  if (!upd.hidden) upd.textContent = u.status === 'ready' ? '↻ Redémarrer pour mettre à jour' : u.status === 'downloading' ? `⬇ Téléchargement ${u.progress}%` : '⬇ Mise à jour disponible';
  $('#meta').textContent = st.updatedAt ? `Analyse du ${new Date(st.updatedAt).toLocaleString('fr-FR')} · prix gardés en mémoire, rafraîchis en arrière-plan` : '';
  $('#chips').innerHTML = FILTERS.map(([k, label, fn]) => {
    const n = k === 'done' ? st.completed.length : st.sets.filter(fn).length;
    return `<button class="chip ${k === filter ? 'on' : ''}" data-f="${k}">${label} <i>${n}</i></button>`;
  }).join('');
  if ($('#sdlg').open) renderUpdate();
  showView();
}

function showView() {
  document.querySelectorAll('#views button[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  $('#v-sets').hidden = view !== 'sets'; $('#v-boosters').hidden = view !== 'boosters'; $('#v-rank').hidden = view !== 'rank';
  if (view === 'sets') draw(); if (view === 'boosters') drawBoosters(); if (view === 'rank') drawRank();
}
$('#views').onclick = (e) => {
  const b = e.target.closest('button[data-v]'); if (b) { view = b.dataset.v; lastSig = ''; showView(); if (view === 'rank' && rankTab === 'global') loadGlobal(); }
  if (e.target.closest('#upd')) { const u = st.update; if (u.status === 'ready') api('/api/update/install', {}); else openSettings(); }
};

// ---------- sets ----------
function draw() {
  const q = $('#q').value.toLowerCase(), sort = $('#sort').value;
  const sig = JSON.stringify([filter, q, sort, st.currency, st.credits, st.sets.map((s) => [s.appid, s.ownedUnique, s.botHas, s.friends.length, s.cost]), st.completed.length, st.progress.running]);
  if (sig === lastSig) return; lastSig = sig;
  if (filter === 'done') {
    $('#h2').innerHTML = 'Badges terminés <small>niveau 5 — 100 %</small>';
    $('#grid').innerHTML = st.completed.filter((b) => b.name.toLowerCase().includes(q)).map((b) => `
      <article class="set done"><img class="banner" src="${esc(b.banner)}" alt="" onerror="this.remove()"><div class="body"><header><h3>${esc(b.name)}</h3><span class="pill ok">Niveau ${b.level} ✔</span></header>
      <a class="lnk" href="https://steamcommunity.com/my/gamecards/${b.appid}/" target="_blank" rel="noopener">Voir le badge ↗</a></div></article>`).join('') || '<p class="empty">Aucun badge niveau 5 pour le moment.</p>';
    return;
  }
  $('#h2').innerHTML = 'Sets à compléter <small>' + { cost: 'du moins cher au plus cher', missing: 'les plus proches de 100 %', pct: 'les plus avancés', name: 'par nom' }[sort] + '</small>';
  const fn = FILTERS.find((f) => f[0] === filter)[2];
  const by = { cost: (a, b) => a.cost - b.cost, missing: (a, b) => a.missingCount - b.missingCount || a.cost - b.cost, pct: (a, b) => b.ownedUnique / b.total - a.ownedUnique / a.total, name: (a, b) => a.name.localeCompare(b.name) }[sort];
  const list = st.sets.filter((s) => fn(s) && s.name.toLowerCase().includes(q)).sort(by);
  const bal = st.credits.balance;
  $('#grid').innerHTML = list.map((s) => `
  <article class="set"><img class="banner" src="${esc(s.banner)}" alt="" loading="lazy" onerror="this.remove()">
   <div class="body"><header><h3>${esc(s.name)}</h3><span class="pill">${s.badgeLevel ? 'Niv. ' + s.badgeLevel + ' → ' + (s.badgeLevel + 1) : 'Nouveau badge'}</span></header>
    <div class="fan">${s.cards.map((c) => `<img loading="lazy" src="${esc(c.img)}" title="${esc(c.name)} — ${esc(c.priceText || '')}${c.credits ? ' · ' + c.credits + ' crédit(s)' : ''}${c.bot ? ' · dispo chez le bot' : ''}" class="${c.owned ? '' : 'miss'}${c.bot ? ' bot' : ''}" alt="${esc(c.name)}">`).join('')}</div>
    <div class="meter"><i style="width:${(100 * s.ownedUnique) / s.total}%"></i></div>
    <div class="row"><span>${s.ownedUnique}/${s.total} cartes · ${s.dupes} doublon(s)</span><span>+100 XP</span></div>
    <div class="tags">${s.botHas ? `<span class="tag bot">🤖 ${s.botHas}/${s.missingCount} chez le bot</span>` : ''}${s.friends.length ? `<span class="tag fr">👥 ${s.friends.length} ami(s)</span>` : ''}${s.credits != null && s.missingCount ? `<span class="tag cr">💳 ${s.credits} crédit(s)${bal != null ? (bal >= s.credits ? ' ✔' : ' ✖') : ''}</span>` : ''}</div>
    <div class="row"><span class="price ${s.cost ? '' : 'free'}">${s.cost ? money(s.cost, st.currency) : 'Prêt à crafter !'}${s.stale ? ' <small title="prix en cours de rafraîchissement">~</small>' : ''}</span><a class="lnk" href="${esc(s.link)}" target="_blank" rel="noopener">Comparer sur SCE ↗</a></div>
    <button class="cta" data-app="${s.appid}">${s.cost ? '⇄ Compléter par échange' : '🔨 Crafter le badge (Steam)'}</button></div>
  </article>`).join('') || `<p class="empty">${st.progress.running ? 'Analyse en cours, les sets apparaissent ici au fur et à mesure…' : 'Aucun set ne correspond à ce filtre.'}</p>`;
}

// ---------- connexion Steam (échanges, boosters) ----------
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
  return r.status === 'ready';
}

// ---------- échange ----------
$('#grid').addEventListener('click', (e) => {
  const b = e.target.closest('.cta'); if (!b) return;
  cur = st.sets.find((s) => s.appid == b.dataset.app);
  if (!cur.cost) return window.open(`${st.profile.url.replace(/\/$/, '')}/gamecards/${cur.appid}/`, '_blank');
  $('#dt').textContent = cur.name; pv = null; $('#pv').hidden = true; $('#note').textContent = ''; $('#go').disabled = true;
  source = cur.botHas ? 'bot' : cur.friends.length ? 'friend' : 'bot'; friendId = cur.friends[0] ? cur.friends[0].steamid : '';
  setSource(source); $('#dlg').showModal();
});
function setSource(s) {
  source = s;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
  const box = $('#srcbox'); pv = null; $('#pv').hidden = true; $('#go').disabled = true;
  if (s === 'bot') box.innerHTML = `<p class="mut">${cur.botHas ? `Le bot a ${cur.botHas} de tes ${cur.missingCount} carte(s) manquante(s).` : 'Le bot n\'a aucune de tes cartes manquantes.'}</p><label class="lab">Lien d'échange du bot (si pas déjà dans les Réglages)<input id="turl" placeholder="https://steamcommunity.com/tradeoffer/new/?partner=…&token=…"></label>`;
  if (s === 'friend') box.innerHTML = cur.friends.length ? `<label class="lab">Ami<select id="fsel">${cur.friends.map((f) => `<option value="${f.steamid}" ${f.steamid === friendId ? 'selected' : ''}>${esc(f.name)} — ${f.have.length} carte(s)</option>`).join('')}</select></label>`
    : '<p class="mut">Aucun ami n\'a tes cartes manquantes (clique d\'abord sur « Scanner mes amis »).</p>';
  if (s === 'url') box.innerHTML = '<label class="lab">Lien d\'échange du partenaire<input id="turl" placeholder="https://steamcommunity.com/tradeoffer/new/?partner=…&token=…"></label>';
  if (s === 'friend' && cur.friends.length) { $('#fsel').onchange = () => { friendId = $('#fsel').value; preview(); }; friendId = $('#fsel').value; }
  if ((s === 'bot' && cur.botHas) || (s === 'friend' && cur.friends.length)) preview();
  if (st.demo && $('#turl')) $('#turl').value = 'https://steamcommunity.com/tradeoffer/new/?partner=123456&token=demo';
}
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) setSource(b.dataset.s); };
async function preview() {
  try {
    pv = await api('/api/trade/preview', { appid: cur.appid, source, friendId, tradeUrl: $('#turl') ? $('#turl').value : '' });
    const im = (l) => l.map((c) => `<img src="${esc(c.img)}" title="${esc(c.name)}" alt="${esc(c.name)}">`).join('') || '<small>–</small>';
    $('#askl').innerHTML = im(pv.ask); $('#givel').innerHTML = im(pv.give); $('#pv').hidden = false;
    $('#note').textContent = (pv.notFound ? `${pv.notFound} carte(s) manquante(s) introuvable(s) chez cette source. ` : '') + (pv.give.length < pv.ask.length ? 'Tu n\'as pas assez de cartes en trop à donner en retour.' : '');
    $('#go').disabled = !pv.ask.length;
  } catch (e) { toast(e.message, true); }
}
$('#srcbox').addEventListener('change', (e) => { if (e.target.id === 'turl') preview(); });
$('#go').onclick = async () => {
  $('#go').disabled = true;
  try {
    if (!(await ensureLogin())) { $('#go').disabled = false; return; }
    const r = await api('/api/trade/send', { source, friendId, tradeUrl: $('#turl') ? $('#turl').value : '', give: pv.give.map((c) => c.assetid), ask: pv.ask.map((c) => c.assetid) });
    toast('✅ ' + r.note); $('#dlg').close();
  } catch (e) { toast(e.message, true); $('#go').disabled = false; }
};

// ---------- boosters ----------
function drawBoosters() {
  $('#bgrid').innerHTML = st.boosters.map((b) => `
  <article class="set"><img class="banner" src="${esc(b.banner)}" alt="" onerror="this.remove()"><div class="body"><header><h3>${esc(b.game)}</h3><span class="pill">× ${b.count}</span></header>
    <div class="fan"><img src="${esc(b.img)}" alt="" style="width:96px;height:96px"></div>
    <button class="cta" data-boost="${b.appid}" data-asset="${b.assetid}">📦 Ouvrir un booster</button></div></article>`).join('') || '<p class="empty">Aucun booster dans ton inventaire.</p>';
}
$('#bgrid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-boost]'); if (!b) return;
  const bo = st.boosters.find((x) => String(x.appid) === b.dataset.boost);
  if (!confirm(`Ouvrir un booster « ${bo.game} » ? Cette action est définitive.`)) return;
  b.disabled = true;
  try {
    if (!(await ensureLogin())) { b.disabled = false; return; }
    const r = await api('/api/boosters/open', { appid: bo.appid, assetid: b.dataset.asset });
    $('#bt').textContent = `Booster ${bo.game} : tu as reçu`;
    $('#bres').innerHTML = r.cards.map((c) => `<img src="${esc(c.img)}" title="${esc(c.name)}${c.foil ? ' (foil)' : ''}" alt="${esc(c.name)}">`).join('');
    $('#bdlg').showModal(); poll();
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

// ---------- classement ----------
async function loadGlobal() { try { glob = await api('/api/rank/global'); } catch (e) { glob = { error: e.message, list: [] }; } drawRank(); }
function drawRank() {
  document.querySelectorAll('#rtabs button').forEach((b) => b.classList.toggle('on', b.dataset.r === rankTab));
  const m = $('#rmetric').value, box = $('#rbody');
  const table = (list) => `<table class="rank"><tr><th></th><th>Joueur</th><th>Niveau</th><th>Badges</th><th>Rareté</th></tr>${[...list].sort((a, b) => (b[m] || 0) - (a[m] || 0)).map((p, i) => `
    <tr class="${p.me ? 'me' : ''}"><td class="n">${['🥇', '🥈', '🥉'][i] || i + 1}</td><td><img src="${esc(p.avatar || '')}" alt="">${esc(p.name)}${p.me ? ' (toi)' : ''}</td>
    <td class="${m === 'level' || m === 'xp' ? 'hl' : ''}">${p.level}</td><td class="${m === 'badgeCount' ? 'hl' : ''}">${nf(p.badgeCount)}</td><td class="${m === 'rarity' ? 'hl' : ''}">${nf(p.rarity)}${p.rareCount != null ? ` <small class="mut">· ${p.rareCount} rares</small>` : ''}</td></tr>`).join('')}</table>`;
  if (rankTab === 'friends') {
    const r = st.rank;
    const head = `<div class="row" style="margin-bottom:12px"><span class="mut">${r.status === 'loading' ? `Analyse ${r.done}/${r.total}…` : r.status === 'error' ? '⚠ ' + esc(r.error) : r.list.length ? `${r.list.length} joueurs` : 'Pas encore analysé'}</span><button class="ghost" id="rscan">${r.list.length ? '↻ Réanalyser' : '👥 Analyser mes amis'}</button></div>`;
    box.innerHTML = head + (r.list.length ? table(r.list) : '<div class="sbox">Clique sur « Analyser mes amis » : l\'app lit le niveau et les badges publics de tes amis (leurs badges doivent être visibles).</div>');
    $('#rscan').onclick = async () => { await api('/api/rank/scan', {}); poll(); };
  } else {
    if (!glob) { box.innerHTML = '<p class="empty">Chargement…</p>'; return; }
    if (glob.missing) { box.innerHTML = '<div class="sbox">Le classement entre utilisateurs de l\'app a besoin d\'un serveur. Héberge <code>leaderboard-server</code> (voir son README), puis colle son adresse dans ⚙ Réglages.</div>'; return; }
    if (glob.error) { box.innerHTML = `<div class="errbox">${esc(glob.error)}</div>`; return; }
    const joined = st.leaderboard.joined;
    box.innerHTML = `<div class="row" style="margin-bottom:12px"><span class="mut">${glob.list.length} joueur(s)${glob.demo ? ' · données de démonstration' : ''}</span>${joined ? '<span class="tag fr">✔ Tu participes</span>' : '<button class="ghost" id="rjoin">Rejoindre le classement</button>'}</div>` + table(glob.list);
    if (!joined) $('#rjoin').onclick = async () => { if (!confirm('Ton pseudo, ton avatar, ton niveau et tes badges (publics) seront visibles par les autres utilisateurs. Continuer ?')) return; try { await api('/api/rank/join', {}); toast('Tu es dans le classement !'); await loadGlobal(); poll(); } catch (e) { toast(e.message, true); } };
  }
}
$('#rtabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { rankTab = b.dataset.r; if (rankTab === 'global') loadGlobal(); else drawRank(); } };
$('#rmetric').onchange = drawRank;

// ---------- barre d'outils ----------
$('#chips').onclick = (e) => { const b = e.target.closest('.chip'); if (b) { filter = b.dataset.f; lastSig = ''; render(); } };
$('#q').oninput = () => st && draw(); $('#sort').onchange = () => st && draw();
$('#refresh').onclick = async () => { await api('/api/refresh', {}); lastSig = ''; poll(); };
$('#botref').onclick = async () => { await api('/api/bot/refresh', {}); poll(); };
$('#frscan').onclick = async () => { await api('/api/friends/scan', {}); toast('Analyse des amis lancée (en arrière-plan)'); poll(); };

// ---------- réglages ----------
function renderUpdate() {
  const u = st.update || {}; $('#ver').textContent = st.version ? 'Version installée : ' + st.version : '';
  const b = $('#updbtn');
  b.textContent = u.status === 'ready' ? '↻ Redémarrer et installer' : u.status === 'downloading' ? `⬇ Téléchargement ${u.progress}%…` : u.status === 'checking' ? 'Recherche…' : '⬇ Mettre à jour le logiciel';
  b.disabled = ['checking', 'downloading'].includes(u.status);
  $('#updst').textContent = { none: '✔ Tu as déjà la dernière version.', available: `Version ${u.latest} trouvée, téléchargement…`, ready: `Version ${u.latest} prête : le logiciel va redémarrer.`, error: '⚠ ' + (u.error || ''), dev: 'Disponible uniquement dans le logiciel installé.' }[u.status] || '';
}
$('#updbtn').onclick = async () => {
  try {
    if (st.update && st.update.status === 'ready') return api('/api/update/install', {});
    await api('/api/update/check', {}); poll();
  } catch (e) { $('#updst').textContent = '⚠ ' + e.message; }
};
$('#themes').innerHTML = THEMES.map(([k, n, c]) => `<button class="ghost sw" data-t="${k}"><i style="background:${c}"></i>${n}</button>`).join('');
$('#themes').onclick = async (e) => { const b = e.target.closest('[data-t]'); if (!b) return; setTheme(b.dataset.t); st.theme = b.dataset.t; await api('/api/settings', { THEME: b.dataset.t }); markTheme(); };
const markTheme = () => document.querySelectorAll('.sw').forEach((b) => b.classList.toggle('on', b.dataset.t === document.documentElement.dataset.theme));

async function openSettings() {
  const c = await api('/api/settings');
  $('#s_profile').value = c.STEAM_PROFILE; $('#s_key').value = c.STEAM_API_KEY; $('#s_cur').value = c.CURRENCY || '3'; $('#s_acc').value = c.STEAM_ACCOUNT;
  $('#s_bot').value = c.BOT_PROFILE; $('#s_boturl').value = c.BOT_TRADE_URL; $('#s_botonly').checked = c.BOT_ONLY !== '0';
  $('#s_cbal').value = c.CREDITS_BALANCE; $('#s_cpc').value = c.CREDITS_PER_CARD; $('#s_lb').value = c.LEADERBOARD_URL;
  for (const [id, k] of [['s_pwd', 'STEAM_PASSWORD'], ['s_shared', 'STEAM_SHARED_SECRET'], ['s_ident', 'STEAM_IDENTITY_SECRET']]) { $('#' + id).value = ''; $('#' + id).placeholder = c[k + '_SET'] ? '••••••• (enregistré)' : ''; }
  markTheme(); renderUpdate(); $('#sdlg').showModal();
}
$('#ssave').onclick = async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', { STEAM_PROFILE: $('#s_profile').value, STEAM_API_KEY: $('#s_key').value, CURRENCY: $('#s_cur').value, STEAM_ACCOUNT: $('#s_acc').value, BOT_PROFILE: $('#s_bot').value, BOT_TRADE_URL: $('#s_boturl').value,
      BOT_ONLY: $('#s_botonly').checked ? '1' : '0', CREDITS_BALANCE: $('#s_cbal').value.replace(',', '.'), CREDITS_PER_CARD: $('#s_cpc').value.replace(',', '.'), LEADERBOARD_URL: $('#s_lb').value,
      STEAM_PASSWORD: $('#s_pwd').value, STEAM_SHARED_SECRET: $('#s_shared').value, STEAM_IDENTITY_SECRET: $('#s_ident').value });
    $('#sdlg').close(); toast('Réglages enregistrés'); lastSig = ''; glob = null; poll();
  } catch (err) { toast(err.message, true); }
};
// bouton ⚙ ajouté dans la barre d'onglets
const cfgBtn = document.createElement('button'); cfgBtn.id = 'cfg'; cfgBtn.className = 'ghost'; cfgBtn.textContent = '⚙ Réglages'; $('#views').appendChild(cfgBtn); cfgBtn.onclick = openSettings;

poll().then(() => { if (st && st.demo && !st.seenSetup) { api('/api/settings', { SEEN_SETUP: '1' }); openSettings(); } });
