import Peer, { DataConnection } from 'peerjs';
import { v4 as uuidv4 } from 'uuid';
import {
    ProtocolMessage,
    RainMessage,
    JoinAccept,
    AttachAccept,
    AttachReject,
    SubtreeStatus,
    RebindAssign,
    PeerId
} from './types.js';
import {
    DeduplicationCache,
    RateLimiter,
    GameEventCache,
    PendingAckTracker,
    createAckMessage,
    createPongMessage,
    createStateMessage,
    createGameEvent
} from './utils/index.js';
import { TopologyManager } from './host/TopologyManager.js';

export class Host {
    private peer: Peer;
    private gameId: string;
    private secret: string;
    private rainSeq: number = 0;
    private gameSeq: number = 0;
    private qrSeq: number = 0;
    private children: Map<string, DataConnection> = new Map();
    private rainInterval: NodeJS.Timeout | null = null;

    // Topology Manager
    private topologyManager: TopologyManager;

    // Utility classes
    private dedupCache: DeduplicationCache;
    private rateLimiter: RateLimiter;
    private gameEventCache: GameEventCache;
    private ackTracker: PendingAckTracker;

    // Game event callback
    private onGameEventCallback: ((type: string, data: unknown, from: string) => void) | null = null;

    constructor(gameId: string, secret: string, peer: Peer) {
        this.gameId = gameId;
        this.secret = secret;
        this.peer = peer;

        // Initialize utility classes
        this.dedupCache = new DeduplicationCache(100);
        this.rateLimiter = new RateLimiter(5, 10000, 30000);
        this.gameEventCache = new GameEventCache(100);
        this.ackTracker = new PendingAckTracker(10000);

        // Initialize Topology Manager
        this.topologyManager = new TopologyManager(this.children);

        this.peer.on('open', (id) => {
            console.log('Host Open:', id);
            this.startRain();
            this.emitState();
            this.rateLimiter.startCleanup();
        });

        this.peer.on('error', (err) => {
            console.error('[Host] Peer Error:', err);
        });

        this.peer.on('connection', (conn) => {
            this.handleConnection(conn);
        });
    }

    private handleConnection(conn: DataConnection) {
        // Rate limit check using utility
        if (!this.rateLimiter.allowConnection(conn.peer)) {
            const count = this.rateLimiter.getAttemptCount(conn.peer);
            console.warn(`[Host] Rate limit exceeded for ${conn.peer} (${count} attempts), rejecting`);
            conn.close();
            return;
        }

        const meta = conn.metadata;
        console.log('New connection:', conn.peer, meta);
        if (!meta || meta.gameId !== this.gameId || meta.secret !== this.secret) {
            console.warn(`[Host] Rejecting connection from ${conn.peer}: Invalid Metadata`, meta);
            conn.close();
            return;
        }

        // Register data handler immediately to avoid dropping messages sent on peer open.
        conn.on('data', (data) => {
            this.handleMessage(conn, data as ProtocolMessage);
        });

        conn.on('open', () => {
            console.log('New connection2:', conn.peer);
        });

        conn.on('error', (err) => {
            console.error(`[Host] Connection error with ${conn.peer}:`, err);
        });

        conn.on('close', () => {
            console.log(`[Host] Connection closed: ${conn.peer}`);
            this.children.delete(conn.peer);
            this.topologyManager.removeNodesVia(conn.peer);
            this.emitState();
        });
    }

