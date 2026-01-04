Critical gaps (protocol can break / won’t heal correctly)
1) Host does not implement REQ_STATE fallback (spec says it should)

Nodes explicitly fall back to asking the host for state when no cousins exist, but the host will silently ignore it.

Where the node sends it: Node.ts:1253-1271 (sendReqStateToCousins() → fallback builds REQ_STATE with dest:'HOST')

Routing behavior: Node.ts:443-463 routes any dest:'HOST' message upward

Host missing handler: Host.ts:106-304 (handleMessage() switch has no case 'REQ_STATE')

Why it matters: in sparse networks (or early join phases) where cousins aren’t established yet, your recovery path is dead.

Fix direction: add case 'REQ_STATE' to host and reply with STATE using gameEventCache and current rainSeq/gameSeq (Host.ts:46-48, Host.ts:547-552 already cache game events).

2) Incoming cousin connections are never registered → replies can’t route back

You only register cousins on the initiator side.

Outgoing cousin adds to map: Node.ts:1108-1120 (connectToCousin() sets this.cousins.set(...))

Incoming connections do not classify/store role=COUSIN: Node.ts:898-920 (handleIncomingConnection() only special-cases ATTACH_REQUEST and SUBTREE_STATUS)

But routeReply() can only send via parent/children/cousins maps: Node.ts:1011-1057

This breaks STATE replies created with explicit routes: Node.ts:640-666 (REQ_STATE handler builds STATE then calls routeReply())

Why it matters: If A connects to B as cousin, B will not put A in cousins, so when B tries to routeReply() a STATE back, it may fail with: “next hop not connected”.

Fix direction:

In handleIncomingConnection(), if conn.metadata?.role === 'COUSIN', register it in this.cousins and set handlers similarly to outgoing cousins. Or:

Make routeReply() fall back to sourceConn.send(msg) when the computed hop isn’t found (safer for direct-cousin requests).

3) STATE.events loses sequence numbers; receiver “reconstructs” them incorrectly

You send only raw events, not {seq,event}, and the receiver guesses the seq range.

Sender strips seq: Node.ts:644-646 (eventsToSend = cache.filter(...).map(e => e.event))

Receiver guesses seq positions: Node.ts:676-688 (eventSeq = latestGameSeq - events.length + i + 1)

Why it matters: if caches are truncated (MAX_CACHE_SIZE=20), or events are non-contiguous, you’ll assign wrong gameSeq to recovered events → dedupe will drop legit updates or reorder them.

Fix direction: update protocol and implementation so STATE.events includes sequence numbers:

events: Array<{seq:number, event:{type,data}}> (best)

OR include startGameSeq and require contiguity + indicate truncation.

4) Patch mode repairs rainSeq internally but does not “heal” downstream RAIN

After a STATE, you update rainSeq, but you don’t generate/forward a synthetic RAIN to children, and you don’t refresh stall timers.

Receiver updates counters only: Node.ts:718-720

No downstream RAIN emit or lastRainTime update on repair: Node.ts:668-721

Why it matters: your children can still trip SUSPECT_UPSTREAM because their RAIN stream didn’t resume, even if you repaired state via cousins.

Fix direction: when STATE.latestRainSeq advances, treat it like receiving RAIN:

update lastRainTime / lastParentRainTime

optionally broadcast a RAIN with the repaired rainSeq to children (with dedupe rules so it doesn’t fight the real parent when it returns)

High-impact spec/behavior mismatches
5) ATTACH_REJECT.redirect is too weak and can hotspot

When full, you redirect to your direct children only (and not randomized).

Current behavior: Node.ts:936-949 (redirect: Array.from(this.children.keys()))

Why it matters: if those children are also full, joiners will churn and hammer the same small set. Also you’re ignoring childCapacities/childDescendants you already track.

Fix direction: build redirect list from known-capacity descendants (freeSlots>0), shuffle it, include a bounded size (like 5–10). You already have data structures for this in reportSubtree() (Node.ts:852-892).

6) Host doesn’t dedupe inbound msgId (idempotency risk for GAME_CMD)

Nodes have msgId dedupe; host does not.

Node dedupe: Node.ts:427-438

Host processes without dedupe: Host.ts:106-181 (GAME_CMD / GAME_EVENT)

Why it matters: retries, reconnects, or buggy routing can cause double-apply on host-side game state.

Fix direction: add a small recentMsgIds cache to host similar to node.

7) Host “virtual topology map” is missing important fields in practice

Spec talks about liveness/state/relationships; host currently tracks only: nextHop, depth, lastSeen, freeSlots.

Topology node definition: Host.ts:20-25

Host ignores subtree states/children list: Host.ts:307-330 (only freeSlots + descendants mapping)

Why it matters: QR seeding, monitoring “who dropped”, and smart rebind decisions will be low quality.

Fix direction: either (a) reduce spec expectations, or (b) extend TopologyNode and teach host to ingest more from SUBTREE_STATUS (msg.state, child statuses, lastRainSeq, etc).

8) REBIND_REQUEST.subtreeCount is not actually subtree size

You send only immediate children count.

Where sent: Node.ts:1275-1293 (subtreeCount: this.children.size)

Why it matters: host can’t make informed decisions (“this node is carrying 40 peers, prioritize it”).

Fix direction: use the computed descendant count you already calculate in reportSubtree() (Node.ts:888-890) and cache it for rebind requests.

Test coverage gaps (things that should be tested but currently aren’t)
A) Host REQ_STATE fallback behavior isn’t tested

There’s no test that sends REQ_STATE to host and expects STATE.

Add coverage around Node.ts:1253-1271 + new Host.ts handler.

B) Incoming cousin registration isn’t tested

You should have a test where:

node A connects to node B with {role:'COUSIN'},

A sends REQ_STATE,

B replies successfully (this currently likely fails depending on which side initiated).

C) STATE.events sequencing correctness under cache truncation isn’t tested

Add a test where sender’s cache does not include a contiguous range and verify receiver doesn’t mis-assign gameSeq.

(Your current tests cover patch → rebind timing nicely: protocol.test.ts:508-535, but they don’t validate correctness of repair payloads.)