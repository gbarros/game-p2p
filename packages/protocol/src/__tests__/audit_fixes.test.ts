import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('peerjs', async () => {
    const mod = await import('./peerjs-mock.js');
    return { default: mod.FakePeer, DataConnection: mod.FakeDataConnection };
});

import { Host } from '../Host.js';
import { Node } from '../Node.js';
import type { ProtocolMessage, AttachReject } from '../types.js';
import { FakeDataConnection, FakePeer, resetPeers } from './peerjs-mock.js';

describe('Audit Fixes Verification', () => {
    beforeEach(() => {
        resetPeers();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('Gap 1: Host responds to REQ_STATE with STATE (replyTo/dest/route + pointers)', async () => {
        const host = new Host('game', 'secret', new FakePeer('host') as any);
        const node = new Node('game', 'secret', new FakePeer('nodeA') as any);
        const hostId = host.getPeerId();

        // Simulate nodeA attached to host
        // We can manually simulate the request without full attachment
        const connToHost = new FakeDataConnection(hostId);
        (node as any).connManager.parent = connToHost;
        (node as any).stateManager.isAttached = true;
        // connToHost.peer = hostId; // This is readonly/set by constructor, need cast if modifying or pass in constructor
        // FakeDataConnection constructor sets this.peer
        // But constructor takes 'peer' as destination? No, 'peer' property of connection usually means REMOTE peer.
        // In FakeDataConnection constructor: this.peer = peer;
        // So new FakeDataConnection(hostId) sets .peer to hostId. Correct.
        connToHost.open = true;

        // Let's use the actual Host processing
        // We need to establish the connection on the Host side too
        const hostConn = new FakeDataConnection('nodeA');
        // hostConn.peer = 'nodeA'; // set by constructor
        hostConn.open = true;
        (host as any).children.set('nodeA', hostConn);
        (host as any).topologyManager.topology.set('nodeA', { nextHop: 'nodeA', depth: 1, lastSeen: Date.now(), freeSlots: 3, state: 'OK' });

        // Node sends REQ_STATE
        const reqState: ProtocolMessage = {
            t: 'REQ_STATE',
            v: 1,
            gameId: 'game',
            src: 'nodeA',
            msgId: 'm1',
            dest: 'HOST',
            fromRainSeq: 0,
            fromGameSeq: 0,
            path: ['nodeA']
        };

        // Host receives message
        (host as any).handleMessage(hostConn, reqState);

        // Expect hostConn to have sent a STATE message
        expect(hostConn.sent.length).toBeGreaterThan(0);
        const response = hostConn.sent.find(m => (m as ProtocolMessage).t === 'STATE') as ProtocolMessage;
        expect(response).toBeDefined();
        expect(response.t).toBe('STATE');
        expect(response.src).toBe(hostId);
        // Stronger contract requirements (spec v1.1 addenda)
        expect((response as any).replyTo).toBe('m1');
        expect((response as any).dest).toBe('nodeA');
        // Even for a direct child, host SHOULD include an explicit route
        expect(Array.isArray((response as any).route)).toBe(true);
        expect((response as any).route[0]).toBe(hostId);
    });

    it('Gap 1b: Host STATE indicates truncation when request is older than cache', async () => {
        const host = new Host('game', 'secret', new FakePeer('host') as any);
        const hostConn = new FakeDataConnection('nodeA');
        hostConn.open = true;
        (host as any).children.set('nodeA', hostConn);
        (host as any).topologyManager.topology.set('nodeA', { nextHop: 'nodeA', depth: 1, lastSeen: Date.now(), freeSlots: 3, state: 'OK' });

        // Host MAX_CACHE_SIZE is 100. Push 110 events so the oldest 10 drop.
        for (let i = 1; i <= 110; i++) {
            host.broadcastGameEvent(`EVT${i}`, { i });
        }

        const reqState: ProtocolMessage = {
            t: 'REQ_STATE',
            v: 1,
            gameId: 'game',
            src: 'nodeA',
            msgId: 'm-req-old',
            dest: 'HOST',
            fromRainSeq: 0,
            fromGameSeq: 0,
            path: ['nodeA']
        };

        (host as any).handleMessage(hostConn, reqState);

        const response = hostConn.sent.find(m => (m as any).t === 'STATE') as any;
        expect(response).toBeDefined();

        // The response should admit truncation and expose the minimum available seq.
        expect(response.truncated).toBe(true);
        expect(response.minGameSeqAvailable).toBe(11); // First 10 dropped, cache starts at seq 11
        expect(Array.isArray(response.events)).toBe(true);
        expect(response.events[0].seq).toBe(11);
        expect(response.events[response.events.length - 1].seq).toBe(110);
    });

    it('Gap 2: Incoming cousin connection is registered', async () => {
        const nodeB = new Node('game', 'secret', new FakePeer('nodeB') as any);

        // Manually trigger handleIncomingConnection on B
        const connFromA = new FakeDataConnection('nodeA');
        (connFromA as any).metadata = { gameId: 'game', secret: 'secret', role: 'COUSIN' };

        // Access private method via any
        (nodeB as any).handleIncomingConnection(connFromA);

        expect((nodeB as any).connManager.cousins.has('nodeA')).toBe(true);
        expect((nodeB as any).connManager.cousins.get('nodeA')).toBe(connFromA);

        // A cousin connection must NOT be treated as a child connection
        expect((nodeB as any).connManager.children.has('nodeA')).toBe(false);
    });

    it('Gap 3a: Node responds to REQ_STATE with sequenced events (StateMessage.events carries {seq,event})', async () => {
        const node = new Node('game', 'secret', new FakePeer('node') as any);
        (node as any).stateManager.rainSeq = 10;
        (node as any).lastGameSeq = 2;
        (node as any).gameEventCache.add(1, { type: 'EVT1', data: { a: 1 } });
        (node as any).gameEventCache.add(2, { type: 'EVT2', data: { a: 2 } });

        const cousinConn = new FakeDataConnection('cousin');
        cousinConn.open = true;

        const reqState: ProtocolMessage = {
            t: 'REQ_STATE',
            v: 1,
            gameId: 'game',
            src: 'cousin',
            msgId: 'req-1',
            dest: 'node',
            fromRainSeq: 0,
            fromGameSeq: 0,
            path: ['cousin']
        };

        (node as any).handleMessage(cousinConn, reqState);

        const state = cousinConn.sent.find(m => (m as any).t === 'STATE') as any;
        expect(state).toBeDefined();
        expect(state.replyTo).toBe('req-1');
        expect(state.dest).toBe('cousin');
        expect(Array.isArray(state.events)).toBe(true);
        expect(state.events[0]).toHaveProperty('seq');
        expect(state.events[0]).toHaveProperty('event');
        expect(state.events.map((e: any) => e.seq)).toEqual([1, 2]);
        expect(state.events.map((e: any) => e.event.type)).toEqual(['EVT1', 'EVT2']);
    });

    it('Gap 3b: Node consumes STATE.events using explicit seq (no inferred seq reconstruction)', async () => {
        const node = new Node('game', 'secret', new FakePeer('node') as any);
        const childConn = new FakeDataConnection('child');
        childConn.open = true;
        (node as any).connManager.children.set('child', childConn);

        // Pretend we are already up to seq 96.
        (node as any).lastGameSeq = 96;
        (node as any).stateManager.rainSeq = 10;

        const parentConn = new FakeDataConnection('parent');
        parentConn.open = true;

        // Provide non-contiguous seqs to ensure implementation does NOT infer from latestGameSeq/length.
        const stateMsg: ProtocolMessage = {
            t: 'STATE',
            v: 1,
            gameId: 'game',
            src: 'parent',
            msgId: 'state-1',
            dest: 'node',
            latestRainSeq: 11,
            latestGameSeq: 100,
            events: [
                { seq: 97, event: { type: 'EVT97', data: { n: 97 } } },
                { seq: 100, event: { type: 'EVT100', data: { n: 100 } } },
            ],
            path: ['parent']
        } as any;

        (node as any).handleMessage(parentConn, stateMsg);

        // Node should forward repaired events downstream with the *same* seq numbers.
        const forwarded = childConn.sent.filter(m => (m as any).t === 'GAME_EVENT') as any[];
        expect(forwarded.length).toBe(2);
        expect(forwarded.map(m => m.gameSeq)).toEqual([97, 100]);
    });

    it('Gap 3: STATE message includes events with sequence numbers', async () => {
        const host = new Host('game', 'secret', new FakePeer('host') as any);
        const hostConn = new FakeDataConnection('nodeA');
        // hostConn.peer = 'nodeA'; // Correctly managed by constructor
        hostConn.open = true;
        (host as any).children.set('nodeA', hostConn);

        // Add some events to Host cache
        host.broadcastGameEvent('EVT1', { foo: 'bar' }); // Seq 1
        host.broadcastGameEvent('EVT2', { baz: 'qux' }); // Seq 2

        const reqState: ProtocolMessage = {
            t: 'REQ_STATE',
            v: 1,
            gameId: 'game',
            src: 'nodeA',
            msgId: 'm1',
            dest: 'HOST',
            fromRainSeq: 0,
            fromGameSeq: 0, // Request from 0, should get 1 and 2
            path: ['nodeA']
        };

        (host as any).handleMessage(hostConn, reqState);

        const response = hostConn.sent.find(m => (m as ProtocolMessage).t === 'STATE') as any;
        expect(response).toBeDefined();
        expect(response.events).toHaveLength(2);
        expect(response.events[0].seq).toBe(1);
        expect(response.events[0].event.type).toBe('EVT1');
        expect(response.events[1].seq).toBe(2);
        expect(response.events[1].event.type).toBe('EVT2');
    });

    it('Gap 5: Host redirects to smart candidates', async () => {
        const host = new Host('game', 'secret', new FakePeer('host') as any);

        // Fill host with 5 children
        for (let i = 1; i <= 5; i++) {
            const id = `child${i}`;
            const conn = new FakeDataConnection(id);
            // (conn as any).peer = id;
            (host as any).children.set(id, conn);

            // Set topology: only child3 has free slots
            const freeSlots = i === 3 ? 5 : 0;
            (host as any).topologyManager.topology.set(id, { nextHop: id, depth: 1, lastSeen: Date.now(), freeSlots: freeSlots, state: 'OK' });
        }

        const newConn = new FakeDataConnection('newJoiner');
        // (newConn as any).peer = 'newJoiner';
        (newConn as any).metadata = { gameId: 'game', secret: 'secret' };
        newConn.open = true; // Must be open for Host to send ATTACH_REJECT

        // Trigger ATTACH_REQUEST via handleMessage since direct event listener might be hard to reach
        // Actually handleConnection binds it. Let's call callback directly if exposed?
        // Or just emulate the message reception logic.
        // It's in host.handleMessage
        const attachReq: ProtocolMessage = {
            t: 'ATTACH_REQUEST',
            v: 1,
            gameId: 'game',
            src: 'newJoiner',
            msgId: 'm1',
            dest: 'HOST',
            wantRole: 'CHILD',
            depth: 0,
            path: ['newJoiner']
        };

        // We need to inject the connection so it can reply
        // Host handleMessage takes (conn, msg)
        (host as any).handleMessage(newConn, attachReq);

        const reject = newConn.sent.find(m => (m as ProtocolMessage).t === 'ATTACH_REJECT') as AttachReject;
        expect(reject).toBeDefined();
        expect(reject.redirect).toContain('child3');
        // Because of randomization/shuffling, it might contain others if they fall back?
        // But our logic prioritizes those with slots.
        // Also child3 is the ONLY one with slots > 0.
        // So it SHOULD be in the list.

        // Verify child1 (0 slots) is NOT in the list? 
        // The implementation does simpleShuffle fallback if < 5 candidates.
        // So it might return others but child3 must be there.
        expect(reject.redirect.some(id => id === 'child3')).toBe(true);
    });

    it('Gap 8: Rebind counts descendants', async () => {
        const nodeA = new Node('game', 'secret', new FakePeer('nodeA') as any);

        // A has child B
        const connB = new FakeDataConnection('nodeB');
        // (connB as any).peer = 'nodeB';
        (nodeA as any).connManager.children.set('nodeB', connB);
        (nodeA as any).childDescendants.set('nodeB', [{ id: 'nodeC', hops: 2 }]); // B has child C

        // Mock parent for A
        const parentConn = new FakeDataConnection('host');
        // (parentConn as any).peer = 'host';
        parentConn.open = true;
        (nodeA as any).connManager.parent = parentConn;

        // Trigger rebind
        (nodeA as any).requestRebind('TEST');

        const rebindReq = parentConn.sent.find(m => (m as ProtocolMessage).t === 'REBIND_REQUEST') as any;
        expect(rebindReq).toBeDefined();

        // Spec v1.1 §18.7: subtreeCount MUST include sender + all descendants.
        // So: A + B + C = 3
        expect(rebindReq.subtreeCount).toBe(3);
    });

    it('Gap 8b: SUBTREE_STATUS.subtreeCount includes self + descendants (spec v1.1 §18.7)', async () => {
        const nodeA = new Node('game', 'secret', new FakePeer('nodeA') as any);

        const connB = new FakeDataConnection('nodeB');
        connB.open = true;
        (nodeA as any).connManager.children.set('nodeB', connB);
        (nodeA as any).childDescendants.set('nodeB', [{ id: 'nodeC', hops: 1, freeSlots: 0 }]);

        const parentConn = new FakeDataConnection('host');
        parentConn.open = true;
        (nodeA as any).connManager.parent = parentConn;

        (nodeA as any).reportSubtree();

        const st = parentConn.sent.find(m => (m as any).t === 'SUBTREE_STATUS') as any;
        expect(st).toBeDefined();
        expect(st.subtreeCount).toBe(3);
    });

    it('Gap 4: Patch mode broadcasts RAIN downstream', async () => {
        const node = new Node('game', 'secret', new FakePeer('node') as any);
        const childConn = new FakeDataConnection('child');
        childConn.open = true;
        (node as any).connManager.children.set('child', childConn);

        // State: PATCHING, rainSeq: 10
        (node as any).stateManager.state = 'PATCHING';
        (node as any).stateManager.rainSeq = 10;

        // Receive STATE with rainSeq 11
        const stateMsg: ProtocolMessage = {
            t: 'STATE',
            v: 1,
            gameId: 'game',
            src: 'parent',
            msgId: 'm1',
            dest: 'node',
            latestRainSeq: 11,
            latestGameSeq: 100,
            path: ['parent']
        };

        const parentConn = new FakeDataConnection('parent');
        (node as any).handleMessage(parentConn, stateMsg);

        // Expect RAIN to child
        const rain = childConn.sent.find(m => (m as ProtocolMessage).t === 'RAIN') as any;
        expect(rain).toBeDefined();
        expect(rain.rainSeq).toBe(11);

        // Node must also update its local pointer.
        expect((node as any).stateManager.rainSeq).toBe(11);
    });

    it('Gap 6: Host dedupes messages (prevents double ACK / double apply)', async () => {
        const host = new Host('game', 'secret', new FakePeer('host') as any);
        const conn = new FakeDataConnection('node');
        conn.open = true;
        (host as any).children.set('node', conn);
        (host as any).topologyManager.topology.set('node', { nextHop: 'node', depth: 1, lastSeen: Date.now(), freeSlots: 3, state: 'OK' });

        const msg: ProtocolMessage = {
            t: 'GAME_CMD',
            v: 1,
            gameId: 'game',
            src: 'node',
            msgId: 'uuid-unique',
            dest: 'HOST',
            ack: true,
            cmd: { type: 'CMD', data: {} },
            path: ['node']
        };

        // First handle (should produce one ACK)
        (host as any).handleMessage(conn, msg);
        const acks1 = conn.sent.filter(m => (m as any).t === 'ACK');
        expect(acks1).toHaveLength(1);

        // Duplicate handle (should NOT produce a second ACK)
        (host as any).handleMessage(conn, msg);
        const acks2 = conn.sent.filter(m => (m as any).t === 'ACK');
        expect(acks2).toHaveLength(1);
    });
});
