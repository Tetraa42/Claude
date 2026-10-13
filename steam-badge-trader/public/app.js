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

const THEMES = [['nuit', 'Nuit', '#66c0f4'], ['steam', 'Steam', '#1a9fff'], ['clair', 'Clair', '#f3f6fc'], ['violet', 'Violet', '#c084fc'], ['foret', 'Forêt', '#4ade80'], ['braise', 'Braise', '#fb923c'], ['ocean', 'Océan', '#22d3ee'], ['sakura', 'Sakura', '#f9a8d4'], ['noir', 'Noir', '#e5e7eb'],
  ['crt', 'Écran CRT (console)', 'linear-gradient(135deg,#020b04,#39ff6a)'], ['ambre', 'Ordi ambre 80s', 'linear-gradient(135deg,#110900,#ffb000)'], ['neon', 'Néon', 'linear-gradient(135deg,#ff2bd6,#00f0ff)'], ['cyberpunk', 'Cyberpunk', 'linear-gradient(135deg,#fcee0a,#00e5ff)'],
  ['steampunk', 'Steampunk', 'linear-gradient(135deg,#b4622d,#d09a45)'], ['synthwave', 'Synthwave', 'linear-gradient(135deg,#ff4fd8,#ffb347)'], ['gameboy', 'Game Boy', 'linear-gradient(135deg,#0f380f,#9bbc0f)'], ['vaporwave', 'Vaporwave', 'linear-gradient(135deg,#ff9ff3,#7df9ff)'],
  ['parchemin', 'Parchemin', 'linear-gradient(135deg,#efe1c3,#9a5b13)'], ['arcade', 'Arcade', 'linear-gradient(135deg,#ffe600,#ff3b30)']];
const FILTERS = [
  ['all', 'Tous', () => true],
  ['near', '🎯 Presque à 100 %', (s) => s.missingCount > 0 && s.missingCount <= 2],
  ['ready', '🔨 Prêts à crafter', (s) => s.missingCount === 0],
  ['new', '🆕 Nouveaux badges', (s) => s.badgeLevel === 0],
  ['progress', '📈 Badges en cours', (s) => s.badgeLevel > 0],
  ['dupes', '♻ Avec doublons', (s) => s.dupes > 0],
  ['cheap', '💶 < 0,50 €', (s) => s.cost != null && s.cost > 0 && s.cost < 0.5],
  ['bot', '🤖 En stock chez le bot', (s) => s.botStock > 0],
  ['friends', '👥 Chez des amis', (s) => s.friends.length > 0],
  ['botfull', '🤖 Set complet dispo', (s) => s.botSets > 0],
  ['drops', '🎴 À récupérer en jouant', (s) => s.drops > 0],
  ['done', '🏆 Badges terminés', null],
  ['allbadges', '🏅 Tous mes badges', null],
];

const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
function toast(t, bad) { const e = $('#toast'); e.textContent = t; e.className = 'show' + (bad ? ' bad' : ''); setTimeout(() => (e.className = ''), 4500); }
async function api(u, o, signal) {
  const r = await fetch(u, o !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o), signal } : { signal });
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
  ['prices', '💱', 'Prix du site', 'Lire les prix d\'achat et de rachat des cartes que j\'ai sur SteamCardExchange'],
  ['friends', '👥', 'Amis', 'Lire les inventaires de mes amis (cartes qu\'ils ont pour toi)'],
  ['balance', '💳', 'Solde de crédits', 'Lire mon solde sur SteamCardExchange'],
];
const fmtEta = (s) => (s == null ? '' : s < 90 ? `~${Math.max(1, Math.round(s))} s` : `~${Math.ceil(s / 60)} min`);
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'à l\'instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`; };
function friendsInfo() {
  const f = st.friends, x = f.stats;
  if (!x) return `${f.count} ami(s)`;
  return `${f.count} ami(s) · ${x.withCards} ont des cartes pour toi (${x.cards})${x.private ? ` · ${x.private} inventaire(s) privé(s)` : ''}${x.errors ? ` · ${x.errors} erreur(s)` : ''}`;
}
function taskInfo(k) {
  const t = st.tasks[k], g = st.progress;
  if (t.state === 'running') return `${t.label || 'En cours'}${k === 'cards' && g.wait ? ` · attente Steam ${g.wait} s` : ''}${t.eta ? ' · ' + fmtEta(t.eta) + ' restantes' : ''}`;
  if (t.state === 'error') return '⚠ ' + t.error;
  if (t.stopped) return '■ Arrêté — clique pour relancer';
  if (!t.doneAt) return 'Pas encore scanné — clique pour lancer';
  const n = { badges: `${st.completed.length} badge(s) terminé(s)${st.dropsTotal ? ` · 🎴 ${st.dropsTotal} à récupérer` : ''}`, cards: `${st.sets.length} jeu(x)`, boosters: `${st.boosters.reduce((a, b) => a + b.count, 0)} booster(s)`,
    gems: `${nf(st.gems.gems + st.gems.sacks * 1000)} gemme(s)`, bot: `${nf(st.bot.games)} jeux en stock`, friends: friendsInfo(), prices: 'prix lus pour tes jeux', balance: `${st.credits.balance ?? '?'} crédit(s)`, verify: `${st.ready.conds.find((c) => c.key === 'verify').label}` }[k];
  return `✔ ${ago(t.doneAt)} · ${n}`;
}
function renderScans() {
  const box = $('#scans');
  if (!box.children.length) {
    box.innerHTML = SCANS.map(([k, ic, name, tip]) => `<div class="scan" role="button" tabindex="0" data-scan="${k}" title="${esc(tip)}"><span class="fill"></span><span class="t"><b>${ic} ${name}</b><small></small></span><span class="pc"></span><button class="stop" data-stop="${k}" title="Arrêter ce scan" aria-label="Arrêter">■</button></div>`).join('');
  }
  for (const [k] of SCANS) {
    const b = box.querySelector(`[data-scan="${k}"]`), t = st.tasks[k];
    b.className = 'scan ' + t.state; b.style.setProperty('--p', t.pct + '%');
    b.querySelector('small').textContent = taskInfo(k); b.querySelector('small').title = taskInfo(k);
    b.querySelector('.pc').textContent = t.state === 'running' ? t.pct + '%' : t.state === 'done' ? '↻' : t.state === 'error' ? '⟳' : '▶';
    b.dataset.state = t.state;
  }
}
$('#scans').addEventListener('click', safe(async (e) => {
  const stop = e.target.closest('[data-stop]');
  if (stop) { await api(`/api/scan/${stop.dataset.stop}/cancel`, {}); toast('Scan arrêté'); return poll(); }
  const b = e.target.closest('[data-scan]'); if (!b) return;
  const k = b.dataset.scan;
  if (b.dataset.state === 'running') return; // déjà en cours : le bouton ■ permet de l'arrêter
  startScan(k);
}));
async function startScan(k) {
  if (k === 'balance' && !st.demo && !st.credits.sce.connected && st.credits.balance == null) return openSettings();
  if (st.tasks[k] && st.tasks[k].state === 'running') return;
  await api('/api/scan/' + k, {}); poll();
}
// ---------- bouton « prêt à échanger » : rouge → orange → vert, avec ce qu'il reste à faire ----------
function renderReady() {
  const r = st.ready, box = $('#ready'); if (!r) return;
  const sig = JSON.stringify([r.level, r.pct, r.conds.map((c) => c.ok + c.label + c.pct), Object.values(st.tasks).map((t) => t.state + t.pct)]); if (box._sig === sig) return; box._sig = sig;
  box.className = 'ready ' + r.level; box.style.setProperty('--p', r.pct + '%');
  const sub = r.level === 'green' ? 'Tout est vérifié : clique pour préparer tes échanges' : r.level === 'orange' ? 'Presque prêt : clique pour terminer et préparer tes échanges' : 'Pas encore prêt : clique, l\'app prépare tout';
  const todo = r.conds.filter((c) => !c.ok);
  box.innerHTML = `<div class="rhead"><span class="rbadge"><i></i><b>🤖 MODE AUTO</b></span><span class="rpc">${r.pct} %</span></div><div class="rsub">${sub}</div>
    <div class="rbar"><i></i></div>
    ${todo.length ? `<div class="rtodo"><small>Il manque :</small>${todo.map((c) => { const t = st.tasks[c.key]; const on = t && t.state === 'running'; return `<button class="rbtn ${on ? 'run' : ''}" data-do="${c.key}" title="${on ? 'En cours…' : 'Lancer'}">${on ? '⏳' : '▶'} ${esc(c.label)}${on ? ` · ${t.pct}%` : c.pct > 0 && c.pct < 100 ? ` · ${c.pct}%` : ''}</button>`; }).join('')}</div>` : ''}`;
}
$('#ready').addEventListener('click', safe(async (e) => {
  const b = e.target.closest('[data-do]'); if (b) return startScan(b.dataset.do);
  openAuto();
}));
$('#ready').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAuto(); } });
// menu déroulant (scans et actions)
const menu = $('#menu'), menuBtn = $('#menubtn');
const setMenu = (on) => { menu.hidden = !on; menuBtn.setAttribute('aria-expanded', on); menuBtn.textContent = on ? '☰ Menu ▴' : '☰ Menu ▾'; };
menuBtn.onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.menuwrap')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) setMenu(false); });

