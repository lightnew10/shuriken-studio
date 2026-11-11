# Intégration Codex dans Shuriken Studio

Cette intégration est disponible sur la branche de développement `feature/codex-integration`. Claude reste le fournisseur par défaut. La version Codex qualifiée est **0.166.0** : une autre version est signalée dans les réglages et ne déclenche pas l'ancien adaptateur.

1. Ouvrir **Settings → AI accounts** puis **Refresh**. Shuriken réutilise la connexion ChatGPT du Codex officiel déjà installé, sans lire ni copier son fichier d'authentification. Si une connexion est nécessaire, la lancer explicitement depuis les réglages. Aucun compte API ni deuxième compte Codex n'est accepté.
2. Choisir un modèle explicite pour **Fast**, **Balanced** et **Deep**. Le catalogue vient d'App Server. Astra est exclu à la sélection et au démarrage ; une ancienne valeur `default` reste à configurer. Le modèle et l'effort ajusté sont consignés dans le suivi du run.
3. Choisir Codex pour un rôle ou comme fournisseur par défaut. Le fallback **Claude → Codex** est facultatif et exige les trois modèles configurés. Il concerne les nouveaux runs après un signal de quota Claude et cesse au retour de Claude. Une conversation ne passe pas d'un fournisseur à l'autre.
4. Vérifier les limites dans **Codex run limits** : 20 minutes et 200 000 tokens par défaut. La limite de tokens est contrôlée à réception du compteur du fournisseur ; elle ne garantit pas un maximum absolu sur la requête en cours. Les quotas absents et le coût de l'abonnement sont affichés comme inconnus. Un budget monétaire strict est refusé pour Codex.

L'adaptateur lance l'exécutable réel avec `shell: false` et utilise [Codex App Server](https://learn.chatgpt.com/docs/app-server) sur stdio. Chaque run a un processus et un jeton MCP propres. Avant l'inférence, Shuriken vérifie la configuration effective, la connexion ChatGPT, le modèle et l'inventaire MCP autorisé. Les MCP personnels, plugins, hooks, applications et outils natifs d'exécution ou de délégation sont désactivés. Le routage MCP utilise le Code Mode local de Codex 0.166.0. Le mode d'approbation propre au serveur MCP Shuriken [autorise le transport](https://learn.chatgpt.com/docs/extend/mcp), puis Shuriken décide avant chaque effet ; il ne confère aucune approbation de projet.

- Le sandbox natif du tour reste en lecture seule, sans approbation native ni relance avec élévation. Les outils d'accès au projet appliquent les droits du rôle, les règles du projet, le journal et les cartes d'approbation. La publication et les dépenses restent soumises aux règles propriétaire.
- Une écriture contrôlée requiert le SHA-256 de la version lue (ou `absent` à la création), refuse les chemins protégés et les alias par lien, et réserve le fichier avant de l'écrire. La synchronisation ignore les fichiers réservés par un autre run. Une commande d'écriture prend un verrou de mutation du projet.
- Le shell contrôlé requiert le [sandbox Windows avec lecture restreinte](https://learn.chatgpt.com/docs/permissions) ; l'exécuteur utilise un profil projet sans réseau et refuse de continuer si le backend ne le met pas en place. Le poste de validation ne disposait pas du backend requis. Le Python libre de Blender et les plugins Shuriken sont exclus du catalogue Codex ; l'outil borné `blender_create_box` produit une scène et un export GLB avec un script interne fixe. Claude conserve son outil Blender historique. Le scénario réel ne couvre pas l'ensemble des fonctions de modélisation.
- Arrêter un run ferme l'accès aux outils, interrompt le tour et ferme le processus. Les métadonnées de session vérifient le compte, l'adaptateur, le modèle et les permissions. Une session `exec` historique ou incompatible redémarre avec le contexte Shuriken ; l'historique reste lisible.

Vérification locale : `npm run typecheck`, `npm run build`, `npm test -- --maxWorkers=4`. Pour les essais **avec quota réel**, dans un environnement où Studio et Blender sont disponibles :

~~~powershell
$env:CODEX_LIVE = '1'
$env:CODEX_LIVE_MODEL = 'gpt-6-luna'
npx vitest run --config vitest.e2e.config.ts tests/e2e/codex.e2e.ts
~~~

Ces essais créent un projet et des données sous `.cache`, ouvrent leur propre fichier Roblox et ne publient rien. Ne pas les lancer automatiquement. Voir le [rapport de qualification](test-reports/CODEX_2026-11-11.md). Le lanceur Windows n'installe plus Codex et ne déclenche plus une connexion de lui-même. Codex n'est pas inclus dans l'installeur Shuriken.
