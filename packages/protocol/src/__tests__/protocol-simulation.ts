import { vi, expect } from 'vitest';
import type { Host } from '../Host.js';
import type { Node, NodeState } from '../Node.js';

export type NodeSnapshot = {
    role: 'NODE';
    peerId: string;
    peerOpen: boolean;
    parentId: string | null;
    children: string[];
    rainSeq: number;
    isAttached: boolean;
    depth: number;
    state: NodeState;
};

export type SimulationConfig = {
    nodeCount?: number;
    maxNodes?: number;
    ensureMinDepth?: number;
    hostId?: string;
};

export class ProtocolSimulation {
    public readonly host: Host;
    public readonly hostId: string;

    private readonly createNode: (id: string) => Node;
    private readonly nodes: Node[] = [];
    private readonly nodeById: Map<string, Node> = new Map();
    private readonly snapshots: Map<string, NodeSnapshot> = new Map();
    private readonly history: Map<string, NodeSnapshot[]> = new Map();
    private readonly nodeIdsInOrder: string[] = [];

    constructor(args: {
        host: Host;
        hostId: string;
        createNode: (id: string) => Node;
    }) {
        this.host = args.host;
        this.hostId = args.hostId;
        this.createNode = args.createNode;
    }

    public getAllNodeIds(): string[] {
        return [...this.nodeIdsInOrder];
    }

    public getNode(id: string): Node {
        const node = this.nodeById.get(id);
        if (!node) throw new Error(`Unknown node: ${id}`);
        return node;
    }

    public getSnapshot(id: string): NodeSnapshot {
        const snap = this.snapshots.get(id);
        if (!snap) throw new Error(`No snapshot for node: ${id}`);
        return snap;
    }

    public getHistory(id: string): NodeSnapshot[] {
        return this.history.get(id) || [];
    }

    public getMaxDepth(): number {
        let max = 0;
        for (const id of this.nodeIdsInOrder) {
            const snap = this.snapshots.get(id);
            if (snap) max = Math.max(max, snap.depth);
        }
        return max;
    }

    public getLeaves(): string[] {
        const leaves: string[] = [];
        for (const id of this.nodeIdsInOrder) {
            const snap = this.snapshots.get(id);
            if (!snap) continue;
            if (snap.children.length === 0) leaves.push(id);
        }
        return leaves;
    }

    public getFurthestLeaf(): string {
        const leaves = this.getLeaves();
        if (leaves.length === 0) throw new Error('No leaves found');
        let best = leaves[0];
        let bestDepth = this.getSnapshot(best).depth;
        for (const id of leaves) {
            const d = this.getSnapshot(id).depth;
            if (d > bestDepth) {
                bestDepth = d;
                best = id;
            }
        }
        return best;
    }

    public findBranchForMidNodeFault(): { l1Id: string; l2Id: string; l3Id: string } {
        for (const id of this.nodeIdsInOrder) {
            const snap = this.getSnapshot(id);
            if (snap.depth !== 2) continue;
            if (snap.children.length === 0) continue;
            const node = this.getNode(id) as any;
            const cousinsSize = (node.connManager.cousins?.size as number | undefined) ?? 0;
            if (cousinsSize <= 0) continue;

            const parentId = snap.parentId;
            if (!parentId) continue;
            const parentSnap = this.getSnapshot(parentId);
            if (parentSnap.depth !== 1) continue;

            const l3Id = snap.children[0];
            const l3Snap = this.getSnapshot(l3Id);
            if (!l3Snap || l3Snap.depth !== 3) continue;

            return { l1Id: parentId, l2Id: id, l3Id };
        }
        throw new Error('Could not find Host -> L1 -> L2 -> L3 branch with cousins on L2');
    }

    public togglePause(id: string, paused: boolean) {
        const node = this.getNode(id);
        node.togglePause(paused);
    }

    public crashNode(id: string) {
        const node = this.getNode(id) as any;

        const parent = node.connManager.parent as { close?: () => void } | null;
        if (parent?.close) parent.close();

        const children = node.connManager.children as Map<string, { close?: () => void }>;
        if (children) {
            for (const conn of children.values()) {
                conn.close?.();
            }
        }

        node.close();
    }

    public replaceNode(id: string, newNode: Node) {
        this.nodeById.set(id, newNode);
        const idx = this.nodes.findIndex((n) => (n as any).peer?.id === id || (n as any).getPeerId?.() === id);
        if (idx >= 0) this.nodes[idx] = newNode;
    }

