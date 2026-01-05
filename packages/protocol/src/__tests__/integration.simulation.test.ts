import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('peerjs', async () => {
    const mod = await import('./peerjs-mock.js');
    return { default: mod.FakePeer, DataConnection: mod.FakeDataConnection };
});

import { Host } from '../Host.js';
import { Node, NodeState } from '../Node.js';
import { FakePeer, resetPeers } from './peerjs-mock.js';
import { ProtocolSimulation } from './protocol-simulation.js';

const GAME_ID = 'simulation-game';
const SECRET = 'simulation-secret';

function clampInt(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function mulberry32(seed: number) {
    let t = seed >>> 0;
    return () => {
        t += 0x6d2b79f5;
        let x = t;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

describe('Integration simulation', () => {
    const baseNodeCount = clampInt(parseInt(process.env.SIM_NODES || '20', 10) || 20, 1, 100);
    const maxNodes = 100;
    const ensureMinDepth = 3;

    let sim: ProtocolSimulation;
    let makeNode: (id: string) => Node;

    let branch: { l1Id: string; l2Id: string; l3Id: string };
    let crashedL1Id: string | null = null;

    beforeAll(async () => {
        resetPeers();
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockImplementation(mulberry32(1));

        const host = new Host(GAME_ID, SECRET, new FakePeer('host-1') as any);
        const hostId = host.getPeerId();

        makeNode = (id: string) => new Node(GAME_ID, SECRET, new FakePeer(id) as any);
        sim = new ProtocolSimulation({ host, hostId, createNode: makeNode });

        await sim.spawnNodes(baseNodeCount, { staggerMs: 25 });
        await vi.advanceTimersByTimeAsync(30_000);
        await sim.stabilize({ minRainSeq: 10, timeoutMs: 120_000 });

        while (true) {
            if (sim.getMaxDepth() < ensureMinDepth) {
                if (sim.getAllNodeIds().length >= maxNodes) break;
                await sim.spawnNodes(Math.min(10, maxNodes - sim.getAllNodeIds().length), { staggerMs: 25 });
                await vi.advanceTimersByTimeAsync(20_000);
                await sim.stabilize({ minRainSeq: 10, timeoutMs: 120_000 });
                continue;
            }

            try {
                branch = sim.findBranchForMidNodeFault();
                break;
            } catch {
                if (sim.getAllNodeIds().length >= maxNodes) throw new Error('Unable to satisfy branch prerequisites within maxNodes');
                await sim.spawnNodes(Math.min(10, maxNodes - sim.getAllNodeIds().length), { staggerMs: 25 });
                await vi.advanceTimersByTimeAsync(20_000);
                await sim.stabilize({ minRainSeq: 10, timeoutMs: 120_000 });
            }
        }
    });

    afterAll(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('stabilizes (tree formed, connections open, rain propagates)', async () => {
        sim.assertTreeFormed();
        sim.assertConnectionsOpen();
        sim.assertRainPropagating();

        expect(sim.getAllNodeIds().length).toBeGreaterThanOrEqual(baseNodeCount);
        expect(sim.getLeaves().length).toBeGreaterThan(0);
        expect(sim.getMaxDepth()).toBeGreaterThanOrEqual(ensureMinDepth);
    });

    it('Host -> furthest leaf comms (ACK + delivery)', async () => {
        const leafId = sim.getFurthestLeaf();
        const leaf = sim.getNode(leafId);

        const received: Array<{ type: string; from: string }> = [];
        leaf.onGameEventReceived((type, _data, from) => received.push({ type, from }));

        const hostAny = sim.host as any;
        const pendingBefore = hostAny.pendingAcks?.size ?? 0;

        const p = sim.host.sendToPeer(leafId, 'HOST_TO_LEAF', { n: 1 }, true) as Promise<boolean>;

        await sim.waitFor(() => (hostAny.pendingAcks?.size ?? 0) === pendingBefore, 5_000, 50);
        await expect(p).resolves.toBe(true);

        await sim.waitFor(() => received.some((e) => e.type === 'HOST_TO_LEAF'), 2_000, 25);
    });

    it('Furthest leaf -> Host comms (ACK + ping/pong)', async () => {
        const leafId = sim.getFurthestLeaf();
        const leaf = sim.getNode(leafId);

        const hostEvents: Array<{ type: string; from: string }> = [];
        sim.host.onGameEventReceived((type, _data, from) => hostEvents.push({ type, from }));

        const leafAny = leaf as any;
        const pendingBefore = leafAny.pendingAcks?.size ?? 0;

        const p = leaf.sendGameEvent('LEAF_TO_HOST', { n: 1 }, true) as Promise<boolean>;

        await sim.waitFor(() => (leafAny.pendingAcks?.size ?? 0) === pendingBefore, 5_000, 50);
        await expect(p).resolves.toBe(true);

        await sim.waitFor(() => hostEvents.some((e) => e.type === 'LEAF_TO_HOST' && e.from === leafId), 2_000, 25);

        expect((leafAny.pendingPings as Map<string, number>).size).toBe(0);
        leaf.pingHost();
        await sim.waitFor(() => (leafAny.pendingPings as Map<string, number>).size === 0, 2_000, 25);
    });

    it('Mid-node pause triggers cousin patching and keeps downstream stable (RAIN + events)', async () => {
        const { l1Id, l2Id, l3Id } = branch;

        // Ensure L2 has a cousin that is not affected by pausing its own L1.
        // The built-in cousin discovery for L2 is scoped to its parent (L1) branches,
        // so we create a cross-branch cousin link here to exercise "patch via cousin"
        // during an L1 pause.
        const crossBranchCousinId = sim
            .getAllNodeIds()
            .find((id) => sim.getSnapshot(id).depth === 2 && sim.getSnapshot(id).parentId !== l1Id);
        if (!crossBranchCousinId) throw new Error('Missing cross-branch depth=2 node for cousin link');

        const l2Any = sim.getNode(l2Id) as any;
        if (l2Any.cousins?.size) {
            for (const conn of l2Any.cousins.values()) conn.close?.();
            l2Any.cousins.clear();
        }
        l2Any.connectToCousin(crossBranchCousinId);
        await sim.waitFor(() => (l2Any.cousins?.size ?? 0) === 1, 10_000, 100);

        sim.togglePause(l1Id, true);
        l2Any.lastParentRainTime = Date.now() - 4000;

        await sim.waitFor(() => sim.getSnapshot(l2Id).state === NodeState.PATCHING, 20_000, 250);

        const l3 = sim.getNode(l3Id);
        expect(sim.getSnapshot(l3Id).isAttached).toBe(true);
        expect(l3.getHealthStatus()).not.toBe('OFFLINE');

        const rainBefore = sim.getSnapshot(l3Id).rainSeq;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(sim.getSnapshot(l3Id).rainSeq).toBeGreaterThan(rainBefore);
    });

    it('Mid-node resume returns to normal flow', async () => {
        const { l1Id, l2Id, l3Id } = branch;

        sim.togglePause(l1Id, false);

        await sim.waitFor(() => sim.getSnapshot(l2Id).state === NodeState.NORMAL, 20_000, 250);
        expect(sim.getSnapshot(l3Id).isAttached).toBe(true);
        sim.assertRainPropagating({ maxLag: 3 });
    });

    it('Mid-node crash triggers prompt downstream re-attach', async () => {
        const { l1Id, l2Id, l3Id } = branch;
        crashedL1Id = l1Id;

        sim.crashNode(l1Id);

        const l2Any = sim.getNode(l2Id) as any;
        await sim.waitFor(
            () => (l2Any.attachRetryTimer != null) || (typeof l2Any.attachAttempts === 'number' && l2Any.attachAttempts > 0),
            1_000,
            25
        );

        await sim.waitFor(() => sim.getHistory(l2Id).some((h) => h.isAttached === false), 2_000, 25);
        await sim.waitFor(() => sim.getSnapshot(l2Id).isAttached === true, 30_000, 250);
        await sim.waitFor(() => sim.getSnapshot(l3Id).isAttached === true, 30_000, 250);
    });

    it('Mid-node recovery rejoins the network (children may reattach elsewhere)', async () => {
        if (!crashedL1Id) throw new Error('Missing crashed mid-node id from previous phase');

        const recovered = makeNode(crashedL1Id);
        sim.attachSnapshotCollector(recovered);
        recovered.bootstrap(sim.hostId);
        sim.replaceNode(crashedL1Id, recovered);

        await sim.waitFor(() => sim.getSnapshot(crashedL1Id!).isAttached === true, 60_000, 250);
        await vi.advanceTimersByTimeAsync(30_000);

        sim.assertTreeFormed();
        sim.assertConnectionsOpen();
        await sim.waitFor(() => {
            const hostRain = (sim.host as any).rainSeq as number;
            return sim.getAllNodeIds().every((id) => hostRain - sim.getSnapshot(id).rainSeq <= 3);
        }, 60_000, 250);
        sim.assertRainPropagating({ maxLag: 3 });
    });
});
