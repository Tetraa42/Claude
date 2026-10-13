// Réglages enregistrés sur l'ordinateur de l'utilisateur. Les secrets sont chiffrés avec Electron safeStorage quand c'est possible.
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./fsutil');
const SECRET = ['STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'STEAM_IDENTITY_SECRET'];
const KEYS = ['STEAM_PROFILE', 'STEAM_API_KEY', 'CURRENCY', 'STEAM_ACCOUNT', 'BOT_PROFILE', 'BOT_TRADE_URL', 'THEME', 'SEEN_SETUP', 'BOT_ONLY', 'AUTO_CARDS', 'CREDITS_BALANCE', 'CREDITS_PER_CARD', 'CREDIT_VALUE', 'SCHED_ON', 'SCHED_TIME', 'SCHED_TASKS', 'SCHED_LAST', 'LEADERBOARD_URL', 'LB_JOINED', ...SECRET];

let safe = null;
try { const { safeStorage } = require('electron'); if (safeStorage && safeStorage.isEncryptionAvailable()) safe = safeStorage; } catch {}

const enc = (v) => (safe && v ? 'enc:' + safe.encryptString(v).toString('base64') : v);
const dec = (v) => { try { return v && v.startsWith('enc:') && safe ? safe.decryptString(Buffer.from(v.slice(4), 'base64')) : v; } catch { return ''; } };

function load(dir) {
  const f = path.join(dir, 'config.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} // fichier absent ou abîmé : on repart de réglages vides plutôt que de planter
  const out = {};
  for (const k of KEYS) if (raw[k]) out[k] = SECRET.includes(k) ? dec(raw[k]) : raw[k];
  return out;
}
function save(dir, values) {
  const cur = load(dir), next = { ...cur };
  for (const k of KEYS) if (k in values && values[k] !== undefined) {
    if (SECRET.includes(k) && values[k] === '') continue; // vide = on garde l'ancien secret
    next[k] = String(values[k]).trim();
  }
  const raw = {};
  for (const k of KEYS) if (next[k]) raw[k] = SECRET.includes(k) ? enc(next[k]) : next[k];
  writeJsonAtomic(path.join(dir, 'config.json'), raw);
}
module.exports = { load, save, KEYS, SECRET };
