# Shuriken collaboration relay

Hosts deploy this relay to **their own Cloudflare account**. A guest never needs a Cloudflare account.

## Deployment (one-time, on the host's machine)

1. Open a terminal in this directory.
2. Run `npm install` and `npx wrangler login` (Cloudflare OAuth belongs to the host).
3. Run `npm run deploy`.
4. Copy the resulting **HTTPS workers.dev URL** into **Shuriken → Settings → Collaboration**.

Shuriken does not deploy, bill, or modify Cloudflare resources automatically. Do not paste API tokens into Shuriken. Link invitations must be pasted **inside Shuriken**. Their URL fragment contains a session secret; do not share it publicly.

## Protocol and security

- Upgrade `GET /room/<32-lowercase-hex>` to WSS. Verify that `GET /health` reports `coopVersion: 2`.
- The host transport token defines the room ID. The relay validates a separate one-use invitation token with a ten-minute lifetime and stores a hash of the guest's resume token.
- Version 2 forwards opaque packets between the host and one guest. The pairing key stays in the invitation fragment and on the two apps. The relay sees transport credentials, connection names, routing metadata and packet sizes.
- Hibernating WebSockets reduce idle CPU usage. Transport requires TLS except for loopback development. A host disconnect allows ten minutes for reconnection. Ending the session revokes it.
- Version 1 remains available for older human-chat clients and handles plaintext under TLS. The current Shuriken app requires version 2.

See [the coop guide](../../docs/COOP.md) for the key pool, permissions and two-PC qualification.