// ---------- liste de souhaits ----------
function drawWish() {
  const w = st.wishlist || [], al = st.alerts || [], box = $('#wbody');
  const sig = JSON.stringify([w, al]); if (box._sig === sig) return;
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // on ne redessine pas pendant la saisie d'un prix
  box._sig = sig;
  const cards = w.length ? `<div class="flist">${w.map((x) => `<div class="frow ${x.available ? 'hit' : ''}"><img src="${esc(x.img)}" alt=""><div class="grow"><b>${esc(x.name)}</b> <small class="mut">· ${esc(x.game)}</small><br><small>${x.owned ? '✔ tu l\'as déjà' : x.available ? '🔔 ' + [x.bot && x.bot.stock > 0 ? `le bot l'a (${x.bot.stock} en stock${x.bot.price != null ? ', ' + x.bot.price + ' cr' : ''})` : '', x.friends.length ? `chez ${x.friends.map((f) => esc(f.name)).join(', ')}` : '', x.priceHit ? `prix atteint : ${money(x.price)}` : ''].filter(Boolean).join(' · ') : x.botChecked ? 'pas disponible pour le moment (vérifié)' : 'pas encore vérifié'}${x.price != null ? ` · marché ${money(x.price)}` : ''}</small><br><small class="cost" title="Coût d'achat de la carte chez le bot SteamCardExchange">🤖 coût : <b>${x.bot && x.bot.price != null ? x.bot.price + ' cr' : '? cr <span class="mut">(vérifie le jeu)</span>'}</b>${x.worth != null ? ` · le site la rachète ${x.worth} cr` : ''}</small></div>
      <label class="tgt" title="M'avertir quand cette carte coûte moins que ce prix sur le marché">🔔 ≤ <input data-target="${esc(x.hash)}" inputmode="decimal" placeholder="prix" value="${esc(x.target || '')}"></label>
      ${x.bot && x.bot.stock > 0 ? `<a class="ghost sm" href="${esc(x.url)}" target="_blank" rel="noopener">Ouvrir chez le bot ↗</a>` : ''}<button class="ghost sm" data-unwish="${esc(x.hash)}">Retirer</button></div>`).join('')}</div>`
    : '<div class="sbox">Aucune carte surveillée. Ouvre un jeu et clique sur l\'étoile ☆ d\'une carte manquante : l\'app te prévient dès que le bot (ou un ami) l\'a, ou quand son prix passe sous le seuil que tu fixes.</div>';
  const sets = al.length ? `<h3 style="margin:18px 0 8px">🔔 Alertes de prix de sets</h3><div class="flist">${al.map((a) => `<div class="frow ${a.hit ? 'hit' : ''}"><div class="grow"><b>${esc(a.name)}</b><br><small>${a.hit ? '🔔 prix atteint : ' : 'coût actuel : '}${a.cost != null ? money(a.cost) : '–'} · seuil ${money(a.target)}</small></div><button class="ghost sm" data-unalert="${a.appid}">Retirer</button></div>`).join('')}</div>` : '';
  box.innerHTML = cards + sets;
}
$('#wbody').addEventListener('click', safe(async (e) => {
  const b = e.target.closest('[data-unwish]'); if (b) { await api('/api/wish/remove', { hash: b.dataset.unwish }); poll(); }
  const u = e.target.closest('[data-unalert]'); if (u) { await api('/api/alert/set', { appid: u.dataset.unalert, target: 0 }); poll(); }
}));
$('#wbody').addEventListener('change', safe(async (e) => { const t = e.target.closest('[data-target]'); if (t) { await api('/api/wish/target', { hash: t.dataset.target, target: t.value }); toast(t.value ? `🔔 Alerte à ${t.value}` : 'Alerte retirée'); poll(); } }));
$('#wcheck').onclick = safe(async () => { await api('/api/wish/check', {}); await poll(); toast('Liste de souhaits revérifiée'); });
// ---------- progrès : historique et rythme ----------
function lineChart(pts, key, color, fmt = (v) => nf(Math.round(v))) {
  const d = pts.filter((p) => p[key] != null); if (d.length < 2) return '<p class="mut small">Pas encore assez de données.</p>';
  const W = 560, H = 150, P = 8, t0 = d[0].t, t1 = d[d.length - 1].t || t0 + 1, vals = d.map((p) => p[key]);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const X = (t) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P), Y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const path = d.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join('');
  const last = d[d.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" class="lc" role="img"><path d="${path} L${X(last.t).toFixed(1)},${H - P} L${P},${H - P}Z" fill="${color}" opacity=".12"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${X(last.t).toFixed(1)}" cy="${Y(last[key]).toFixed(1)}" r="4" fill="${color}"/></svg>
    <div class="lcax"><span>${fmt(lo)}</span><span>${new Date(t0).toLocaleDateString('fr-FR')} → ${new Date(t1).toLocaleDateString('fr-FR')}</span><span>${fmt(hi)}</span></div>`;
}
const dayWord = (ms) => { const d = Math.ceil((ms - Date.now()) / 86400e3); return d <= 0 ? 'en cours' : d === 1 ? 'demain' : `dans ${d} jours`; };
function drawProg() {
  const h = st.history || [], pc = st.pace, box = $('#pbody');
  const sig = JSON.stringify([h.length, h[h.length - 1], pc, st.dropsList, st.events, st.profile && st.profile.level]); if (box._sig === sig) return;
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; box._sig = sig;
  let top = '<div class="sbox">L\'historique se construit à chaque scan (niveau, XP, badges, crédits, gemmes). Reviens après quelques jours pour voir ta courbe et le rythme de progression.</div>';
  if (h.length >= 2) {
    const first = h[0], last = h[h.length - 1];
    const eta = pc && pc.etaDays ? new Date(Date.now() + pc.etaDays * 86400e3).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : null;
    top = `<div class="kpis"><div class="stat"><b>${last.level}</b><small>niveau actuel (+${last.level - first.level} depuis le début)</small></div><div class="stat"><b>+${nf(last.xp - first.xp)}</b><small>XP gagnée sur la période</small></div>
    <div class="stat"><b>${pc && pc.xpPerDay ? pc.xpPerDay : '–'}</b><small>XP par jour (30 derniers jours)</small></div><div class="stat"><b>${eta || '–'}</b><small>${eta ? `niveau ${last.level + 1} estimé (dans ${pc.etaDays} j)` : 'niveau suivant : pas assez de données'}</small></div></div>
    <div class="charts"><div class="cbox"><h4>XP</h4>${lineChart(h, 'xp', 'var(--ac)')}</div><div class="cbox"><h4>Badges</h4>${lineChart(h, 'badges', '#22c55e')}</div>
    <div class="cbox"><h4>Crédits SCE</h4>${lineChart(h, 'balance', '#f59e0b', (v) => v.toFixed(1))}</div><div class="cbox"><h4>Gemmes</h4>${lineChart(h, 'gems', '#a855f7')}</div></div>`;
  }
  const lvl = st.profile ? st.profile.level : 0, goal = prefs.goal && prefs.goal > lvl ? prefs.goal : lvl + 5;
  const drops = (st.dropsList || []).slice(0, 30), dTot = (st.dropsList || []).reduce((t, x) => t + x.drops, 0);
  box.innerHTML = top + `
  <div class="cbox sec2"><h4>🎯 Objectif de niveau</h4><div class="row" style="justify-content:flex-start;gap:10px"><label class="tgt" style="font-size:14px">Niveau visé <input id="goalin" type="number" min="${lvl + 1}" value="${goal}" style="width:90px"></label><button id="goalgo" class="ghost">Calculer le plan</button></div><div id="goalout"></div></div>
  <div class="cbox sec2"><h4>🎴 À récupérer en jouant ${dTot ? `<small class="mut">— ${nf(dTot)} carte(s) dans ${(st.dropsList || []).length} jeu(x)</small>` : ''}</h4>${drops.length ? `<div class="flist">${drops.map((d) => `<div class="frow"><img src="${esc(d.banner)}" alt="" style="width:90px;height:42px;object-fit:cover;border-radius:8px" onerror="this.style.display='none'"><div class="grow"><b>${esc(d.name)}</b><br><small>${d.drops} carte(s) à obtenir</small></div><a class="ghost sm" href="steam://run/${d.appid}">▶ Lancer le jeu</a></div>`).join('')}</div>` : '<p class="mut small">Aucune carte à récupérer en jouant (ou page des badges pas encore lue).</p>'}</div>
  <div class="cbox sec2"><h4>📅 Soldes et événements Steam</h4>${(st.events || []).length ? `<div class="flist">${st.events.map((e) => `<div class="frow"><div class="grow"><b>${esc(e.name)}</b>${e.approx ? ' <small class="mut" title="Dates indicatives : vérifie-les sur Steam et supprime / ajoute au besoin">· dates indicatives</small>' : ''}<br><small>${new Date(e.startMs).toLocaleDateString('fr-FR')} → ${new Date(e.endMs).toLocaleDateString('fr-FR')} · <b>${dayWord(e.startMs)}</b></small></div><button class="ghost sm" data-evdel="${esc(e.id)}">Retirer</button></div>`).join('')}</div>` : '<p class="mut small">Aucun événement à venir.</p>'}<div style="margin-top:8px"><button class="ghost sm" id="evadd">➕ Ajouter un événement</button></div></div>`;
  $('#goalgo').onclick = safe(async () => { prefs.goal = Number($('#goalin').value); savePrefs(); await showGoal(prefs.goal); });
  if (prefs.goal && prefs.goal > lvl) showGoal(prefs.goal).catch(() => {});
}
async function showGoal(level) {
  const out = $('#goalout'); out.innerHTML = '<p class="mut small">Calcul…</p>';
  try {
    const g = await api('/api/goal?level=' + level);
    out.innerHTML = `<p style="margin:8px 0"><b>Niveau ${g.level} → ${g.target}</b> : il faut <b>${nf(g.need)} XP</b> = ${Math.ceil(g.need / 100)} badge(s) / niveau(x) de badge.<br>${g.feasible ? `Plan le moins cher : <b>${money(g.totalCost)}</b> pour ${g.steps.length} set(s).` : `⚠ Avec tes sets actuels tu n'obtiens que ${nf(g.steps.length * 100)} XP sur ${nf(g.need)} (il manque ${nf(g.missingXp)} XP : ouvre d'autres jeux, boosters, nouveaux badges).`}${g.provisional ? '<br><small class="mut">Certains prix ne sont pas encore connus : relance « Cartes & sets ».</small>' : ''}</p>
      ${g.steps.length ? `<table class="cards"><tr><th>#</th><th>Jeu</th><th>Manquantes</th><th>Coût</th><th>Cumul</th><th>XP cumulée</th></tr>${g.steps.map((x, i) => `<tr><td>${i + 1}</td><td><a class="lnk" href="#" data-goalopen="${x.appid}">${esc(x.name)}</a></td><td>${x.missing}</td><td>${x.cost ? money(x.cost) : 'Prêt à crafter'}</td><td>${money(x.cumCost)}</td><td>+${x.cumXp}</td></tr>`).join('')}</table>` : ''}`;
  } catch (e) { out.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
}
$('#pbody').addEventListener('click', safe(async (e) => {
  const o = e.target.closest('[data-goalopen]'); if (o) { e.preventDefault(); return openDetail(Number(o.dataset.goalopen)); }
  const dl = e.target.closest('[data-evdel]'); if (dl) { await api('/api/event/remove', { id: dl.dataset.evdel }); $('#pbody')._sig = ''; return poll(); }
  if (e.target.closest('#evadd')) {
    const name = prompt('Nom de l\'événement :'); if (!name) return;
    const start = prompt('Début (AAAA-MM-JJ) :'); if (!start) return; const end = prompt('Fin (AAAA-MM-JJ) :', start); if (!end) return;
    await api('/api/event/add', { name, start, end }); $('#pbody')._sig = ''; poll();
  }
}));
async function drawDeals() {
  const box = $('#dbody'); box.innerHTML = '<p class="mut">Calcul…</p>';
  try {
    const d = await api('/api/deals'), cv = d.creditValue;
    box.innerHTML = `${cv ? `<p class="mut small">1 crédit = ${money(cv)} (réglable dans ⚙ Réglages).</p>` : '<p class="mut small">💡 Indique la valeur d\'un crédit dans ⚙ Réglages pour voir le gain net et quelle voie est la moins chère.</p>'}
    <h3 style="margin:10px 0 8px">Cartes à acheter sur le marché pour les revendre au bot</h3>
    ${d.cards.length ? `<table class="cards"><tr><th>Carte</th><th>Jeu</th><th>Prix marché</th><th>Le bot donne</th><th>Crédits / ${st.currency === 3 ? '€' : st.currency === 2 ? '£' : '$'}</th>${cv ? '<th>Gain net</th>' : ''}</tr>${d.cards.map((c) => `<tr><td><img src="${esc(c.img)}" alt="" loading="lazy"> ${esc(c.name)}</td><td>${esc(c.game)}</td><td>${esc(c.priceText || money(c.price))}</td><td>${c.worth} cr</td><td><b>${c.ratio}</b></td>${cv ? `<td class="${c.net > 0 ? 'ok' : 'mut'}">${c.net > 0 ? '+' : ''}${money(c.net)}</td>` : ''}</tr>`).join('')}</table>` : '<div class="sbox">Pas encore de données : lance « Cartes & sets » et « Bot (SCE) ».</div>'}
    <h3 style="margin:22px 0 8px">Compléter un set : marché Steam ou bot ?</h3>
    ${d.sets.length ? `<table class="cards"><tr><th>Jeu</th><th>Manquantes</th><th>Marché Steam</th><th>Chez le bot</th>${cv ? '<th>Le moins cher</th>' : ''}</tr>${d.sets.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.missing}</td><td>${money(x.market)}</td><td>${x.bot} cr${cv ? ` (≈ ${money(x.botEuro)})` : ''}</td>${cv ? `<td>${x.cheaper === 'bot' ? '🤖 bot' : '🛒 marché'}</td>` : ''}</tr>`).join('')}</table>` : '<div class="sbox">Lance « ✅ Vérifier les jeux » : l\'app compare alors les sets que le bot peut compléter en entier.</div>'}
    <div id="spare"></div><div id="rare"></div>`;
    drawSpare(); drawRare();
  } catch (e) { box.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
}
async function drawSpare() {
  const box = $('#spare'); if (!box) return;
  try {
    const d = await api('/api/spare'), t = d.target;
    box.innerHTML = `<h3 style="margin:22px 0 8px">♻ Doublons à revendre au bot</h3>
      ${t ? `<div class="sbox"><b>Prochain set à financer : ${esc(t.name)}</b> (${t.total} cr). Solde : ${t.balance} cr${t.shortfall ? ` → il te manque <b>${t.shortfall} cr</b>.<br>${t.covered ? `Revends ces cartes au bot (${t.sell.length}) : ${t.sell.map((c) => `${esc(c.name)} <small class="mut">(${esc(c.game)}, +${c.worth})</small>`).join(' · ')}` : '⚠ Même en revendant tous tes doublons, ça ne suffit pas.'}` : ' → <b>ton solde suffit</b>.'} <a class="ghost sm" href="${esc(t.url)}" target="_blank" rel="noopener">Ouvrir ${esc(t.name)} chez le bot ↗</a> <a class="ghost sm" href="${esc(d.home)}" target="_blank" rel="noopener">Inventaire du bot ↗</a></div>` : '<p class="mut small">Lance « ✅ Vérifier les jeux » pour savoir quel set financer.</p>'}
      ${d.groups.length ? `<p class="mut small">${d.groups.reduce((n, g) => n + g.count, 0)} carte(s) en trop, valeur totale ≈ <b>${d.totalValue} cr</b>.</p><div class="mini big">${d.groups.slice(0, 40).map((g) => `<img src="${esc(g.img)}" title="${esc(g.name)} × ${g.count} — ${esc(g.game)} (${g.total} cr)" alt="">`).join('')}</div>` : '<p class="mut small">Aucun doublon pour le moment.</p>'}`;
  } catch (e) { box.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
}
async function drawRare() {
  const box = $('#rare'); if (!box) return;
  try {
    const d = await api('/api/rare');
    box.innerHTML = `<h3 style="margin:22px 0 8px">💎 Badges rares à viser</h3><p class="mut small">Badges que tes amis possèdent et pas toi, du plus rare au moins rare (points de rareté ≈ 7 − log₁₀ du nombre de détenteurs).</p>
      <table class="cards"><tr><th>Jeu</th><th>Détenteurs</th><th>Points</th><th>Ton avancement</th></tr>${d.list.map((x) => `<tr><td>${esc(x.name)}</td><td>${nf(x.scarcity)}</td><td><b>${x.points}</b></td><td>${x.progress ? `${x.progress.owned}/${x.progress.total} cartes${x.progress.cost != null ? ` · ${x.progress.cost ? money(x.progress.cost) : 'prêt à crafter'}` : ''}` : '<span class="mut">pas de carte</span>'}</td></tr>`).join('')}</table>`;
  } catch (e) { box.innerHTML = `<h3 style="margin:22px 0 8px">💎 Badges rares à viser</h3><div class="sbox">${esc(e.message)}</div>`; }
}
$('#dreload').onclick = () => drawDeals();
// ---------- amis : qui a besoin de mes doubles (un menu déroulant par ami, tuiles comme la page des badges) ----------
let fSig = '', FR = [];
const fcard = (c) => `<span class="fc2 ${c.canGive ? 'give' : c.iNeed ? 'need' : c.friendHas ? 'has' : 'lack'}" title="${esc(c.name)} — ${c.canGive ? 'tu peux la lui donner' : c.iNeed ? 'il l\'a et elle te manque' : c.friendHas ? 'il l\'a déjà' : 'il ne l\'a pas'}"><img loading="lazy" src="${esc(c.img)}" alt="${esc(c.name)}"></span>`;
async function drawFriends() {
  const box = $('#fbody');
  try {
    const d = await api('/api/friends/needs'), sig = JSON.stringify([d, st.friends.status]); if (sig === fSig) return; fSig = sig; $('#fdiag')._d = d.diag; FR = d.friends;
    const open = new Set([...box.querySelectorAll('details[open]')].map((x) => x.dataset.f));
    const head = `<p class="mut small">${d.hasAll ? `${d.total} ami(s) · ${friendsInfo()}${d.age ? ' · lu ' + ago(d.age) : ''}` : 'Pas encore lu : clique sur « Lire les inventaires des amis ».'}${st.friends.status === 'loading' ? ' · ⏳ lecture en cours…' : ''}</p>
      <div class="legend"><span class="lg give">🎁 tu peux la lui donner</span><span class="lg need">⭐ il l'a et elle te manque</span><span class="lg has">il l'a déjà</span><span class="lg lack">il ne l'a pas</span></div>`;
    if (!d.hasAll) { box.innerHTML = head + '<div class="sbox">Clique sur « Lire les inventaires des amis » : l\'app regarde leurs cartes pour trouver ceux à qui tes doublons permettent de finir un badge. Si leurs inventaires sont privés, ils n\'apparaîtront pas (le diagnostic dit pourquoi).</div>'; return; }
    box.innerHTML = head + (d.friends.length ? d.friends.map((f, i) => `<details class="fdet cbox sec2" data-f="${esc(f.steamid)}" ${open.has(f.steamid) || (!open.size && i === 0) ? 'open' : ''}>
      <summary><img src="${esc(f.avatar || '')}" alt="" class="fav"><b>${esc(f.name)}</b> <span class="chip cbot">🎁 ${f.giveCount} à donner</span>${f.games.reduce((t, g) => t + g.iNeed.length, 0) ? ` <span class="chip cfr">⭐ ${f.games.reduce((t, g) => t + g.iNeed.length, 0)} pour toi</span>` : ''}${f.completes ? ` <span class="chip" style="border-color:var(--ok)">✔ ${f.completes} badge(s) à finir</span>` : ''}<small class="mut"> · ${f.games.length} jeu(x)</small></summary>
      <div class="grid fgrid">${f.games.map((g) => `<article class="set ${g.completes && g.canGive.length ? 'finish' : ''}"><img class="banner" data-n="${esc(g.name)}" src="${esc(g.banner)}" alt="" loading="lazy" onerror="fb(this)">
        <div class="body"><header><h3>${esc(g.name)}</h3><span class="pill">${g.level ? 'Niv. ' + g.level : 'Nouveau badge'}</span></header>
        <div class="fan">${g.cards.map(fcard).join('')}</div>
        <div class="cnt"><span class="c miss">il lui manque ${g.need}</span><span class="c bot">🎁 ${g.canGive.length}</span><span class="c fr">⭐ ${g.iNeed.length}</span>${g.completes && g.canGive.length ? '<span class="c" style="border-color:var(--ok)">✔ finit son set</span>' : ''}</div>
        <div class="row"><span>${g.has}/${g.total} cartes chez lui</span></div>
        <button class="cta" data-foffer="${esc(f.steamid)}|${g.appid}">📨 Proposer l'échange (${Math.min(6, g.canGive.length)} contre ${Math.min(6, g.iNeed.length)})</button></div></article>`).join('')}</div>
      <div class="row" style="margin-top:8px;justify-content:flex-start"><a class="ghost sm" href="${esc(tradeUrl(f.steamid))}" target="_blank" rel="noopener">⇄ Page d'échange Steam avec ${esc(f.name)}</a></div></details>`).join('')
      : '<div class="sbox">Aucun ami n\'a besoin de tes doublons pour le moment (ou ils ont un inventaire privé : copie le diagnostic pour voir).</div>');
  } catch (e) { box.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
}
$('#fbody').addEventListener('click', safe(async (e) => {
  const o = e.target.closest('[data-foffer]'); if (!o) return;
  const [sid, appid] = o.dataset.foffer.split('|'), f = FR.find((x) => x.steamid === sid), g = f && f.games.find((x) => x.appid == appid); if (!g) return;
  const give = g.canGive.slice(0, 6), ask = g.iNeed.slice(0, 6); // 6 cartes maximum de chaque côté
  if (!give.length && !ask.length) return toast('Rien à échanger pour ce jeu.', true);
  confirmTrade({ title: `Offre à ${f.name}`, who: `👥 ${f.name} — ${g.name}`, asks: ask.map((c) => ({ ...c, game: g.name })), gives: give.map((c) => ({ ...c, game: g.name })), validateLabel: 'Valider et envoyer l\'offre',
    summary: ask.length ? 'Échange carte contre carte.' : 'Il n\'a aucune carte qui te manque : tu lui <b>offres</b> ces cartes sans rien recevoir.', warn: !ask.length ? 'Ce sera un cadeau : tu ne reçois rien en échange.' : '' },
  () => sendFriendOffer(sid, give.map((c) => c.assetid), ask.map((c) => c.assetid)));
}));
$('#fscan').onclick = safe(async () => { await api('/api/scan/friends', {}); fSig = ''; poll(); });
$('#fdiag').onclick = safe(async () => { const d = $('#fdiag')._d || (await api('/api/friends/needs')).diag; try { await navigator.clipboard.writeText(d); toast('Diagnostic des amis copié'); } catch { prompt('Copie ce diagnostic :', d); } });
// ---------- journal ----------
function drawJournal() {
  const box = $('#jbody'), j = st.journal || [], sig = JSON.stringify(j); if (box._sig === sig) return;
  if (box.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return; box._sig = sig;
  const net = +j.reduce((t, x) => t + (x.credits || 0), 0).toFixed(2), ic = { trade: '⇄', buy: '🛒', sell: '💰', craft: '🛠', other: '•' };
  box.innerHTML = `<div class="kpis"><div class="stat"><b class="${net >= 0 ? 'ok' : ''}">${net > 0 ? '+' : ''}${net} cr</b><small>bilan en crédits (${j.length} entrée(s))</small></div></div>
  <div class="row" style="justify-content:flex-start;gap:8px;flex-wrap:wrap;margin:10px 0"><select id="jtype"><option value="trade">⇄ Échange</option><option value="buy">🛒 Achat</option><option value="sell">💰 Vente</option><option value="craft">🛠 Fabrication</option><option value="other">• Autre</option></select>
    <input id="jtext" placeholder="Description (ex. 3 cartes de Metal Slug 3 achetées au bot)" style="flex:1;min-width:220px"><input id="jcr" inputmode="decimal" placeholder="crédits (+/−)" style="width:120px"><button id="jadd" class="ghost">➕ Ajouter</button></div>
  ${j.length ? `<div class="flist">${j.map((x) => `<div class="frow"><span>${ic[x.type] || '•'}</span><div class="grow"><b>${esc(x.text)}</b>${x.auto ? ' <small class="mut">· automatique</small>' : ''}<br><small>${new Date(x.t).toLocaleString('fr-FR')}</small></div><b class="${x.credits > 0 ? 'ok' : 'mut'}">${x.credits ? (x.credits > 0 ? '+' : '') + x.credits + ' cr' : ''}</b><button class="ghost sm" data-jdel="${esc(x.id)}">✕</button></div>`).join('')}</div>` : '<div class="sbox">Rien pour le moment. Les offres envoyées et les boosters fabriqués depuis l\'app s\'ajoutent tout seuls ; ajoute à la main tes échanges faits sur le site du bot (bouton « ✔ Fait » dans le plan d\'échanges).</div>'}`;
}
$('#jbody').addEventListener('click', safe(async (e) => {
  const d = e.target.closest('[data-jdel]'); if (d) { await api('/api/journal/remove', { id: d.dataset.jdel }); $('#jbody')._sig = ''; return poll(); }
  if (e.target.closest('#jadd')) { const text = $('#jtext').value.trim(); if (!text) return toast('Ajoute une description.', true); await api('/api/journal/add', { type: $('#jtype').value, text, credits: $('#jcr').value }); $('#jbody')._sig = ''; poll(); }
}));
// rappel quotidien des cartes à récupérer en jouant
function dropsReminder() {
  const n = (st.dropsList || []).reduce((t, x) => t + x.drops, 0), day = new Date().toDateString();
  if (!n || lsGet('sbt.dropsDay', '') === day) return; lsSet('sbt.dropsDay', day);
  toast(`🎴 ${nf(n)} carte(s) à récupérer en jouant (onglet Progrès)`);
  try { if (window.Notification && Notification.permission === 'granted') new Notification('Cartes à récupérer', { body: `${nf(n)} carte(s) à obtenir en jouant` }); } catch {}
}
// ---------- page de confirmation : aucune offre ni ouverture de fenêtre d'échange sans que tu aies relu et cliqué sur « Valider » ----------
const cfCards = (l, k) => l.length ? l.map((c) => `<span class="tcard" title="${esc(c.name)} — ${esc(c.game || '')}"><img src="${esc(c.img)}" alt=""><small>${esc(c.name)}</small><small>${k === 'ask' ? (c.price != null ? esc(c.unit === 'cr' ? c.price + ' cr' : money(c.price)) : '') : (c.worth != null ? esc(c.unit === 'cr' ? c.worth + ' cr' : money(c.worth)) : '')}</small></span>`).join('') : '<small class="mut">rien</small>';
// t : { title, who, asks, gives, summary, validateLabel, warn } ; onValidate() n'est appelé qu'après ton clic
function confirmTrade(t, onValidate) {
  $('#cft').textContent = t.title || 'Vérifie et valide l\'échange';
  $('#cfbody').innerHTML = `<p class="mut small">Relis le détail : <b>rien n'est envoyé ni acheté tant que tu n'as pas cliqué sur « ${esc(t.validateLabel || 'Valider')} »</b>.</p>
    <div class="cfsum"><b>${esc(t.who || '')}</b><br>${t.summary || ''}</div>
    <div class="cfgrid"><div class="cfcol"><h4>Je prends (${t.asks.length})</h4><div class="tc">${cfCards(t.asks.map((c) => ({ ...c, unit: t.unit })), 'ask')}</div></div>
      <div class="cfcol"><h4>Je donne (${t.gives.length})</h4><div class="tc">${cfCards(t.gives.map((c) => ({ ...c, unit: t.unit })), 'give')}</div></div></div>
    ${t.warn ? `<p class="note">⚠ ${esc(t.warn)}</p>` : ''}
    <div class="row" style="justify-content:flex-end;gap:8px"><button class="ghost" id="cfno">Annuler</button><button class="go" id="cfok" style="width:auto;padding:12px 26px;margin:0">✅ ${esc(t.validateLabel || 'Valider')}</button></div>`;
  $('#cfno').onclick = () => $('#cfdlg').close();
  $('#cfok').onclick = async () => { $('#cfok').disabled = true; try { await onValidate(); $('#cfdlg').close(); } catch (e) { toast(e.message, true); $('#cfok').disabled = false; } };
  if (!$('#cfdlg').open) $('#cfdlg').showModal();
}
// envoi d'une offre Steam à un ami (après validation) puis ouverture de la page de l'offre dans l'application
async function sendFriendOffer(friendId, give, ask) {
  if (!(await ensureLogin())) throw new Error('Connexion à Steam annulée : rien n\'a été envoyé.');
  const r = await api('/api/trade/send', { source: 'friend', friendId, give, ask, gift: !ask.length, confirmed: true });
  toast('✅ ' + r.note); if (r.id && r.id !== '000000') window.open(`https://steamcommunity.com/tradeoffer/${r.id}/`, '_blank');
  return r;
}
// ---------- 🤖 Mode auto : choisir ses cartes, trader avec le bot ou des amis, vendre ses doubles ----------
const A = { data: null, ask: new Map(), give: new Set(), plan: null, init: false, vAt: -1, allCards: false, mode: 'bot', user: new Set(), seen: new Set(),
  wq: '', wfilter: 'all', wsort: 'game', gq: '', gfilter: 'spare', gsort: 'worth' };
async function openAuto() {
  A.ask = new Map(); A.give = new Set(); A.init = false; A.vAt = -1; A.seen = new Set(); A.user = new Set();
  $('#abody').innerHTML = '<p class="mut">Chargement…</p>'; $('#adlg').showModal();
  const v = st.tasks.verify; if (v.state !== 'running' && !v.doneAt) startScan('verify'); // première ouverture : on vérifie les jeux tout de suite
  await loadAuto();
}
const srcFor = (w, mode) => (mode === 'bot' ? (w.bot ? 'bot' : null) : mode === 'friends' ? (w.friends[0] ? w.friends[0].steamid : null) : null);
let autoLoading = false;
async function loadAuto() {
  if (autoLoading) return; autoLoading = true;
  try {
    A.vAt = st.tasks.verify.doneAt; A.data = await api('/api/auto/data');
    for (const w of A.data.wanted) {
      const def = srcFor(w, A.mode);
      if (!A.seen.has(w.hash)) { A.seen.add(w.hash); if (w.completable && def) A.ask.set(w.hash, def); }
      else if (A.ask.has(w.hash) && !A.user.has(w.hash) && def) A.ask.set(w.hash, def);
    }
    for (const h of [...A.ask.keys()]) if (!A.data.wanted.some((w) => w.hash === h)) A.ask.delete(h);
    A.init = true;
    await planAuto(); renderAuto();
  } catch (e) { $('#abody').innerHTML = `<div class="errbox">${esc(e.message)}</div>`; } finally { autoLoading = false; }
}
let planSeq = 0;
async function planAuto() {
  const my = ++planSeq, asks = A.mode === 'sell' ? [] : [...A.ask].filter(([, src]) => (A.mode === 'bot' ? src === 'bot' : src !== 'bot')).map(([hash, src]) => ({ hash, src }));
  const r = await api('/api/auto/plan', { asks, gives: [...A.give], mode: A.mode });
  if (my === planSeq) A.plan = r; // une réponse arrivée en retard n'écrase pas la plus récente
}
function autoHead() {
  const v = st.tasks.verify, f = st.friends, d = A.data; if (!d) return '';
  const vtxt = v.state === 'running' ? `<div class="rbar"><i style="width:${v.pct}%"></i></div><small>${esc(v.label || 'Vérification…')} · ${v.pct}%${v.eta ? ' · ~' + v.eta + ' s' : ''}</small> <button class="ghost sm" data-ax="stop">■ Arrêter</button>`
    : `<small>${v.doneAt ? '✔ jeux vérifiés ' + ago(v.doneAt) : 'Jeux pas encore vérifiés : les prix du site ne sont pas à jour.'}</small> <button class="ghost sm" data-ax="verify">${v.doneAt ? '↻ Tout revérifier (bot + amis)' : '▶ Tout vérifier (bot + amis)'}</button>`;
  const r = st.ready, todo = r ? r.conds.filter((c) => !c.ok && c.key !== 'verify') : [];
  const todoHtml = todo.length ? `<div class="row" style="gap:8px;flex-wrap:wrap;justify-content:flex-start;margin:0 0 6px"><small>Il manque :</small>${todo.map((c) => `<button class="rbtn" data-ax="do:${c.key}">▶ ${esc(c.label)}</button>`).join('')}</div>` : '';
  const ftxt = `<small>👥 amis : ${f.stats ? friendsInfo() : 'pas encore lus'}${f.t ? ' · ' + ago(f.t) : ''}</small> <button class="ghost sm" data-ax="friends">${f.status === 'loading' ? '⏳ lecture…' : '↻ Lire les amis'}</button>`;
  return `${todoHtml}<div class="row" style="gap:16px;flex-wrap:wrap;justify-content:flex-start"><span>💳 Solde : <b>${d.balance} cr</b></span><span>🃏 ${A.ask.size} carte(s) voulue(s)</span><span>♻ ${d.give.filter((g) => g.spare).length} doublon(s) · ${d.give.length} carte(s) au total</span></div><div class="row" style="gap:10px;flex-wrap:wrap;justify-content:flex-start;margin:6px 0">${vtxt}</div><div class="row" style="gap:10px;flex-wrap:wrap;justify-content:flex-start;margin:0 0 8px">${ftxt} <button class="ghost sm" data-ax="botcheck" title="Relit chez le bot tous les jeux où tu as des doublons ou des cartes manquantes">🔎 Vérifier doubles & manquantes du bot</button></div>`;
}
const wantedView = () => {
  const d = A.data, q = A.wq.toLowerCase();
  let l = d.wanted.filter((w) => (A.mode === 'bot' ? w.bot : A.mode === 'friends' ? w.friends.length : false) && (!q || (w.name + ' ' + w.game).toLowerCase().includes(q)));
  if (A.wfilter === 'completable') l = l.filter((w) => w.completable); else if (A.wfilter === 'selected') l = l.filter((w) => A.ask.has(w.hash)); else if (A.wfilter === 'unselected') l = l.filter((w) => !A.ask.has(w.hash)); else if (A.wfilter === 'cheap') l = l.filter((w) => w.bot && w.bot.price <= 6);
  const key = { game: (a, b) => a.game.localeCompare(b.game) || a.name.localeCompare(b.name), name: (a, b) => a.name.localeCompare(b.name), price: (a, b) => (a.bot ? a.bot.price : 99) - (b.bot ? b.bot.price : 99), market: (a, b) => (b.price || 0) - (a.price || 0), set: (a, b) => (a.setCost || 0) - (b.setCost || 0) }[A.wsort];
  return l.sort(key);
};
const giveView = () => {
  const d = A.data, q = A.gq.toLowerCase();
  let l = d.give.filter((g) => (!q || (g.name + ' ' + g.game).toLowerCase().includes(q)));
  if (A.mode !== 'sell' && !A.allCards && A.gfilter === 'spare') l = l.filter((g) => g.spare || A.give.has(String(g.assetid)));
  else if (A.gfilter === 'spare') l = l.filter((g) => g.spare); else if (A.gfilter === 'selected') l = l.filter((g) => A.give.has(String(g.assetid))); else if (A.gfilter === 'valuable') l = l.filter((g) => g.worth >= 6); else if (A.gfilter === 'unchecked') l = l.filter((g) => !d.botDupes.some((x) => x.hash === g.hash && x.checked));
  const key = { worth: (a, b) => b.worth - a.worth, worthasc: (a, b) => a.worth - b.worth, name: (a, b) => a.name.localeCompare(b.name), game: (a, b) => String(a.game).localeCompare(String(b.game)), price: (a, b) => b.price - a.price }[A.gsort];
  return l.sort(key);
};
function wantedHtml() {
  const l = wantedView(), by = [...l.reduce((m, w) => (m.get(w.appid) || m.set(w.appid, []).get(w.appid)).push(w) && m, new Map()).values()];
  return by.map((list) => `<div class="agame"><b>${esc(list[0].game)}</b> ${list[0].completable ? '<small class="ok">✔ set complétable</small>' : '<small class="mut">set incomplet</small>'}
    ${list.map((w) => { const src = A.ask.get(w.hash); return `<div class="arow ${src ? 'sel' : ''}"><input type="checkbox" data-aw="${esc(w.hash)}" ${src ? 'checked' : ''}><img src="${esc(w.img)}" alt=""><div class="grow"><b>${esc(w.name)}</b> <small class="mut">${esc(w.price ? money(w.price) : '')}</small><br>
      ${A.mode === 'bot' && w.bot ? `<span class="chip cbot on" title="Prix d'achat chez le bot">🤖 achat ${w.bot.price} cr · rachat ${w.bot.worth} cr</span>` : ''}${A.mode === 'friends' ? w.friends.map((f) => `<button class="chip cfr ${src === f.steamid ? 'on' : ''}" data-asrc="${esc(f.steamid)}" data-h="${esc(w.hash)}">👥 ${esc(f.name)}</button>`).join('') : ''}</div></div>`; }).join('')}</div>`).join('') || `<p class="mut small">${A.mode === 'bot' ? 'Aucune carte voulue disponible chez le bot (ou filtre trop strict). Lance « Tout vérifier ».' : 'Aucune carte voulue chez tes amis (ou filtre trop strict). Lance « Lire les amis ».'}</p>`;
}
function giveHtml() {
  const l = giveView();
  return l.map((g) => `<label class="arow ${A.give.has(String(g.assetid)) ? 'sel' : ''}"><input type="checkbox" data-ag="${esc(String(g.assetid))}" ${A.give.has(String(g.assetid)) ? 'checked' : ''}><img src="${esc(g.img)}" alt=""><div class="grow"><b>${esc(g.name)}</b><br><small class="mut">${esc(g.game)}${g.spare ? '' : ' · <b style="color:var(--warn)">pas un doublon</b>'}</small></div><span class="chip cbot" title="Ce que le site te donne pour cette carte">rachat ${g.worth} cr</span></label>`).join('') || '<p class="mut small">Aucune carte ne correspond.</p>';
}
function renderAuto() {
  const d = A.data; if (!d) return;
  const dupOk = d.botDupes.filter((x) => x.checked), dupSell = dupOk.filter((x) => !x.over), dupOver = dupOk.filter((x) => x.over);
  const botBox = `<details class="cbox"><summary><b>🔎 Contrôle du bot</b> <small class="mut">— ${dupOk.length}/${d.botDupes.length} de tes doublons vérifiés · ${d.wanted.filter((w) => w.bot).length} carte(s) manquante(s) que le bot a</small></summary>
    ${d.botDupes.length ? `<p class="small" style="margin:8px 0 4px">♻ Mes doubles : <b class="ok">${dupSell.length} rachetés</b>${dupOver.length ? ` · <b style="color:var(--warn)">${dupOver.length} en surstock</b>` : ''}${d.botDupes.length - dupOk.length ? ` · <span class="mut">${d.botDupes.length - dupOk.length} pas encore vérifiés</span>` : ''}</p>
      <div class="tc">${d.botDupes.slice(0, 60).map((x) => `<span class="tcard" title="${esc(x.name)} × ${x.count} — ${esc(x.game)}${x.checked ? '' : ' (pas vérifié)'}${x.over ? ' — surstock' : ''}"><img src="${esc(x.img)}" alt="" style="${x.checked ? '' : 'opacity:.45'}${x.over ? ';outline:2px solid var(--warn)' : ''}"><small>${x.worth} cr${x.count > 1 ? ' ×' + x.count : ''}</small></span>`).join('')}</div>` : '<p class="mut small">Aucun doublon.</p>'}</details>`;
  const modes = [['bot', '🤖 Trader avec le bot'], ['friends', '👥 Trader avec mes amis'], ['sell', '💰 Vendre mes cartes au bot']];
  const sel = (id, val, opts) => `<select id="${id}">${opts.map(([v, t]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const wantTools = A.mode === 'sell' ? '' : `<div class="atool"><input id="awq" placeholder="🔎 Chercher une carte voulue ou un jeu…" value="${esc(A.wq)}">${sel('awf', A.wfilter, [['all', 'Toutes'], ['completable', 'Sets complétables'], ['selected', 'Cochées'], ['unselected', 'Non cochées'], ['cheap', 'Pas chères (≤ 6 cr)']])}${sel('aws', A.wsort, [['game', 'Tri : jeu'], ['name', 'Tri : nom'], ['price', 'Tri : prix chez le bot'], ['market', 'Tri : prix marché'], ['set', 'Tri : set le moins cher']])}
    <button class="ghost sm" data-ax="wall">Tout cocher</button><button class="ghost sm" data-ax="wnone">Tout décocher</button></div>`;
  const giveTools = `<div class="atool"><input id="agq" placeholder="🔎 Chercher dans mon inventaire…" value="${esc(A.gq)}">${sel('agf', A.gfilter, [['spare', 'Mes doublons'], ['all', 'Toutes mes cartes'], ['selected', 'Cochées'], ['valuable', 'Valeur ≥ 6 cr'], ['unchecked', 'Pas vérifiées chez le bot']])}${sel('ags', A.gsort, [['worth', 'Tri : rachat (haut)'], ['worthasc', 'Tri : rachat (bas)'], ['price', 'Tri : prix marché'], ['name', 'Tri : nom'], ['game', 'Tri : jeu']])}
    <button class="ghost sm" data-ax="gspare" title="Coche tous tes doublons">♻ Tous mes doubles</button><button class="ghost sm" data-ax="gvis">Cocher les visibles</button><button class="ghost sm" data-ax="gnone">Tout décocher</button></div>`;
  $('#abody').innerHTML = `<div id="ahead">${autoHead()}</div>${botBox}
    <div class="modebar">${modes.map(([k, t]) => `<button class="ghost ${A.mode === k ? 'on' : ''}" data-amode="${k}">${t}</button>`).join('')}</div>
    <p class="mut small">${A.mode === 'bot' ? 'Le bot te vend les cartes cochées contre des crédits (ton solde + la revente de tes cartes).' : A.mode === 'friends' ? 'Tu proposes des échanges carte contre carte à tes amis (6 cartes maximum de chaque côté).' : 'Coche les cartes à vendre (ou « Tous mes doubles ») : elles sont regroupées par paquets de 6 cartes maximum.'}</p>
    <div class="agrid">${A.mode === 'sell' ? '' : `<div class="cbox"><h4>🃏 Cartes que je veux</h4>${wantTools}<div class="alist" id="awlist">${wantedHtml()}</div></div>`}
    <div class="cbox"><h4>${A.mode === 'sell' ? '💰 Cartes à vendre' : '♻ Cartes que je donne'} <small class="mut">${A.mode === 'sell' ? '— rien de coché = rien vendu' : '— rien de coché = choix automatique (tes doublons)'}</small></h4>${giveTools}<div class="alist" id="aglist">${giveHtml()}</div></div></div>
    <h3 style="margin:16px 0 8px">Échanges proposés <small class="mut">(6 cartes maximum de chaque côté — rien n'est envoyé sans ta validation)</small></h3><div id="atrades">${tradesHtml()}</div>`;
}
function tradesHtml() {
  const tr = (A.plan && A.plan.trades) || [];
  if (!tr.length) return `<p class="mut small">${A.mode === 'sell' ? 'Coche des cartes à vendre : les paquets se calculent tout seuls.' : 'Coche des cartes à gauche : les échanges se calculent tout seuls.'}</p>`;
  const cardsHtml = (l, f) => l.map((c) => `<span class="tcard" title="${esc(c.name)} — ${esc(c.game)}"><img src="${esc(c.img)}" alt=""><small>${esc(f(c))}</small></span>`).join('') || '<small class="mut">rien</small>';
  return tr.map((t, i) => `<div class="trade ${t.feasible ? '' : 'no'}" data-t="${esc(t.id)}"><div class="row" style="justify-content:space-between;gap:8px"><b>${t.kind === 'bot' ? '🤖 SteamCardExchange' : t.kind === 'sell' ? '💰 Vente au bot' : '👥 ' + esc(t.friend.name)} — ${t.kind === 'sell' ? 'paquet' : 'échange'} ${i + 1}</b>
    <span>${t.kind === 'bot' ? `${t.askTotal} cr contre ${t.giveTotal} cr · solde après : ${t.balanceAfter} cr` : t.kind === 'sell' ? `+${t.giveTotal} cr · solde après : ${t.balanceAfter} cr` : `≈ ${money(t.askTotal)} contre ≈ ${money(t.giveTotal)}`}</span></div>
    <div class="tcols"><div><small>Je prends (${t.asks.length}/6)</small><div class="tc">${cardsHtml(t.asks, (c) => (t.kind === 'bot' ? c.price + ' cr' : c.name))}</div></div>
      <div><small>Je donne (${t.gives.length}/6)</small><div class="tc">${cardsHtml(t.gives, (c) => (t.kind === 'friend' ? c.name : c.worth + ' cr'))}</div></div></div>
    ${t.feasible ? '' : `<p class="note">⚠ ${t.kind === 'bot' ? `Il manque ${t.short} cr : coche d'autres cartes à donner ou retire des cartes voulues.` : t.kind === 'sell' ? 'Ces cartes ne valent rien pour le bot.' : 'Aucune carte à donner.'}</p>`}
    <div class="row" style="justify-content:flex-start;gap:8px;flex-wrap:wrap"><button class="go sm" data-acheck="${esc(t.id)}" ${t.feasible ? '' : 'disabled'}>👁 Vérifier et valider…</button>${t.kind !== 'friend' ? `<button class="ghost sm" data-adone="${esc(t.id)}" title="Note cet échange dans le journal quand c'est fait">✔ Fait</button>` : `<a class="ghost sm" href="${esc(tradeUrl(t.friend.steamid))}" target="_blank" rel="noopener">↗ Page d'échange Steam</a>`}</div></div>`).join('');
}
let aTimer = 0;
const replan = () => { clearTimeout(aTimer); aTimer = setTimeout(async () => { try { await planAuto(); $('#atrades').innerHTML = tradesHtml(); $('#ahead').innerHTML = autoHead(); } catch (e) { toast(e.message, true); } }, 150); };
const refreshLists = () => { const w = $('#awlist'), g = $('#aglist'); if (w) w.innerHTML = wantedHtml(); if (g) g.innerHTML = giveHtml(); };
$('#abody').addEventListener('input', (e) => {
  if (e.target.id === 'awq') { A.wq = e.target.value; refreshLists(); }
  if (e.target.id === 'agq') { A.gq = e.target.value; refreshLists(); }
});
$('#abody').addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'awf') { A.wfilter = e.target.value; return refreshLists(); }
  if (id === 'aws') { A.wsort = e.target.value; return refreshLists(); }
  if (id === 'agf') { A.gfilter = e.target.value; return refreshLists(); }
  if (id === 'ags') { A.gsort = e.target.value; return refreshLists(); }
  const w = e.target.dataset.aw, g = e.target.dataset.ag;
  if (w !== undefined) { const x = A.data.wanted.find((y) => y.hash === w); if (e.target.checked) { const s = srcFor(x, A.mode); if (s) A.ask.set(w, s); } else A.ask.delete(w); e.target.closest('.arow').classList.toggle('sel', e.target.checked); }
  if (g !== undefined) { e.target.checked ? A.give.add(g) : A.give.delete(g); e.target.closest('.arow').classList.toggle('sel', e.target.checked); }
  replan();
});
// ouvre la page de confirmation pour un échange proposé ; l'action n'a lieu qu'après « Valider »
function reviewAuto(t) {
  const money2 = (n) => n + ' cr';
  if (t.kind === 'friend') {
    return confirmTrade({ title: `Offre à ${t.friend.name}`, who: `👥 Offre d'échange Steam à ${t.friend.name}`, asks: t.asks, gives: t.gives, summary: `Environ ${money(t.askTotal)} contre ${money(t.giveTotal)}. L'offre part sur ton compte Steam ; ${esc(t.friend.name)} devra l'accepter (et tu devras la confirmer dans l'app Steam mobile si elle est protégée).`,
      warn: t.gives.length < t.asks.length ? 'Tu donnes moins de cartes que tu n\'en demandes : l\'offre risque d\'être refusée.' : '', validateLabel: 'Valider et envoyer l\'offre' },
    () => sendFriendOffer(t.friend.steamid, t.gives.map((g) => g.assetid), t.asks.map((c) => c.assetid)));
  }
  const sell = t.kind === 'sell';
  confirmTrade({ title: sell ? 'Vente au bot' : 'Échange avec le bot', who: sell ? '💰 Vente de cartes à SteamCardExchange' : '🤖 Échange avec SteamCardExchange', unit: 'cr', asks: t.asks.map((c) => ({ ...c })), gives: t.gives, validateLabel: sell ? 'Valider et ouvrir le bot' : 'Valider et ouvrir le bot',
    summary: sell ? `Tu vends ${t.gives.length} carte(s) pour +${money2(t.giveTotal)} (solde après : ${money2(t.balanceAfter)}).<br><small class="mut">Une fenêtre du bot s'ouvre dans l'application : tu y fais « Make Offer » avec ces cartes. Rien n'est vendu avant ton action dans cette fenêtre.</small>` : `Tu paies ${money2(t.askTotal)} : ${t.giveTotal ? 'revente de ' + t.gives.length + ' carte(s) (' + money2(t.giveTotal) + ') + ' : ''}ton solde. Solde après : ${money2(t.balanceAfter)}.<br><small class="mut">Une fenêtre du bot s'ouvre dans l'application avec un bouton « Quick-Trade » par carte : l'achat ne part que quand tu cliques dessus.</small>` },
  async () => {
    if (sell) { const r = await api('/api/auto/open', { mode: 'sell', names: t.gives.map((g) => g.name) }); if (!r.opened) window.open(r.url, '_blank'); return; }
    for (const g of t.games) { const r = await api('/api/auto/open', { appid: g.appid, names: g.cards }); if (!r.opened) window.open(r.url, '_blank'); }
  });
}
$('#abody').addEventListener('click', safe(async (e) => {
  const sc = e.target.closest('[data-asrc]');
  if (sc) { e.preventDefault(); A.ask.set(sc.dataset.h, sc.dataset.asrc); A.user.add(sc.dataset.h); refreshLists(); return replan(); }
  const md = e.target.closest('[data-amode]');
  if (md) { A.mode = md.dataset.amode; A.ask = new Map(); A.user = new Set(); A.seen = new Set(); A.give = new Set(); A.gfilter = A.mode === 'sell' ? 'spare' : A.gfilter; await loadAuto(); return; }
  const ax = e.target.closest('[data-ax]');
  if (ax) {
    const k = ax.dataset.ax;
    if (k === 'wall') { for (const w of wantedView()) { const s = srcFor(w, A.mode); if (s) A.ask.set(w.hash, s); } refreshLists(); return replan(); }
    if (k === 'wnone') { for (const w of wantedView()) A.ask.delete(w.hash); refreshLists(); return replan(); }
    if (k === 'gspare') { for (const g of A.data.give) if (g.spare) A.give.add(String(g.assetid)); refreshLists(); return replan(); }
    if (k === 'gvis') { for (const g of giveView()) A.give.add(String(g.assetid)); refreshLists(); return replan(); }
    if (k === 'gnone') { A.give.clear(); refreshLists(); return replan(); }
    if (k === 'stop') await api('/api/scan/verify/cancel', {}); else if (k === 'botcheck') await api('/api/botcheck', {}); else if (k.startsWith('do:')) await startScan(k.slice(3)); else await api('/api/scan/' + (k === 'friends' ? 'friends' : 'verify'), {});
    await poll(); $('#ahead').innerHTML = autoHead(); return;
  }
  const tid = (e.target.closest('[data-t]') || {}).dataset; const t = tid && A.plan.trades.find((x) => x.id === tid.t);
  if (e.target.closest('[data-acheck]') && t) return reviewAuto(t);
  if (e.target.closest('[data-adone]') && t) { await api('/api/journal/add', { type: t.kind === 'sell' ? 'sell' : 'trade', text: t.kind === 'sell' ? `Vente au bot : ${t.gives.map((c) => c.name).join(', ')}` : `SteamCardExchange : ${t.asks.map((c) => c.name).join(', ')}`, credits: +(t.giveTotal - t.askTotal).toFixed(2) }); toast('📒 Ajouté au journal'); }
}));
// pendant que la fenêtre est ouverte : l'en-tête suit la progression ; la liste se recharge quand la vérification se termine
function autoTick() {
  if (!$('#adlg').open || !A.data) return;
  if ($('#ahead')) $('#ahead').innerHTML = autoHead();
  if (st.tasks.verify.state !== 'running' && st.tasks.verify.doneAt !== A.vAt) loadAuto();
}
let wishSeen = new Set(lsGet('sbt.wishseen', []));
function watchWishes() {
  const w = st.wishlist || [], n = w.filter((x) => x.available && !x.owned).length;
  $('#nwish').textContent = n ? `🔔${n}` : w.length ? w.length : '';
  for (const x of w) if (x.available && !x.owned && !wishSeen.has(x.hash)) {
    wishSeen.add(x.hash); lsSet('sbt.wishseen', [...wishSeen]);
    toast(`🔔 « ${x.name} » (${x.game}) est disponible !`);
    try { if (window.Notification && Notification.permission === 'granted') new Notification('Carte disponible', { body: `${x.name} — ${x.game}` }); } catch {}
  }
  for (const a of st.alerts || []) {
    const k = 'set-' + a.appid;
    if (a.hit && !wishSeen.has(k)) { wishSeen.add(k); lsSet('sbt.wishseen', [...wishSeen]); toast(`🔔 Le set « ${a.name} » est passé à ${money(a.cost)} !`); try { if (window.Notification && Notification.permission === 'granted') new Notification('Prix du set atteint', { body: `${a.name} — ${money(a.cost)}` }); } catch {} }
    if (!a.hit) wishSeen.delete(k);
  }
  for (const h of [...wishSeen]) if (!h.startsWith('set-') && !w.some((x) => x.hash === h && x.available)) wishSeen.delete(h); // redevient indisponible : on réavertira
}
try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}
// bouton à remplissage pour une action sans progression connue (ex. lire une page du site) : le remplissage suit le temps estimé
async function fillProgress(btn, estSec, promiseOrFn) {
  btn.classList.add('running');
  const ac = new AbortController(); btn._ac = ac; // un second clic sur le bouton arrête l'attente
  const promise = typeof promiseOrFn === 'function' ? promiseOrFn(ac.signal) : promiseOrFn;
  const t0 = Date.now(), small = btn.querySelector('small'), keep = small.textContent;
  const iv = setInterval(() => { const el = (Date.now() - t0) / 1000, p = Math.min(95, Math.round((100 * el) / estSec)); btn.style.setProperty('--p', p + '%'); btn.querySelector('.pc').textContent = p + '%'; small.textContent = `~${Math.max(1, Math.round(estSec - el))} s restantes · clique pour arrêter`; }, 250);
  try { return await promise; } finally { clearInterval(iv); btn._ac = null; btn.classList.remove('running'); btn.style.setProperty('--p', '0%'); btn.querySelector('.pc').textContent = '▶'; small.textContent = keep; }
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
function drawBasket() {
  const idx = cardIndex(), items = [...basket].map((h) => idx.get(h)).filter(Boolean), box = $('#bkbody');
  if (!items.length) { box.innerHTML = '<p class="mut">Le panier est vide. Ajoute des cartes depuis la page des badges (🛒) ou la fiche d\'un jeu.</p>'; return; }
  const byGame = [...items.reduce((m, c) => (m.get(c.appid) || m.set(c.appid, []).get(c.appid)).push(c) && m, new Map()).values()], total = items.reduce((t, c) => t + (c.price || 0), 0);
  box.innerHTML = `<p class="mut small">${items.length} carte(s) · environ ${money(total)} sur le marché</p>
    ${byGame.map((l) => `<div class="agame"><b>${esc(l[0].game)}</b>${l.map((c) => { const fr = (c.friends || []).length; return `<div class="arow"><img src="${esc(c.img)}" alt=""><div class="grow"><b>${esc(c.name)}</b> <small class="mut">${esc(c.priceText || money(c.price))}</small>${c.credits != null ? ` <small class="mut">· rachat site ${c.credits} cr</small>` : ''}${c.botCard && c.botCard.stock > 0 ? ' <span class="chip cbot">🤖 chez le bot</span>' : ''}${fr ? ` <span class="chip cfr">👥 ${fr}</span>` : ''}</div><button class="ghost sm" data-bkrm="${esc(c.hash)}">✕ Retirer</button></div>`; }).join('')}</div>`).join('')}
    <div class="row" style="margin-top:12px;gap:8px;justify-content:flex-end"><button class="ghost" data-bkx="clear">Vider le panier</button><button class="go" style="width:auto;padding:10px 22px;margin:0" data-bkx="go">⇄ Lancer l'échange</button></div>`;
}
$('#bkview').onclick = () => { drawBasket(); $('#bkdlg').showModal(); };
$('#bkbody').addEventListener('click', (e) => {
  const r = e.target.closest('[data-bkrm]'); if (r) { basket.delete(r.dataset.bkrm); renderBasket(); drawBasket(); lastSig = ''; return; }
  const x = e.target.closest('[data-bkx]'); if (!x) return;
  if (x.dataset.bkx === 'clear') { basket.clear(); renderBasket(); drawBasket(); lastSig = ''; }
  if (x.dataset.bkx === 'go') { $('#bkdlg').close(); openTrade(); }
});

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
  renderScans(); renderReady(); watchWishes(); dropsReminder(); autoTick();
  $('#nboost').textContent = st.boosters.reduce((t, b) => t + b.count, 0) || '';
  const u = st.update, upd = $('#upd'); upd.hidden = !(u && ['available', 'downloading', 'ready'].includes(u.status));
  if (!upd.hidden) upd.textContent = u.status === 'ready' ? '↻ Redémarrer pour mettre à jour' : u.status === 'downloading' ? `⬇ Téléchargement ${u.progress}%` : '⬇ Mise à jour disponible';
  $('#meta').textContent = (st.sets.length || st.completed.length ? `${st.sets.length} jeu(x) et ${st.completed.length} badge(s) terminé(s) en mémoire` : '') + (st.dropsTotal ? ` · 🎴 ${st.dropsTotal} carte(s) à récupérer en jouant sur ${st.dropsGames} jeu(x)` : '') + (st.updatedAt ? ` · analyse du ${new Date(st.updatedAt).toLocaleString('fr-FR')} · fermer le logiciel ne perd rien` : '');
  { const fs = $('#filt'), opts = FILTERS.map(([k, label, fn]) => { const n = k === 'done' ? st.completed.length : k === 'allbadges' ? (st.allBadges || []).length : st.sets.filter(fn).length; return `<option value="${k}">${label} (${n})</option>`; }).join(''); if (fs._o !== opts) { fs.innerHTML = opts; fs._o = opts; } fs.value = filter; }
  if ($('#sdlg').open) { renderUpdate(); renderSce(); }
  renderBasket(); showView();
}

function showView() {
  document.querySelectorAll('#views button[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  $('#v-sets').hidden = view !== 'sets'; $('#v-boosters').hidden = view !== 'boosters'; $('#v-rank').hidden = view !== 'rank'; $('#v-wish').hidden = view !== 'wish'; $('#v-prog').hidden = view !== 'prog'; $('#v-deals').hidden = view !== 'deals'; $('#v-journal').hidden = view !== 'journal'; $('#v-friends').hidden = view !== 'friends';
  if (view === 'friends') drawFriends(); if (view === 'journal') drawJournal(); if (view === 'prog') drawProg(); if (view === 'deals') drawDeals(); if (view === 'wish') drawWish(); if (view === 'sets') draw(); if (view === 'boosters') drawBoosters(); if (view === 'rank') drawRank();
}
$('#views').onclick = (e) => {
  const b = e.target.closest('button[data-v]'); if (b) { view = prefs.view = b.dataset.v; savePrefs(); lastSig = ''; showView(); if (view === 'rank' && rankTab === 'global') loadGlobal(); }
  if (e.target.closest('#upd')) { const u = st.update; if (u.status === 'ready') api('/api/update/install', {}); else openSettings(); }
};

// ---------- couleur des cartes manquantes : bot (turquoise), ami (violet), les deux (dégradé) ----------
const botHas = (c) => !!(c.botCard && c.botCard.stock > 0);
function missClass(s, c) {
  const fr = s.friends.some((f) => f.have.includes(c.hash)), bot = botHas(c);
  return bot && fr ? 'both' : bot ? 'cbot' : fr ? 'cfr' : '';
}
const tradeUrl = (steamid) => `https://steamcommunity.com/tradeoffer/new/?partner=${(BigInt(steamid) - 76561197960265728n).toString()}`; // page d'échange Steam avec cet ami
// ---------- sets ----------
function draw() {
  const q = $('#q').value.toLowerCase(), sort = $('#sort').value, wished = new Set((st.wishlist || []).map((w) => w.hash));
  const sig = JSON.stringify([filter, q, sort, st.currency, st.credits.balance, st.sets.map((s) => [s.appid, s.ownedUnique, s.botStock, s.friends.length, s.cost, s.worth, s.provisional, s.botChecked, s.botHas, s.friendsHave, s.dupes, s.nobody, s.drops, s.badgeLevel, s.cards.map((c) => c.owned + ':' + (c.botCard ? c.botCard.stock : '-')).join()]), st.completed.length, [...basket].join(), (st.wishlist || []).map((w) => w.hash).join(), (st.allBadges || []).length, st.friends.stats && st.friends.stats.cards, st.progress.running]);
  if (sig === lastSig) return; lastSig = sig;
  if (filter === 'done' || filter === 'allbadges') {
    const src = filter === 'done' ? st.completed : (st.allBadges || []);
    $('#h2').innerHTML = (filter === 'done' ? 'Badges terminés <small>niveau 5 — 100 % · clique pour voir le détail</small>' : `Tous mes badges <small>${src.length} badge(s) · clique pour voir le détail</small>`);
    $('#grid').innerHTML = src.filter((b) => b.name.toLowerCase().includes(q)).map((b) => `
      <article class="set done"><img class="banner" data-n="${esc(b.name)}" data-detail="${b.appid}" src="${esc(b.banner)}" alt="" onerror="fb(this)"><div class="body"><header><h3 data-detail="${b.appid}">${esc(b.name)}</h3><span class="pill ${b.level >= 5 ? 'ok' : ''}">Niveau ${b.level}${b.level >= 5 ? ' ✔' : ''}</span></header>
      ${b.drops ? `<div class="tags"><span class="tag dr" title="Cartes qu'il te reste à obtenir en jouant à ce jeu">🎴 ${b.drops} carte(s) à récupérer en jouant</span></div>` : ''}
      <button class="cta" data-detail="${b.appid}">Voir les données</button></div></article>`).join('') || '<p class="empty">Aucun badge à afficher pour le moment.</p>';
    return;
  }
  $('#h2').innerHTML = 'Sets à compléter <small>' + ($('#sort').selectedOptions[0] ? $('#sort').selectedOptions[0].text.toLowerCase() : '') + ' · clique sur un jeu pour le détail</small>';
  const fn = FILTERS.find((f) => f[0] === filter)[2];
  const cc = (x) => (x.cost == null ? 1e9 : x.cost); // prix pas encore connu : en fin de liste
  const nm = (a, b) => a.name.localeCompare(b.name), pctOf = (x) => x.ownedUnique / (x.total || 1);
  const by = { cost: (a, b) => cc(a) - cc(b), costdesc: (a, b) => cc(b) - cc(a), missing: (a, b) => a.missingCount - b.missingCount || cc(a) - cc(b), missingdesc: (a, b) => b.missingCount - a.missingCount || nm(a, b),
    pct: (a, b) => pctOf(b) - pctOf(a), pctasc: (a, b) => pctOf(a) - pctOf(b), owned: (a, b) => b.ownedUnique - a.ownedUnique, dupes: (a, b) => b.dupes - a.dupes || nm(a, b), dupval: (a, b) => (b.dupesValue || 0) - (a.dupesValue || 0) || nm(a, b),
    bothas: (a, b) => b.botHas - a.botHas || nm(a, b), friends: (a, b) => b.friendsHave - a.friendsHave || nm(a, b), nobody: (a, b) => (b.nobody || 0) - (a.nobody || 0) || nm(a, b),
    level: (a, b) => b.badgeLevel - a.badgeLevel || nm(a, b), levelasc: (a, b) => a.badgeLevel - b.badgeLevel || nm(a, b), drops: (a, b) => (b.drops || 0) - (a.drops || 0) || nm(a, b), name: nm, namedesc: (a, b) => nm(b, a) }[sort] || nm;
  const list = st.sets.filter((s) => fn(s) && s.name.toLowerCase().includes(q)).sort(by);
  $('#grid').innerHTML = list.map((s) => `
  <article class="set"><img class="banner" data-n="${esc(s.name)}" data-detail="${s.appid}" src="${esc(s.banner)}" alt="" loading="lazy" onerror="fb(this)">
   <div class="body"><header><h3 data-detail="${s.appid}">${esc(s.name)}</h3><span class="pill">${s.badgeLevel ? 'Niv. ' + s.badgeLevel + ' → ' + (s.badgeLevel + 1) : 'Nouveau badge'}</span></header>
    <div class="fan">${s.cards.map((c) => { if (c.unknown) return '<span class="ph" title="Carte pas encore connue"></span>'; if (c.owned) return `<img loading="lazy" src="${esc(c.img)}" title="${esc(c.name)} — possédée ×${c.owned}" alt="${esc(c.name)}">`;
      const fr = s.friends.filter((f) => f.have.includes(c.hash)), w = wished.has(c.hash);
      return `<span class="fc ${missClass(s, c) || 'none'} ${w ? 'wished' : ''}" data-wishcard="${esc(c.hash)}" title="${esc(c.name)} — ${esc(c.priceText || '')}${c.botCard ? (c.botCard.stock > 0 ? ` · 🤖 le bot l'a (${c.botCard.price != null ? c.botCard.price + ' cr' : ''})` : ' · 🤖 rupture chez le bot') : ''}${fr.length ? ' · 👥 ' + fr.map((f) => esc(f.name)).join(', ') : ''} — clique pour ${w ? 'retirer des' : 'ajouter aux'} souhaits"><img loading="lazy" src="${esc(c.img)}" alt="${esc(c.name)}"><b class="st">${w ? '★' : '☆'}</b></span>`; }).join('')}</div>
    ${s.missingCount ? `<div class="cnt"><span class="c miss">❌ ${s.missingCount} manquante(s)</span><span class="c bot" title="${s.botChecked ? 'Vérifié carte par carte' : 'Estimation d\'après le tableau du bot : lance le Mode auto pour vérifier'}">🤖 bot : ${s.botHas}${s.botChecked ? '' : ' ~'}</span><span class="c fr" title="Cartes manquantes que tes amis ont">👥 amis : ${s.friendsHave}</span>${s.botChecked || st.friends.stats ? `<span class="c none" title="Cartes que ni le bot ni un ami n'a">∅ nulle part : ${s.nobody}</span>` : ''}</div>` : ''}
    <div class="meter"><i style="width:${(100 * s.ownedUnique) / s.total}%"></i></div>
    <div class="row"><span>${s.ownedUnique}/${s.total} cartes · ${s.dupes} doublon(s)</span><span>+100 XP</span></div>
    <div class="tags">${s.botChecked ? `<span class="tag bot" title="Vérifié carte par carte sur la page du jeu chez le bot">🤖 a ${s.botHas}/${s.missingCount} de tes cartes manquantes</span>` : s.botStock ? `<span class="tag bot" title="Cartes en stock chez le bot SteamCardExchange (pas encore vérifié carte par carte)">🤖 stock ${s.botStock} · ${s.botDistinct}/${s.total} différentes${s.botSets ? ' · ' + s.botSets + ' set(s) complet(s)' : ''}</span>` : ''}${s.friends.length ? `<span class="tag fr">👥 ${s.friends.length} ami(s)</span>` : ''}${s.drops ? `<span class="tag dr" title="Cartes qu'il te reste à obtenir en jouant à ce jeu">🎴 ${s.drops} à récupérer en jouant</span>` : ''}${s.worth != null ? `<span class="tag cr" title="Crédits que le bot te donne pour une carte de ce jeu">💳 ${s.worth} crédit(s)/carte</span>` : ''}</div>
    <div class="row"><span class="price ${s.cost === 0 ? 'free' : ''}">${s.cost == null ? '<small class="mut">prix en cours de lecture…</small>' : s.cost ? money(s.cost) : 'Prêt à crafter !'}${s.stale && !s.provisional ? ' <small title="prix en cours de rafraîchissement">~</small>' : ''}</span><a class="lnk" href="${esc(s.link)}" target="_blank" rel="noopener">Comparer sur SCE ↗</a></div>
    <button class="cta" data-app="${s.appid}">${s.cost == null ? '🔎 Voir le détail' : s.cost ? '⇄ Compléter par échange' : '🔨 Crafter le badge (Steam)'}</button>
    ${s.missingCount && s.cards.some((c) => !c.owned && !c.unknown) ? `<button class="ghost addbk ${s.cards.filter((c) => !c.owned && !c.unknown).every((c) => basket.has(c.hash)) ? 'on' : ''}" data-addbk="${s.appid}" title="Ajoute (ou retire) toutes les cartes manquantes de ce jeu au panier">🛒 ${s.cards.filter((c) => !c.owned && !c.unknown).every((c) => basket.has(c.hash)) ? 'Retirer du panier' : 'Ajouter les manquantes au panier'}</button>` : ''}</div>
  </article>`).join('') || `<p class="empty">${st.progress.running ? 'Analyse en cours, les sets apparaissent ici au fur et à mesure…' : 'Aucun set ne correspond à ce filtre.'}</p>`;
}
$('#grid').addEventListener('click', safe(async (e) => {
  const ab = e.target.closest('[data-addbk]');
  if (ab) { const s2 = st.sets.find((x) => x.appid == ab.dataset.addbk), hs = s2.cards.filter((c) => !c.owned && !c.unknown).map((c) => c.hash), all = hs.every((h) => basket.has(h)); toggleCards(hs, !all, false); lastSig = ''; draw(); return toast(all ? 'Retirées du panier' : `🛒 ${hs.length} carte(s) ajoutée(s) au panier`); }
  const wc = e.target.closest('[data-wishcard]');
  if (wc) {
    const on = wc.classList.contains('wished');
    await api(on ? '/api/wish/remove' : '/api/wish/add', { hash: wc.dataset.wishcard });
    wc.classList.toggle('wished', !on); wc.querySelector('.st').textContent = on ? '☆' : '★';
    toast(on ? 'Retirée de la liste de souhaits' : '⭐ Ajoutée aux souhaits : tu seras averti quand le bot ou un ami l\'aura'); return poll();
  }
  const d = e.target.closest('[data-detail]'); if (d) return openDetail(Number(d.dataset.detail));
  const b = e.target.closest('.cta'); if (!b) return;
  const s = st.sets.find((x) => x.appid == b.dataset.app);
  if (s.cost == null) return openDetail(s.appid); // prix pas encore lu : la fiche le récupère
  if (!s.cost) return window.open(`${st.profile.url.replace(/\/$/, '')}/gamecards/${s.appid}/`, '_blank');
  toggleCards(s.cards.filter((c) => !c.owned).map((c) => c.hash), true); openTrade(); // « compléter » = tout le set manquant dans le panier
}));

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
    ${s.botBuy != null ? `<div class="stat"><b>${s.botBuy} cr</b><small>pour acheter tes manquantes au bot${st.credits && st.credits.balance != null ? ` (solde ${st.credits.balance})` : ''}</small></div>` : ''}
    ${s.dupesValue ? `<div class="stat"><b>${s.dupesValue} cr</b><small>valeur de tes doublons (revente au bot)</small></div>` : ''}
    ${s.badgePrice != null ? `<div class="stat"><b>${s.badgePrice} cr</b><small>prix du badge sur SteamCardExchange</small></div>` : ''}
    ${s.drops != null ? `<div class="stat"><b>${s.drops}</b><small>carte(s) encore à récupérer en jouant</small></div>` : ''}
  </div>
  <div class="xsec"><h4>💎 Gemmes</h4><div class="bbox"><div class="grow">${s.gemValue != null ? `<b>1 carte = ${s.gemValue} 💎</b> si tu la transformes en gemmes` : '<span class="mut">Valeur d\'une carte en gemmes inconnue.</span>'}<br>${s.boosterGems != null ? `<b>Booster = ${nf(s.boosterGems)} 💎</b>${s.boosterUnavail ? ` <span class="mut">(indisponible${s.boosterAt ? ' jusqu\'au ' + new Date(s.boosterAt).toLocaleString('fr-FR') : ''})</span>` : ''}` : '<small class="mut">Prix du booster inconnu — charge-le dans l\'onglet Boosters.</small>'}</div>
    <button class="ghost sm" data-act="gval">💎 Valeur d'une carte</button>${s.boosterGems != null && !s.boosterUnavail ? ` <button class="cta" style="width:auto;padding:10px 18px" data-act="craft">🛠 Fabriquer un booster</button>` : ''}</div></div>
  ${d.boosters ? `<div class="xsec"><h4>📦 Boosters</h4><div class="bbox"><img src="${esc(d.boosters.img)}" alt=""><div class="grow"><b>${d.boosters.count} booster(s)</b> pour ce jeu<br><small class="mut">ouvre l'inventaire Steam avec ce booster déjà sélectionné.</small></div><button class="cta" style="width:auto;padding:10px 18px" data-act="boost">📦 Ouvrir sur Steam ↗</button></div></div>` : ''}
  <div class="xsec"><h4>Cartes <small class="mut">— coche celles à échanger (panier)</small></h4>
  <table class="cards"><tr><th></th><th>Carte</th><th>Possédée</th><th>Prix marché</th><th title="Ce que le site te donne si tu lui vends cette carte">Rachat par le site</th><th>Chez le bot (achat / revente)</th><th>Chez des amis</th><th></th></tr>${s.cards.map((c) => `
    <tr class="${c.owned ? '' : 'miss'} ${basket.has(c.hash) ? 'sel' : ''}"><td>${c.owned ? '' : `<input type="checkbox" data-h="${esc(c.hash)}" ${basket.has(c.hash) ? 'checked' : ''}>`}</td>
    <td><img src="${esc(c.img)}" alt="" loading="lazy"><a class="lnk" href="https://steamcommunity.com/market/listings/753/${encodeURIComponent(c.hash)}" target="_blank" rel="noopener">${esc(c.name)}</a></td>
    <td>${c.owned ? '× ' + c.owned : '<span class="mut">manquante</span>'}</td><td>${esc(c.priceText || money(c.price))}</td><td>${c.credits != null ? `<b>${c.credits} cr</b>` : '–'}</td><td>${c.owned ? '' : c.botCard ? (c.botCard.stock > 0 ? `<a class="chip cbot" href="${esc(s.botUrl)}" target="_blank" rel="noopener" title="Ouvrir la page d'échange du bot pour ce jeu">🤖 ✔ ${c.botCard.stock} en stock${c.botCard.price != null ? ' · achat ' + c.botCard.price + ' cr' : ''}${c.botCard.worth != null ? ' · revente ' + c.botCard.worth + ' cr' : ''}</a>` : '✖ rupture' + (c.botCard.worth != null ? ' · revente ' + c.botCard.worth + ' cr' : '')) : s.botChecked ? '–' : '<span class="mut" title="Pas encore vérifié">?</span>'}</td>
    <td>${c.owned ? '' : (() => { const f = s.friends.filter((x) => x.have.includes(c.hash)); return f.length ? f.map((x) => `<button class="chip cfr" data-tfriend="${x.steamid}" data-h="${esc(c.hash)}" title="Échanger cette carte avec ${esc(x.name)}">👥 ${esc(x.name)}</button>`).join('') : '–'; })()}</td>
    <td>${c.owned || c.unknown ? '' : `<button class="star ${(st.wishlist || []).some((w) => w.hash === c.hash) ? 'on' : ''}" data-wish="${esc(c.hash)}" title="Liste de souhaits : m'avertir quand le bot a cette carte">${(st.wishlist || []).some((w) => w.hash === c.hash) ? '★' : '☆'}</button>`}</td></tr>`).join('')}</table></div>
  <div class="xsec"><h4>🔎 Vérifier ce jeu</h4>
    <div class="checks">
      <button class="scan sm" data-act="chkbot"><span class="fill"></span><span class="t"><b>🤖 Le bot a-t-il mes cartes ?</b><small>lit la page du jeu sur SteamCardExchange</small></span><span class="pc">▶</span></button>
      <button class="scan sm" data-act="chkall"><span class="fill"></span><span class="t"><b>🔄 Vérifier tout ce jeu</b><small>bot carte par carte + prix Steam à jour</small></span><span class="pc">▶</span></button>
    </div>${(detail.notes || []).map((n) => `<p class="note">⚠ ${esc(n)}</p>`).join('')}</div>
  <div class="xsec"><h4>⇄ Échanges possibles</h4>
    <div class="flist">
     <div class="frow"><span>🤖</span><div class="grow"><b>${esc(d.bot.name)}</b><br><small>${s.botChecked ? (s.botHas ? `a ${s.botHas}/${missing.length} de tes cartes manquantes : ${s.cards.filter((c) => !c.owned && c.botCard && c.botCard.stock > 0).map((c) => esc(c.name)).join(', ')}` : 'n\'a aucune de tes cartes manquantes (vérifié carte par carte)') : d.bot.status !== 'ready' ? 'inventaire du bot non chargé : clique sur le bouton « Bot SteamCardExchange » en haut' : s.botStock ? `stock : ${s.botStock} carte(s) · ${s.botDistinct}/${s.total} différentes${s.botSets ? ` · ${s.botSets} set(s) complet(s) disponible(s)` : ''} · il te donne ${s.worth} crédit(s) par carte` : 'n\'a aucune carte de ce jeu en stock'}</small></div><a class="ghost sm" href="${esc(s.link)}" target="_blank" rel="noopener">Ouvrir sur le site ↗</a></div>
     ${s.friends.map((f) => `<div class="frow"><img src="${esc(f.avatar || '')}" alt=""><div class="grow"><b>${esc(f.name)}</b><br><small>a ${f.have.length}/${missing.length} : ${f.have.map((h) => esc((s.cards.find((c) => c.hash === h) || {}).name)).join(', ')}</small></div><button class="ghost sm" data-act="selfriend" data-f="${f.steamid}">⇄ Échanger</button></div>`).join('') || (st.friends.status === 'ready' ? '<p class="mut small">Aucun ami n\'a tes cartes manquantes.</p>' : '<p class="mut small">Clique sur « 👥 Amis » en haut pour voir qui a tes cartes.</p>')}
    </div>
    <div class="row" style="margin-top:10px"><span><button class="ghost sm" data-act="selall">Tout sélectionner (manquantes)</button> <button class="ghost sm" data-act="selnone">Désélectionner</button> <button class="ghost sm" data-act="alert" title="M'avertir quand le coût du set passe sous un prix">🔔 Alerte prix du set</button></span></div></div>
  <div class="row xfoot"><span id="xcount"></span><button class="go" style="width:auto;padding:12px 24px;margin:0" data-act="trade">⇄ Lancer l'échange</button></div>`;
  renderBasket();
}
$('#xbody').addEventListener('change', (e) => { const h = e.target.dataset && e.target.dataset.h; if (h === undefined) return; toggleCards([h], e.target.checked, false); e.target.closest('tr').classList.toggle('sel', e.target.checked); });
$('#xbody').addEventListener('click', async (e) => {
  const tf = e.target.closest('[data-tfriend]');
  if (tf) { toggleCards([tf.dataset.h], true); T.friendId = tf.dataset.tfriend; $('#xdlg').close(); openTrade(); return; }
  const w = e.target.closest('[data-wish]');
  if (w) { const on = w.classList.contains('on'); try { await api(on ? '/api/wish/remove' : '/api/wish/add', { hash: w.dataset.wish }); w.classList.toggle('on', !on); w.textContent = on ? '☆' : '★'; toast(on ? 'Retirée de la liste de souhaits' : '⭐ Ajoutée : tu seras averti quand le bot l\'aura'); poll(); } catch (err) { toast(err.message, true); } return; }
  const b = e.target.closest('[data-act]'); if (!b || !detail) return;
  const s = detail.set, missing = s.cards.filter((c) => !c.owned), act = b.dataset.act;
  if (act === 'selall') toggleCards(missing.map((c) => c.hash), true);
  if (act === 'alert') { const v = prompt(`Prévenir quand le coût pour compléter « ${s.name} » passe sous (en ${st.currency === 3 ? '€' : st.currency === 2 ? '£' : '$'}) :`, s.cost ? (s.cost * 0.8).toFixed(2).replace('.', ',') : ''); if (v) { try { await api('/api/alert/set', { appid: s.appid, target: v }); toast('🔔 Alerte enregistrée'); poll(); } catch (err) { toast(err.message, true); } } }
  if (act === 'selnone') toggleCards(missing.map((c) => c.hash), false);
    if (act === 'selfriend') { const f = s.friends.find((x) => x.steamid === b.dataset.f); toggleCards(f.have, true); T.friendId = f.steamid; $('#xdlg').close(); openTrade(); return; }
  if (act === 'trade') { $('#xdlg').close(); openTrade(); }
  if (act === 'gval') { try { b.disabled = true; await api('/api/gems/value', { appid: s.appid }); detail = await api('/api/game/' + s.appid); renderDetail(); poll(); } catch (err) { toast(err.message, true); b.disabled = false; } }
  if (act === 'craft') craftBooster(s.appid, s.name, s.boosterGems, b);
  if (act === 'boost') openBooster(s.appid, detail.boosters.assetid);
  if (act === 'chkbot' || act === 'chkall') {
    if (b._ac) { b._ac.abort(); return; } // déjà en cours : on arrête
    try { const d = await fillProgress(b, act === 'chkall' ? 16 : 9, (sig) => api(`/api/game/${s.appid}/check`, act === 'chkbot' ? { only: 'bot' } : {}, sig)); detail = d; renderDetail(); poll(); }
    catch (err) { if (err.name === 'AbortError') toast('Vérification arrêtée'); else toast(err.message, true); }
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
  const fr = new Map();
  for (const h of hs) for (const f of idx.get(h).friends) fr.set(f.steamid, { id: f.steamid, name: f.name, n: (fr.get(f.steamid) ? fr.get(f.steamid).n : 0) + 1 });
  T.friends = [...fr.values()].sort((a, b) => b.n - a.n);
  if (!T.friends.find((f) => f.id === T.friendId)) T.friendId = T.friends[0] ? T.friends[0].id : '';
  T.source = T.friends.length ? 'friend' : 'url'; T.pref = null; T.botN = 0;
  $('#dsub').textContent = `${hs.length} carte(s) dans le panier — chez des amis : ${T.friends.length} ami(s)`;
  $('#note').textContent = ''; $('#pv').hidden = true; $('#go').disabled = true;
  $('#basket').hidden = true; setSource(T.source); $('#dlg').showModal();
}
$('#dlg').addEventListener('close', renderBasket);
function setSource(s) {
  T.source = s; T.pv = null;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
  const box = $('#srcbox'); $('#pv').hidden = true; $('#go').disabled = true;
  if (s === 'bot') {
    const idx = cardIndex(), by = new Map();
    for (const h of basket) { const c = idx.get(h); if (c && c.botCard && c.botCard.stock > 0) (by.get(c.appid) || by.set(c.appid, { name: c.game, cards: [] }).get(c.appid)).cards.push(c.name); }
    box.innerHTML = `<div class="sbox">Le bot SteamCardExchange fait ses échanges depuis <b>son site</b> (bouton « Quick-Trade » à côté de chaque carte).${by.size ? '' : '<br>Aucune carte du panier n\'est connue chez le bot : lance le Mode auto pour vérifier.'}<br><a class="ghost sm" href="https://www.steamcardexchange.net/index.php?inventory" target="_blank" rel="noopener">Ouvrir l\'inventaire du bot ↗</a></div>${[...by].map(([appid, g]) => `<button class="go" style="margin:6px 0" data-botopen="${appid}">↗ Ouvrir la fenêtre du bot — ${esc(g.name)} (${g.cards.length} carte(s) surlignée(s))</button>`).join('')}`;
    box._by = by;
  }
  if (s === 'friend') box.innerHTML = T.friends.length ? `<label class="lab">Ami<select id="fsel">${T.friends.map((f) => `<option value="${f.id}" ${f.id === T.friendId ? 'selected' : ''}>${esc(f.name)} — ${f.n} carte(s) du panier</option>`).join('')}</select></label><p class="mut small" style="margin:8px 0 0"><a id="fopen" class="ghost sm" href="#" target="_blank" rel="noopener">↗ Ouvrir la page d'échange Steam avec cet ami</a> — ou envoie l'offre directement avec le bouton ci-dessous.</p>`
    : '<p class="mut">Aucun ami n\'a les cartes du panier (clique d\'abord sur « Scanner mes amis »).</p>';
  if (s === 'url') box.innerHTML = '<label class="lab">Lien d\'échange du partenaire<input id="turl" placeholder="https://steamcommunity.com/tradeoffer/new/?partner=…&token=…"></label>';
  if (s === 'friend' && T.friends.length) { $('#fsel').onchange = () => { T.friendId = $('#fsel').value; preview(); }; T.friendId = $('#fsel').value; }
  if (s === 'friend' && T.friends.length) { const upd = () => { $('#fopen').href = tradeUrl($('#fsel').value); }; upd(); $('#fsel').addEventListener('change', upd); preview(); }
  if (st.demo && $('#turl')) $('#turl').value = 'https://steamcommunity.com/tradeoffer/new/?partner=123456&token=demo';
}
$('#srcbox').addEventListener('click', safe(async (e) => {
  const b = e.target.closest('[data-botopen]'); if (!b) return;
  const g = $('#srcbox')._by.get(Number(b.dataset.botopen)), r = await api('/api/auto/open', { appid: Number(b.dataset.botopen), names: g.cards });
  if (!r.opened) window.open(r.url, '_blank');
}));
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
$('#go').onclick = () => {
  if (!T.pv) return;
  const asks = T.pv.ask.filter((c) => T.askSel.has(c.assetid)), gives = [...T.pv.give, ...T.pv.giveMore].filter((c) => T.giveSel.has(c.assetid));
  const who = T.source === 'friend' ? (T.friends.find((f) => f.id === T.friendId) || { name: 'ton ami' }).name : 'ton partenaire (lien d\'échange)';
  confirmTrade({ title: 'Vérifie et valide l\'échange', who: `Offre d'échange Steam à ${who}`, asks, gives, validateLabel: 'Valider et envoyer l\'offre',
    summary: `Les cartes du panier ci-dessous. L'offre part sur ton compte Steam (connexion demandée si besoin), puis sa page s'ouvre dans l'application.`,
    warn: gives.length < asks.length ? 'Tu donnes moins de cartes que tu n\'en demandes : l\'offre risque d\'être refusée.' : '' },
  async () => {
    if (!(await ensureLogin())) throw new Error('Connexion à Steam annulée : rien n\'a été envoyé.');
    const r = await api('/api/trade/send', { source: T.source, friendId: T.friendId, tradeUrl: $('#turl') ? $('#turl').value : '', give: gives.map((c) => c.assetid), ask: asks.map((c) => c.assetid), gift: !asks.length, confirmed: true });
    for (const c of asks) basket.delete(c.hash);
    toast('✅ ' + r.note); $('#dlg').close(); renderBasket();
    if (r.id && r.id !== '000000') window.open(`https://steamcommunity.com/tradeoffer/${r.id}/`, '_blank'); // la page de l'offre, dans une fenêtre de l'application
  });
};

// ---------- boosters ----------
// Ouvre l'inventaire Steam avec le booster déjà sélectionné : il ne reste qu'à cliquer sur « Ouvrir le booster ».
function openBooster(appid, assetid) {
  const id = st.profile && st.profile.steamid; if (!id) return toast('Profil Steam non chargé.', true);
  window.open(`https://steamcommunity.com/profiles/${id}/inventory/#753_6_${assetid}`, '_blank');
  toast('Page Steam ouverte : clique sur « Ouvrir le booster » sur le booster sélectionné.');
}
async function craftBooster(appid, name, price, btn) {
  if (!confirm(`Fabriquer un booster « ${name} » pour ${nf(price)} gemmes ?`)) return;
  if (btn) btn.disabled = true;
  try {
    if (!(await ensureLogin())) { if (btn) btn.disabled = false; return; }
    const r = await api('/api/gems/craft', { appid, confirmed: true });
    toast(`Booster fabriqué ! Il te reste ${nf(r.totalGems)} gemmes.`);
    drawCatalog(); poll();
  } catch (err) { toast(err.message, true); }
  if (btn) btn.disabled = false;
}
let catQ = '';
async function drawCatalog() {
  const r = await api('/api/gems/list'); const box = $('#catbox');
  if (!r.list.length) { box.innerHTML = ''; return; }
  const q = catQ.toLowerCase(), own = new Set((st.sets || []).map((x) => x.appid));
  const sortBy = lsGet('sbt.catsort', 'own');
  const rows = r.list.filter((x) => !q || (x.name || '').toLowerCase().includes(q)).sort(sortBy === 'rent' ? (a, b) => (b.perK ?? -1) - (a.perK ?? -1) : (a, b) => (own.has(b.appid) - own.has(a.appid)) || a.price - b.price).slice(0, 60);
  box.innerHTML = `<p class="mut small">💎 ${nf(r.gems.total)} gemmes disponibles · ${r.list.length} boosters · mis à jour ${new Date(r.t).toLocaleTimeString('fr-FR')}</p>
   <div class="row" style="justify-content:flex-start;gap:8px;margin:8px 0"><div class="search"><input id="catq" placeholder="Filtrer les boosters…" value="${esc(catQ)}"></div><select id="catsort"><option value="own" ${sortBy === 'own' ? 'selected' : ''}>Mes jeux d'abord, puis moins cher</option><option value="rent" ${sortBy === 'rent' ? 'selected' : ''}>Les plus rentables d'abord</option></select></div>
   <div class="flist">${rows.map((x) => `<div class="frow"><div class="grow"><b>${esc(x.name || 'Jeu ' + x.appid)}</b>${own.has(x.appid) ? ' <small class="mut">· dans tes sets</small>' : ''}<br><small>${nf(x.price)} 💎${x.ev != null ? ` · 3 cartes ≈ ${money(x.ev)}${x.evCredits ? ` / ${x.evCredits} cr` : ''} · <b title="valeur des cartes pour 1 000 gemmes">${money(x.perK)} / 1 000 💎</b>` : ''}${x.unavailable ? ' · indisponible' + (x.availableAtTime ? ' jusqu\'au ' + new Date(x.availableAtTime).toLocaleString('fr-FR') : '') : ''}</small></div><button class="ghost sm" data-craft="${x.appid}" ${x.unavailable || (r.gems.total && r.gems.total < x.price) ? 'disabled' : ''}>🛠 Fabriquer</button></div>`).join('')}</div>`;
  $('#catsort').onchange = () => { lsSet('sbt.catsort', $('#catsort').value); drawCatalog(); };
  const qi = $('#catq'); qi.oninput = () => { catQ = qi.value; const pos = qi.selectionStart; drawCatalog().then(() => { const n = $('#catq'); n.focus(); n.setSelectionRange(pos, pos); }); };
  box.querySelectorAll('[data-craft]').forEach((b) => { b.onclick = () => { const x = r.list.find((y) => y.appid === +b.dataset.craft); craftBooster(x.appid, x.name || 'Jeu ' + x.appid, x.price, b); }; });
}
$('#catbtn').onclick = safe(async () => {
  const b = $('#catbtn'); if (b._ac) { b._ac.abort(); return; }
  if (!(await ensureLogin())) return;
  try { await fillProgress(b, 8, (sig) => api('/api/gems/catalog', {}, sig)); await drawCatalog(); }
  catch (err) { if (err.name === 'AbortError') toast('Chargement arrêté'); else toast(err.message, true); }
});
let bSig = '', rSig = '';
function drawBoosters() {
  $('#gemsbar').innerHTML = st.tasks.gems.doneAt || st.gems.gems || st.gems.sacks ? `<div class="gem"><b>💎 ${nf(st.gems.gems)}</b><small>gemmes en vrac</small></div><div class="gem"><b>🎒 ${nf(st.gems.sacks)}</b><small>sac(s) de 1 000 gemmes</small></div><div class="gem"><b>∑ ${nf(st.gems.gems + st.gems.sacks * 1000)}</b><small>gemmes au total</small></div>` : '<p class="mut">Clique sur le bouton « 💎 Gemmes » en haut pour scanner tes gemmes.</p>';
  const sig = JSON.stringify([st.boosters, st.gems]); if (sig === bSig) return; bSig = sig;
  $('#bgrid').innerHTML = st.boosters.map((b) => `
  <article class="set"><img class="banner" data-n="${esc(b.game)}" data-detail="${b.appid}" src="${esc(b.banner)}" alt="" onerror="fb(this)"><div class="body"><header><h3 data-detail="${b.appid}">${esc(b.game)}</h3><span class="pill">× ${b.count}</span></header>
    <div class="fan"><img src="${esc(b.img)}" alt="" style="width:96px;height:96px"></div>
    <button class="cta" data-boost="${b.appid}" data-asset="${b.assetid}">📦 Ouvrir sur Steam ↗</button></div></article>`).join('') || '<p class="empty">Aucun booster dans ton inventaire.</p>';
}
$('#bgrid').addEventListener('click', (e) => {
  const d = e.target.closest('[data-detail]'); if (d) return openDetail(Number(d.dataset.detail));
  const b = e.target.closest('[data-boost]'); if (!b) return;
  const bo = st.boosters.find((x) => String(x.appid) === b.dataset.boost); openBooster(bo.appid, b.dataset.asset);
});

// ---------- classement ----------
async function loadGlobal() { try { glob = await api('/api/rank/global'); } catch (e) { glob = { error: e.message, list: [] }; } rSig = ''; drawRank(); }
$('#rbody').addEventListener('click', safe(async (e) => {
  const c = e.target.closest('[data-cmp]'); if (!c) return;
  const d = await api('/api/compare/' + c.dataset.cmp), L = (title, l, n, f) => `<div class="cbox"><h4>${title} <small class="mut">(${n})</small></h4>${l.length ? `<ul class="cl">${l.map(f).join('')}</ul>` : '<p class="mut small">Aucun.</p>'}</div>`;
  $('#cbody').innerHTML = `<h3>⚔ Toi contre ${esc(d.friend.name)}</h3><div class="kpis"><div class="stat"><b>${d.me.level} / ${d.friend.level}</b><small>niveau (toi / lui)</small></div><div class="stat"><b>${nf(d.me.badgeCount)} / ${nf(d.friend.badgeCount)}</b><small>badges</small></div><div class="stat"><b>${nf(d.me.rarity)} / ${nf(d.friend.rarity)}</b><small>rareté</small></div></div>
    <div class="charts">${L('Badges qu\'il a et pas toi', d.onlyFriend, d.counts.onlyFriend, (x) => `<li>${esc(x.name)} <small class="mut">niv. ${x.theirs}</small></li>`)}${L('Badges que tu as et pas lui', d.onlyMe, d.counts.onlyMe, (x) => `<li>${esc(x.name)} <small class="mut">niv. ${x.mine}</small></li>`)}
    ${L('Il a un niveau plus haut', d.higherFriend, d.counts.higherFriend, (x) => `<li>${esc(x.name)} <small class="mut">toi ${x.mine} · lui ${x.theirs}</small></li>`)}${L('Tu as un niveau plus haut', d.higherMe, d.counts.higherMe, (x) => `<li>${esc(x.name)} <small class="mut">toi ${x.mine} · lui ${x.theirs}</small></li>`)}</div>`;
  $('#cdlg').showModal();
}));
function drawRank() {
  const sig = JSON.stringify([rankTab, $('#rmetric').value, st.rank, glob, st.leaderboard]); if (sig === rSig) return; rSig = sig;
  document.querySelectorAll('#rtabs button').forEach((b) => b.classList.toggle('on', b.dataset.r === rankTab));
  const m = $('#rmetric').value, box = $('#rbody');
  const table = (list) => `<table class="rank"><tr><th></th><th>Joueur</th><th>Niveau</th><th>Badges</th><th>Rareté</th></tr>${[...list].sort((a, b) => (b[m] || 0) - (a[m] || 0)).map((p, i) => `
    <tr class="${p.me ? 'me' : ''}"><td class="n">${['🥇', '🥈', '🥉'][i] || i + 1}</td><td><img src="${esc(p.avatar || '')}" alt="">${esc(p.name)}${p.me ? ' (toi)' : ''}</td>
    <td class="${m === 'level' || m === 'xp' ? 'hl' : ''}">${esc(p.level)}${!p.me && rankTab === 'friends' ? ` <button class="ghost sm" data-cmp="${esc(p.steamid)}" title="Comparer tes badges avec ${esc(p.name)}">⚔</button>` : ''}</td><td class="${m === 'badgeCount' ? 'hl' : ''}">${nf(p.badgeCount)}</td><td class="${m === 'rarity' ? 'hl' : ''}">${nf(p.rarity)}${p.rareCount != null ? ` <small class="mut">· ${esc(p.rareCount)} rares</small>` : ''}</td></tr>`).join('')}</table>`;
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
$('#filt').onchange = () => { filter = prefs.filter = $('#filt').value; savePrefs(); lastSig = ''; render(); };
$('#q').oninput = () => { $('#qx').hidden = !$('#q').value; st && draw(); };
$('#qx').onclick = () => { $('#q').value = ''; $('#qx').hidden = true; $('#q').focus(); lastSig = ''; st && draw(); }; $('#sort').onchange = () => { prefs.sort = $('#sort').value; savePrefs(); st && draw(); };
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
  $('#s_cval').value = c.CREDIT_VALUE || ''; $('#s_cbal').value = c.CREDITS_BALANCE; $('#s_lb').value = c.LEADERBOARD_URL;
  for (const [id, k] of [['s_pwd', 'STEAM_PASSWORD'], ['s_shared', 'STEAM_SHARED_SECRET'], ['s_ident', 'STEAM_IDENTITY_SECRET']]) { $('#' + id).value = ''; $('#' + id).placeholder = c[k + '_SET'] ? '••••••• (enregistré)' : ''; }
  $('#s_son').checked = c.SCHED_ON === '1'; $('#s_stime').value = c.SCHED_TIME || '03:00';
  const sel = new Set((c.SCHED_TASKS || 'badges,cards,bot,balance,verify').split(','));
  $('#s_stasks').innerHTML = [['badges', '🏅 Badges'], ['cards', '🃏 Cartes & sets'], ['boosters', '📦 Boosters / 💎 Gemmes'], ['bot', '🤖 Bot (SCE)'], ['balance', '💳 Solde'], ['friends', '👥 Amis'], ['verify', '✅ Vérifier les jeux']].map(([k, n]) => `<label class="check"><input type="checkbox" data-st="${k}" ${sel.has(k) ? 'checked' : ''}> ${n}</label>`).join('');
  markTheme(); renderUpdate(); renderSce(); $('#sdlg').showModal();
}
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
$('#exp').onclick = safe(async (e) => { e.preventDefault(); const d = await api('/api/export'); d.prefs = prefs; download('steam-badge-trader-sauvegarde.json', new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' })); toast('Sauvegarde exportée'); });
$('#expcsv').onclick = safe(async (e) => { e.preventDefault(); const r = await fetch('/api/export.csv'); download('steam-badge-trader-sets.csv', await r.blob()); toast('CSV exporté'); });
$('#imp').onclick = (e) => { e.preventDefault(); $('#impfile').click(); };
$('#impfile').onchange = safe(async () => {
  const f = $('#impfile').files[0]; if (!f) return; $('#impfile').value = '';
  let d; try { d = JSON.parse(await f.text()); } catch { throw new Error('Fichier illisible (JSON attendu)'); }
  if (d.prefs && typeof d.prefs === 'object') { Object.assign(prefs, d.prefs); savePrefs(); }
  const r = await api('/api/import', { data: d }); toast(`Importé : ${r.wishlist} souhait(s), ${r.alerts} alerte(s), ${r.history} point(s) d'historique`); poll();
});
$('#ssave').onclick = async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', { STEAM_PROFILE: $('#s_profile').value, STEAM_API_KEY: $('#s_key').value, CURRENCY: $('#s_cur').value, STEAM_ACCOUNT: $('#s_acc').value,
      BOT_ONLY: $('#s_botonly').checked ? '1' : '0', AUTO_CARDS: $('#s_autocards').checked ? '1' : '0', CREDITS_BALANCE: $('#s_cbal').value.replace(',', '.'), CREDIT_VALUE: $('#s_cval').value.replace(',', '.'), SCHED_ON: $('#s_son').checked ? '1' : '0', SCHED_TIME: $('#s_stime').value || '03:00', SCHED_TASKS: [...document.querySelectorAll('#s_stasks [data-st]:checked')].map((x) => x.dataset.st).join(','), LEADERBOARD_URL: $('#s_lb').value,
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
