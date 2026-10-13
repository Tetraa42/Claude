# Steam Badge Trader

Application locale (Node.js + navigateur) pour monter de niveau Steam : elle liste les sets de cartes à compléter **du moins cher au plus cher**, montre le niveau atteignable, et envoie une offre d'échange en un clic.

## Installer sur Windows (le plus simple)
Télécharge `Steam-Badge-Trader-Setup-x.x.x.exe` depuis l'onglet **Releases** du dépôt GitHub, double-clique, installe : un raccourci est créé sur le **Bureau** et dans le **menu Démarrer**. Au premier lancement, la fenêtre **Réglages** s'ouvre : colle ton profil + ta clé API Steam.

## Fonctions
- Analyse en tâche de fond : les sets apparaissent au fur et à mesure, Steam qui limite le débit (429) = l'app attend et reprend toute seule, le cache (12 h) évite de tout refaire à chaque « Actualiser ».
- Filtres : presque à 100 %, prêts à crafter, nouveaux badges, badges en cours, doublons, < 0,50 €, chez le bot, chez des amis, badges terminés.
- 🤖 Bot SteamCardExchange : son inventaire est lu depuis le tableau « Inventory » du site (stock, cartes différentes, valeur en crédits par jeu) — pas depuis Steam, trop gros (Steam bloquait avec des erreurs 429). Les échanges avec le bot se font sur son site (« Make Offer »). 👥 Amis : « Scanner mes amis » (liste d'amis publique requise ; lent : ~3 s par ami).

## Scans (boutons qui se remplissent)
Au lancement, seule ta **page de badges** est lue (profil, badges terminés, cartes à récupérer en jouant). Le reste se lance avec des boutons, chacun avec son % et son temps restant estimé :
🏅 Badges · 🃏 Cartes & sets (inventaire + prix) · 📦 Boosters · 💎 Gemmes (même requête Steam que les cartes) · 🤖 Bot SCE · 👥 Amis · 💳 Solde.
Dans la fiche d'un jeu : « 🤖 Le bot a-t-il mes cartes ? » lit la page du jeu chez le bot (stock et prix carte par carte) ; « 🔄 Vérifier tout ce jeu » ajoute les prix Steam à jour.

## Fiche badge, panier, crédits
- Clique sur un jeu : fiche avec cartes, prix, crédits, boosters (bouton d'ouverture), et échanges possibles (bot / amis).
- Coche des cartes de plusieurs jeux : elles vont dans le **panier**, puis un seul « Lancer l'échange » (tu peux exclure des cartes demandées ou choisir celles que tu donnes).
- Crédits SteamCardExchange : Réglages → connexion au site (fenêtre intégrée), lecture du solde et des crédits par carte. Lecture heuristique : si rien ne remonte, « Copier le diagnostic ».
- Tout est sauvegardé au fur et à mesure (et à la fermeture) ; filtres, tri, panier et onglets sont retrouvés au prochain lancement.

## Mise à jour
Réglages → **⬇ Mettre à jour le logiciel** : l'app cherche la dernière release GitHub, la télécharge, puis redémarre dessus. Tes réglages et les analyses mémorisées (dossier de données de l'app) sont conservés.

## Classement
- Entre amis : niveau, nombre de badges, rareté (lit les badges publics de tes amis).
- Entre utilisateurs de l'app : nécessite un serveur (`leaderboard-server/`, voir son README) dont l'adresse se renseigne dans les Réglages.

## Lancer depuis le code
```bash
cd steam-badge-trader
npm install
npm run demo        # aperçu avec données fictives, sans Steam
```
Pour ton vrai compte : copie `.env.example` en `.env`, mets ta clé API Steam (https://steamcommunity.com/dev/apikey) puis `npm start` → http://localhost:3000

## Fonctionnement
- Niveau/XP et badges : API Steam officielle. Cartes : inventaire public (profil et inventaire en **Public**).
- Prix : Marché Communautaire Steam (le moins cher en vente), lien « Comparer sur SCE » vers steamcardexchange.net.
- Chaque badge (ou niveau de badge, jusqu'à 5) = 100 XP. Le coût d'un set = somme des cartes manquantes.
- Bouton « Lancer l'échange » : colle le lien d'échange d'un partenaire ; l'app demande ses cartes manquantes pour ton set et offre tes doublons. Connexion Steam locale (`STEAM_ACCOUNT`, `STEAM_PASSWORD`, code Steam Guard demandé dans l'UI).
- Crafter le badge se fait sur Steam (bouton ouvre la page du jeu).

`.env` n'est jamais commité. Respecte les conditions d'utilisation de Steam ; n'échange qu'avec des partenaires de confiance.

## Nouveautés
- **■ Arrêter** un scan en cours (bouton carré sur chaque tuile, ou re-clic sur les boutons de vérification d'un jeu).
- **✕** dans la barre de recherche pour la vider.
- **💎 Gemmes** : valeur d'une carte en gemmes, prix du booster de chaque jeu, et fabrication d'un booster (onglet Boosters → « Charger les prix des boosters », ou depuis la fiche d'un jeu). Une confirmation est demandée et la connexion Steam est nécessaire.
- Prix **achat / revente** de chaque carte chez le bot SteamCardExchange, coût total de tes manquantes en crédits, valeur de tes doublons et prix du badge affiché sur le site.
- **Bouton « Prêt à échanger »** (rouge → orange → vert) : liste ce qu'il reste à faire (badges, cartes, inventaire du bot, solde, jeux vérifiés chez le bot) avec des boutons pour le lancer ; une fois tout vert, il propose un bouton par jeu complétable (cartes à acheter au bot, prix en crédits, et doublons à revendre pour payer). Chaque bouton ouvre la page du jeu sur SteamCardExchange, où l'échange est confirmé.
- **⭐ Liste de souhaits** : étoile sur les cartes manquantes ; avertissement quand le bot (ou un ami scanné) a la carte.
- Les cartes des amis ne sont plus utilisées pour les échanges (seulement pour la liste de souhaits).
- Page d'un jeu chez le bot : lecture corrigée (blocs « Stock / Worth / Price »).
- Amis de retour : cartes manquantes colorées (turquoise = chez le bot, violet = chez un ami, double contour = les deux), pastilles cliquables par carte (ami → page d'échange, bot → page du jeu chez le bot).
- « Ouvrir un booster » ouvre l'inventaire Steam avec le booster déjà sélectionné.
- **📈 Progrès** : courbes d'XP, badges, crédits et gemmes, rythme d'XP par jour et date estimée du prochain niveau.
- **💡 Bons plans** : cartes à acheter sur le marché Steam pour les revendre au bot (crédits par monnaie, gain net si la valeur d'un crédit est renseignée) et comparaison marché / bot pour compléter un set.
- **🔔 Alertes de prix** : seuil sur une carte de la liste de souhaits, ou sur le coût d'un set entier (fiche du jeu).
- **💾 Sauvegarde** (Réglages) : export/import JSON (souhaits, alertes, historique, préférences, réglages non secrets) et export CSV des sets.
- **🎯 Objectif de niveau**, **🎴 cartes à récupérer en jouant** (bouton « Lancer le jeu », rappel quotidien) et **📅 soldes Steam** (dates indicatives, modifiables) dans l'onglet Progrès.
- **♻ Doublons à revendre** (quoi vendre au bot pour financer le prochain set) et **💎 badges rares à viser** (d'après les badges de tes amis) dans Bons plans.
- **💎 Rentabilité des boosters** (valeur des 3 cartes pour 1 000 gemmes) dans le catalogue de boosters.
- **⚔ Comparaison avec un ami** (Classement → ⚔).
- **⏰ Planificateur** (Réglages) : scans automatiques quotidiens quand l'app est ouverte.
- **📒 Journal** des échanges, achats, ventes et fabrications (automatique pour les offres envoyées / boosters fabriqués, bouton « ✔ Fait » dans le plan d'échanges).
- **🤖 Mode auto** (ex-« Vérifier les jeux ») : page où l'on coche les cartes voulues (bot ou ami, avec prix d'achat et de rachat) et les cartes à donner ; l'app prépare des échanges de **6 cartes maximum de chaque côté**. Bot : ouvre la page du jeu dans une fenêtre déjà connectée, cartes surlignées ; amis : envoi de l'offre Steam puis ouverture de la page de l'offre.
- Tuiles de badges : cartes manquantes en gros, colorées (bot / ami / les deux) avec compteurs ; filtre « Tous mes badges » ; amis mémorisés entre deux lancements ; historique des échanges SteamCardExchange importé dans le Journal.
- **10 nouveaux thèmes** dessinés pour l'app (aucune ressource externe) : Écran CRT, Ordi ambre 80s, Néon, Cyberpunk, Steampunk, Synthwave, Game Boy, Vaporwave, Parchemin, Arcade.
- **Mode auto = la grande barre colorée du haut** (rouge → orange → vert) ; tous les scans et actions sont dans le menu déroulant « ☰ Menu ».
- **Page 👥 Amis** : pour chaque ami, les badges où il lui manque des cartes que tu as en double, et ce qu'il a pour toi ; diagnostic de lecture copiable.
- Cartes manquantes dans l'ordre du set (colorées), cliquables pour les ajouter aux souhaits ; bouton « 🔎 Vérifier doubles & manquantes du bot » dans le Mode auto.
- **Mode auto** lit aussi les inventaires des amis ; tu peux choisir **toutes tes cartes** (pas seulement les doublons) ; **panier** consultable (👁) avec bouton 🛒 « Ajouter les manquantes » sur chaque badge ; l'échange avec un ami envoie l'offre Steam (connexion Steam si besoin) puis **ouvre la fenêtre de l'offre** ; page Amis en menus déroulants avec tuiles et proposition d'échange (6 cartes max de chaque côté) ; coût en crédits dans l'onglet Souhaits.
