# Shuriken collaborative sessions — implementation plan

## Product decisions (5 November 2026)

- **Host-only Roblox Studio and host-only project writes.** The host's project and running Roblox Studio are the **single source of truth**. Guests run Shuriken and their own permitted AI agents, but **never apply changes directly to Studio or the host filesystem**. No second Studio or full mirrored writable project is required.
- Internet invitations via a host-owned relay (Cloudflare Worker + Durable Object), not a public socket into the host PC.
- Relay carries events, not AI credentials. Host retains authoritative chat/history/tasks locally.
- Session permissions: host, invited guest; guests may leave immediately; network loss has a **10-minute reconnect grace**.
- Claude/Codex run with the credentials installed on the account owner's own PC. **Never copy OAuth tokens or CODEX_HOME/Claude profiles to the host or relay.**
- Fast/Balanced/Deep provider selection remains local to the executing participant.
- Shared capacity requested as an opt-in feature. **Do not auto-delegate personal ChatGPT/Claude subscriptions to other people until provider terms and controls permit it.** Individual owners can execute their own assignments in the shared project. Provider-specific pool policies need review.
- Default permissions deny remote file writes, Roblox mutations, terminal commands and unattended AI execution. Guests can submit **proposals** that the host validates and optionally applies through its own tools.
- **Luau/UI/VFX:** a guest sends proposed source changes, builder scripts or structured operations. The host checks a base revision, paths, allowlists and permissions; applies the changes locally; and then synchronizes with Roblox Studio. No guest process receives direct Studio MCP or local HTTP access.
- **3D assets:** guest sends a model + textures (or a manifest and temporary transfer), host previews it and explicitly accepts or rejects import. Approval is mandatory by default. The host performs any conversion and the final Studio import locally.
- **Network transfers:** Cloudflare carries control messages, operation envelopes, result receipts and small payloads. Large 3D files use a separate integrity-checked, resumable transfer (WebRTC data channel or time-limited upload with host consent), not thousands of unbounded WebSocket frames.

## Implementation status

**C1 implemented in branch (not deployed):** Settings tab, host- or guest-initiated WSS, private invitation links, Cloudflare Durable Object authentication, human chat, peer presence, 10-minute reconnect, immediate leave, bounded in-memory history and CI tests. The Worker is tested in a local Cloudflare runtime, but still requires a deployment to the host's Cloudflare account and a two-PC packaged-app test.

**C2 partially implemented:** guests receive the host's project title, recent visible Director messages and task status updates **read-only**. Dashboard Director has a shortcut to session chat. Full authoritative persistence and true remote editing are still pending.

**C3–C5 NOT IMPLEMENTED:** no guest proposals can be applied yet, no asset transfers or import approvals, no remote Claude/Codex execution and no cross-user subscription pooling. The host-only execution boundary is a design decision, **not** a claim that the new workflow is already operational. Do not treat the feature as production-ready or enable remote AI actions without the listed security reviews.

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

### C2 — Real shared project state
- [ ] Single authoritative project ID and rev/sequence (host), snapshots + replay after reconnect.
- [ ] Shared human chat visible in the main dashboard; distinguish human discussion from Director prompts and track message author. (Session chat accessible via a dashboard shortcut; not merged into Director.)
- [ ] Guest agent activity + task status, human permissions/approvals, pause/resume semantics. (Host task statuses are already mirrored read-only.)
- [ ] Durable host-side event log, idempotent operations, acknowledgements and crash recovery.
- [ ] Integration tests with two Shuriken cores, packet loss, latency, 10-minute disconnect.

### C3 — Host-only Roblox edits and guest proposals (simplified design)
- [ ] Host provides **only task-scoped, read-only context** required by a guest agent: selected source text, public asset metadata, references and relevant project instructions. No full writable file sync, no database copy, no arbitrary filesystem/secret access.
- [ ] Guest returns a **versioned change proposal**: operation ID, task ID, guest ID, proposed paths or Roblox operation, base file hash/revision, content hash, and a human-readable summary.
- [ ] Host validates proposal authorization, schema, path confinement, content size, allowed action and base revision **server-side** before any write.
- [ ] **Luau, UI, VFX**: only the host Shuriken applies accepted changes to its local project and executes its own Roblox Studio MCP/plugin tools. Ordinary, allowlisted edits can use a configurable approval policy; sensitive actions (deletes, destructive Studio operations, publishing, permissions) must request host confirmation.
- [ ] Host detects conflicting or stale proposals (revision mismatch) and offers review instead of silent overwrite; commits a local checkpoint before changes and supports rollback.
- [ ] **3D models and textures**: transfer a manifest with filenames, MIME types, dimensions, sizes, hashes and optional thumbnail. The host sees a preview and **Accept / Reject** controls before transfer/import is finalized.
- [ ] For large assets use integrity-checked chunks and resume (WebRTC or an explicitly authorized temporary transfer channel); **do not assume small Cloudflare WebSocket messages can transfer arbitrary multi-GB assets**. Verify asset format and scan or sandbox conversion before import.
- [ ] Only the host's core interacts with its **single Roblox Studio**. Remote agents never receive an unaudited direct MCP URL, bearer token, local filesystem path or terminal access.
- [ ] Host acknowledges applied operation IDs; guests see an applied/rejected/conflict outcome. A disconnected guest cannot replay the same patch twice or apply a late proposal against a changed base.
- [ ] Integration tests: simultaneous guest Luau changes, invalid/escaped paths, malicious asset metadata, duplicate operations, stale base revisions, host restart, revocation, and rollback. Validate GUI/VFX/model import on a real Studio machine.

### C4 — Distributed agents, quotas and permissions
- [ ] Signed task envelopes (owner, originator, role, provider, model tier, budget, immutable task snapshot).
- [ ] Guest worker executes only on its own device; no credential transfer.
- [ ] Owner-controlled consent, per-provider allowlists, limits, immediate revocation, guest-host permission separation.
- [ ] Hard boundaries for personal ChatGPT/Claude accounts until provider terms permit cross-user automatic delegation.
- [ ] Routing on connection, owner, eligibility, quota health and model; test exhausted/unknown quotas and fallback.
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
- **No second synchronized Roblox Studio and no direct remote edits.** Proposals, approvals, import jobs and results are coordinated, but the host remains the only writer.
- Never auto-import untrusted 3D files or execute guest-supplied scripts before the host has evaluated the requested permissions and content.
- No claim of lossless instant replication without snapshots, deduplication, replay and host-side integrity verification.
- No claim of entitlement to consume another person's personal subscription merely because the owner opted in.
- No backend deployment, Cloudflare account connection or billable resource creation without user approval.

## Operation

The relay is optional and explicitly deployed by the user. With no relay URL configured, Shuriken operates exactly as before. Each phase is reviewable and independently tested before the next. Do not mark the full collaborative functionality released until C1–C5 pass.
