# PeerJS Overlay Network Protocol Specification (Tree + Cousins, QR-Bootstrapped)

**Status:** Draft v1.1  
**Scope:** Browser-based, phone-first P2P overlay using **PeerJS** (WebRTC DataChannels) with a **host-rooted tree** for broadcast and **cousin links** for repair, plus a **QR-code bootstrap** mechanism.  
**Non-goals:** Defining Bingo rules/UI, cryptographic hardening beyond simple secrets, or guaranteeing real-time delivery under all network conditions.

---

## 1. Goals & Design Principles

### 1.1 Goals

- Enable a **phone-only** multiplayer session without requiring a local server.
- Support **~20 players reliably** on LAN/Wi‑Fi; degrade gracefully if used at **100–200 players**.
- Avoid “join storms” and prevent the **host** from holding O(N) WebRTC connections.
- Provide **fast detection** of upstream partitions and **self-healing** via cousin links.
- Provide a protocol that is **game-generic**: game logic evolves without changing transport fundamentals.
- Allow the host to maintain a **virtual tree map** for UI/monitoring/rebalancing.

### 1.2 Constraints

- WebRTC connections are **slow to establish** (300ms–1s typical).
- WebRTC connections are **heavy**; each phone should keep **~5–7 stable connections**.
- Browsers (especially iOS) aggressively suspend background execution.
- PeerJS abstracts low-level WebRTC; the protocol must operate at **application message** level.

### 1.3 Core Ideas

- The overlay is primarily a **broadcast tree** rooted at the host.
- Each node maintains:
  - **1 parent** (upstream “father”)
  - **C children** (downstream “leechers”; default C=3)
  - **S cousins** (side peers for repair; default S=2)
- The host sends a **1Hz “RAIN” heartbeat** (sequence-based) down the tree.
- Nodes detect upstream issues when **RAIN stops advancing**.
- Nodes request missing updates from cousins (patch mode) and later escalate to the host (rebalance).
- Join bootstrapping uses a **dynamic QR code** containing:
  - session secret
  - host PeerJS ID
  - a **rotating seed list** of peer IDs with known capacity

---

## 2. Roles & Responsibilities

### 2.1 Host (Root)

The host is authoritative for the session and acts as **root of truth**.

Host responsibilities:

1. **Session Authority**
   - Creates `gameId` and session secret.
   - Authorizes joiners.

2. **Bootstrap Distributor**
   - Generates and **rotates** QR payload frequently.
   - Provides seed peer lists biased toward available capacity.

3. **Card / Heavy Payload Distributor** (game-specific example)
   - Issues a player’s initial heavy state payload (e.g., Bingo card).

4. **Broadcast Origin**
   - Emits `RAIN` at 1Hz.
   - Emits game broadcast events (e.g., `GAME_EVENT:DRAW_NUMBER`).

5. **Virtual Topology Map**
   - Tracks a **best-effort tree model**: node levels, parent/children edges, and capacity.
   - Receives aggregated status from level-1 nodes.

6. **Rebalancing Authority**
   - Handles `REBIND_REQUEST` when nodes are partitioned or need a new parent.

7. **State Service (required)**
   - MUST accept `REQ_STATE` when a node cannot reach cousins (common for L1) and MUST reply with a bounded `STATE` response.

**Host does NOT:**
- Maintain direct WebRTC connections to all players.
- Act as a relay for all messages.

### 2.2 Middle Nodes (Internal Tree Nodes)

Responsibilities:
- Maintain exactly one upstream parent connection.
- Maintain up to `C` children.
- Maintain up to `S` cousin links.
- Forward `RAIN` and broadcast game events **down to children**.
- Provide **redirect lists** during joins (recursive admission control).
- Aggregate subtree health/status upward.
- Enter **Patch Mode** when upstream rain stalls: pull updates from cousins (or host fallback) and forward to subtree.

### 2.3 Leaf Nodes

Responsibilities:
- Maintain upstream parent and cousin links.
- Receive `RAIN` and game events.
- Do **not** send periodic heartbeats.
- Participate in patch mode and state repair.

---

## 3. Network Topology & Connection Budget

### 3.1 Default Degree Targets

