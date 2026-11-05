# Shuriken Studio — Collaborative mode implementation report

**Date:** 2026-11-05  
**Branch:** `feature/codex-integration`  
**Status:** Feature branch implementation and automated integration checks; **not production-ready and not deployed**.

## 1. Delivered in this iteration

### Shared connectivity (C1)

- Cloudflare Durable Object WSS room authentication, separate host and guest secrets, invitation links and connection/presence events.
- 10-minute automatic network reconnection window; voluntary leave immediately ends session access.
- Host-owned session with a discreet status/participant indicator in the normal header and in the Start screen.
- Settings → Collaboration with host/join controls, participants, session chat and a trusted-guest execution toggle.
- Worker hibernation fix (derives the room identity from the Durable Object ID, not merely an in-memory field).

### Host-authoritative collaborative workflow (C2/C3; real-device test still required)

- Authenticated guest instructions are forwarded through the relay **only to the host**.
- Host admission is **off by default for every new session**, and must be enabled once for trusted guests; no acceptance prompt for every ordinary edit.
- Guest request IDs are UUID-validated, bounded, rate-limited to 8 new requests/minute per room, acknowledged, and de-duplicated by the host during the active session.
- Only the host's Director is invoked. Existing host agents and tools act upon the local game/project; guests receive no remote MCP URL or direct file-write API.
- The host chat records the initiator (guest name/ID and request ID). The guest sees the host Director conversation, tasks, agent runs, current activity markers and typing indicator.
- New **Collaboration workspace** is available to a guest without a local Roblox project. It shows shared Director, requests, live tasks, runs, participants and human session chat.
- On unexpected network reconnect, clients request authoritative host snapshots and retry pending requests with the same ID to avoid re-running a request.

### UI integration

- `src/renderer/src/components/topbar.tsx`: compact session badge and access to the shared workspace.
- `src/renderer/src/pages/start.tsx`: the session is visible when a guest is on the app's Start screen.
- `src/renderer/src/pages/collaboration-settings.tsx`: host trust toggle, guest requests and remote status.
- `src/renderer/src/pages/collaboration-workspace.tsx`: remote client experience, integrated with the app's existing colors and layouts.
- `src/renderer/src/containers/chat.tsx`: guest author label in the host conversation.

## 2. Verification

The GitHub Actions workflow now checks:

- Windows and Ubuntu TypeScript typecheck and Electron build.
- Existing Codex adapter tests.
- Collaboration protocol validation, role restrictions, session key constraints.
- Unit tests for host approval, guest requests, acknowledgments, de-duplication and isolation.
- In-memory **two-Shuriken-core** test for guest request → host callback → live updates, duplicate submissions and network recovery.
- Cloudflare Worker typecheck and dry-run deployment.
- Real **local** Wrangler Worker smoke with two WebSocket clients, host authentication, chat, project sync, guest instructions and host acknowledgments.

All tests are automated/simulated; this is **not** a substitute for a deployment with two physical computers and a real Roblox Studio attached to the host.

## 3. Explicitly not implemented or not validated

1. **Guest-provided ChatGPT/Claude subscriptions and API keys on the host:** not connected. Existing host provider accounts can run work. Guest-owned identity delegation needs provider-supported authentication and a new authorization/credential-isolation architecture.
2. **Per-guest fine-grained permissions for dangerous tool calls:** incomplete. The host toggles trusted guest instructions once; this invokes the ordinary host Director and its existing permission mode. Do not invite untrusted users or enable guest execution when the host account/project has unrestricted privileges.
3. **End-to-end encryption:** no; Cloudflare sees the content of TLS-transported collaboration messages. Do not send confidential source material or secrets.
4. **Individual kick/invitation revoke/expiry:** not provided; anyone with the current invitation bearer key may enter until the host ends the room.
5. **Durable request replay after a host application crash:** not supported. Request de-duplication exists in memory, snapshots reconstruct guest state, but no transactional distributed job ledger.
6. **Real Roblox Studio end-to-end multi-PC validation:** not performed; the normal host pipeline should do the writing but models, plugins, Luau, VFX and UI changes need actual device-level integration testing.
7. **Large files originating outside the host:** no file/texture/model transfer channel. With option B, normal 3D creation takes place on the host and needs no transfer.
8. **Guest task cancellation on intentional departure:** new requests stop immediately, but already accepted host-owned tasks are not automatically cancelled by guest departure.

## 4. Host/guest test procedure

On the host machine, inside the cloned branch:

```powershell
cd collaboration/relay
npm install
npx wrangler login
npm run deploy
```

Then:

1. Open the latest branch build on the **host**, with a Roblox project loaded.
2. Open **Settings → Collaboration**. Enter the Cloudflare Worker HTTPS URL and host display name.
3. Click **Host a session**. Copy the invitation and share it privately with the intended tester.
4. Enable **Allow trusted guests to ask the Director** once for the session, if you are comfortable with the guest's requests consuming the host's configured AI account.
5. On the **guest**, open Shuriken (Roblox Studio and a local project are not required). Enter the invitation in **Settings → Collaboration**, and join.
6. Click **Open shared workspace** or use the header indicator. Send a safe, reversible Luau/UI request. Confirm the host Director receives it and the local Studio project changes after the existing Shuriken pipeline acts.
7. Verify chat authors, tasks, activity markers and acknowledgements on both PCs.
8. Temporarily disconnect a client for under 10 minutes and reconnect, then test voluntary leave and rejoining. Avoid destructive operations during the first test.

No Cloudflare deployment, access-token registration or provider login was performed by this implementation run.

## 5. Recommended next gates before release

- Enforce real per-actor tool permissions and a host approval path for publishing, destructive operations and account/security changes.
- Add durable operation IDs, stronger sequencing/replay and conflict policy across application crashes.
- Add end-to-end encryption, secure per-member invitations, revocation and abuse controls.
- Integrate eligible provider-authorized guest identities/API keys with explicit owner consent, host trust warning, quota attribution and revocation; do not copy personal CLI session files.
- Validate the complete Windows packaged app + Cloudflare + host Roblox Studio flow using **two real PCs**, including 3D/GUI/VFX and network faults.
- Only after these checks, consider merging/releasing this feature branch.

See `docs/COLLABORATION_PLAN.md` for the detailed roadmap.
