# Shuriken Studio — index documentaire

État inspecté le 11 novembre 2026 : version 1.16.2, branche de développement
`feature/codex-integration`, base `7400f17` et stabilisation Codex locale.

## Entrées utiles

- [Consignes Codex](AGENTS.md), [contribution](CONTRIBUTING.md), [présentation](README.md).
- [Architecture détaillée](docs/ARCHITECTURE.md), [installation](docs/SETUP.md).
- [Intégration Codex](docs/CODEX_INTEGRATION.md) et [rapport de qualification](docs/test-reports/CODEX_2026-11-11.md).
- [Coop à deux](docs/COOP.md), [rapport de la première intégration collaborative](docs/COLLABORATION_IMPLEMENTATION_REPORT.md).
- [Plugins](docs/PLUGINS.md), [sessions](docs/SESSIONS.md), [Studio en arrière-plan](docs/STUDIO-BACKGROUND.md).
- [Audit technique indépendant du 11 novembre 2026](docs/audits/2026-11-11/REPORT.md).

## Composants

| Famille | Sources et responsabilité |
|---|---|
| Application Electron | `src/main/index.ts`, `kiln-dock.ts`, `kiln-host.ts`, `updater.ts` : onglets, supervision, IPC, secrets, OS |
| Bridge | `src/preload/index.ts`, `api.d.ts`, `kiln.ts` |
| Composition/RPC | `src/core/core.ts`, `index.ts`, `rpc/router.ts` |
| Agents et orchestration | `core/agents/roles.ts`, `core/orchestrator/`, `core/tasks/` |
| Fournisseurs | `core/providers/types.ts`, `provider-registry.ts`, `claude/`, `codex/` |
| Contexte/mémoire | `core/context/`, `knowledge/`, `skills/`, `research/`, notes du planner |
| Persistance | `core/db/store.ts`, `schema.ts`, `projects/`, `audit/` |
| Permissions/outils/MCP | `core/permissions/`, `capabilities/`, `mcp/` |
| Roblox | `core/roblox/studio-adapter.ts`, `link/`, `code-sync.ts`, `playtest-lease.ts`, `verification/` |
| 3D | `core/modeling/`, `core/blender/`, `resources/blender/` |
| Ateliers | `core/ui/`, `effects/`, `animation/`, `audio/`, `assets/`, `storefront/` |
| Interface | `renderer/src/App.tsx`, `pages/`, `components/`, `containers/`, `lib/rpc.ts` |
| Collaboration | `core/collaboration/`, `shared/collaboration.ts`, `collaboration/relay/` |
| Vérification | `tests/`, `vitest.config.ts` ; E2E séparés dans `tests/e2e/` |

Les chemins `core/`, `renderer/` et `shared/` du tableau sont relatifs à `src/`.

## Fonctionnalités et état connu

Le code comprend un directeur conversationnel, un planner et des rôles spécialisés, un graphe de tâches,
la vérification et la critique, des reprises après interruption, des ateliers UI/VFX/audio/animation/3D,
la synchronisation Luau et la collaboration avec exécution sur l'hôte.
Codex App Server 0.166.0 est utilisé avec le compte ChatGPT existant. Les quatre parcours réels
sur données isolées ont vérifié la sortie structurée avec MCP, l'édition Luau dans Studio,
le GLB Blender et l'arrêt/reprise. Le smoke Electron a ouvert 13 vues sans erreur.
La campagne standard après l'ajout des quotas a donné 2 082 réussites, aucun échec et 19 exclusions documentées.

Les quotas de lancement par modèle Claude et Codex sont partagés entre les projets et fenêtres.
Le routeur reprend les tâches selon les quotas et les deux préférences de bascule. Groq et
OpenRouter sont disponibles pour les projets qui autorisent leur usage. Les clés sont chiffrées
via le coffre Electron. Les scénarios simulés sont dans `tests/ai-routing.test.ts` et le parcours
avec des clés jetables est documenté dans [le guide d'intégration](docs/CODEX_INTEGRATION.md).

La coop v2 ajoute une invitation à usage unique, l’admission par l’hôte, la connexion chiffrée,
un pool de clés conservées sur les postes de leurs propriétaires et un journal des effets
sur le projet hôte. Les contributions Claude et Codex sont partagées manuellement.

## Problèmes et travaux restants

- Le shell Codex requiert un sandbox Windows à lecture restreinte, non disponible sur le poste de qualification.
- Codex utilise un outil Blender borné ; la parité avec le Python libre et le parcours Kiln personnel restent à qualifier.
- Six avis npm modérés subsistent dans l'empaquetage ; aucun avis élevé ou critique dans le rapport final.
- OpenCode, l'API directe Codex et les multi-comptes Codex restent différés. La validation Groq et OpenRouter avec clés réelles requiert des clés de test autorisées.
- Qualification de la coop sur deux PC avec un relais Cloudflare de test, installeur Windows et compte Claude réel restent ouverts.