- Parent: 1
- Children: `C = 3` (target)
- Cousins: `S = 2` (target)

Total stable connections per peer: **~6**

### 3.2 Host Limits

- Host keeps **K = 5** stable child connections (level-1).
- Host may accept **short-lived** join connections above K for onboarding (card distribution), then disconnect.

### 3.3 Scaling Intuition

For branching factor `C=3`, theoretical capacity by level:
- L0: 1
- L1: 5
- L2: 15
- L3: 45
- L4: 135

This is not guaranteed; it is used only to guide the host’s QR seeding strategy.

---

## 4. Bootstrap & Join Flow (QR + Recursive Redirect)

### 4.1 QR Payload

**QR fields (minimum):**
- `v`: protocol version integer
- `gameId`: string
- `secret`: string (join secret)
- `hostId`: PeerJS ID
- `seeds`: array of PeerJS IDs (5–10)
- `qrSeq`: integer (monotonic)

**Optional fields:**
- `latestRainSeq`
- `latestGameSeq` / `latestDrawSeq`
- `mode`: e.g., `TREE`

Example:

```json
{
  "v": 1,
  "gameId": "ab12",
  "secret": "k3y",
  "hostId": "peer-host-123",
  "seeds": ["p1","p2","p3","p4","p5","p6"],
  "qrSeq": 42
}
```

Addendum (QR rendering): The protocol layer generates the QR payload/connection string only. Rendering the QR code is handled by the UI layer.

### 4.2 Join Strategy Summary

1. Joiner scans QR.
2. Joiner contacts host for authorization and heavy payload (recommended) **OR** contacts a seed peer for recursive join.
3. Joiner attempts to attach to one peer as parent.
4. If rejected, joiner follows redirect list recursively.
5. On success, joiner establishes cousin links.

### 4.3 Recommended Join Sequence (Practical)

**Step A: Host Onboard (short-lived)**
- Joiner connects to host via PeerJS DataChannel.
- Sends `JOIN_REQUEST` with secret.
- Host replies with:
  - `JOIN_ACCEPT`
  - playerId
  - heavy payload (e.g., Bingo card)
  - seed list for parent candidates
  - current `rainSeq` / current game state pointer
- Joiner closes host connection (unless host invites joiner as L1 child).

**Step B: Parent Attach (recursive)**
- Joiner shuffles candidate seed list and tries one.
- Sends `ATTACH_REQUEST`.
- Peer responds with `ATTACH_ACCEPT` or `ATTACH_REJECT` + redirect list.

**Attempt Limits**
- `MAX_ATTACH_ATTEMPTS = 10`
- `MAX_REDIRECT_DEPTH = 5`

**Fallback**
- If attach fails, joiner reconnects to host briefly for a new seed list (no rescan required).

### 4.4 Recursive Admission Control (Redirect Lists)

Any node can behave like the host for admission:
- If it has child capacity → accept.
- Else → reject with a redirect list of downstream peers that are likely to have capacity.

**Redirect list requirements (normative):**
- MUST be shuffled/randomized to avoid hotspotting.
- SHOULD be 5–10 items.
- SHOULD prefer peers that are known (from subtree summaries) to have free slots.

---

## 5. Virtual Tree Map (Host View)

### 5.1 Purpose

The host maintains a **best-effort** model of:
- parent/child relationships
- node levels
- connection capacity
- liveness/health

Used for:
- QR seed selection
- UI display (who dropped)
- rebalancing guidance

### 5.2 Data Model (Host)

For each `nodeId`:
- `level` (estimated)
- `parentId`
- `childrenIds[]`
- `cousinIds[]` (optional/approx)
- `capacity`: { childrenMax, childrenUsed, cousinMax, cousinUsed }
- `lastSeenRainSeq` (from aggregated status)
- `state`: { OK | SUSPECT | PARTITIONED | OFFLINE }

### 5.3 Updates to Host Map

Host learns topology through:
- join onboarding (host assigns playerId and payload)
- aggregated subtree status reports from L1 nodes
- occasional explicit topology messages (optional)

Host does not require perfect accuracy.

---

## 6. Heartbeat (“RAIN”) & Partition Detection

### 6.1 RAIN Message