    public attachSnapshotCollector(node: Node) {
        node.subscribe((s: any) => {
            const snap = s as NodeSnapshot;
            this.snapshots.set(snap.peerId, snap);
            const list = this.history.get(snap.peerId) || [];
            list.push(snap);
            this.history.set(snap.peerId, list);
        });
    }

    public spawnNode(id: string) {
        const node = this.createNode(id);
        this.attachSnapshotCollector(node);
        node.bootstrap(this.hostId);

        this.nodes.push(node);
        this.nodeById.set(id, node);
        this.nodeIdsInOrder.push(id);
    }

    public async spawnNodes(count: number, { staggerMs = 50 }: { staggerMs?: number } = {}) {
        const startIndex = this.nodes.length;
        for (let i = 0; i < count; i += 1) {
            const id = `node-${startIndex + i + 1}`;
            this.spawnNode(id);
            await vi.advanceTimersByTimeAsync(staggerMs);
        }
    }

    public async waitFor(condition: () => boolean, timeoutMs = 20_000, stepMs = 100) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (condition()) return;
            await vi.advanceTimersByTimeAsync(stepMs);
        }
        throw new Error(`Timed out after ${timeoutMs}ms`);
    }

    public async stabilize({
        minRainSeq = 5,
        timeoutMs = 60_000,
        maxLag = 2
    }: {
        minRainSeq?: number;
        timeoutMs?: number;
        maxLag?: number;
    } = {}) {
        await this.waitFor(() => ((this.host as any).rainSeq as number) >= minRainSeq, timeoutMs, 250);
        await this.waitFor(
            () =>
                this.nodeIdsInOrder.length > 0 &&
                this.nodeIdsInOrder.every((id) => {
                    const s = this.snapshots.get(id);
                    return !!s && s.peerOpen && s.isAttached && !!s.parentId;
                }),
            timeoutMs,
            250
        );

        // Allow at least one full subtree reporting window so Host topology and
        // descendant routing maps are populated for deep routing (ACKs, pings, etc).
        await vi.advanceTimersByTimeAsync(6_000);
        await this.waitFor(() => this.isHostTopologyComplete(), timeoutMs, 250);

        this.assertTreeFormed();
        this.assertConnectionsOpen();
        this.assertRainPropagating({ maxLag });
    }

    private isHostTopologyComplete(): boolean {
        const topology = (this.host as any).topologyManager.topology as Map<string, unknown> | undefined;
        if (!topology) return false;
        return this.nodeIdsInOrder.every((id) => topology.has(id));
    }

    public assertTreeFormed() {
        const allIds = new Set(this.nodeIdsInOrder);

        for (const id of this.nodeIdsInOrder) {
            const snap = this.getSnapshot(id);
            expect(snap.parentId).toBeTruthy();
            if (snap.parentId === this.hostId) continue;
            expect(allIds.has(snap.parentId!)).toBe(true);
        }

        for (const id of this.nodeIdsInOrder) {
            const seen = new Set<string>();
            let cur: string | null = id;
            let steps = 0;
            while (cur) {
                if (seen.has(cur)) throw new Error(`Cycle detected starting at ${id}`);
                seen.add(cur);
                const snap = this.getSnapshot(cur);
                const parent = snap.parentId;
                if (!parent) throw new Error(`Node ${cur} has no parent during traversal`);
                if (parent === this.hostId) break;
                cur = parent;
                steps += 1;
                if (steps > 100) throw new Error(`Unbounded parent traversal starting at ${id}`);
            }
        }
    }

    public assertConnectionsOpen() {
        for (const id of this.nodeIdsInOrder) {
            const node = this.getNode(id) as any;
            const snap = this.getSnapshot(id);

            const parentConn = node.connManager.parent as { open?: boolean; peer?: string } | null;
            expect(parentConn).toBeTruthy();
            expect(parentConn?.open).toBe(true);
            expect(parentConn?.peer).toBe(snap.parentId);

            const children = node.connManager.children as Map<string, { open?: boolean }>;
            for (const childId of snap.children) {
                const conn = children.get(childId);
                expect(conn).toBeTruthy();
                expect(conn?.open).toBe(true);
            }
        }
    }

    public assertRainPropagating({ maxLag = 2 }: { maxLag?: number } = {}) {
        const hostRain = (this.host as any).rainSeq as number;
        for (const id of this.nodeIdsInOrder) {
            const snap = this.getSnapshot(id);
            expect(hostRain - snap.rainSeq).toBeLessThanOrEqual(maxLag);
        }
    }
}
