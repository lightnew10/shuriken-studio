# Coop à deux dans Shuriken Studio

## Ouvrir une session

1. Les deux PC utilisent une version de Shuriken compatible avec le protocole coop v2. L’hôte ouvre le projet et garde sa copie de travail et Roblox Studio.
2. Dans **Paramètres → Collaboration**, l’hôte configure l’adresse du relais HTTPS compatible v2 et crée une invitation. Il transmet le lien complet en privé au coéquipier. Le lien expire au bout de dix minutes et sert une seule fois.
3. Le coéquipier renseigne son nom et colle le lien dans Shuriken. L’hôte vérifie le nom de la personne et l’admet. Il peut suspendre les demandes ordinaires ou révoquer la session.
4. Dans **Collaboration**, chaque personne peut proposer un travail. Le Directeur, l’état des tâches, les résultats et les résumés des preuves sont partagés. Les fichiers, pièces jointes et captures restent sur le PC hôte. Les participants peuvent partager explicitement un extrait via la conversation.

La reconnexion est automatique pendant la fenêtre de dix minutes après une coupure. Après un redémarrage, rouvrir le projet sur l’hôte puis utiliser **Resume saved host session** ou **Resume saved guest session** dans les paramètres. La reprise requiert le coffre chiffré Electron du poste et une session toujours valide sur le relais.

## Contribuer au pool

Dans **Paramètres → Comptes IA**, chaque personne ajoute et vérifie ses clés Groq ou OpenRouter, puis choisit les modèles Fast, Balanced et Deep. Dans **Collaboration**, elle choisit les clés qu’elle contribue et fixe un plafond quotidien par clé. Les appels d’inférence consomment ce plafond dans le fuseau local du propriétaire. Un appel interrompu peut avoir été reçu par le fournisseur et reste comptabilisé.

L’hôte autorise chaque fournisseur à recevoir le contexte du projet et établit un ordre commun. Le propriétaire réalise l’appel HTTPS avec la clé de son coffre. Shuriken vérifie le catalogue avant les inférences. OpenRouter impose le prix maximal de zéro et Groq dépend du forfait Free Tier déclaré par le propriétaire. Les tâches partagées se mettent en attente si aucune clé autorisée n’est disponible.

Claude et Codex restent des contributions personnelles. Lancez la demande dans votre client, puis collez l’extrait retenu dans **Share a contribution from your own client**. L’autre personne peut en demander l’application depuis le projet partagé.

## Protocole et persistance

- Le Worker existant achemine les trames v2. `GET /health` indique `coopVersion: 2`. Les apps vérifient la version à la connexion.
- La clé d’appairage figure dans le fragment de l’invitation et reste sur les deux apps. Des défis authentifiés établissent les clés directionnelles HKDF. AES-256-GCM et des numéros de séquence protègent le contenu. Le relais voit les informations de transport, les noms de connexion et la taille des trames.
- Le core hôte contrôle le projet, les outils et les effets. Toute publication, dépense ou action à risque passe par l’approbation de l’hôte, y compris en mode autonome.
- SQLite conserve l’auteur et l’identifiant de la demande, les runs, le quota et les effets. Une écriture confirmée avec les mêmes arguments est réutilisée à la reprise. Si l’état d’une opération est incertain, l’hôte vérifie le fichier ou Studio, puis confirme dans l’espace Collaboration si l’effet a eu lieu.

## Qualification sur deux PC

Sur un relais de test autorisé et une place Roblox isolée, configurer une clé jetable sur chaque PC. Donner priorité à la clé du coéquipier, puis faire lancer une tâche par chaque personne. Vérifier le fournisseur dans les deux apps, la modification dans Studio chez l’hôte, l’autorisation locale des opérations à risque et l’absence de clé dans le trafic du relais. Couper le réseau du coéquipier après une écriture confirmée, vérifier la reprise sur la route suivante, puis rétablir la connexion. Contrôler que le journal contient une seule écriture appliquée. Enfin, révoquer la session et vérifier que le coéquipier ne peut plus s’y reconnecter.

`tests/coop.test.ts` couvre les deux cores, le Worker avec stockage et sockets simulés, le rejeu, l’invitation, la reprise et la révocation. `tests/autonomous-mode.test.ts` vérifie les approbations sur l’hôte. Ces tests utilisent des clés fictives et des dossiers temporaires. La qualification sur deux PC, le relais Cloudflare déployé et le parcours Studio restent à effectuer.

## Résultats locaux

Sur Windows, avec Node 25.0.0 et Vitest 4.1.12, le typage et le build Electron passent. La suite standard a compté 2 086 tests réussis et 19 ignorés. Les exclusions concernent 17 vérifications Luau dépendantes de Selene ou luau-lsp et deux tests nécessitant les fichiers d’un projet de drift local. Les 34 tests ciblés ont été rejoués après les derniers changements de routage et d’affichage.

Pour revenir au mode individuel, l’hôte révoque la session depuis **Paramètres → Collaboration**. Les demandes déjà enregistrées dans le journal coop restent liées au pool et peuvent être annulées depuis les tâches. Les migrations SQLite sont additives. Sauvegarder les bases et le dossier de projet avant de réinstaller une ancienne version.