Host emits `RAIN` once per second (1Hz).
- `rainSeq` increments monotonically.
- No timestamps required.

Nodes forward `RAIN` to children.

### 6.2 Local Detection Rule

Each node maintains:
- `lastRainSeq` (most recently received)
- `lastRainReceivedAt` (local clock)

A node enters `SUSPECT_UPSTREAM` when:
- `now - lastRainReceivedAt > 3 seconds` **OR**
- expected `rainSeq` does not advance for 3 cycles.

### 6.3 Patch Mode (Cousin Pull)

On suspect:
1. Node keeps parent connection (do not thrash immediately).
2. Node requests missing state from cousins via `REQ_STATE`.
3. If no cousins are available (common for L1), node MAY request state from host via `REQ_STATE`.
4. Node forwards any recovered `RAIN`/game events to its children.
5. Node periodically retries parent or seeks reparenting.

**Patch-forwarded RAIN semantics (normative):**
- If a node learns a newer `latestRainSeq` via `STATE`, it MUST treat that as “rain received” (update `lastRainSeq` and `lastRainReceivedAt`) and MUST forward a `RAIN` with that `rainSeq` down to its children.
- The forwarded/patched `RAIN` MAY set `src` to the host if known, or to the patching node if not. Receivers MUST rely on `rainSeq` (not `src`) for dedupe.

### 6.4 Escalation

If patch mode persists for `T_REBIND = 60–120 seconds`:
- Node sends `REBIND_REQUEST` to host, including subtree size.

If host unreachable:
- Node enters `WAITING_FOR_HOST` and continues best-effort patch via cousins with exponential backoff.

---

## 7. Cousin Links (Side Connections)

### 7.1 Purpose

Cousin links provide:
- alternative paths for state recovery
- repair capability when parent is alive but partitioned
- fast subtree continuity (avoid collapse)

### 7.2 Establishment

Upon `ATTACH_ACCEPT`, parent provides a cousin candidate list:
- peers at same level but different parent branch
- randomized

Child establishes up to `S=2` cousin connections.

### 7.2.1 Cousin Handshake & Registration (normative)

PeerJS connections can arrive inbound; both sides MUST agree on link role.

One of the following MUST be implemented:

**Option A (PeerJS connection metadata):**
- Initiator sets `conn.metadata.role = "COUSIN"`.
- Receiver MUST register the inbound connection as a cousin link if metadata matches.

**Option B (in-band handshake):**
- After opening the DataChannel, initiator sends `LINK_HELLO` with `{role:"COUSIN"}`.
- Receiver replies `LINK_HELLO_ACK` and registers the link.

In both options:
- Cousin links MUST be symmetric for repair replies (`REQ_STATE/STATE`) to route reliably.

### 7.3 Usage Rules

- Cousin links are **not** used for normal broadcast forwarding.
- Cousin links are used for:
  - `REQ_STATE` / `STATE` exchanges
  - repair coordination
  - optional emergency forwarding when a node is orphaned

### 7.4 L1 Node Exception

**L1 nodes (nodes directly attached to Host) do NOT have cousins.**

L1 recovery strategy on Host loss:
1. Enter `WAITING_FOR_HOST` state
2. Retry Host connection with exponential backoff
3. Continue forwarding cached state to children if possible

---

## 8. Message Envelope & Versioning

All messages are JSON objects sent over PeerJS DataChannel.

### 8.1 Common Envelope Fields

Required:
- `t`: message type string
- `v`: protocol version integer (start at 1)
- `gameId`: session id
- `src`: sender peerId
- `msgId`: unique id (uuid)
- `path`: array of peerIds (trace of forwarders)

Optional:
- `dest`: peerId (final destination for directed/unicast)
- `route`: array of peerIds (explicit hop-by-hop route; mainly for replies)
- `ttl`: hop limit (decrement each forward; drop at 0)
- `seq`: per-stream sequence number
- `replyTo`: msgId

Example:

```json
{ "t":"RAIN", "v":1, "gameId":"ab12", "src":"peer-host", "msgId":"...", "rainSeq":123, "path":[] }
```

### 8.2 Stream Sequence Numbers

- `rainSeq`: host-only monotonic
- `gameSeq`: host-only monotonic for broadcast game events

