const $ = (s) => document.querySelector(s);
const money = (n, c) => n.toLocaleString('fr-FR', { style: 'currency', currency: c === 1 ? 'USD' : 'EUR' });
let data, cur, pv;

function toast(t, bad) { const e = $('#toast'); e.textContent = t; e.className = 'show' + (bad ? ' bad' : ''); setTimeout(() => (e.className = ''), 4200); }
async function api(u, o) { const r = await fetch(u, o && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; }

async function load(refresh) {
  $('#load').hidden = false; $('#err').hidden = true; $('#grid').innerHTML = '';
  const poll = setInterval(async () => { try { const p = await api('/api/progress'); if (p.busy) $('#loadt').textContent = `Analyse des sets… ${p.done}/${p.total}`; } catch {} }, 1500);
  try { data = await api('/api/overview' + (refresh ? '?refresh=1' : '')); render(); }
  catch (e) { $('#err').hidden = false; $('#err').textContent = '⚠ ' + e.message; }
  clearInterval(poll); $('#load').hidden = true;
}

function render() {
  const p = data.profile;
  $('#avatar').src = p.avatar; $('#name').textContent = p.name;
  $('#sub').textContent = `${p.xp.toLocaleString('fr-FR')} XP · ${p.needed - p.intoLevel} XP avant le niveau ${p.level + 1}` + (data.demo ? ' · MODE DÉMO' : '');
  $('#lvl').textContent = p.level; $('#ring').style.strokeDashoffset = 327 * (1 - p.intoLevel / p.needed);
  $('#proj').textContent = data.projection.level; $('#gain').textContent = '+' + data.projection.gainXp;
  $('#tot').textContent = money(data.sets.reduce((t, s) => t + s.cost, 0), data.currency);
  draw();
}

function draw() {
  const q = $('#q').value.toLowerCase();
  $('#grid').innerHTML = data.sets.filter((s) => s.name.toLowerCase().includes(q)).map((s) => `
  <article class="set"><header><h3>${s.name}</h3><span class="pill">${s.badgeLevel ? 'Badge niv. ' + s.badgeLevel + ' → ' + (s.badgeLevel + 1) : 'Nouveau badge'}</span></header>
    <div class="fan">${s.cards.map((c) => `<img loading="lazy" src="${c.img}" title="${c.name} — ${c.priceText || ''}" class="${c.owned ? '' : 'miss'}" alt="${c.name}">`).join('')}</div>
    <div class="meter"><i style="width:${(100 * s.ownedUnique) / s.total}%"></i></div>
    <div class="row"><span>${s.ownedUnique}/${s.total} cartes · ${s.dupes} doublon(s)</span><span>+100 XP</span></div>
    <div class="row"><span class="price ${s.cost ? '' : 'free'}">${s.cost ? money(s.cost, data.currency) : 'Prêt à crafter !'}</span><a class="lnk" href="${s.link}" target="_blank" rel="noopener">Comparer sur SCE ↗</a></div>
    <button class="cta" data-app="${s.appid}">${s.cost ? '⇄ Compléter par échange' : '🔨 Crafter le badge (Steam)'}</button>
  </article>`).join('') || '<p>Aucun set trouvé.</p>';
}

$('#grid').addEventListener('click', (e) => {
  const b = e.target.closest('.cta'); if (!b) return;
  cur = data.sets.find((s) => s.appid == b.dataset.app);
  if (!cur.cost) return window.open(`${data.profile.url.replace(/\/$/, '')}/gamecards/${cur.appid}/`, '_blank');
  $('#dt').textContent = cur.name; $('#pv').hidden = true; $('#note').textContent = ''; $('#go').disabled = true; pv = null;
  if (data.demo) $('#turl').value = 'https://steamcommunity.com/tradeoffer/new/?partner=123456&token=demo';
  $('#dlg').showModal();
});
$('#prev').onclick = async () => {
  try {
    pv = await api('/api/trade/preview', { appid: cur.appid, tradeUrl: $('#turl').value });
    const im = (l) => l.map((c) => `<img src="${c.img}" title="${c.name}" alt="${c.name}">`).join('') || '<small>–</small>';
    $('#askl').innerHTML = im(pv.ask); $('#givel').innerHTML = im(pv.give); $('#pv').hidden = false;
    $('#note').textContent = pv.notFound ? `${pv.notFound} carte(s) manquante(s) introuvable(s) chez ce partenaire.` : '';
    if (pv.give.length < pv.ask.length) $('#note').textContent += ' Tu n\'as pas assez de doublons à donner en retour.';
    $('#go').disabled = !pv.ask.length;
  } catch (e) { toast(e.message, true); }
};
$('#go').onclick = async () => {
  $('#go').disabled = true;
  try {
    const st = await api('/api/trade/login', {});
    if (st.status === 'guard') { $('#guard').hidden = false; $('#note').textContent = 'Entre ton code Steam Guard puis relance.'; $('#go').disabled = false; return; }
    const r = await api('/api/trade/send', { tradeUrl: $('#turl').value, give: pv.give.map((c) => c.assetid), ask: pv.ask.map((c) => c.assetid) });
    toast('✅ ' + r.note); $('#dlg').close();
  } catch (e) { toast(e.message, true); $('#go').disabled = false; }
};
$('#gok').onclick = async () => {
  try { const r = await api('/api/trade/login', { code: $('#gcode').value }); if (r.status === 'ready') { $('#guard').hidden = true; toast('Connecté à Steam'); } } catch (e) { toast(e.message, true); }
};
$('#q').oninput = () => data && draw();
$('#refresh').onclick = () => load(true);
load();
