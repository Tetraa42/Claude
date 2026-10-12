// Envoi d'offres d'échange Steam (connexion locale, rien ne quitte ton ordinateur sauf vers Steam).
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');

const state = { client: null, manager: null, community: null, ready: false, needGuard: false, error: null, resolveGuard: null };

function login(env, guardCode) {
  return new Promise((resolve, reject) => {
    if (state.ready) return resolve('ready');
    if (!env.STEAM_ACCOUNT || !env.STEAM_PASSWORD) return reject(new Error('STEAM_ACCOUNT / STEAM_PASSWORD manquent dans .env'));
    const client = new SteamUser();
    const community = new SteamCommunity();
    const manager = new TradeOfferManager({ steam: client, community, language: 'fr' });
    Object.assign(state, { client, community, manager, error: null, needGuard: false });
    const opts = { accountName: env.STEAM_ACCOUNT, password: env.STEAM_PASSWORD };
    if (env.STEAM_SHARED_SECRET) opts.twoFactorCode = SteamTotp.generateAuthCode(env.STEAM_SHARED_SECRET);
    else if (guardCode) opts.twoFactorCode = guardCode;
    const timer = setTimeout(() => reject(new Error('Délai dépassé pendant la connexion')), 30000);
    client.on('steamGuard', (domain, cb) => {
      if (guardCode) return cb(guardCode);
      state.needGuard = true; clearTimeout(timer); resolve('guard');
      state.resolveGuard = cb;
    });
    client.on('webSession', (sid, cookies) => {
      manager.setCookies(cookies, (e) => {
        if (e) { clearTimeout(timer); return reject(e); }
        community.setCookies(cookies);
        state.ready = true; state.needGuard = false; clearTimeout(timer); resolve('ready');
      });
    });
    client.on('error', (e) => { state.error = e.message; clearTimeout(timer); reject(e); });
    client.logOn(opts);
  });
}

function submitGuard(code) {
  if (!state.resolveGuard) throw new Error('Aucun code Steam Guard attendu');
  const cb = state.resolveGuard; state.resolveGuard = null; cb(code);
}

function sendOffer(env, { tradeUrl, give, ask, message }) {
  return new Promise((resolve, reject) => {
    if (!state.ready) return reject(new Error('Pas connecté à Steam'));
    const offer = state.manager.createOffer(tradeUrl);
    for (const id of give) offer.addMyItem({ appid: 753, contextid: '6', assetid: String(id), amount: 1 });
    for (const id of ask) offer.addTheirItem({ appid: 753, contextid: '6', assetid: String(id), amount: 1 });
    offer.setMessage(message || 'Échange de cartes pour compléter un badge');
    offer.send((err, status) => {
      if (err) return reject(err);
      if (status === 'pending' && env.STEAM_IDENTITY_SECRET) {
        return state.community.acceptConfirmationForObject(env.STEAM_IDENTITY_SECRET, offer.id, (e) =>
          e ? resolve({ id: offer.id, status: 'pending', note: 'Offre envoyée, confirme-la sur ton mobile.' })
            : resolve({ id: offer.id, status: 'sent', note: 'Offre envoyée et confirmée.' }));
      }
      resolve({ id: offer.id, status, note: status === 'pending' ? 'Offre envoyée : confirme-la dans l\'app Steam mobile.' : 'Offre envoyée.' });
    });
  });
}
module.exports = { state, login, submitGuard, sendOffer };