Clients dedupe with `msgId` and/or `seq`.

### 8.3 Path & Loop Rules (normative)

- When forwarding, append your own peerId to `path` only if it is not already the last element.
- If your peerId already appears anywhere in `path`, drop the message (loop guard).
- If `ttl` is present: decrement by 1 on forward; if `ttl` becomes 0, drop the message.
- For forwarded messages, keep `msgId` unchanged.

### 8.4 Directed Reply Routing (Reverse-Path) (normative)

For critical directed replies (`ACK`, `STATE`, `COUSINS`):
- Receiver computes `route = reverse(request.path)`.
- Reply sets `dest = request.src` and includes `route`.
- Each hop forwards to the next peerId in `route`.
- If next-hop is missing, a hop MAY fall back to forwarding to its parent, but MUST preserve `dest` and MUST NOT create loops (use §8.3).

---

## 9. Message Types

### 9.1 Bootstrap & Join

#### `JOIN_REQUEST` (client → host)

```json
{ "t":"JOIN_REQUEST", "v":1, "gameId":"...", "src":"peerX", "msgId":"...", "secret":"...", "clientInfo":{...}, "path":[] }
```

#### `JOIN_ACCEPT` (host → client)

```json
{
  "t":"JOIN_ACCEPT",
  "v":1,
  "gameId":"...",
  "src":"host",
  "msgId":"...",
  "playerId":"p123",
  "payload":{ "type":"INITIAL_STATE", "data":{...} },
  "seeds":["peerA","peerB"],
  "rainSeq":123,
  "gameSeq":55,
  "path":[]
}
```

#### `JOIN_REJECT` (host → client)

```json
{ "t":"JOIN_REJECT", "v":1, "gameId":"...", "src":"host", "msgId":"...", "reason":"BAD_SECRET", "path":[] }
```

#### `ATTACH_REQUEST` (child → candidate parent)

```json
{ "t":"ATTACH_REQUEST", "v":1, "gameId":"...", "src":"peerX", "msgId":"...", "wantRole":"CHILD", "depth":0, "path":[] }
```

#### `ATTACH_ACCEPT` (parent → child)

```json
{
  "t":"ATTACH_ACCEPT",
  "v":1,
  "gameId":"...",
  "src":"peerParent",
  "msgId":"...",
  "parentId":"peerParent",
  "level":2,
  "cousinCandidates":["peerC1","peerC2","peerC3"],
  "childrenMax":3,
  "childrenUsed":1,
  "path":[]
}
```

#### `ATTACH_REJECT` (parent → child)

```json
{
  "t":"ATTACH_REJECT",
  "v":1,
  "gameId":"...",
  "src":"peerParent",
  "msgId":"...",
  "reason":"FULL",
  "redirect":["peerDown1","peerDown2","peerDown3"],
  "depthHint":2,
  "path":[]
}
```

### 9.2 Heartbeat & Health

#### `RAIN` (host → all via tree)

```json
{ "t":"RAIN", "v":1, "gameId":"...", "src":"host", "msgId":"...", "rainSeq":123, "path":[] }
```

#### `REQ_STATE` (node → cousin, parent, or host)

Request missing rain/game events.

**Routing & fallback (normative):**
- Prefer cousins first.
- If no cousins are available, MAY send to host.

```json
{ "t":"REQ_STATE", "v":1, "gameId":"...", "src":"peerX", "msgId":"...", "fromRainSeq":120, "fromGameSeq":50, "path":["peerX"] }
```

#### `STATE` (peer/host → requester)

Provide latest pointers and optionally a bounded list of missing events.

**Event sequencing (normative):** `events` MUST carry sequence numbers.

**Host response contract (normative):**
- Host MUST respond with `STATE`.
- Host SHOULD include as many events as possible from `(fromGameSeq+1 .. latestGameSeq)` up to `STATE_MAX_EVENTS`.
- If requested range is older than cache, host MUST set `truncated:true` and include `minGameSeqAvailable`.