    private handleMessage(conn: DataConnection, msg: ProtocolMessage) {
        // Validate gameId on all inbound messages
        if (msg.gameId !== this.gameId) {
            console.warn(`[Host] Rejecting message from ${msg.src}: gameId mismatch`);
            return;
        }

        // Deduplication using utility
        if (this.dedupCache.isDuplicate(msg.msgId)) {
            return;
        }

        switch (msg.t) {
            case 'PING':
                console.log(`[Host] PING from ${msg.src} path=${JSON.stringify(msg.path)}`);
                const pongMsg = createPongMessage(this.gameId, this.peer.id, msg.msgId, msg.src, msg.path);
                console.log(`[Host] Constructed reverse route: ${JSON.stringify(pongMsg.route)}`);
                this.routeMessage(msg.src, pongMsg);
                break;

            case 'ACK':
                console.log(`[Host] ACK from ${msg.src} for msg ${msg.replyTo}`);
                if (msg.replyTo) {
                    this.ackTracker.resolve(msg.replyTo);
                }
                break;

            case 'GAME_CMD':
                console.log(`[Host] GAME_CMD from ${msg.src}: ${msg.cmd?.type}`);
                // Send ACK if requested
                if (msg.ack) {
                    const ackMsg = createAckMessage(this.gameId, this.peer.id, msg.msgId, msg.src, msg.path);
                    this.routeMessage(msg.src, ackMsg);
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
                    const ackMsg = createAckMessage(this.gameId, this.peer.id, msg.msgId, msg.src, msg.path);
                    this.routeMessage(msg.src, ackMsg);
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
                const rebindCandidates = this.topologyManager.getSmartSeeds().slice(0, 3);

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
                const seeds = this.topologyManager.getSmartSeeds();

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

                if (conn.open) {
                    conn.send(accept);
                } else {
                    console.warn(`[Host] Connection to ${conn.peer} closed before sending JOIN_ACCEPT`);
                }

                if (hasSpace) {
                    // Optimized: Keep connection and promote to L1 Child immediately
                    console.log(`[Host] Promoting ${conn.peer} to L1 child`);
                    this.children.set(conn.peer, conn);
                    this.topologyManager.updateNode(conn.peer, { nextHop: conn.peer, depth: 1, lastSeen: Date.now(), freeSlots: 3, state: 'OK' });
                    this.emitState();
                } else {
                    // Standard spec flow: Host gave us seeds and will close connection.
                    console.log(`[Host] Host full, providing seeds to ${conn.peer} and disconnecting`);
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
                        redirect: this.topologyManager.getSmartSeeds(),
                        depthHint: 1,
                        path: [this.peer.id]
                    };
                    if (conn.open) {
                        conn.send(reject);
                    } else {
                        console.warn(`[Host] Connection to ${conn.peer} closed before sending ATTACH_REJECT`);
                    }
                } else {
                    this.children.set(conn.peer, conn);
                    this.topologyManager.updateNode(conn.peer, { nextHop: conn.peer, depth: 1, lastSeen: Date.now(), freeSlots: 3, state: 'OK' });
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
                    if (conn.open) {
                        conn.send(accept);
                    } else {
                        console.warn(`[Host] Connection to ${conn.peer} closed before sending ATTACH_ACCEPT`);
                    }
                }
                break;

            case 'REQ_STATE':
                console.log(`[Host] REQ_STATE from ${msg.src} (fromGameSeq: ${msg.fromGameSeq})`);

                const eventsToSend = this.gameEventCache.getEventsAfter(msg.fromGameSeq);
                const minSeqInCache = this.gameEventCache.getMinSeq();
                const truncated = this.gameEventCache.isTruncated(msg.fromGameSeq);

                const stateMsg = createStateMessage(
                    this.gameId,
                    this.peer.id,
                    msg.msgId,
                    msg.src,
                    this.rainSeq,
                    this.gameSeq,
                    eventsToSend,
                    minSeqInCache,
                    truncated,
                    msg.path
                );

                this.routeMessage(msg.src, stateMsg);
                break;
        }
    }

    private handleSubtreeStatus(conn: DataConnection, msg: SubtreeStatus) {
        // Msg comes from a direct child (Depth 1).
        const nextHop = conn.peer;

        // Update Child itself (Depth 1)
        this.topologyManager.updateNode(nextHop, {
            nextHop: nextHop,
            depth: 1,
            lastSeen: Date.now(),
            freeSlots: msg.freeSlots, // This is the child's own capacity
            state: 'OK'
        });

        if (msg.descendants && msg.descendants.length > 0) {
            msg.descendants.forEach(d => {
                this.topologyManager.updateNode(d.id, {
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
        const routeInfo = this.topologyManager.get(targetId);
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
                this.topologyManager.removeNode(targetId);
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
        const routeInfo = this.topologyManager.get(targetId);
        if (!routeInfo) return [];

        // For now, we can only provide [host, nextHop, ...] since we don't have full tree structure
        // Nodes will need to continue forwarding based on their own descendant maps
        return [this.peer.id, routeInfo.nextHop];
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
            seeds: this.topologyManager.getSmartSeeds(),
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
        const event = createGameEvent(this.gameId, this.peer.id, this.gameSeq, type, data);

        // Cache the event for STATE responses
        this.gameEventCache.add(this.gameSeq, { type, data });

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
        const msg = createGameEvent(this.gameId, this.peer.id, ++this.gameSeq, type, data, peerId, ack);

        if (ack) {
            const promise = this.ackTracker.waitForAck(msg.msgId);
            this.routeMessage(peerId, msg);
            return promise;
        }

        this.routeMessage(peerId, msg);
    }

    // UI helper
    private onStateChange: ((state: any) => void) | null = null;
    public subscribe(callback: (state: any) => void) {
        this.onStateChange = callback;
        this.emitState();
    }
    public close() {
        if (this.rainInterval) {
            clearInterval(this.rainInterval);
            this.rainInterval = null;
        }
        if (this.rateLimiter) {
            this.rateLimiter.stopCleanup();
        }
    }

    private emitState() {
        if (this.onStateChange) {
            this.onStateChange({
                role: 'HOST',
                peerId: this.peer.id,
                children: Array.from(this.children.keys()),
                rainSeq: this.rainSeq,
                topology: this.topologyManager.getAllData()
            });
        }
    }
}
