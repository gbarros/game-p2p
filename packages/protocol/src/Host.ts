import Peer, { DataConnection } from 'peerjs';
import { v4 as uuidv4 } from 'uuid';
import {
    ProtocolMessage,
    RainMessage,
    JoinAccept,
    JoinReject,
    AttachAccept,
    AttachReject,
    SubtreeStatus,
    AckMessage,
    GameEvent,
    GameCmd,
    ReqCousins,
    CousinsMessage,
    RebindAssign,
    PeerId
} from './types.js';

interface TopologyNode {
    nextHop: string; // The L1 child that leads to this node
    depth: number;
    lastSeen: number;
    freeSlots: number;
    state?: string;
}

export class Host {
    private peer: Peer;
    private gameId: string;
    private secret: string;
    private rainSeq: number = 0;
    private gameSeq: number = 0;
    private qrSeq: number = 0;
    private children: Map<string, DataConnection> = new Map();
    private rainInterval: NodeJS.Timeout | null = null;

    // Virtual Tree / Topology Map
    private topology: Map<string, TopologyNode> = new Map();

    // ACK tracking for guaranteed delivery
    private pendingAcks: Map<string, { resolve: (v: boolean) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }> = new Map();

    // Game event callback
    private onGameEventCallback: ((type: string, data: unknown, from: string) => void) | null = null;

    // Game event cache for STATE responses (fallback for L1 nodes or when cousins unavailable)
    private gameEventCache: Array<{ seq: number; event: { type: string; data: unknown } }> = [];
    private readonly MAX_CACHE_SIZE = 20;

    // Deduplication
    private recentMsgIds: Set<string> = new Set();
    private readonly MAX_MSG_ID_CACHE = 100;

    constructor(gameId: string, secret: string, peer: Peer) {
        this.gameId = gameId;
        this.secret = secret;
        this.peer = peer;

        this.peer.on('open', (id) => {
            console.log('Host Open:', id);
            this.startRain();
            this.emitState();
        });

        this.peer.on('error', (err) => {
            console.error('[Host] Peer Error:', err);
        });

        this.peer.on('connection', (conn) => {
            this.handleConnection(conn);
        });
    }

    private handleConnection(conn: DataConnection) {
        const meta = conn.metadata;
        console.log('New connection:', conn.peer, meta);
        if (!meta || meta.gameId !== this.gameId || meta.secret !== this.secret) {
            console.warn(`[Host] Rejecting connection from ${conn.peer}: Invalid Metadata`, meta);
            conn.close();
            return;
        }

        conn.on('data', (data) => {
            this.handleMessage(conn, data as ProtocolMessage);
        });

        conn.on('open', () => {
            console.log('New connection:', conn.peer);
        });

        conn.on('error', (err) => {
            console.error(`[Host] Connection error with ${conn.peer}:`, err);
        });

        conn.on('close', () => {
            console.log(`[Host] Connection closed: ${conn.peer}`);
            this.children.delete(conn.peer);
            this.removeFromTopology(conn.peer);
            this.emitState();
        });
    }

    private removeFromTopology(l1PeerId: string) {
        for (const [id, node] of this.topology.entries()) {
            if (node.nextHop === l1PeerId) {
                this.topology.delete(id);
            }
        }
    }

