# Shuriken collaborative sessions — implementation plan

## Product decisions (5 November 2026)

- **Host-only Roblox Studio and host-only project writes.** The host's project and running Roblox Studio are the **single source of truth**. Every participant can submit natural-language requests through their own Shuriken. **The host's Director receives guest requests and executes the resulting project changes locally**, using the existing host tools, just as it would for a host request. No second Roblox Studio and no guest-owned writable project copy are needed.
- Internet invitations via a host-owned relay (Cloudflare Worker + Durable Object), not a public socket into the host PC.
- Relay carries events, not AI credentials. Host retains authoritative chat/history/tasks locally.
- Session permissions: host, invited guest; guests may leave immediately; network loss has a **10-minute reconnect grace**.
- **User's selected target: Option B (5 Nov 2026).** All project-changing agents, including guest-attributed Codex/Claude jobs, should **execute on the host PC** alongside the host's sole Roblox Studio. The owner of each AI quota remains identifiable, and guest controls and results synchronize in real time.
- **All supported credential sources accepted from host and guest:** own OpenAI ChatGPT subscription (using official Sign in with ChatGPT when eligible), own OpenAI API key, own Anthropic API key/Claude Console, Claude subscription via an Anthropic-supported native Claude Code sign-in, and any existing compatible model/provider connectors. Show provider/auth method and quota or billing owner per account. Each connection must be separately approved for collaborative use by its owner.
- **Official OpenAI OSS plan usage (2026):** OpenAI documents Sign in with ChatGPT for open-source clients, distinct OAuth scopes for eligible plan-powered Responses API requests (including `chatgpt.tokens.use.direct`), host IDs, use via Codex app-server, and a self-hosted-VM guide for secure transfer of a user-owned credential registration. Evaluate the exact multi-user host scenario; **do not confuse official app authorization with permission to share a personal account directly with another person**. Authenticate every registered owner, preserve separate clients/host IDs, verify scopes/eligibility, and add a compatible auth/billing adapter rather than reading somebody's personal CLI/browser token cache.
- **Anthropic constraint:** Claude Code terms allow each end user to authenticate using their own key, subscription or approved third-party inference route, but do not allow third-party applications to collect/intermediate Claude.ai session tokens or offer a custom Claude subscription login. Integrate API key auth as the supported default; any native subscription option must use the unmodified Claude Code binary and Anthropic's own sign-in flow, subject to terms and safe isolation. Never scrape or copy Claude login tokens.
- Fast/Balanced/Deep model selection applies to the execution runtime on the host. Track **who requested** a task separately from **which authorized provider identity is charged**; no impersonation or automatic use of someone else's personal subscription.
- **Shared AI capacity opt-in:** every account from a host or guest is registered separately with a quota owner, approved execution scope, per-session spending/usage cap and revocation. A registered source enters the host's routing pool **only when its specific authorization flow and provider conditions allow this session**. A guest can contribute multiple accounts; each task records its actual provider, model, owner and charge/usage. Unknown usage does not imply unlimited capacity.
- **Guest task requests are automatic within the host's configured collaboration permissions.** An authenticated guest message enters the host Director's ordinary execution pipeline, with explicit author and session metadata. The host must not be interrupted for every Luau, GUI, VFX, building or asset edit. Apply existing verification, sandboxing, undo/checkpoint and scope limits regardless of initiator.
- **Sensitive operations still require authorization:** publishing, deleting substantial content, modifying secrets/security, account changes and other high-risk/destructive actions. The host sets permissions once in Settings; an exceptional operation requires explicit approval, not a blanket approval for every task.
- **Luau/UI/VFX/world modifications are produced and applied on the host PC by default**, not as guest-authored file patches awaiting acceptance. Only the host talks to Roblox Studio/MCP/plugin and writes project files.
- **3D generated on the host** follows the host's existing local creation/import pipeline (no network asset transfer needed). When a separately authorized guest-side worker actually generates a 3D asset, transfer its model and textures with validated sizes/hashes and optional review before host import.
- **Cloudflare is a relay:** client requests, event streams, task state, chat, Studio operation outcomes and replay metadata. Heavy media travels on a separate explicit file transport only when generated outside the host.
- **Execution placement is host-only.** The guest consents through the provider's supported auth flow. A remote host may be a less-trusted machine: show a clear warning before provisioning any guest credential into that host runtime. Use ephemeral, individually isolated host-runtime credentials where documented, encrypted in transit and at rest, never passed in relay chat/URLs/logs. Remove session access on leave; revoke or invalidate credentials on the identity provider if supported. A host machine owner can potentially extract secrets used by processes on that PC; claiming that such a host cannot access provisioned secrets would be inaccurate.

## Implementation status

