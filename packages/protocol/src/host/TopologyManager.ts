import { weightedShuffle, shuffleArray } from '../utils/index.js';

export interface TopologyNode {
    nextHop: string; // The L1 child that leads to this node
    depth: number;
    lastSeen: number;
    freeSlots: number;
    state?: string;
}

export class TopologyManager {
    private topology: Map<string, TopologyNode> = new Map();

    constructor(private children: Map<string, any>) { } // Just need keys from children

    public updateNode(id: string, node: TopologyNode) {
        this.topology.set(id, node);
    }

    public removeNode(id: string) {
        this.topology.delete(id);
    }

    public removeNodesVia(l1PeerId: string) {
        for (const [id, node] of this.topology.entries()) {
            if (node.nextHop === l1PeerId) {
                this.topology.delete(id);
            }
        }
    }

    public get(id: string): TopologyNode | undefined {
        return this.topology.get(id);
    }

    public getAllData() {
        const data: { id: string; depth: number; nextHop: string; freeSlots: number; state?: string }[] = [];
        this.topology.forEach((node, id) => {
            data.push({
                id,
                depth: node.depth,
                nextHop: node.nextHop,
                freeSlots: node.freeSlots,
                state: node.state
            });
        });
        return data;
    }

    public getSmartSeeds(): string[] {
        // Return peers with > 0 free slots provided their depth isn't too high
        // Sort by: 1) depth (shallow first), 2) capacity (more slots first)
        const candidates = Array.from(this.topology.entries())
            .filter(([_id, node]) => node.freeSlots > 0 && node.depth < 4)
            .sort((a, b) => {
                // Primary: shallowest depth first
                if (a[1].depth !== b[1].depth) {
                    return a[1].depth - b[1].depth;
                }
                // Secondary: bias toward higher capacity
                return b[1].freeSlots - a[1].freeSlots;
            })
            .map(entry => entry[0]);

        // Randomize the list to avoid hotspots, but keep shallow/high-capacity nodes more likely
        const shuffled = weightedShuffle(candidates);

        // Fallback to direct children if no smart candidates found
        if (shuffled.length < 5) {
            const childKeys = Array.from(this.children.keys()).filter(id => !shuffled.includes(id));
            const extra = shuffleArray(childKeys);
            shuffled.push(...extra);
        }

        return shuffled.slice(0, 10);
    }
}