    private handleMessage(conn: DataConnection, msg: ProtocolMessage) {
        // Validate gameId on all inbound messages
        if (msg.gameId !== this.gameId) {
            console.warn(`[Host] Rejecting message from ${msg.src}: gameId mismatch`);
            return;
        }

        // --- Deduplication Layer ---
        if (this.recentMsgIds.has(msg.msgId)) {
            // Duplicate message, ignore
            return;
        }
        this.recentMsgIds.add(msg.msgId);
        if (this.recentMsgIds.size > this.MAX_MSG_ID_CACHE) {
            // Simple FIFO cleanup
            const iterator = this.recentMsgIds.values();
            const first = iterator.next().value;
            if (first !== undefined) this.recentMsgIds.delete(first);
        }

        switch (msg.t) {
            case 'PING':
                console.log(`[Host] PING from ${msg.src} path=${JSON.stringify(msg.path)}`);
                const reversePath = msg.path ? [...msg.path].reverse() : [msg.src];
                console.log(`[Host] Constructed reverse route: ${JSON.stringify(reversePath)}`);
                this.routeMessage(msg.src, {
                    t: 'PONG',
                    v: 1,
                    gameId: this.gameId,
                    src: this.peer.id,
                    msgId: uuidv4(),
                    replyTo: msg.msgId,
                    dest: msg.src,
                    path: [this.peer.id],
                    route: [this.peer.id, ...reversePath]
                });
                break;

            case 'ACK':
                console.log(`[Host] ACK from ${msg.src} for msg ${msg.replyTo}`);
                // Resolve pending ACK promise if exists
                if (msg.replyTo && this.pendingAcks.has(msg.replyTo)) {
                    const pending = this.pendingAcks.get(msg.replyTo)!;
                    clearTimeout(pending.timeout);
                    pending.resolve(true);
                    this.pendingAcks.delete(msg.replyTo);
                }
                break;

            case 'GAME_CMD':
                console.log(`[Host] GAME_CMD from ${msg.src}: ${msg.cmd?.type}`);
                // Send ACK if requested
                if (msg.ack) {
                    this.routeMessage(msg.src, {
                        t: 'ACK',
                        v: 1,
                        gameId: this.gameId,
                        src: this.peer.id,
                        msgId: uuidv4(),
                        replyTo: msg.msgId,
                        dest: msg.src,
                        path: msg.path || []
                    });
                }
                // Notify callback if registered (treat GAME_CMD as the new upstream message type)
                if (this.onGameEventCallback && msg.cmd) {
                    this.onGameEventCallback(msg.cmd.type, msg.cmd.data, msg.src);
                }
                break;

            case 'GAME_EVENT':
                // GAME_EVENT should only be host-originated now, but handle legacy incoming if any
                console.log(`[Host] GAME_EVENT from ${msg.src}: ${msg.event?.type}`);
                if (msg.ack) {
                    this.routeMessage(msg.src, {
                        t: 'ACK',
                        v: 1,
                        gameId: this.gameId,
                        src: this.peer.id,
                        msgId: uuidv4(),
                        replyTo: msg.msgId,
                        dest: msg.src,
                        path: msg.path || []
                    });
                }
                if (this.onGameEventCallback && msg.event) {
                    this.onGameEventCallback(msg.event.type, msg.event.data, msg.src);
                }
                break;

            case 'REQ_PAYLOAD':
                console.log(`[Host] REQ_PAYLOAD from ${msg.src}: ${msg.payloadType}`);
                // Respond with the requested payload
                const payloadData = msg.payloadType === 'INITIAL_STATE'
                    ? { info: "Initial state payload" }
                    : { info: "Generic payload" };

                this.routeMessage(msg.src, {
                    t: 'PAYLOAD',
                    v: 1,
                    gameId: this.gameId,
                    src: this.peer.id,
                    msgId: uuidv4(),
                    replyTo: msg.msgId,
                    dest: msg.src,
                    payloadType: msg.payloadType,
                    data: payloadData,
                    path: [this.peer.id]
                });
                console.log(`[Host] Sent PAYLOAD response to ${msg.src}`);
                break;

            case 'REBIND_REQUEST':
                console.log(`[Host] REBIND_REQUEST from ${msg.src} (reason: ${msg.reason})`);
                // Respond with best parent candidates based on topology
                const rebindCandidates = this.getSmartRedirects().slice(0, 3);

                const rebindAssign: RebindAssign = {
                    t: 'REBIND_ASSIGN',
                    v: 1,
                    gameId: this.gameId,
                    src: this.peer.id,
                    msgId: uuidv4(),
                    replyTo: msg.msgId,
                    dest: msg.src,
                    newParentCandidates: rebindCandidates,
                    priority: 'TRY_IN_ORDER',
                    path: []
                };
                this.routeMessage(msg.src, rebindAssign);
                break;

            case 'SUBTREE_STATUS':
                this.handleSubtreeStatus(conn, msg);
                break;

            case 'JOIN_REQUEST':
                console.log(`[Host] Accepted join from ${conn.peer}`);

                const hasSpace = this.children.size < 5;
                const seeds = this.getSmartSeeds();

                const accept: JoinAccept = {
                    t: 'JOIN_ACCEPT',
                    v: 1,
                    gameId: this.gameId,
                    src: this.peer.id,
                    msgId: uuidv4(),
                    playerId: uuidv4(),
                    payload: { type: 'INITIAL_STATE', data: { msg: "Welcome to the game" } },
                    seeds: seeds,
                    keepAlive: hasSpace,
                    rainSeq: this.rainSeq,
                    gameSeq: this.gameSeq,
                    path: [this.peer.id]
                };
                conn.send(accept);

                if (hasSpace) {
                    // Optimized: Keep connection and promote to L1 Child immediately
                    console.log(`[Host] Promoting ${conn.peer} to L1 child`);
                    this.children.set(conn.peer, conn);
                    this.topology.set(conn.peer, { nextHop: conn.peer, depth: 1, lastSeen: Date.now(), freeSlots: 3, state: 'OK' });
                    this.emitState();
                } else {
                    // Standard spec flow: Host gave us seeds and will close connection.
                    // We wait a bit to ensure the message is sent before closing.
                    console.log(`[Host] Host full, providing seeds to ${conn.peer} and disconnecting`);
                    // Immediate close for better test behavior, or keep standard 500ms?
                    // Test expects it to be closed fairly quickly.
                    setTimeout(() => conn.close(), 100);
                }
                break;

            case 'ATTACH_REQUEST':
                console.log(`[Host] ATTACH_REQUEST from ${conn.peer}`);
                if (this.children.size >= 5) {
                    const reject: AttachReject = {
                        t: 'ATTACH_REJECT',
                        v: 1,
                        gameId: this.gameId,
                        src: this.peer.id,
                        msgId: uuidv4(),
                        reason: 'FULL',
                        redirect: this.getSmartRedirects(),
                        depthHint: 1,
                        path: [this.peer.id]
                    };
                    conn.send(reject);
                } else {
                    // Logic duplication here, but acceptable for clarity
                    this.children.set(conn.peer, conn);
                    // ... same register logic
                    this.topology.set(conn.peer, { nextHop: conn.peer, depth: 1, lastSeen: Date.now(), freeSlots: 3, state: 'OK' });
                    this.emitState();
                    const accept: AttachAccept = {
                        t: 'ATTACH_ACCEPT',
                        v: 1,
                        gameId: this.gameId,
                        src: this.peer.id,
                        msgId: uuidv4(),
                        parentId: this.peer.id,
                        level: 0,
                        cousinCandidates: [],
                        childrenMax: 5,
                        childrenUsed: this.children.size,
                        path: [this.peer.id]
                    };
                    conn.send(accept);
                }
                break;

            case 'REQ_STATE':
                console.log(`[Host] REQ_STATE from ${msg.src} (fromGameSeq: ${msg.fromGameSeq})`);

                const eventsToSend = this.gameEventCache
                    .filter(e => e.seq > msg.fromGameSeq)
                    .map(e => ({ seq: e.seq, event: e.event }));

                // Check for truncation
                const minSeqInCache = this.gameEventCache.length > 0 ? this.gameEventCache[0].seq : 0;
                const truncated = minSeqInCache > (msg.fromGameSeq + 1);

                const reversePathForState = [...(msg.path || [])].reverse();
                // Host constructs STATE response
                // IMPORTANT: Host acts as the authority
                this.routeMessage(msg.src, {
                    t: 'STATE',
                    v: 1,
                    gameId: this.gameId,
                    src: this.peer.id,
                    msgId: uuidv4(),
                    replyTo: msg.msgId,
                    dest: msg.src,
                    latestRainSeq: this.rainSeq,
                    latestGameSeq: this.gameSeq,
                    events: eventsToSend,
                    minGameSeqAvailable: minSeqInCache,
                    truncated: truncated,
                    path: [this.peer.id],
                    route: [this.peer.id, ...reversePathForState]
                });
                break;

        }
    }