**C1 implemented in branch (not deployed):** Settings tab, host- or guest-initiated WSS, private invitation links, Cloudflare Durable Object authentication, human chat, peer presence, 10-minute reconnect, immediate leave, bounded in-memory history and CI tests. The Worker is tested in a local Cloudflare runtime, but still requires a deployment to the host's Cloudflare account and a two-PC packaged-app test.

**C2 partially implemented:** guests receive the host's project title, recent visible Director messages and task status updates **read-only**. Dashboard Director has a shortcut to session chat. Full authoritative persistence and true remote editing are still pending.

**C3–C5 NOT IMPLEMENTED:** guest chat messages are not yet submitted into the host Director for automatic execution; the host's tools do not currently run tasks on behalf of guests; complete bidirectional task/result synchronization, remote provider execution and optional external asset transfers are pending. The host-only execution boundary is a design decision, **not** a claim that the new workflow is already operational. Do not treat the feature as production-ready or enable remote AI actions without the listed security reviews.

## Phases, dependencies, and acceptance criteria

### C1 — Session transport and settings (implementation baseline)
- [x] New **Settings → Collaboration** section with relay URL, display name, create/join, copy invitation, leave, peers, connection status and session chat.
- [x] Cloudflare hibernating WebSocket relay with short-lived secret-based room authentication and no persisted chat or game content; deployable with host's account.
- [x] Versioned shared wire protocol, payload validation and limits.
- [x] Separate host secret / invite secret, randomized session identifiers, server-side role enforcement.
- [x] Automatic reconnection with bounded exponential backoff and **10 min** grace; voluntary leave is immediate and clears temporary keys.
- [x] Locally retained bounded session chat; joining/rejoining participants request missed events from the host.
- [x] Unit tests and Windows/Linux typecheck.
- [x] Clear UI that session link joining is in-app (not a hosted project page) and relay deployment is an explicit separate action.

### C2 — Real-time host-authoritative state and Director
- [ ] Authenticated guest request travels to the **host Director** with user ID, room ID, request ID and permitted scope; the host's normal orchestrator starts the work without a per-edit approval prompt.
- [ ] The host writes chat, tasks, plans and agent runs to its own project; the guest receives the same conversation updates and streamed progress (including partial responses, status, errors, cancellations and outcomes).
- [ ] Host-owned ordered event sequence, acknowledgements, idempotency and snapshot/replay after an unexpected disconnect of up to 10 minutes.
- [ ] Clear distinction in the shared timeline between a human's message and a Director/agent reply, with the initiating participant's identity.
- [ ] Guest can request and see task pause/resume only where authorized; these actions are executed by the host core.
- [ ] Host-side persisted event log, deduplication, crash recovery and two-Core tests with dropped events and late reconnect. (Host Director/task snapshots are already mirrored read-only; guest submission is not implemented.)

### C3 — Host-local automatic execution, verification and optional 3D transfers
- [ ] **Default pipeline:** guest asks through Shuriken → the relay authenticates and forwards the request → host Director creates tasks → host agents/tools edit the host files and its Roblox Studio → results stream to all participants. No separate guest-built Luau/UI/VFX patch approval step.
- [ ] Host collaboration settings define permitted actions by role (e.g., normal scripts, GUI, VFX, terrain, model generation); guests cannot bypass host approvals or invoke arbitrary host MCP/terminal commands.
- [ ] Only the host's existing code sync, Roblox Studio adapter, lock and verification mechanisms perform game mutations. Enforce actor identity and allowlist **in the host core**, not just the client UI or relay.
- [ ] For ordinary permitted changes, **no host confirmation prompt**. Keep checks, checkpoints, version conflicts, idempotent operation IDs and rollback in the host runtime.
- [ ] For destructive or privileged operations (publish, secret/permission changes, bulk delete, external integrations), request host approval or deny according to collaboration policy.
- [ ] 3D generation, textures and local conversion run on the host when invoked as a normal collaborative task; the existing host-controlled import pipeline handles the output. Do not add unnecessary asset sharing when the host already owns the files.
- [ ] Only if a separately authorized remote AI/3D worker produces files outside the host: transfer a validated manifest, checksums and bounded asset chunks; host accepts/rejects untrusted external imports according to the host's policy. No remote process directly imports to Roblox Studio.
- [ ] Guests see near-real-time code/tool effects as **structured state and outcomes** without receiving sensitive local file paths or credentials. Consider lightweight Studio preview/state and task log sync; reconcile late events with an authoritative snapshot.
- [ ] Multi-PC integration tests: simultaneous guest prompts, safe Luau/UI/VFX edits, 3D host generation, sensitive-action approval, reconnect, replay, out-of-order results, rollback and invalid remote commands.

