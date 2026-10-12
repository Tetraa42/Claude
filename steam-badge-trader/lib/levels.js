// Steam : passer du niveau L à L+1 coûte (floor(L/10)+1)*100 XP. Chaque badge/niveau de badge = 100 XP.
const xpToNext = (level) => (Math.floor(level / 10) + 1) * 100;
function levelFromXp(xp) {
  let level = 0;
  while (xp >= xpToNext(level)) { xp -= xpToNext(level); level++; }
  return { level, intoLevel: xp, needed: xpToNext(level) };
}
function totalXpForLevel(level) { let t = 0; for (let l = 0; l < level; l++) t += xpToNext(l); return t; }
module.exports = { xpToNext, levelFromXp, totalXpForLevel };