    private handleSubtreeStatus(conn: DataConnection, msg: SubtreeStatus) {
        // Msg comes from a direct child (Depth 1).
        const nextHop = conn.peer;

        // Update Child itself (Depth 1)
        this.topology.set(nextHop, {
            nextHop: nextHop,
            depth: 1,
            lastSeen: Date.now(),
            freeSlots: msg.freeSlots, // This is the child's own capacity
            state: 'OK'
        });

        if (msg.descendants && msg.descendants.length > 0) {
            msg.descendants.forEach(d => {
                this.topology.set(d.id, {
                    nextHop: nextHop,
                    depth: 1 + d.hops,
                    lastSeen: Date.now(),
                    freeSlots: d.freeSlots,
                    state: 'OK' // Assume OK for now
                });
            });
        }

        this.emitState();
    }

    private routeMessage(targetId: string, msg: ProtocolMessage) {
        // Add ourselves to trace path
        const path = msg.path || [];
        path.push(this.peer.id);
        msg.path = path;

        // Direct child case
        if (this.children.has(targetId)) {
            const conn = this.children.get(targetId);
            if (conn && conn.open) {
                // For direct children, route is simple
                msg.route = [this.peer.id, targetId];
                conn.send(msg);
                return;
            }
        }

        // Deep target case - compute full route path
        const routeInfo = this.topology.get(targetId);
        if (routeInfo) {
            const conn = this.children.get(routeInfo.nextHop);
            if (conn && conn.open) {
                // Attach explicit route for multi-hop forwarding if not already present
                if (!msg.route) {
                    msg.route = this.computeRoutePath(targetId);
                }
                conn.send(msg);
                return;
            } else {
                console.warn(`[Host] NextHop ${routeInfo.nextHop} dead for target ${targetId}`);
                this.topology.delete(targetId);
            }
        } else {
            console.warn(`[Host] No route to ${targetId}. Dropping message ${msg.t}`);
        }
    }