```json
{
  "t":"STATE",
  "v":1,
  "gameId":"...",
  "src":"peerY",
  "msgId":"...",
  "replyTo":"<reqStateMsgId>",
  "dest":"peerX",
  "route":["peerY","...","peerX"],
  "latestRainSeq":123,
  "latestGameSeq":55,
  "minGameSeqAvailable":40,
  "truncated":false,
  "events":[ {"seq":54,"event":{ "type":"DRAW_NUMBER", "data":{ "n":12 } }} ],
  "path":["peerY"]
}
```

#### `SUBTREE_STATUS` (node → parent)

```json
{
  "t":"SUBTREE_STATUS",
  "v":1,
  "gameId":"...",
  "src":"peerX",
  "msgId":"...",
  "lastRainSeq":123,
  "state":"OK",
  "children":[
    {"id":"child1","state":"OK","lastRainSeq":123},
    {"id":"child2","state":"OFFLINE","lastRainSeq":118}
  ],
  "subtreeCount":17,
  "path":["peerX"]
}
```

**Subtree counting (normative):** `subtreeCount` includes sender + all descendants.

### 9.3 Repair / Rebalance

#### `REBIND_REQUEST` (node → host)

```json
{
  "t":"REBIND_REQUEST",
  "v":1,
  "gameId":"...",
  "src":"peerX",
  "msgId":"...",
  "lastRainSeq":120,
  "lastGameSeq":53,
  "subtreeCount":17,
  "reason":"UPSTREAM_STALL",
  "path":["peerX"]
}
```

#### `REBIND_ASSIGN` (host → node)

```json
{
  "t":"REBIND_ASSIGN",
  "v":1,
  "gameId":"...",
  "src":"host",
  "msgId":"...",
  "newParentCandidates":["peerP1","peerP2","peerP3"],
  "priority":"TRY_IN_ORDER",
  "path":["host"]
}
```

### 9.4 Game-Generic Messaging

#### `GAME_EVENT` (host → all via tree)

```json
{
  "t":"GAME_EVENT",
  "v":1,
  "gameId":"...",
  "src":"host",
  "msgId":"...",
  "gameSeq":55,
  "event":{ "type":"DRAW_NUMBER", "data":{ "n":72 } },
  "path":["host"]
}
```

Clients dedupe using `gameSeq`.

#### `GAME_CMD` (client → host)

```json
{
  "t":"GAME_CMD",
  "v":1,
  "gameId":"...",
  "src":"peerX",
  "msgId":"...",
  "cmd":{ "type":"MARK_CELL", "data":{ "cardId":"...","pos":7 } },
  "path":["peerX"]
}
```

**Host idempotency (normative):** Host MUST dedupe `GAME_CMD` by `msgId` (bounded cache) or otherwise apply commands idempotently.

#### `GAME_ACK` (host → client)

```json
{ "t":"GAME_ACK", "v":1, "gameId":"...", "src":"host", "msgId":"...", "replyTo":"<cmdMsgId>", "ok":true, "path":["host"] }
```

### 9.5 Heavy Payload Request (e.g., Bingo card)

#### `REQ_PAYLOAD` (client → host)

```json
{ "t":"REQ_PAYLOAD", "v":1, "gameId":"...", "src":"peerX", "msgId":"...", "payloadType":"BINGO_CARD", "path":["peerX"] }
```

#### `PAYLOAD` (host → client)

```json
{ "t":"PAYLOAD", "v":1, "gameId":"...", "src":"host", "msgId":"...", "payloadType":"BINGO_CARD", "data":{...}, "path":["host"] }
```

### 9.6 Acknowledgement & Reliability

#### `ACK` (generic)

Purpose: Confirm receipt of critical messages (directed/unicast).

**Reply routing (normative):**
- `ACK.dest` MUST be the original sender.
- `ACK.route` SHOULD be set to `reverse(original.path)`.

```json
{
  "t":"ACK",
  "v":1,
  "gameId":"...",
  "src":"peerY",
  "msgId":"...",
  "replyTo":"<originalMsgId>",
  "dest":"peerX",
  "route":["peerY","...","peerX"],
  "path":["peerY"]
}
```

### 9.7 Optional Cousin Discovery

If `cousinCandidates` are absent or insufficient, a node MAY request additional suggestions.

#### `REQ_COUSINS` (node → parent/host)

