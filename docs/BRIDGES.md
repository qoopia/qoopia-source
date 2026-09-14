# Qoopia bridges — owner-approved V1 scope

Updated 2026-09-11 from the owner's conversation. This replaces the older
one-peer V2 product boundary. The implementation is in schema 039 and
`src/bridges`; deployment evidence is recorded separately with the release.

## Product contract

A bridge is an invitation-only group of independent Qoopia installations.
Two participants use the same mechanism as three or more. Each installation
keeps its own owner, database, agents, credentials and external folder.
Membership does not create a shared workspace or grant private-memory access.

The external folder has two sections:

* **For sending:** explicitly staged, fixed versions of notes, files or skills.
  Members see only owner-approved display titles and short descriptions in a
  catalogue. Publication is scoped to a selected bridge. Search uses only
  these catalogue fields, never the source text or private index.
* **Received:** material delivered by another member, with its sender, version
  and request recorded. It is absent from the catalogue and the main memory
  index. Receipt neither installs a skill nor authorizes onward sharing.

A member requests a catalogue item. The supplying installation selects and
authorizes the exact staged bytes. Default is human Approve / Skip; an owner
may explicitly pre-authorize automatic responses for a published version in
a particular bridge. Changing the bytes requires a new approval. Requests
must not become a free-form channel for an agent to export private context.

The creator manages invitations and membership. A link, copyable code and QR
represent the same invitation. An unbound invite requires local acceptance
and the creator's confirmation of the joining installation. Invitations can
expire or be revoked. Any participant may leave; the creator may remove a
member. Removal ends future access, but cannot erase received copies.

Groups do not start agent runtimes. An agent uses the bridge from its existing
client through scoped MCP operations; incoming work waits when it is stopped.

## Implementation boundaries

Reuse the existing owner authorization, SQLite transactions, MCP, browser UI
and update/backup mechanism. Preserve the existing AgentComm owner boundary.
Foreign identities must never become ordinary local memory principals.

An outbound-only connection through a small relay supports ordinary laptops.
Group membership is coordination metadata, not a shared content database.
Content and catalogue packets require authenticated encryption between the
intended installations. Use a maintained standard implementation, not custom
cryptographic primitives. Local queues retain undelivered work. Relay outage
must not disable ordinary local memory operations.

Transport choice and supported-runtime verification must be recorded with the
implementation; the old proposed TLS tunnel is not already-qualified code.
Hosted relay operator, metadata, transient buffering, limits and costs must be
disclosed before public distribution. No unapproved paid service is implied.

## Finite acceptance

Exercise three independent owners: create group, invite two members, confirm
membership, see approved catalogue metadata, request a material, Approve/Skip,
and receive exactly that version. A third member cannot read another member's
transfer. Verify private IDs/content and received materials cannot appear in
the catalogue or be downloaded without a grant. Verify retry/restart does not
duplicate receipt; offline delivery recovers; leaving/removal/revoked invites
deny new access. Check one ordinary local memory flow remains available while
the relay is unavailable. No million-message benchmark is required for the pilot.

## Delivered protocol and pilot boundaries

Each installation owns Ed25519 signing and P-256 encryption keys. JOSE 6.2.2
signs packets and encrypts them to the individual recipient using ECDH-ES and
A256GCM. HTTPS additionally protects transport. Creator-signed admission
statements bind each admitted member to its public keys; invitation codes pin
the creator fingerprint. Live RPC signatures bind operation, body, audience,
nonce and a maximum 60-second lifetime. Used nonces are rejected.

The existing Qoopia authentication service at `https://auth.qoopia.ai/bridge`
provides the relay. It stores membership, public keys, display names and
invitation digests. It sees routing, timing, IP addresses and packet sizes;
it cannot decrypt catalogue or material packets. It is trusted for current
membership and availability. This is not a claim of forward secrecy or
revocation against a malicious relay. Already delivered copies cannot be
recalled.

Encrypted relay buffers are RAM-only, expire after 120 seconds and are capped
at 64 MiB globally and 64 packets per recipient. The sender's local durable
queue retries until an end-to-end receipt, for up to seven days. Closed group
metadata expires after 30 days; active membership remains until closed.
Removal/leave/invite revocation is saved and enforced locally immediately,
then retried at the relay when connected. Other installations learn an offline
revocation after it reaches the relay. Existing local memory works offline.

Pilot limits: 32 membership records per group, 8 groups per creator, 512 groups
on the relay, 100 published entries per group and 1 MiB per material. No new
paid provider, model invocation or group-wide content database is required.
Catalogue search examines display titles/descriptions only. Content is
requested by exact item/version and received into the separate local folder.

The dashboard issues a 24-hour invitation as a link, code and QR. The link/QR
opens instructions and a copyable code; the recipient pastes it into their own
Qoopia and requests membership. This release does not register an OS deep link.
The creator confirms the joining installation. Only the owner publishes or
approves sending; a selected local agent may discover metadata, request, review
received materials and prepare private outgoing drafts through MCP. Receiving
a skill never installs or executes it.

Private database backups include bridge identity keys, received copies and
queues. Protect them as credentials; stop the original installation before
resuming the same bridge identity on a replacement machine. Schema-39 backup
verification and rotation use the same complete snapshot contract as updates.

## Finite implementation checks

`tests/bridges.test.ts` exercises three independent identities/databases,
creator admission, third-party decryption refusal, signature/replay checks,
metadata-only discovery, exact-version Approve/Skip, explicit automatic send,
received quarantine, service and relay restart recovery, duplicate receipts,
offline removal and invitation revocation. Existing owner-boundary tests remain
unchanged. The isolated browser fixture covers invitation/QR, review, requests,
receipt, publication, mobile layout and keyboard navigation. Production
credentials and notes are never used as test materials.
