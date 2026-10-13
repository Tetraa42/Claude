// Mode démo : données fictives + illustrations SVG générées (aucun accès Steam requis).
const { levelFromXp } = require('./levels');

const GAMES = [
  ['Starfall Odyssey', 210, [210, 280]], ['Neon Samurai', 330, [330, 40]], ['Cave of Embers', 20, [20, 20]],
  ['Pixel Pirates', 150, [150, 200]], ['Mecha Garden', 270, [270, 160]], ['Frost Kingdom', 200, [200, 230]],
  ['Void Runners', 300, [300, 100]], ['Candy Rally', 45, [45, 330]],
].map(([name, hue], i) => ({ appid: 900000 + i, name, hue }));
const CARD_NAMES = ['Héros', 'Gardien', 'Ombre', 'Relique', 'Forteresse', 'Dragon', 'Éclair', 'Mage', 'Voyageur'];

const cardUrl = (appid, i) => `/art/${appid}/${i}.svg`;

function svgCard(appid, i, w = 192, h = 192) {
  const g = GAMES.find((x) => x.appid === Number(appid)) || GAMES[0];
  const h1 = (g.hue + i * 23) % 360, h2 = (h1 + 60) % 360, n = CARD_NAMES[i % CARD_NAMES.length];
  const shapes = [0, 1, 2, 3, 4].map((k) => {
    const x = (k * 53 + i * 31) % 160 + 16, y = (k * 71 + i * 17) % 120 + 20, r = 14 + ((k * 13 + i * 7) % 34);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="hsl(${(h1 + k * 40) % 360} 90% 65% / .28)"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1} 80% 38%)"/><stop offset="1" stop-color="hsl(${h2} 85% 18%)"/></linearGradient>
<radialGradient id="r"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="${w}" height="${h}" rx="14" fill="url(#g)"/>${shapes}
<circle cx="96" cy="84" r="46" fill="url(#r)"/><polygon points="96,40 112,76 150,80 122,104 130,142 96,122 62,142 70,104 42,80 80,76" fill="hsl(${h1} 95% 78%)" opacity=".92"/>
<rect x="10" y="150" width="172" height="32" rx="8" fill="#000" opacity=".45"/>
<text x="96" y="171" text-anchor="middle" font-family="Segoe UI,Arial" font-weight="700" font-size="15" fill="#fff">${n}</text></svg>`;
}

const FRIENDS = ['Lucas', 'Emma', 'Hugo', 'Chloé', 'Nathan', 'Léa'];
function svgBanner(appid) {
  const g = GAMES.find((x) => x.appid === Number(appid)) || { name: 'Jeu', hue: 200 };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 215"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${g.hue} 70% 32%)"/><stop offset="1" stop-color="hsl(${(g.hue + 70) % 360} 80% 14%)"/></linearGradient></defs><rect width="460" height="215" fill="url(#b)"/><g opacity=".25" fill="#fff"><circle cx="380" cy="50" r="90"/><circle cx="60" cy="190" r="70"/></g><text x="24" y="120" font-family="Segoe UI,Arial" font-weight="800" font-size="34" fill="#fff">${g.name}</text></svg>`;
}

function demoState() {
  const sets = [], myCards = [];
  GAMES.forEach((g, i) => {
    const total = 5 + (i % 3);
    const cards = Array.from({ length: total }, (_, k) => {
      const price = +(0.03 + ((i * 7 + k * 5) % 11) * 0.02).toFixed(2);
      const owned = (k + i) % 3 === 0 ? 0 : (k * i) % 4 === 0 ? 2 : 1;
      const hash = `${g.appid}-${CARD_NAMES[k]}`;
      const assetids = Array.from({ length: owned }, (_, j) => `d${g.appid}_${k}_${j}`);
      assetids.forEach((id) => myCards.push({ assetid: id, hash, name: CARD_NAMES[k], appid: g.appid, img: cardUrl(g.appid, k), tradable: true }));
      return { hash, name: CARD_NAMES[k], price, priceText: price.toFixed(2).replace('.', ',') + '€', listings: 120 + k * 9, img: cardUrl(g.appid, k), owned, assetids };
    });
    const missing = cards.filter((c) => !c.owned);
    sets.push({ appid: g.appid, name: g.name, badgeLevel: i % 4 === 3 ? 1 : 0, total, ownedUnique: total - missing.length, missingCount: missing.length,
      cost: +missing.reduce((t, c) => t + c.price, 0).toFixed(2), dupes: cards.reduce((t, c) => t + Math.max(0, c.owned - 1), 0), cards,
      banner: `/art/banner/${g.appid}.svg`, link: `https://www.steamcardexchange.net/index.php?gamepage-appid-${g.appid}` });
  });
  const xp = 4310, L = levelFromXp(xp);
  return {
    sets, myCards, currency: 3,
    profile: { steamid: '76561198000000000', name: 'quarantdeux (démo)', avatar: '/art/avatar.svg', url: 'https://steamcommunity.com/id/quarantdeux/', level: L.level, xp, intoLevel: L.intoLevel, needed: L.needed, badges: [] },
    completed: [['Ocean Keepers', 120], ['Rogue Station', 260], ['Tiny Tanks', 20]].map(([name, hue], i) => ({ appid: 800000 + i, name, level: 5, banner: `/art/banner/${800000 + i}.svg` })),
    bot: { status: 'ready', error: null, name: 'SteamCardExchange (démo)', count: 18420, games: GAMES.length, t: Date.now() },
    retry: { at: 0, n: 0 },
    friends: { status: 'idle', error: null, done: 0, total: FRIENDS.length, list: FRIENDS.map((n, i) => ({ steamid: '7656119800' + i, name: n, avatar: '/art/avatar.svg' })), inv: new Map() },
    boosters: GAMES.slice(0, 3).flatMap((g, i) => Array.from({ length: i + 1 }, (_, k) => ({ assetid: `bo${g.appid}_${k}`, appid: g.appid, name: g.name + ' Booster Pack', game: g.name, img: cardUrl(g.appid, 4 + i), tradable: true }))),
    rank: { status: 'idle', error: null, done: 0, total: 0, list: [], t: 0 },
    drops: new Map(GAMES.map((g, i) => [g.appid, i % 3 === 0 ? 0 : (i % 3) + 1])),
    updatedAt: Date.now(), phase: '', done: 0, total: 0,
  };
}