```json
{ "t":"REQ_COUSINS", "v":1, "gameId":"...", "src":"peerX", "msgId":"...", "path":["peerX"] }
```

#### `COUSINS` (reply)

```json
{
  "t":"COUSINS",
  "v":1,
  "gameId":"...",
  "src":"peerY",
  "msgId":"...",
  "replyTo":"<reqCousinsMsgId>",
  "dest":"peerX",
  "route":["peerY","...","peerX"],
  "cousins":["c1","c2","c3"],
  "path":["peerY"]
}
```

---

## 10. Routing Rules

### 10.1 Downstream Broadcast
- `RAIN` and `GAME_EVENT` propagate **only from parent to children**.
- Cousins do not forward broadcast under normal operation.

### 10.2 Upstream Commands
Client → host messages (`GAME_CMD`, `REBIND_REQUEST`) move upstream:
- node sends to parent
- parent forwards to its parent
- until host

Parents may batch or rate-limit upstream forwarding.

### 10.3 Patch Mode Forwarding
When upstream rain stalls:
- node may obtain missing `RAIN`/`GAME_EVENT` from cousin (or host fallback) via `STATE`.
- node forwards recovered events **down to children**, including forwarding a `RAIN` when patching advances `latestRainSeq`.

---

## 11. State Machine (Per Node)

### 11.1 States
- `NORMAL`: receiving rainSeq regularly
- `SUSPECT_UPSTREAM`: rainSeq stalled for >3s
- `PATCHING`: pulling from cousin(s)
- `REBINDING`: requesting new parent from host
- `WAITING_FOR_HOST`: host unreachable; slow retry

### 11.2 Transitions
- NORMAL → SUSPECT_UPSTREAM: missed 3 rain cycles
- SUSPECT_UPSTREAM → PATCHING: immediately send `REQ_STATE` to cousins (or host fallback)
- PATCHING → NORMAL: rainSeq resumes via parent OR repaired path
- PATCHING → REBINDING: patch persists >60–120s
- REBINDING → NORMAL: successfully attached to new parent
- REBINDING → WAITING_FOR_HOST: host unreachable
- WAITING_FOR_HOST → REBINDING: periodic retry

**Reattach requirement (normative):** On parent connection close/detach, a node MUST attempt to reattach using known seeds/redirects/cousins and MAY fall back to host bootstrap with exponential backoff.

---

## 12. Rate Limits & Backoff

- Join attempts: max 10; exponential backoff between attempts.
- `REQ_STATE`: at most 1 per second during first 5 seconds, then back off to 2s, 5s, 10s.
- `SUBTREE_STATUS`: default every 5 seconds; immediate send on child join/leave.

---

## 13. Security & Abuse Considerations (Minimal)

- Join uses a shared `secret` included in QR.
- Host rejects `JOIN_REQUEST` with invalid secret.
- All messages include `gameId` and are ignored if mismatched.
- Optional: host signs `GAME_EVENT` with HMAC(secret, payload) for tamper detection.

---

## 14. Implementation Notes (PeerJS)

- Use **DataChannel only** (no media).
- Configure PeerJS with STUN server for faster ICE even on LAN:
  - `stun:stun.l.google.com:19302`
- Reject quickly when full: send `ATTACH_REJECT` then close the connection.
- Keep connections stable; avoid churn.
- Prefer `msgId` + `gameSeq` dedupe.
- Validate `v` and required fields for control-plane messages; ignore unknown `t`.

---

## 15. Extensibility

- New game features use `GAME_EVENT` and `GAME_CMD` types.
- Protocol-level evolution increments `v` and adds optional fields.

---

## 16. Appendix: Recommended Defaults

- Host children `K = 5`
- Node children `C = 3`
- Cousins `S = 2`
- RAIN interval = 1 second
- Stall threshold = 3 seconds
- Rebind threshold = 60–120 seconds
- Attach attempts = 10
- Redirect depth = 5
- `STATE_MAX_EVENTS` (recommended): 50 (tune to payload size)

---

## 17. Open Questions (Intentionally Deferred)

- Optimal QR rotation cadence
- Host policy for selecting seed peers
- Subtree migration strategy (optional)
- Handling duplicate player identities across reconnects
- Persisting state if host temporarily disconnects

