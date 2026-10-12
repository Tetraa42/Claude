# Steam Badge Trader

Application locale (Node.js + navigateur) pour monter de niveau Steam : elle liste les sets de cartes à compléter **du moins cher au plus cher**, montre le niveau atteignable, et envoie une offre d'échange en un clic.

## Lancer
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
