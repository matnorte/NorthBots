# Security and Privacy

NorthBot combines explicit permissions, an encrypted vault, data destinations, audit records and operator controls. These are implemented safeguards with automated tests; the repository does not claim an independent security certification.

## Action permissions

The runtime classifies capabilities as read, write, delete, send, spend or login. Rules can allow, ask or block. Approval waits are visible in **Approvals**. Autonomy, budgets, the untrusted-input shield and the action ledger are additional gates. Every new dangerous capability must use this path.

The workspace kill switch stops agent actions. Human handoffs preserve the task/computer when a person must complete a login, 2FA or CAPTCHA. External content—including web pages, tool results and other agents' letters—remains untrusted data.

## Vault and grants

Secrets are stored encrypted under `NORTHBOT_MASTER_KEY`. APIs list secret names and metadata, never secret values. Provider, MCP and store adapters resolve named secrets when needed. Keep the master key with your private recovery material; losing it makes encrypted data in backups unreadable.

Resource grants distinguish **owner**, **user** and **use-only** access. Owners manage grants; use-only access cannot delegate. Non-owner grants require expiry, and revocation is checked again during signing, token resolution and secret injection. Revoking a local grant does not revoke a previously issued third-party token at its provider.

## Labels and outgoing data

Label resources `public`, `private` or `secret`. Secret data needs explicit destinations. Reading restricted files/memory can restrict the receiving agent's outgoing traffic and model selection. The egress proxy checks each connection, and sensitive agents require local models. Review labels based on the actual data before changing them.

**Security** shows encryption/HTTPS/key/grant checks, outgoing connections, alerts and handoffs. A green check is one control's state, not a statement that every deployment choice is safe.

## Passkeys

NorthBot account passkey routes and agent-held website passkeys are distinct uses. Agent website enrollment accepts a site's public registration challenge, user handle, exact origin and relying-party hostname while its browser is on that site. The response is public WebAuthn material; the private signing key stays in the vault.

Connect the credential to the agent through Security. Subsequent site assertions pass login permissions and the approval inbox. The initial grant lasts 24 hours and can be renewed/revoked. Agent website passkeys currently require the relying-party ID to equal the origin hostname.

## Storage and recordings

Memory text uses separate agent/shared encryption keys. Search vectors remain in PostgreSQL. Optional `SANDBOX_DISK_ENCRYPTION=true` encrypts **new** persistent agent homes with gocryptfs. It needs `/dev/fuse`, `SYS_ADMIN` on the root control process and an unconfined AppArmor profile for the FUSE mount; shell work still runs unprivileged. Existing computers keep their previous format.

Retain the original master key and agent identity for restores. Encrypted disk export/volume backup is separate from image snapshotting. Companion screenshots are masked to shared-app regions and stored separately from redacted activity summaries. Review recording retention for your instance.

## Audit and person-data requests

Audit exports are signed with Ed25519. Keep the public-key fingerprint so later exports can be verified against the expected signer. A valid signature establishes artifact integrity under that key, not the correctness of every action.

Person-data export streams the JSON response with bounded keyset reads and backpressure. It includes matching stored records, including expired memory. It is not a transaction-wide snapshot; concurrent writes can affect results. Erasure scans bounded batches and preserves JSON structure while covering matching memory, conversations, tasks, collaboration, routines and activity records.

Backups and already downloaded copies have their own retention/deletion requirements. The feature is an operational tool, not a blanket legal-compliance guarantee.

See [SECURITY.md](../../SECURITY.md) for reporting a vulnerability privately, [BLOCKERS.md](../../BLOCKERS.md) for unverified real-world paths and [architecture](../ARCHITECTURE.md) for trust boundaries.
