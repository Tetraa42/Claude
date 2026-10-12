# Serveur de classement (optionnel)

Permet le classement **entre tous les utilisateurs** de Steam Badge Trader (niveau, nombre de badges, rareté).
Il faut l'héberger quelque part (n'importe quel hébergeur Node.js, ou un PC allumé en permanence) :

    STEAM_API_KEY=ta_clé node server.js

Puis, dans l'application : Réglages → « Adresse du serveur de classement » (ex. `https://mon-serveur.exemple`) → onglet Classement → « Rejoindre ».
Le serveur ne stocke que des données publiques du profil Steam (pseudo, avatar, niveau, badges) qu'il récupère lui-même.
