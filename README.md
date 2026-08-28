# Deux jeux, un seul service Render

Un serveur Node unique qui héberge les deux jeux, pour ne consommer qu'un seul
service gratuit :

| Jeu | Adresse |
|---|---|
| Accueil (choix du jeu) | `/` |
| Le Loup-Garou — joueurs | `/loup-garou/` |
| Le Loup-Garou — console du meneur | `/loup-garou/mj.html` |
| Imposteur | `/imposteur/` |

Aucune dépendance : uniquement les modules natifs de Node.

## Arborescence à respecter

```
.
├── server.js
├── package.json
├── README.md
└── public/
    ├── index.html          ← page d'accueil
    ├── style.css           ← styles du Loup-Garou (doit rester à la racine de public)
    ├── loup-garou/
    │   ├── index.html      ← page « rejoindre »
    │   ├── mj.html         ← console du meneur
    │   └── joueur.html     ← écran d'un joueur
    └── imposteur/
        └── index.html
```

## Mise à jour d'un dépôt Render existant

Si le Loup-Garou est déjà déployé, il suffit de remplacer le contenu du dépôt :

1. Supprimer les anciens `server.js` et le contenu de `public/`.
2. Envoyer les fichiers ci-dessus en respectant l'arborescence.
3. Vérifier que la commande de démarrage du service Render est bien `node server.js`
   et que la commande de build est vide.
4. Pousser sur GitHub : Render redéploie automatiquement.

L'URL du service ne change pas. Les anciens liens `/mj.html` deviennent
`/loup-garou/mj.html` — pensez à mettre à jour les raccourcis enregistrés sur les
téléphones.

## Séparation des deux jeux

Les deux jeux ne partagent que le serveur HTTP. Leurs sessions, leurs codes à 4
caractères et leurs flux temps réel sont indépendants :

- Loup-Garou : routes `/api/*` et `/sse`
- Imposteur : routes `/imposteur/api/*`
- `/api/ping` : garde-éveillé commun (utilisé par la console du meneur)

Deux parties peuvent donc tourner en même temps sans interférence, y compris si
les deux tirent le même code à 4 caractères.

## Limites de l'offre gratuite

- Le service s'endort après une période d'inactivité : le premier chargement de la
  soirée peut demander une trentaine de secondes.
- Les parties vivent en mémoire. Un redémarrage du service les efface, mais les
  deux jeux savent se reconstituer : le meneur du Loup-Garou récupère sa session,
  et les joueurs reprennent leur place automatiquement.
- Une session inactive depuis 8 heures est supprimée automatiquement.

## Modifier les catégories de l'Imposteur

Le bloc `CATEGORIES` se trouve dans `server.js`, section « IMPOSTEUR ». Même format
que dans la version hors ligne : `label` et une liste de paires.
