const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n, c) => n.toLocaleString('fr-FR', { style: 'currency', currency: c === 1 ? 'USD' : c === 2 ? 'GBP' : 'EUR' });
let st = null, filter = 'all', cur = null, pv = null, source = 'bot', friendId = '', timer = null, lastSig = '';

function toast(t, bad) { const e = $('#toast'); e.textContent = t; e.className = 'show' + (bad ? ' bad' : ''); setTimeout(() => (e.className = ''), 4200); }
async function api(u, o) {
  const r = await fetch(u, o !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) } : undefined);
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}

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
  const busy = !st || st.progress.running || st.bot.status === 'loading' || st.friends.status === 'loading';
  timer = setTimeout(poll, busy ? 1500 : 12000);
}

function render() {
  const p = st.profile, g = st.progress;
  if (p) {
    $('#avatar').src = p.avatar || ''; $('#avatar').hidden = !p.avatar; $('#name').innerHTML = `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`;
    $('#sub').textContent = `${p.xp.toLocaleString('fr-FR')} XP · ${p.needed - p.intoLevel} XP avant le niveau ${p.level + 1}` + (st.demo ? ' · MODE DÉMO' : '');
    $('#lvl').textContent = p.level; $('#ring').style.strokeDashoffset = 327 * (1 - p.intoLevel / p.needed);
    $('#proj').textContent = st.projection.level; $('#gain').textContent = '+' + st.projection.gainXp;
  } else $('#name').textContent = 'Lecture de ton profil Steam…';
  $('#tot').textContent = money(st.sets.reduce((t, s) => t + s.cost, 0), st.currency);

  // progression + erreurs (les résultats déjà trouvés restent affichés)
  $('#status').hidden = !g.running;
  if (g.running) {
    $('#stt').textContent = g.wait ? `Steam demande de ralentir : reprise dans ${g.wait} s (rien n'est perdu)…`
      : `${g.phase}${g.total ? ` — ${g.done}/${g.total} jeux` : ''}`;
    $('#stbar').style.width = (g.total ? (100 * g.done) / g.total : 5) + '%';
  }
  $('#err').hidden = !g.error; if (g.error) $('#err').textContent = '⚠ ' + g.error;
  $('#botst').textContent = { idle: 'pas chargé', loading: 'chargement…', error: '⚠ ' + (st.bot.error || ''), ready: `✔ ${st.bot.count.toLocaleString('fr-FR')} cartes` }[st.bot.status];
  $('#frst').textContent = st.friends.status === 'loading' ? `analyse ${st.friends.done}/${st.friends.total}…`
    : st.friends.status === 'ready' ? `✔ ${st.friends.count} amis analysés` : st.friends.status === 'error' ? '⚠ ' + st.friends.error : 'non analysés';

  $('#chips').innerHTML = FILTERS.map(([k, label, fn]) => {
    const n = k === 'done' ? st.completed.length : st.sets.filter(fn).length;
    return `<button class="chip ${k === filter ? 'on' : ''}" data-f="${k}">${label} <i>${n}</i></button>`;
  }).join('');
  draw();
}

