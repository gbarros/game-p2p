# Integration plan (protocol simulation)

## Goal
Create a configurable, long-running protocol simulation (default 20 nodes, scalable up to 100) and exercise it with “integration-style” scenarios that actively manipulate the network and verify stability/recovery.

## Scope
- Lives primarily under `packages/protocol/src/__tests__/`.
- Uses the in-repo `peerjs` mock (`packages/protocol/src/__tests__/peerjs-mock.ts`) and `vitest` fake timers.
- One setup per test file; scenarios run as sequential phases (multiple `it(...)` blocks) against the same simulation instance.

## Configuration
- `SIM_NODES` env var (default `20`, max `100`).
- The simulation may *add nodes beyond the minimum* (up to max) if required to satisfy scenario prerequisites (e.g. to ensure a depth ≥ 3 path exists).

## Simulation invariants (stabilization checks)
After initial network convergence:
- All nodes are `peerOpen=true` and `isAttached=true`.
- The resulting topology is a tree rooted at the Host (no cycles; every node reaches host by following `parentId`).
- Connections match topology (every node’s `parent` connection is open; `children` connections are open).
- Rain propagates: for every node, `host.rainSeq - node.rainSeq` stays within a small bound after settling.

## Scenarios (phased tests)
1) **Host → leaf comms**
   - Pick a leaf (node with no children) with maximum depth.
   - Host sends message to leaf (ACK required) and receives ACK.
   - Optional: verify leaf observes the message (game event callback) for end-to-end sanity.

2) **Leaf → Host comms**
   - Same (or furthest) leaf sends upstream command (ACK required) and receives ACK.
   - Also verify leaf’s `PING/PONG` path via `node.pingHost()` (pending ping cleared).

3) **Mid-node pause → cousin patching**
   - Find a sub-tree `Host -> L1 -> L2 -> L3` where:
     - `L2` has at least one cousin connection
     - `L2` has at least one child (so `L3` exists)
   - Pause `L1` (drop all processing there).
   - Expected:
     - `L2` transitions to `SUSPECT_UPSTREAM`/`PATCHING`
     - `L3` remains stable (does not go `OFFLINE`; does not enter its own patch mode)
     - `L2` continues to advance downstream rain via synthetic `RAIN` from `STATE` pulls.

4) **Mid-node resume**
   - Unpause `L1`.
   - Expected:
     - `L2` returns to `NORMAL` once it receives real `RAIN` from upstream
     - `L3` remains in `NORMAL` and continues to receive rain/events.

5) **Mid-node crash**
   - Crash the same mid-node (`L1`) by closing its parent/child connections and destroying its peer.
   - Store its peer id for recovery.
   - Expected:
     - Downstream (`L2`/`L3`) detects the disconnection *immediately* (parent `close`) and begins recovery/reattachment promptly (no extra multi-second delay).

6) **Mid-node recovery**
   - Recreate the crashed node using the same peer id and bootstrap again.
   - Expected:
     - Recovered node attaches to the network.
     - Downstream nodes return to a healthy attached state. Children may reattach to different parents (acceptable for now).

## Notes / known limitations
- The current protocol implementation is still evolving; some “rejoin old parent / reclaim children” behaviors may not exist yet. The tests should primarily enforce stability and “eventual recovery”, while documenting any limitations observed during the scenarios.

