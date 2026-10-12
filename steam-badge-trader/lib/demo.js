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

function demoOverview() {
  const sets = GAMES.map((g, i) => {
    const total = 5 + (i % 3);
    const cards = Array.from({ length: total }, (_, k) => {
      const price = +(0.03 + ((i * 7 + k * 5) % 11) * 0.02).toFixed(2);
      const owned = (k + i) % 3 === 0 ? 0 : (k * i) % 4 === 0 ? 2 : 1;
      return { hash: `${g.appid}-${CARD_NAMES[k]}`, name: CARD_NAMES[k], price, priceText: price.toFixed(2).replace('.', ',') + '€', listings: 120 + k * 9,
        img: cardUrl(g.appid, k), owned, assetids: Array.from({ length: owned }, (_, j) => `d${g.appid}_${k}_${j}`) };
    });
    const missing = cards.filter((c) => !c.owned);
    return { appid: g.appid, name: g.name, badgeLevel: i % 4 === 3 ? 1 : 0, total, ownedUnique: total - missing.length,
      cost: +missing.reduce((t, c) => t + c.price, 0).toFixed(2), dupes: cards.reduce((t, c) => t + Math.max(0, c.owned - 1), 0),
      costPerXp: 0, cards, link: `https://www.steamcardexchange.net/index.php?gamepage-appid-${g.appid}` };
  }).sort((a, b) => a.cost - b.cost);
  const xp = 4310, L = levelFromXp(xp);
  return { demo: true, profile: { steamid: '76561198000000000', name: 'quarantdeux (démo)', avatar: '/art/avatar.svg', url: 'https://steamcommunity.com/id/quarantdeux/',
    level: L.level, xp, intoLevel: L.intoLevel, needed: L.needed, badges: [] }, sets, totalCards: 41 };
}

function svgAvatar() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#66c0f4"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="120" height="120" fill="url(#a)"/><circle cx="60" cy="46" r="22" fill="#fff" opacity=".9"/><path d="M16 112c4-30 26-40 44-40s40 10 44 40z" fill="#fff" opacity=".9"/></svg>`;
}
module.exports = { demoOverview, svgCard, svgAvatar };