function draw() {
  const q = $('#q').value.toLowerCase(), sort = $('#sort').value;
  const sig = JSON.stringify([filter, q, sort, st.sets.map((s) => [s.appid, s.ownedUnique, s.botHas, s.friends.length]), st.completed.length]);
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
  $('#grid').innerHTML = list.map((s) => `
  <article class="set"><img class="banner" src="${esc(s.banner)}" alt="" loading="lazy" onerror="this.remove()">
   <div class="body"><header><h3>${esc(s.name)}</h3><span class="pill">${s.badgeLevel ? 'Niv. ' + s.badgeLevel + ' → ' + (s.badgeLevel + 1) : 'Nouveau badge'}</span></header>
    <div class="fan">${s.cards.map((c) => `<img loading="lazy" src="${esc(c.img)}" title="${esc(c.name)} — ${esc(c.priceText || '')}${c.bot ? ' · dispo chez le bot' : ''}" class="${c.owned ? '' : 'miss'}${c.bot ? ' bot' : ''}" alt="${esc(c.name)}">`).join('')}</div>
    <div class="meter"><i style="width:${(100 * s.ownedUnique) / s.total}%"></i></div>
    <div class="row"><span>${s.ownedUnique}/${s.total} cartes · ${s.dupes} doublon(s)</span><span>+100 XP</span></div>
    <div class="tags">${s.botHas ? `<span class="tag bot">🤖 ${s.botHas}/${s.missingCount} chez le bot</span>` : ''}${s.friends.length ? `<span class="tag fr">👥 ${s.friends.length} ami(s)</span>` : ''}</div>
    <div class="row"><span class="price ${s.cost ? '' : 'free'}">${s.cost ? money(s.cost, st.currency) : 'Prêt à crafter !'}</span><a class="lnk" href="${esc(s.link)}" target="_blank" rel="noopener">Comparer sur SCE ↗</a></div>
    <button class="cta" data-app="${s.appid}">${s.cost ? '⇄ Compléter par échange' : '🔨 Crafter le badge (Steam)'}</button></div>
  </article>`).join('') || `<p class="empty">${st.progress.running ? 'Analyse en cours, les sets apparaissent ici au fur et à mesure…' : 'Aucun set ne correspond à ce filtre.'}</p>`;
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
  if (s === 'bot' && cur.botHas) preview(); if (s === 'friend' && cur.friends.length) preview();
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
    const l = await api('/api/trade/login', {});
    if (l.status === 'guard') { $('#guard').hidden = false; $('#note').textContent = 'Entre ton code Steam Guard puis relance.'; $('#go').disabled = false; return; }
    const r = await api('/api/trade/send', { source, friendId, tradeUrl: $('#turl') ? $('#turl').value : '', give: pv.give.map((c) => c.assetid), ask: pv.ask.map((c) => c.assetid) });
    toast('✅ ' + r.note); $('#dlg').close();
  } catch (e) { toast(e.message, true); $('#go').disabled = false; }
};
$('#gok').onclick = async () => { try { const r = await api('/api/trade/login', { code: $('#gcode').value }); if (r.status === 'ready') { $('#guard').hidden = true; toast('Connecté à Steam'); } } catch (e) { toast(e.message, true); } };

// ---------- barre d'outils ----------
$('#chips').onclick = (e) => { const b = e.target.closest('.chip'); if (b) { filter = b.dataset.f; lastSig = ''; render(); } };
$('#q').oninput = () => st && draw(); $('#sort').onchange = () => st && draw();
$('#refresh').onclick = async () => { await api('/api/refresh', {}); lastSig = ''; poll(); };
$('#botref').onclick = async () => { await api('/api/bot/refresh', {}); poll(); };
$('#frscan').onclick = async () => { await api('/api/friends/scan', {}); toast('Analyse des amis lancée (elle tourne en arrière-plan)'); poll(); };

async function openSettings() {
  const c = await api('/api/settings');
  $('#s_profile').value = c.STEAM_PROFILE; $('#s_key').value = c.STEAM_API_KEY; $('#s_cur').value = c.CURRENCY || '3'; $('#s_acc').value = c.STEAM_ACCOUNT;
  $('#s_bot').value = c.BOT_PROFILE; $('#s_boturl').value = c.BOT_TRADE_URL;
  for (const [id, k] of [['s_pwd', 'STEAM_PASSWORD'], ['s_shared', 'STEAM_SHARED_SECRET'], ['s_ident', 'STEAM_IDENTITY_SECRET']]) { $('#' + id).value = ''; $('#' + id).placeholder = c[k + '_SET'] ? '••••••• (enregistré)' : ''; }
  $('#sdlg').showModal();
}
$('#cfg').onclick = openSettings;
$('#ssave').onclick = async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', { STEAM_PROFILE: $('#s_profile').value, STEAM_API_KEY: $('#s_key').value, CURRENCY: $('#s_cur').value, STEAM_ACCOUNT: $('#s_acc').value, BOT_PROFILE: $('#s_bot').value, BOT_TRADE_URL: $('#s_boturl').value,
      STEAM_PASSWORD: $('#s_pwd').value, STEAM_SHARED_SECRET: $('#s_shared').value, STEAM_IDENTITY_SECRET: $('#s_ident').value });
    $('#sdlg').close(); toast('Réglages enregistrés'); lastSig = ''; poll();
  } catch (e) { toast(e.message, true); }
};
poll().then(() => { if (st && st.demo) { try { if (!localStorage.seen) { localStorage.seen = 1; openSettings(); } } catch {} } });
