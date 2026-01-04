# Protocol Audit Implementation Plan

## Scope decisions (confirmed)
- [ ] Implement peer-directed routing for PING/ACK/sendToPeer across any depth (not just direct children).
- [x] Use `GAME_CMD` for node -> host messages and `GAME_EVENT` for host -> fan-out.
- [x] Implement cousin links + patch mode + rebind per `protocol design.md`.

## Message envelope alignment
- [x] Keep `path` as trace-only per spec; do not overload as routing.
- [x] Add explicit `route` (full path) for host-originated peer-directed messages so nodes can forward down the correct child branch.
- [ ] Use the incoming `path` as a reverse route for ACKs (and other replies) so they can return along the same chain.
- [x] Validate `gameId` on all inbound messages (host and node).
- [x] Update `packages/protocol/src/types.ts` if envelope changes are introduced.

## Host routing fixes
- [x] Compute next-hop to any target using the topology map.
- [x] Attach explicit `route` metadata on host-originated unicast so nodes can forward down correctly.
- [x] Handle dead next-hops by pruning and refresh.
- [x] Update `packages/protocol/src/Host.ts`.

## Node routing fixes
- [x] Build a descendant-to-nextHop lookup from `childDescendants` to route down to deep targets.
- [x] Forward host-originated unicast using explicit `route`.
- [ ] Forward ACKs strictly using the reverse of the incoming `path` (do not shortcut).
- [x] Add fallback behavior and drop rules for missing routes (send up when dest not in subtree).
- [x] Enforce `gameId` guard in `handleMessage`.
- [x] Update `packages/protocol/src/Node.ts`.

## Join robustness
- [x] Add `MAX_ATTACH_ATTEMPTS` and `MAX_REDIRECT_DEPTH`.
- [x] Implement exponential backoff for attach attempts.
- [x] Use `depth` in `ATTACH_REQUEST` and update on redirects.
- [x] Randomize redirect lists and bias toward capacity.
- [x] Update `packages/protocol/src/Node.ts` and `packages/protocol/src/Host.ts`.

## Cousin links + patch mode
- [x] Define cousin discovery algorithm (local-only): parent resolves 1st-degree cousins (same depth, different parent), not siblings.
- [x] For deeper nodes, parent may request upstream (e.g., grandparent) for cousin candidates in other branches.
- [x] Randomize cousin candidate lists to avoid hammering the same nodes.
- [x] Track cousin connections (S=2) and manage lifecycle.
- [x] Detect upstream stall and issue `REQ_STATE` to cousins.
- [x] Apply `STATE` recovery and forward repaired events downstream.
- [x] Ensure cousins are not used for normal broadcast.
- [x] Update `packages/protocol/src/Node.ts` and `packages/protocol/src/types.ts`.

## Cousin discovery flow (proposed)
- [x] Add a `REQ_COUSINS` message (child -> parent) including requester depth and desired count.
- [x] If parent has local candidates (same depth, different parent), reply with `COUSINS` list.
- [ ] If parent lacks candidates, it forwards `REQ_COUSINS` upstream (parent -> its parent) and merges response.
- [ ] Each hop randomizes/shuffles and caps list size before returning to avoid hotspots.
- [x] Add `REQ_COUSINS` / `COUSINS` to `packages/protocol/src/types.ts` and handle in `packages/protocol/src/Node.ts`.

## Rebind flow
- [x] Detect prolonged stall and send `REBIND_REQUEST`.
- [x] Host responds with `REBIND_ASSIGN` and candidate parents.
- [x] Node retries attach using assigned candidates.
- [x] Update `packages/protocol/src/Host.ts` and `packages/protocol/src/Node.ts`.

## Game message semantics + caching
- [x] Switch upstream sends to `GAME_CMD` and handle in host (emit callback + optional `GAME_ACK`).
- [x] Keep `GAME_EVENT` host-originated only, and fan-out down the tree.
- [x] Add a configurable game-event cache in nodes (default last 20 events).
- [x] Serve cached events via `STATE` responses for cousin repair.
- [x] Add host-side cache to answer `REQ_STATE` as a fallback (useful for L1 nodes or when cousins are unavailable).
- [x] Update `packages/protocol/src/Node.ts`, `packages/protocol/src/Host.ts`, and `packages/protocol/src/types.ts`.

## Subtree reporting improvements
- [ ] Report real `lastRainSeq` per child.
- [ ] Track and send child health state (OK/SUSPECT/PARTITIONED/OFFLINE).
- [x] Keep `freeSlots` accurate and updated.
- [x] Update `packages/protocol/src/Node.ts` and consumption in `packages/protocol/src/Host.ts`.

## Validation
- [ ] Add or update simulations to cover join storms, parent failure, cousin repair, and rebind.
- [ ] Update `apps/example-site/README.md` or simulation docs with new steps.

## Reaudit fixes (5 open issues)
- [x] Route `dest: 'HOST'` messages upward: treat `HOST` as a routable destination in `Node.handleMessage`, forward to parent when not the host, and add a guard to drop only when no parent exists.
- [x] Ensure `sendToHost`/`requestRebind`/`sendGameEvent` paths use the above routing so non-L1 nodes reach the host.
- [x] Implement cousin resolution at first ancestor with sibling-subtree knowledge: parent builds candidates from other children’s descendant lists at the requester’s depth, excluding siblings and the requester itself.
- [x] When selecting two cousins, prefer different uncle branches (one candidate per different parent subtree) and randomize the order before returning `COUSINS`.
- [x] Emit `REQ_COUSINS` after successful attach (and on stall if no cousins) with `desiredCount=2` and `requesterDepth=myDepth`, and respond using reverse-path routing back to the requester.
- [ ] Implement reverse-path replies: on PING/ACK (and other replies), build `route` as the reverse of incoming `path`, and forward using `route` regardless of direction to preserve cousin traversal.
- [ ] Update routing to honor `route` for any reply message (not just host-originated) and avoid overwriting the reverse-path route.
- [x] Dedupe and cache STATE recovery: ignore events with `gameSeq <= lastGameSeq`, insert recovered events into `gameEventCache`, and update `lastGameSeq` before rebroadcasting.
- [x] Add host fallback for REQ_STATE: if no cousins or they time out, send `REQ_STATE` to `HOST` before rebind and apply the response to cache/state.

## Reaudit follow-ups (round 2)
- [ ] Fix reverse-path reply routing for direct requests: when building `route`, include the responder (e.g., `[self, ...msg.path.reverse()]`) so `routeReply` can forward.
- [ ] Ensure host replies (PONG/ACK/STATE) use reverse-path routing instead of `routeMessage` topology routing.
- [x] Skip `GAME_EVENT` ACK support; no `path` augmentation needed for broadcast ACKs.
- [ ] Update `routeReply` to append to `path` when forwarding so reply traces remain complete.
- [ ] Decide whether `REQ_COUSINS` should merge local candidates with upstream results; if yes, implement merge + shuffle per hop.
