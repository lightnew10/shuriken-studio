# Shuriken collaboration relay

Hosts deploy this relay to **their own Cloudflare account**. A guest never needs a Cloudflare account.

## Deployment (one-time, on the host's machine)

1. Open a terminal in this directory.
2. Run `npm install` and `npx wrangler login` (Cloudflare OAuth belongs to the host).
3. Run `npm run deploy`.
4. Copy the resulting **HTTPS workers.dev URL** into **Shuriken → Settings → Collaboration**.

Shuriken does not deploy, bill, or modify Cloudflare resources automatically. Do not paste API tokens into Shuriken. Link invitations must be pasted **inside Shuriken**. Their URL fragment contains a session secret; do not share it publicly.

## Protocol and security

- WSS upgrade: `GET /room/<32-lowercase-hex>`. `GET /health` checks availability.
- Host presents a 256-bit key; the room ID must equal the first 128 bits of SHA-256(host key).
- Guest presents an independent 256-bit invitation key, validated server-side.
- Cloudflare stores **only hashes of the two room keys** temporarily for session authentication and 10-minute host reconnection; it stores **no messages, files, project data, OAuth credentials or AI conversations**.
- Hibernating WebSockets reduce idle CPU usage. Transport requires TLS except for local development.
- A voluntary host leave ends the room immediately. A lost host connection expires after 10 minutes. A guest can leave immediately.
- Invitation links are bearer capabilities: whoever possesses the link can enter until the host ends the room. Per-invite expiration, individual revocation, end-to-end content encryption, abuse protection and privacy review are **future C5 work**.
- This relay **does not expose host MCP, terminal, Roblox Studio or files**.

The current C1 milestone is for human session chat and presence; see `docs/COLLABORATION_PLAN.md` before enabling remote file or AI execution.
