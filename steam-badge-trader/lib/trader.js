// Envoi d'offres d'échange Steam (connexion locale, rien ne quitte ton ordinateur sauf vers Steam).
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');

const state = { client: null, manager: null, community: null, ready: false, needGuard: false, error: null, resolveGuard: null };

function login(env, guardCode) {
  return new Promise((resolve, reject) => {
    if (state.ready) return resolve('ready');
    if (state.client && state.needGuard && state.resolveGuard) return resolve('guard'); // code déjà demandé : on attend
    if (!env.STEAM_ACCOUNT || !env.STEAM_PASSWORD) return reject(new Error('Renseigne ton nom de compte et ton mot de passe Steam dans ⚙ Réglages (section « Échanges et boosters »).'));
    const client = new SteamUser();
    const community = new SteamCommunity();
    const manager = new TradeOfferManager({ steam: client, community, language: 'fr', pollInterval: -1 }); // pas de surveillance permanente des offres
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
    client.on('disconnected', () => { state.ready = false; }); // steam-user se reconnecte seul : 'webSession' remettra ready à true
    client.on('error', (e) => {
      state.error = e.message; clearTimeout(timer);
      Object.assign(state, { client: null, ready: false, needGuard: false, resolveGuard: null }); // permet de réessayer proprement
      reject(e);
    });
    client.logOn(opts);
  });
}

// attend le résultat d'une saisie de code Steam Guard (connecté, nouvelle demande de code, ou erreur)
async function waitAfterGuard(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (state.ready) return 'ready';
    if (state.error) throw new Error(state.error);
    await new Promise((r) => setTimeout(r, 300));
  }
  return 'guard';
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

function openBooster(appid, assetid) {
  return new Promise((resolve, reject) => {
    if (!state.ready) return reject(new Error('Pas connecté à Steam'));
    state.community.openBoosterPack(appid, String(assetid), (err, items) => (err ? reject(err) : resolve(items.map((i) => ({ name: i.name, img: i.image, foil: !!i.foil })))));
  });
}
module.exports = { state, login, submitGuard, waitAfterGuard, sendOffer, openBooster };