### C4 — Unified host-side account execution and quota routing (option B)
- [ ] Account inventory per participant: OpenAI plan OAuth (eligible SIWC), OpenAI API key, Anthropic Console/API key, Claude Code native subscription where permitted, and existing compatible providers, including local models.
- [ ] Record provider, auth mode, owner, consent, quota/billing source, capability restrictions, and whether that identity can legally and technically run in the **host runtime**. Do not treat a ChatGPT subscription as an API key or a Claude subscription as interchangeable with Anthropic Console billing.
- [ ] **Official OpenAI OSS flow:** open browser consent from the participating user, registered issued client ID, unique stable host ID, PKCE, state, nonce, verified OIDC identity, granted scope `chatgpt.tokens.use.direct`, refresh/revoke, streamed Responses API requests with `store:false`; evaluate Codex app-server adapter. Confirm the cross-user collaborating host scenario before enabling guest-to-host token provisioning. Implement no ad-hoc personal CLI token copying.
- [ ] **API keys:** accept keys registered by either host or guest only with explicit owner approval; prefer least-privilege scoped keys and bounded billing, avoid persisting guest keys on another person's PC when possible. If host runtime must possess a key, inform owner of the actual host-access risk and encrypt storage. Never send secrets through ordinary Cloudflare room events.
- [ ] **Claude:** API keys or supported enterprise/provider identity with explicit authorization; for subscription use only Anthropic's supported unmodified Claude Code native sign-in without collecting or proxying Claude.ai session credentials.
- [ ] All agents execute on the host; guests remain synchronized UI clients. Separate request initiator from credential owner, model, authorized host runtime and actual provider usage.
- [ ] Owner opt-in is off by default, per-account/role model allowlists and usage budget controls; immediate new-task revocation, bound cancellation of running tasks, and 10-minute reconnect grace only for network loss, **not** intentional account unsharing.
- [ ] Route on capability, consent, provider eligibility, connection, quota health, priority and available models; never silently switch to a chargeable API key if a subscription limit is reached without the owner's configured permission.
- [ ] Tests: conflicting simultaneous account usage, per-owner quota attribution, no cross-account token leakage, encryption and revocation, untrusted host warnings, failed OAuth, expired API key, unknown quota, duplicate requests, host restart and real two-PC login.

### C5 — Production hardening and deployment
- [ ] Secure host-managed Cloudflare provisioning (no long-lived broad permissions in the app) and deployment verification.
- [ ] End-to-end encryption for content relayed via Cloudflare, key rotation on member removal, invitation expiry/revocation.
- [ ] Abuse controls, join rate limiting, auditing, quotas and back-pressure.
- [ ] Windows packaged app end-to-end smoke with two devices and separate Roblox Studio state.
- [ ] Security review and compatibility verification with each model provider's account terms.

## Non-goals / security requirements

- No silent copying of account passwords, browser cookies or existing personal CLI credentials. Where **officially documented** (e.g. OpenAI SIWC self-hosted VM), a separately authorized and protected credential deployment must be opt-in, per-owner, disclosed and revocable, with the actual risk of the host device accessing process credentials explained.
- No port-forwarding of local MCP/Roblox HTTP listeners to the public Internet.
- **No second synchronized Roblox Studio and no direct remote edits.** Guest requests are routed to the host Director; only host-side workers, guarded by project permissions, mutate Studio and files.
- Do not ask the host to approve every permitted edit. Require host approval or deny only when an action exceeds the previously granted role permissions or is inherently sensitive/destructive.
- Never auto-import untrusted external 3D files or blindly execute untrusted remote scripts; host-local generation is a distinct trusted workflow subject to existing controls.
- No claim of lossless instant replication without snapshots, deduplication, replay and host-side integrity verification.
- No claim of entitlement to consume another person's personal subscription merely because the owner opted in. Validate an officially supported app-usage authorization route **and** its applicability to this collaboration model before adding a user account to the host's shared routing pool.
- No backend deployment, Cloudflare account connection or billable resource creation without user approval.

## Operation

The relay is optional and explicitly deployed by the user. With no relay URL configured, Shuriken operates exactly as before. Each phase is reviewable and independently tested before the next. Do not mark the full collaborative functionality released until C1–C5 pass.

## Provider documentation checked (5 Nov 2026)

- OpenAI open-source SIWC: https://developers.openai.com/siwc/token-sharing-open-source
- SIWC Codex app-server: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- SIWC self-hosted VMs: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- SIWC accounts, consent, token renewal: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- Anthropic Claude Code legal/compliance: https://code.claude.com/docs/en/legal-and-compliance
- OpenAI EU terms/account sharing policy: https://openai.com/fr-FR/policies/eu-terms-of-use/
