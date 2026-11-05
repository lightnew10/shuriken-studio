# Shuriken collaborative sessions — implementation plan

## Product decisions (5 November 2026)

- **Host-only Roblox Studio and host-only project writes.** The host's project and running Roblox Studio are the **single source of truth**. Every participant can submit natural-language requests through their own Shuriken. **The host's Director receives guest requests and executes the resulting project changes locally**, using the existing host tools, just as it would for a host request. No second Roblox Studio and no guest-owned writable project copy are needed.
- Internet invitations via a host-owned relay (Cloudflare Worker + Durable Object), not a public socket into the host PC.
- Relay carries events, not AI credentials. Host retains authoritative chat/history/tasks locally.
- Session permissions: host, invited guest; guests may leave immediately; network loss has a **10-minute reconnect grace**.
- **User's selected target: Option B (5 Nov 2026).** All project-changing agents, including guest-attributed Codex/Claude jobs, should **execute on the host PC** alongside the host's sole Roblox Studio. The owner of each AI quota remains identifiable, and guest controls and results synchronize in real time.
- **Critical provider limitation / implementation gate:** Consumer ChatGPT/Claude subscription authentication does not currently establish a documented compliant delegated-login mechanism for another user's host to consume that subscription. In particular, OpenAI's individual account terms prohibit making the account available to another person. **Do not implement guest-to-host OAuth/session/token copying, shared CODEX_HOME/Claude profiles or quota pooling by evading these restrictions.** Only enable true option B with a provider-supported delegated identity or other explicitly authorized, independently billed integration. An API key would be a separate API billing model, not automatically a user's ChatGPT subscription quota.
- Fast/Balanced/Deep model selection applies to the execution runtime on the host. Track **who requested** a task separately from **which authorized provider identity is charged**; no impersonation or automatic use of someone else's personal subscription.
- Shared AI capacity is an **opt-in product goal**, contingent on the provider explicitly allowing the authorization model. The UI must explain that guest-owned personal subscription quotas are *not presently shareable through option B* and must not show them as available host-side capacity until the provider integration has been verified.
- **Guest task requests are automatic within the host's configured collaboration permissions.** An authenticated guest message enters the host Director's ordinary execution pipeline, with explicit author and session metadata. The host must not be interrupted for every Luau, GUI, VFX, building or asset edit. Apply existing verification, sandboxing, undo/checkpoint and scope limits regardless of initiator.
- **Sensitive operations still require authorization:** publishing, deleting substantial content, modifying secrets/security, account changes and other high-risk/destructive actions. The host sets permissions once in Settings; an exceptional operation requires explicit approval, not a blanket approval for every task.
- **Luau/UI/VFX/world modifications are produced and applied on the host PC by default**, not as guest-authored file patches awaiting acceptance. Only the host talks to Roblox Studio/MCP/plugin and writes project files.
- **3D generated on the host** follows the host's existing local creation/import pipeline (no network asset transfer needed). When a separately authorized guest-side worker actually generates a 3D asset, transfer its model and textures with validated sizes/hashes and optional review before host import.
- **Cloudflare is a relay:** client requests, event streams, task state, chat, Studio operation outcomes and replay metadata. Heavy media travels on a separate explicit file transport only when generated outside the host.
- **Execution placement is host-only as the product goal**; this does **not** grant the host the right to impersonate an invited user's ChatGPT/Claude login. Guest accounts remain private and **must not be migrated to the host**. Host-local execution uses only identities that are permitted for that machine/workflow. Mark guest-owned subscription-backed execution as blocked until an authorized delegation mechanism exists.

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

### C4 — Host-executed AI, quota attribution and permissions (option B)
- [ ] Signed task envelopes distinguish initiating participant, executing host process, provider identity, permitted model tier and execution budget.
- [ ] **All agent processes and Roblox/file mutations run on the host** when a compliant, permitted provider identity is available. The guest is a remote Shuriken UI/client; no guest-side AI runner is required by option B.
- [ ] Do not copy guest OAuth sessions, local CLI credential folders, browser cookies or personal subscription login state onto the host; require the provider's **documented authorized delegation / team identity** before claiming guest-subscription usage on host.
- [ ] Maintain per-identity authorization, usage tracking, rate-limit handling, explicit opt-in and immediate revocation for any future provider-supported delegation. Consent alone does not override provider contract restrictions.
- [ ] Until such integration is documented and supported, only use the host's own authorized providers to perform host-local work. **Do not silently charge the guest's personal ChatGPT/Claude quota.** Mark unavailable owner identities clearly.
- [ ] Test quota attribution, concurrent accounts, profile isolation, revoked identities, unknown quotas, process crashes, reconnect and no duplicate charge or accepted result.
- [ ] Never duplicate or migrate running provider sessions; lease/sequence ensures exactly one accepted result.

### C5 — Production hardening and deployment
- [ ] Secure host-managed Cloudflare provisioning (no long-lived broad permissions in the app) and deployment verification.
- [ ] End-to-end encryption for content relayed via Cloudflare, key rotation on member removal, invitation expiry/revocation.
- [ ] Abuse controls, join rate limiting, auditing, quotas and back-pressure.
- [ ] Windows packaged app end-to-end smoke with two devices and separate Roblox Studio state.
- [ ] Security review and compatibility verification with each model provider's account terms.

## Non-goals / security requirements

- No automatic migration of private ChatGPT or Claude credentials between devices.
- No port-forwarding of local MCP/Roblox HTTP listeners to the public Internet.
- **No second synchronized Roblox Studio and no direct remote edits.** Guest requests are routed to the host Director; only host-side workers, guarded by project permissions, mutate Studio and files.
- Do not ask the host to approve every permitted edit. Require host approval or deny only when an action exceeds the previously granted role permissions or is inherently sensitive/destructive.
- Never auto-import untrusted external 3D files or blindly execute untrusted remote scripts; host-local generation is a distinct trusted workflow subject to existing controls.
- No claim of lossless instant replication without snapshots, deduplication, replay and host-side integrity verification.
- No claim of entitlement to consume another person's personal subscription merely because the owner opted in.
- No backend deployment, Cloudflare account connection or billable resource creation without user approval.

## Operation

The relay is optional and explicitly deployed by the user. With no relay URL configured, Shuriken operates exactly as before. Each phase is reviewable and independently tested before the next. Do not mark the full collaborative functionality released until C1–C5 pass.
