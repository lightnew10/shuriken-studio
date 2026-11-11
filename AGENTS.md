# Shuriken Studio — consignes pour Codex

Application Windows de création de jeux Roblox avec agents IA, ateliers créatifs et intégrations Studio/Kiln.
Point d'entrée documentaire : [AI_INDEX.md](AI_INDEX.md).

## Architecture et technologies

- Electron 44 : `src/main` supervise un core par onglet ; `src/preload` expose le bridge IPC.
- `src/core` : moteur Node sans import Electron, RPC, orchestration, fournisseurs, outils, SQLite et intégrations.
- `src/renderer` : React 19, Tailwind 4, Three.js ; accès au moteur par RPC et événements.
- TypeScript 7 strict, Node >=24, electron-vite 5, Vitest 4, Zod 4, MCP SDK.
- État durable : SQLite (`node:sqlite`), WAL, migrations progressives ; sessions fournisseurs = cache.

## Conventions

Respecter [CONTRIBUTING.md](CONTRIBUTING.md) et consulter les sections pertinentes de
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Ne pas réécrire une migration appliquée.
Passer les outils agents par `ToolRegistry.invoke` et Studio par `RobloxStudioAdapter`.
Ne pas committer de secrets, identifiants personnels ou journaux de sessions réelles.
Préserver les modifications préexistantes et actualiser la documentation après un changement important.

## Branche et vérifications

- Branche de développement : `feature/codex-integration`, base auditée `7400f17`.
- Le rapport d'audit décrit la base ; le travail de stabilisation est local sur la même branche de développement. Aucun commit, push, déploiement ou publication implicite.
- Pour Codex, lire [l'intégration](docs/CODEX_INTEGRATION.md) et [la qualification](docs/test-reports/CODEX_2026-11-11.md). Ne pas rétablir de voie native qui contourne ToolRegistry.
- Serena TypeScript disponible ; aucun graphe Graphify à l'ouverture. Ne pas installer ni envoyer le code à distance sans autorisation.
- Les tests standard désactivent le Studio et le Kiln de l'utilisateur ; les E2E utilisent des comptes et applications réels : ne pas les lancer automatiquement.
- Ne pas ouvrir un projet réel déjà verrouillé par un autre core. Utiliser des dossiers temporaires pour les vérifications.
- Création d'images autorisée ; création de vidéos soumise à autorisation préalable.

## Commandes vérifiées

- `npm ci --ignore-scripts --no-audit --no-fund` : installation autorisée réussie (506 paquets).
- `npm run typecheck` : réussie.
- `npm run build` : réussie ; ceci ne valide ni le démarrage Electron ni l'installeur.
- `npm test -- --maxWorkers=2 <fichiers>` : suites ciblées. `npm test -- --maxWorkers=4` : suite standard. Résultats, exclusions et différences avec l'audit dans le rapport de qualification.
- `npx vitest run --config vitest.e2e.config.ts tests/e2e/codex.e2e.ts` : uniquement sur autorisation de consommer le quota réel, avec `CODEX_LIVE=1` et `CODEX_LIVE_MODEL` explicite. Les quatre scénarios utilisent un projet isolé.
- `node node_modules/vitest/vitest.mjs run --config docs/audits/2026-11-11/probes.config.mjs` : sept reproductions d'audit réussies ; elles démontrent des défauts, pas la conformité du produit.
- `cmd /c Lancer-Shuriken.bat --self-test` : réussie, sans mise à jour ni lancement.
- Aucun script de lint dans `package.json`. Le typecheck du relay nécessite ses dépendances Cloudflare distinctes.

Les restrictions du bac à sable ont bloqué DNS npm puis le renommage du cache Vitest ; les relances autorisées hors bac à sable ont permis l'installation et les tests. Ne pas attribuer ces erreurs au produit.
