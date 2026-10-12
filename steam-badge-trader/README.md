# Steam Badge Trader

Application locale (Node.js + navigateur) pour monter de niveau Steam : elle liste les sets de cartes à compléter **du moins cher au plus cher**, montre le niveau atteignable, et envoie une offre d'échange en un clic.

## Installer sur Windows (le plus simple)
Télécharge `Steam-Badge-Trader-Setup-x.x.x.exe` depuis l'onglet **Releases** du dépôt GitHub, double-clique, installe : un raccourci est créé sur le **Bureau** et dans le **menu Démarrer**. Au premier lancement, la fenêtre **Réglages** s'ouvre : colle ton profil + ta clé API Steam.

## Fonctions
- Analyse en tâche de fond : les sets apparaissent au fur et à mesure, Steam qui limite le débit (429) = l'app attend et reprend toute seule, le cache (12 h) évite de tout refaire à chaque « Actualiser ».
- Filtres : presque à 100 %, prêts à crafter, nouveaux badges, badges en cours, doublons, < 0,50 €, chez le bot, chez des amis, badges terminés.
- 🤖 Bot CardExchange : son inventaire est comparé à tes cartes manquantes. 👥 Amis : « Scanner mes amis » (liste d'amis publique requise).

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