    /**
     * Compute the full routing path from host to a target node
     * This is needed for multi-hop forwarding
     */
    private computeRoutePath(targetId: string): PeerId[] {
        const routeInfo = this.topology.get(targetId);
        if (!routeInfo) return [];

        // For now, we can only provide [host, nextHop, ...] since we don't have full tree structure
        // Nodes will need to continue forwarding based on their own descendant maps
        return [this.peer.id, routeInfo.nextHop];
    }

    private getSmartSeeds(): string[] {
        // Return peers with > 0 free slots provided their depth isn't too high
        // Sort by: 1) depth (shallow first), 2) capacity (more slots first)
        const candidates = Array.from(this.topology.entries())
            .filter(([id, node]) => node.freeSlots > 0 && node.depth < 4)
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
        const shuffled = this.weightedShuffle(candidates);

        // Fallback to direct children if no smart candidates found
        if (shuffled.length < 5) {
            const childKeys = Array.from(this.children.keys()).filter(id => !shuffled.includes(id));
            const extra = this.simpleShuffle(childKeys);
            shuffled.push(...extra);
        }

        return shuffled.slice(0, 10); // Return up to 10
    }

    private weightedShuffle(arr: string[]): string[] {
        // Weighted shuffle: items earlier in the array have higher probability of staying near the front
        const result: string[] = [];
        const weights = arr.map((_, i) => Math.max(1, arr.length - i)); // Higher weight for earlier items
        const remaining = [...arr];

        while (remaining.length > 0) {
            const totalWeight = weights.slice(0, remaining.length).reduce((a, b) => a + b, 0);
            let random = Math.random() * totalWeight;
            let selectedIndex = 0;

            for (let i = 0; i < remaining.length; i++) {
                random -= weights[i];
                if (random <= 0) {
                    selectedIndex = i;
                    break;
                }
            }

            result.push(remaining.splice(selectedIndex, 1)[0]);
        }

        return result;
    }