function demoRank(S) {
  const rows = [['Lucas', 41, 212, 9, 410.5], ['Emma', 33, 160, 4, 295.2], ['Hugo', 58, 340, 22, 780.9], ['Chloé', 27, 98, 2, 150.4], ['Nathan', 46, 255, 12, 520.1], ['Léa', 19, 61, 1, 88.8]];
  const list = rows.map(([name, level, badgeCount, rareCount, rarity], i) => ({ steamid: '7656119800' + i, name, avatar: '/art/avatar.svg', me: false, level, xp: level * 150, badgeCount, rareCount, rarity }));
  list.push({ steamid: S.profile.steamid, name: S.profile.name, avatar: S.profile.avatar, me: true, level: S.profile.level, xp: S.profile.xp, badgeCount: 118, rareCount: 5, rarity: 232.7 });
  return list;
}


function demoCredits(sce) {
  sce.setDemo(GAMES.map((g, i) => ({ appid: g.appid, name: g.name, worth: 3 + i * 2, stock: 6 + i * 3, cardsInSet: 5 + (i % 3), setsAvail: i % 3 === 0 ? 1 : 0, distinct: 2 + (i % 4) })));
}

function fillFriends(F, S) {
  const missing = S.sets.flatMap((s) => s.cards.filter((c) => !c.owned));
  F.list.forEach((f, i) => {
    const m = new Map();
    missing.forEach((c, k) => { if ((k + i) % 3 === 0) m.set(c.hash, [{ assetid: `f${i}_${k}`, tradable: true }]); });
    F.inv.set(f.steamid, m);
  });
  F.all = new Map(); F.log = {};
  F.list.forEach((f, i) => {
    const per = new Map();
    for (const st of S.sets) { const have = new Set(); st.cards.forEach((c, k) => { if ((k + i) % 2 === 0) have.add(c.hash); }); if (have.size) per.set(st.appid, have); }
    F.all.set(f.steamid, per); F.log[f.steamid] = `${[...per.values()].reduce((t, x) => t + x.size, 0)} carte(s) en tout · démo`;
  });
  F.done = F.total; F.status = 'ready';
}

function svgAvatar() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#66c0f4"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="120" height="120" fill="url(#a)"/><circle cx="60" cy="46" r="22" fill="#fff" opacity=".9"/><path d="M16 112c4-30 26-40 44-40s40 10 44 40z" fill="#fff" opacity=".9"/></svg>`;
}
// badges des amis (démo) : certains communs avec tes jeux, d'autres rares que tu n'as pas
function demoBadges(S) {
  const mine = S.sets.map((x) => x.appid), out = new Map();
  ['76561198000000', '76561198000001', '76561198000002', '76561198000003', '76561198000004', '76561198000005'].forEach((_, i) => {
    const id = '7656119800' + i, list = [];
    mine.forEach((a, k) => { if ((k + i) % 2 === 0) list.push({ appid: a, level: 1 + ((k + i) % 4), xp: 100, scarcity: 20000 + k * 9000 }); });
    for (let k = 0; k < 4; k++) list.push({ appid: 880000 + i * 10 + k, level: 1, xp: 100, scarcity: 300 + k * 2500 + i * 150 });
    out.set(id, list);
  });
  return out;
}
module.exports = { demoBadges, demoCredits, demoState, demoRank, fillFriends, svgCard, svgAvatar, svgBanner };