    private simpleShuffle(arr: string[]): string[] {
        const shuffled = [...arr];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    private getSmartRedirects(): string[] {
        return this.getSmartSeeds();
    }

    private startRain() {
        this.rainInterval = setInterval(() => {
            this.rainSeq++;
            this.emitState();
            const rain: RainMessage = {
                t: 'RAIN',
                v: 1,
                gameId: this.gameId,
                src: this.peer.id,
                msgId: uuidv4(),
                rainSeq: this.rainSeq,
                path: [this.peer.id]
            };
            this.broadcast(rain);
        }, 1000);
    }

    private broadcast(msg: ProtocolMessage) {
        this.children.forEach((conn) => {
            if (conn.open) {
                conn.send(msg);
            }
        });
    }

    public getPeerId(): string {
        return this.peer.id;
    }

    /**
     * Generate QR payload / connection string for joiners (§4.1)
     * The host renders a QR that changes over time.
     * 
     * Required fields:
     * - v: protocol version (1)
     * - gameId: session id
     * - secret: join secret
     * - hostId: PeerJS ID of host
     * - seeds: array of PeerJS IDs (5-10) with known capacity
     * - qrSeq: monotonic sequence number
     * 
     * Optional fields:
     * - latestRainSeq: current rain sequence
     * - latestGameSeq: current game sequence
     * - mode: e.g., 'TREE'
     * 
     * @returns Connection string object suitable for QR encoding
     */
    public getConnectionString(): {
        v: number;
        gameId: string;
        secret: string;
        hostId: string;
        seeds: string[];
        qrSeq: number;
        latestRainSeq?: number;
        latestGameSeq?: number;
        mode?: string;
    } {
        this.qrSeq++;
        return {
            v: 1,
            gameId: this.gameId,
            secret: this.secret,
            hostId: this.peer.id,
            seeds: this.getSmartSeeds(),
            qrSeq: this.qrSeq,
            latestRainSeq: this.rainSeq,
            latestGameSeq: this.gameSeq,
            mode: 'TREE'
        };
    }

    // --- Public Game API ---

    /**
     * Register callback for incoming game events from nodes
     */
    public onGameEventReceived(callback: (type: string, data: unknown, from: string) => void): void {
        this.onGameEventCallback = callback;
    }

    /**
     * Broadcast a game event to all connected nodes
     */
    public broadcastGameEvent(type: string, data: unknown): void {
        this.gameSeq++;
        const event: GameEvent = {
            t: 'GAME_EVENT',
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv4(),
            gameSeq: this.gameSeq,
            event: { type, data },
            path: [this.peer.id]
        };

        // Cache the event for STATE responses
        this.gameEventCache.push({ seq: this.gameSeq, event: { type, data } });
        if (this.gameEventCache.length > this.MAX_CACHE_SIZE) {
            this.gameEventCache.shift(); // Remove oldest
        }

        this.broadcast(event);
    }

    /**
     * Send a message to a specific peer
     * @param peerId Target peer ID
     * @param type Message type
     * @param data Message data
     * @param ack If true, returns Promise that resolves when ACK received
     */
    public sendToPeer(peerId: string, type: string, data: unknown, ack: boolean = false): void | Promise<boolean> {
        const msgId = uuidv4();
        const msg: GameEvent = {
            t: 'GAME_EVENT',
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId,
            gameSeq: ++this.gameSeq,
            event: { type, data },
            dest: peerId,
            path: [this.peer.id],
            ack: ack
        };

        this.routeMessage(peerId, msg);

        if (ack) {
            return new Promise<boolean>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingAcks.delete(msgId);
                    reject(new Error(`ACK timeout for message ${msgId}`));
                }, 10000); // 10s timeout

                this.pendingAcks.set(msgId, { resolve, reject, timeout });
            });
        }
    }

    // UI helper
    private onStateChange: ((state: any) => void) | null = null;
    public subscribe(callback: (state: any) => void) {
        this.onStateChange = callback;
        this.emitState();
    }
    private emitState() {
        if (this.onStateChange) {
            // Convert topology Map to array with full node info for UI
            const topologyData: { id: string; depth: number; nextHop: string; freeSlots: number; state?: string }[] = [];
            this.topology.forEach((node, id) => {
                topologyData.push({
                    id,
                    depth: node.depth,
                    nextHop: node.nextHop,
                    freeSlots: node.freeSlots,
                    state: node.state
                });
            });

            this.onStateChange({
                role: 'HOST',
                peerId: this.peer.id,
                children: Array.from(this.children.keys()),
                rainSeq: this.rainSeq,
                topology: topologyData // Full topology for visualization
            });
        }
    }
}
