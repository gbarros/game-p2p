import Peer, { DataConnection } from 'peerjs';
import { v4 as uuidv4 } from 'uuid';
import {
    ProtocolMessage,
    JoinRequest,
    AttachRequest,
    AttachAccept,
    AttachReject,
    SubtreeStatus,
    AckMessage,
    GameEvent,
    GameCmd,
    ReqCousins,
    CousinsMessage,
    RebindAssign,
    StateMessage,
    PeerId
} from './types.js';

export enum NodeState {
    NORMAL = 'NORMAL',
    SUSPECT_UPSTREAM = 'SUSPECT_UPSTREAM',
    PATCHING = 'PATCHING',
    REBINDING = 'REBINDING',
    WAITING_FOR_HOST = 'WAITING_FOR_HOST'
}

export class Node {
    private peer: Peer;
    private gameId: string;
    private secret: string;

    // Parent Connection
    private parent: DataConnection | null = null;

    // Topology Learning
    private seeds: string[] = [];

    // Children (Acting as Parent)
    private children: Map<string, DataConnection> = new Map();
    private childDescendants: Map<string, { id: string, hops: number, freeSlots: number }[]> = new Map();
    private childCapacities: Map<string, number> = new Map();

    private MAX_CHILDREN = 3;

    // State
    private rainSeq: number = 0;
    private lastRainTime: number = Date.now();
    private isAttached = false;
    private subtreeInterval: NodeJS.Timeout | null = null;
    private myDepth: number = 0;
    private state: NodeState = NodeState.NORMAL;
    private patchStartTime: number = 0;

    // Simulation Controls
    private _paused: boolean = false;
    private _logger: (msg: string) => void = (msg) => console.log(msg);
    private pendingPings: Map<string, number> = new Map(); // msgId -> timestamp
    private pendingAcks: Map<string, { resolve: (v: boolean) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }> = new Map();

    // Callback for game events
    private onGameEvent: ((type: string, data: unknown, from: string) => void) | null = null;

    // Cousin connections for patch mode (S=2 connections at same depth, different parent)
    private cousins: Map<string, DataConnection> = new Map();
    private lastGameSeq: number = 0;
    private gameEventCache: Array<{ seq: number; event: { type: string; data: unknown } }> = [];
    private MAX_CACHE_SIZE = 20; // Configurable cache size (default 20)
    private lastParentRainTime: number = Date.now();
    private stallDetectionInterval: NodeJS.Timeout | null = null;
    private lastReqStateTime: number = 0; // Track when we last sent REQ_STATE
    private reqStateTarget: 'COUSIN' | 'HOST' | null = null; // Track where we sent REQ_STATE
    private reqStateCount: number = 0; // Track number of REQ_STATE sent for rate limiting

    // Join robustness
    private readonly MAX_ATTACH_ATTEMPTS = 10;
    private readonly MAX_REDIRECT_DEPTH = 5;
    private attachAttempts: number = 0;
    private redirectDepth: number = 0;
    private lastAttachTime: number = 0;
    private attachRetryTimer: NodeJS.Timeout | null = null;
    private authAttempts: number = 0;

    // Descendant routing map: descendantId -> nextHop childId
    private descendantToNextHop: Map<string, string> = new Map();
    private descendantsCount: number = 0;

    // Deduplication
    private recentMsgIds: Set<string> = new Set();
    private readonly MAX_MSG_ID_CACHE = 100;

    constructor(gameId: string, secret: string, peer: Peer, logger?: (msg: string) => void) {
        this.gameId = gameId;
        this.secret = secret;
        this.peer = peer;
        if (logger) this._logger = logger;

        this.peer.on('open', (id) => {
            this.log(`[Node] Peer Open: ${id}`);
            this.emitState();
        });

        this.peer.on('error', (err) => {
            this.log(`[Node] Peer Error: ${err}`);
        });

        this.peer.on('connection', (conn) => {
            this.log(`[Node] Incoming connection: ${conn.peer}`, this.peer.id, JSON.stringify(conn.metadata));
            this.handleIncomingConnection(conn);
        });

        // Start stall detection early so tests that manually set state/parent still tick.
        this.startStallDetection();
    }

    // --- Simulation Controls ---

    public setLogger(logger: (msg: string) => void) {
        this._logger = logger;
    }

    public togglePause(paused: boolean) {
        this._paused = paused;
        this.log(`[Node] Paused state set to: ${paused}`);
        this.emitState();
    }

    public isPaused(): boolean {
        return this._paused;
    }

    public getHealthStatus(): 'HEALTHY' | 'DEGRADED' | 'OFFLINE' {
        if (!this.isAttached) return 'OFFLINE';
        const timeSinceRain = Date.now() - this.lastRainTime;
        if (timeSinceRain > 5000) return 'OFFLINE'; // > 5s no rain
        if (timeSinceRain > 2000) return 'DEGRADED'; // > 2s no rain
        return 'HEALTHY';
    }

    /**
     * Configure the game event cache size
     * @param size Number of events to cache (default: 20)
     */
    public setGameEventCacheSize(size: number) {
        if (size < 0) {
            this.log('[Node] Warning: Cache size must be >= 0, using default of 20');
            this.MAX_CACHE_SIZE = 20;
            return;
        }
        this.MAX_CACHE_SIZE = size;
        // Trim existing cache if needed
        while (this.gameEventCache.length > this.MAX_CACHE_SIZE) {
            this.gameEventCache.shift();
        }
        this.log(`[Node] Game event cache size set to ${size}`);
    }

    public close() {
        this.log('[Node] Closing (Simulated Kill)...');
        // Stop any intervals
        if (this.subtreeInterval) clearInterval(this.subtreeInterval);
        if (this.stallDetectionInterval) clearInterval(this.stallDetectionInterval);
        this.subtreeInterval = null;
        this.stallDetectionInterval = null;
        // Close peer connection
        this.peer.destroy();
    }

    private log(msg: string, ...args: any[]) {
        // Custom logger only supports string, so we try to format simple args
        const formatted = args.length > 0 ? `${msg} ${args.map(a => JSON.stringify(a)).join(' ')}` : msg;
        this._logger(formatted);
    }

    // ---------------------------

    private hostId: string | null = null;

    // Step A: Bootstrap (Auth)
    public bootstrap(hostId: string) {
        this.hostId = hostId;
        this.authAttempts = 0;
        if (this.peer.open) {
            this.log('[Node] Peer is open, bootstrapping...');
            this.authenticateWithHost(hostId);
        } else {
            this.log('[Node] Waiting to open before bootstrapping...');
            this.peer.once('open', () => {
                this.authenticateWithHost(hostId);
            });
        }
    }

    private authenticateWithHost(hostId: string) {
        this.log(`[Node] Authenticating with Host ${hostId}...`);
        this.log(`[Node] Creating connection with metadata: gameId=${this.gameId}, secret=${this.secret}`);

        const conn = this.peer.connect(hostId, {
            reliable: true,
            metadata: { gameId: this.gameId, secret: this.secret }
        });

        this.log(`[Node] Connection object created, peer: ${conn.peer}, open: ${conn.open}`);

        const onOpen = () => {
            this.log('[Node] Host p2p connection open, sending JOIN_REQUEST...');
            const req: JoinRequest = {
                t: 'JOIN_REQUEST',
                v: 1,
                gameId: this.gameId,
                src: this.peer.id,
                msgId: uuidv4(),
                secret: this.secret,
                path: [this.peer.id]
            };
            conn.send(req);
        };

        if (conn.open) {
            onOpen();
        } else {
            conn.on('open', onOpen);
        }

        conn.on('data', (data) => {
            // Check paused state
            if (this._paused) return;

            const msg = data as ProtocolMessage;
            if (msg.t === 'JOIN_ACCEPT') {
                this.log('[Node] Join Accepted.');
                this.seeds = msg.seeds || [];

                if (msg.keepAlive) {
                    // Optimization: Host kept us as a child. 
                    this.log('[Node] Host kept connection. Attached as L1.');
                    this.parent = conn;
                    this.isAttached = true;
                    this.myDepth = 1; // Host is L0
                    this.emitState();

                    // Switch listener to normal message handling
                    conn.off('data');
                    conn.on('data', (d) => {
                        if (this._paused) return;
                        this.handleMessage(conn, d as ProtocolMessage);
                    });

                    conn.on('close', () => {
                        this.log('[Node] Parent (Host) connection closed');
                        this.parent = null;
                        this.isAttached = false;
                        this.emitState();
                    });

                    // Start timers only after successful attachment
                    this.startSubtreeReporting();
                    this.startStallDetection();

                } else {
                    // Standard spec flow: Host gave us seeds and will close connection.
                    this.log(`[Node] Host provided seeds: [${this.seeds.join(', ')}]. Disconnecting to attach to seeds.`);
                    conn.close();
                    this.scheduleAttachRetry();
                }

            } else if (msg.t === 'JOIN_REJECT') {
                this.log(`[Node] Join Rejected: ${msg.reason}`);
                conn.close();
            }
        });

        conn.on('error', (e) => {
            this.log(`[Node] Auth Error: ${e}`);
            // Retry on negotiation failure (common in local simulator race conditions)
            if (e.toString().includes('Negotiation') && this.authAttempts < 5) {
                this.log(`[Node] Retrying auth in 500ms... (Attempt ${this.authAttempts + 1}/5)`);
                this.authAttempts++;
                setTimeout(() => {
                    if (!this.isAttached) this.authenticateWithHost(hostId);
                }, 500 + Math.random() * 500);
            }
        });

        conn.on('close', () => {
            this.log(`[Node] Auth connection to ${hostId} closed`);
        });
    }

    // Step B: Attach to Network (Recursive with robustness)
    private attemptAttachToNetwork() {
        this.log(`[Node] attemptAttachToNetwork called. isAttached=${this.isAttached}, attempts=${this.attachAttempts}, seeds=${JSON.stringify(this.seeds)}`);
        if (this.isAttached) {
            this.log('[Node] Already attached, skipping attemptAttachToNetwork');
            return;
        }

        // Check max attempts
        if (this.attachAttempts >= this.MAX_ATTACH_ATTEMPTS) {
            this.log('[Node] Max attach attempts reached, falling back to host');
            this.attachAttempts = 0;
            this.redirectDepth = 0; // Reset depth too when starting fresh
            if (this.hostId) {
                this.authenticateWithHost(this.hostId);
            }
            return;
        }

        // Check max redirect depth
        if (this.redirectDepth >= this.MAX_REDIRECT_DEPTH) {
            this.log('[Node] Max redirect depth reached, resetting');
            this.redirectDepth = 0;
            this.attachAttempts = 0;
            if (this.hostId) {
                this.authenticateWithHost(this.hostId);
            }
            return;
        }

        let targetId: string;
        if (this.seeds.length > 0) {
            // Randomize seed selection
            targetId = this.seeds[Math.floor(Math.random() * this.seeds.length)];
        } else {
            this.log('[Node] No seeds! Falling back to host...');
            if (this.hostId) {
                this.authenticateWithHost(this.hostId);
            }
            return;
        }

        this.attachAttempts++;
        this.lastAttachTime = Date.now();

        this.log(`[Node] Attempting to attach to ${targetId}...`);
        const conn = this.peer.connect(targetId, {
            reliable: true,
            metadata: { gameId: this.gameId, secret: this.secret }
        });

        conn.on('open', () => {
            const req: AttachRequest = {
                t: 'ATTACH_REQUEST',
                v: 1,
                gameId: this.gameId,
                src: this.peer.id,
                msgId: uuidv4(),
                wantRole: 'CHILD',
                depth: this.redirectDepth, // Track redirect depth
                path: [this.peer.id]
            };
            conn.send(req);
        });

        conn.on('data', (data) => this.handleAttachResponse(conn, data as ProtocolMessage));

        conn.on('error', (err) => {
            this.log(`[Node] Failed to connect to ${targetId}`, err);
            this.seeds = this.seeds.filter(s => s !== targetId);
            this.scheduleAttachRetry();
        });
    }

    private scheduleAttachRetry() {
        if (this.attachRetryTimer) clearTimeout(this.attachRetryTimer);

        if (this.attachAttempts === 0) {
            // First attempt: immediate
            this.attemptAttachToNetwork();
            return;
        }

        // Exponential backoff
        const backoffMs = Math.min(500 * Math.pow(2, this.attachAttempts - 1), 5000);
        this.log(`[Node] Retrying attach after ${backoffMs}ms backoff (attempt ${this.attachAttempts})`);
        this.attachRetryTimer = setTimeout(() => {
            this.attachRetryTimer = null;
            this.attemptAttachToNetwork();
        }, backoffMs);
    }

    private handleAttachResponse(conn: DataConnection, msg: ProtocolMessage) {
        if (msg.t === 'ATTACH_ACCEPT') {
            this.log(`[Node] Attached to parent ${conn.peer}`);
            this.parent = conn;
            this.isAttached = true;
            this.myDepth = (msg.level || 0) + 1;

            // Reset counters on success
            this.attachAttempts = 0;
            this.redirectDepth = 0;

            this.emitState();

            conn.off('data');
            conn.on('data', (data) => {
                if (this._paused) return;
                this.handleMessage(conn, data as ProtocolMessage);
            });

            conn.on('close', () => {
                this.log('[Node] Parent connection closed');
                this.parent = null;
                this.isAttached = false;
                this.emitState();
            });

            // Request cousins after successful attach (L2+ only per §7.4)
            if (this.myDepth > 1) {
                this.requestCousins();
            }

            // Start timers only after successful attachment
            this.startSubtreeReporting();
            this.startStallDetection();

        } else if (msg.t === 'ATTACH_REJECT') {
            this.log(`[Node] Attach Rejected by ${conn.peer}. Redirects: ${JSON.stringify(msg.redirect)}`);
            conn.close();

            // Increment redirect depth
            this.redirectDepth++;

            if (msg.redirect && msg.redirect.length > 0) {
                // Randomize redirect list to avoid hotspots
                this.seeds = this.shuffleArray(msg.redirect);
            }

            // Exponential backoff
            this.scheduleAttachRetry();
        }
    }

    private shuffleArray<T>(array: T[]): T[] {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    private handleMessage(conn: DataConnection, msg: ProtocolMessage) {
        // Validate gameId on all inbound messages
        if (msg.gameId !== this.gameId) {
            this.log(`[Node] Rejecting message from ${msg.src}: gameId mismatch`);
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
        const isFromParent = this.parent && conn.peer === this.parent.peer;
        const isFromChild = this.children.has(conn.peer);
        const isFromCousin = this.cousins.has(conn.peer);

        // Check if message needs routing (has a dest that's not us)
        if (msg.dest && msg.dest !== this.peer.id) {
            // Message is not for us, route it

            // Add ourselves to trace path
            const currentPath = msg.path ? [...msg.path] : [];
            if (!currentPath.includes(this.peer.id)) {
                currentPath.push(this.peer.id);
            }
            const forwardedMsg = { ...msg, path: currentPath };

            // Special handling for HOST destination - always route upward
            if (forwardedMsg.dest === 'HOST') {
                if (this.parent && this.parent.open) {
                    this.log(`[Node] Routing ${forwardedMsg.t} UP to HOST`);
                    this.parent.send(forwardedMsg);
                } else {
                    this.log(`[Node] Cannot route to HOST - no parent connection, dropping message`);
                }
                return;
            }

            if (isFromChild) {
                // Came from DOWN → route UP (toward Host)
                if (this.parent && this.parent.open) {
                    this.log(`[Node] Routing ${forwardedMsg.t} UP to parent (dest: ${forwardedMsg.dest})`);
                    this.parent.send(forwardedMsg);
                } else {
                    this.log(`[Node] Cannot route UP - no parent connection`);
                }
            } else if (isFromParent) {
                // Came from UP → route DOWN using explicit route or descendant map
                let nextHop: string | undefined;

                // First try explicit route if available
                if (forwardedMsg.route) {
                    const myIndex = forwardedMsg.route.indexOf(this.peer.id);
                    if (myIndex >= 0 && myIndex < forwardedMsg.route.length - 1) {
                        nextHop = forwardedMsg.route[myIndex + 1];
                    }
                }

                if (!nextHop && forwardedMsg.dest) {
                    nextHop = this.descendantToNextHop.get(forwardedMsg.dest);
                }

                if (nextHop && this.children.has(nextHop)) {
                    this.log(`[Node] Routing ${forwardedMsg.t} DOWN to next hop ${nextHop} (dest: ${forwardedMsg.dest})`);
                    this.children.get(nextHop)!.send(forwardedMsg);
                } else {
                    this.log(`[Node] No route found for child ${forwardedMsg.dest}, routing UP to parent as fallback`);
                    if (this.parent && this.parent.open) {
                        this.parent.send(forwardedMsg);
                    }
                }
            }
            return;
        }

        // --- Message is for us or has no dest (local processing) ---
        switch (msg.t) {
            case 'RAIN':
                if (isFromParent) {
                    // Dedupe by sequence too
                    if (msg.rainSeq <= this.rainSeq) return;

                    this.rainSeq = msg.rainSeq;
                    this.lastRainTime = Date.now();
                    this.lastParentRainTime = Date.now(); // Track for stall detection

                    if (this.state !== NodeState.NORMAL) {
                        this.log(`[Node] Received RAIN from parent, transitioning to NORMAL`);
                        this.state = NodeState.NORMAL;
                        this.patchStartTime = 0;
                        this.reqStateCount = 0;
                    }

                    this.reqStateTarget = null;
                    this.emitState();

                    const currentPath = msg.path ? [...msg.path] : [];
                    if (!currentPath.includes(this.peer.id)) {
                        currentPath.push(this.peer.id);
                    }
                    this.broadcast({ ...msg, path: currentPath });
                }
                break;

            case 'SUBTREE_STATUS':
                if (msg.descendants && msg.freeSlots !== undefined) {
                    this.childDescendants.set(conn.peer, msg.descendants);
                }
                break;

            case 'PING':
                // Respond with PONG back to sender using reverse path
                this.log(`[Node] PING received from ${msg.src}, sending PONG`);
                // Use reverse of incoming path as explicit route for return
                const reversePath = [...(msg.path || [])].reverse();
                const pongMsg: ProtocolMessage = {
                    t: 'PONG',
                    v: 1,
                    gameId: this.gameId,
                    src: this.peer.id,
                    msgId: uuidv4(),
                    replyTo: msg.msgId,
                    dest: msg.src,
                    path: [this.peer.id],
                    route: [this.peer.id, ...reversePath] // Explicit reverse-path routing including self
                };
                // Route using the reverse path (may go through cousins)
                this.routeReply(pongMsg, conn);
                break;

            case 'PONG':
                // Calculate latency if we have the original ping timestamp
                if (msg.replyTo && this.pendingPings.has(msg.replyTo)) {
                    const sendTime = this.pendingPings.get(msg.replyTo)!;
                    const latency = Date.now() - sendTime;
                    this.pendingPings.delete(msg.replyTo);
                    this.log(`[Node] PONG received from ${msg.src} - RTT: ${latency}ms (hops: ${(msg.path || []).length})`);
                } else {
                    this.log(`[Node] PONG received from ${msg.src} via path: ${JSON.stringify(msg.path)}`);
                }
                break;

            case 'ACK':
                // Resolve pending ACK promise if exists
                if (msg.replyTo && this.pendingAcks.has(msg.replyTo)) {
                    const pending = this.pendingAcks.get(msg.replyTo)!;
                    clearTimeout(pending.timeout);
                    pending.resolve(true);
                    this.pendingAcks.delete(msg.replyTo);
                    this.log(`[Node] ACK received for msg ${msg.replyTo}`);
                }
                break;

            case 'GAME_EVENT':
                this.log(`[Node] GAME_EVENT from ${msg.src}: ${msg.event?.type}`);

                // Dedupe by sequence
                if (msg.gameSeq !== undefined) {
                    if (msg.gameSeq <= this.lastGameSeq) return;
                    this.lastGameSeq = msg.gameSeq;
                }

                // Cache the event
                if (msg.event) {
                    this.gameEventCache.push({ seq: msg.gameSeq || 0, event: msg.event });
                    if (this.gameEventCache.length > this.MAX_CACHE_SIZE) {
                        this.gameEventCache.shift();
                    }
                }

                // Send ACK if requested - strictly use reverse of incoming path
                if (msg.ack) {
                    const reversePath = msg.path ? [...msg.path].reverse() : [msg.src];
                    const ackMsg: AckMessage = {
                        t: 'ACK',
                        v: 1,
                        gameId: this.gameId,
                        src: this.peer.id,
                        msgId: uuidv4(),
                        replyTo: msg.msgId,
                        dest: msg.src,
                        path: [this.peer.id],
                        route: [this.peer.id, ...reversePath]
                    };
                    // Route using the reverse path
                    this.routeReply(ackMsg, conn);
                }
                // Notify callback if registered
                if (this.onGameEvent && msg.event) {
                    this.onGameEvent(msg.event.type, msg.event.data, msg.src);
                }

                // Broadcast to children if from parent (tree propagation)
                if (isFromParent) {
                    const currentPath = msg.path ? [...msg.path] : [];
                    if (!currentPath.includes(this.peer.id)) {
                        currentPath.push(this.peer.id);
                    }
                    this.broadcast({ ...msg, path: currentPath });
                }
                break;

            case 'PAYLOAD':
                this.log(`[Node] PAYLOAD received from ${msg.src} (type: ${msg.payloadType}). ReplyTo: ${msg.replyTo}. Pending: ${Array.from(this.pendingAcks.keys()).join(',')}`);
                // Trigger any waiting promises for this payload (using replyTo as key)
                if (msg.replyTo && this.pendingAcks.has(msg.replyTo)) {
                    const pending = this.pendingAcks.get(msg.replyTo)!;
                    clearTimeout(pending.timeout);
                    pending.resolve(true);
                    this.pendingAcks.delete(msg.replyTo);
                }
                break;

            case 'REQ_STATE':
                // Handle state request from cousin or child
                this.log(`[Node] REQ_STATE from ${msg.src} (fromGameSeq: ${msg.fromGameSeq})`);

                const eventsToSend = this.gameEventCache
                    .filter(e => e.seq > msg.fromGameSeq)
                    .map(e => ({ seq: e.seq, event: e.event }));

                // Check for truncation
                const minSeqInCache = this.gameEventCache.length > 0 ? this.gameEventCache[0].seq : 0;
                const truncated = minSeqInCache > (msg.fromGameSeq + 1);

                const reversePathForState = [...(msg.path || [])].reverse();
                const stateMsg: StateMessage = {
                    t: 'STATE',
                    v: 1,
                    gameId: this.gameId,
                    src: this.peer.id,
                    msgId: uuidv4(),
                    replyTo: msg.msgId,
                    dest: msg.src,
                    latestRainSeq: this.rainSeq,
                    latestGameSeq: this.lastGameSeq,
                    events: eventsToSend,
                    minGameSeqAvailable: minSeqInCache,
                    truncated: truncated,
                    path: [this.peer.id],
                    route: [this.peer.id, ...reversePathForState] // Explicit reverse-path routing including self
                };

                // Route using the reverse path
                this.routeReply(stateMsg, conn);
                break;

            case 'STATE':
                // Received state recovery from cousin or parent
                this.log(`[Node] STATE received from ${msg.src} with ${msg.events?.length || 0} events`);

                // Dedupe and cache recovered events
                if (msg.events && msg.events.length > 0) {
                    const newEvents: Array<{ seq: number; event: { type: string; data: unknown } }> = [];

                    msg.events.forEach((item) => {
                        // Use explicit sequence from message
                        const eventSeq = item.seq;
                        const event = item.event;

                        // Ignore events we've already seen
                        if (eventSeq <= this.lastGameSeq) {
                            // this.log(`[Node] Skipping duplicate event seq ${eventSeq}`);
                            return;
                        }

                        // Add to cache
                        this.gameEventCache.push({ seq: eventSeq, event });
                        if (this.gameEventCache.length > this.MAX_CACHE_SIZE) {
                            this.gameEventCache.shift();
                        }

                        newEvents.push({ seq: eventSeq, event });

                        // Notify callback
                        if (this.onGameEvent) {
                            this.onGameEvent(event.type, event.data, msg.src);
                        }
                    });

                    // Update lastGameSeq BEFORE rebroadcasting
                    this.lastGameSeq = Math.max(this.lastGameSeq, msg.latestGameSeq);

                    // Forward only new repaired events downstream
                    newEvents.forEach(({ seq, event }) => {
                        const gameEvent: GameEvent = {
                            t: 'GAME_EVENT',
                            v: 1,
                            gameId: this.gameId,
                            src: this.peer.id,
                            msgId: uuidv4(),
                            gameSeq: seq,
                            event: event,
                            path: [this.peer.id]
                        };
                        this.broadcast(gameEvent);
                    });
                }

                if (msg.latestRainSeq > this.rainSeq) {
                    this.log(`[Node] STATE advanced rainSeq from ${this.rainSeq} to ${msg.latestRainSeq}. Forwarding RAIN downstream.`);
                    this.rainSeq = msg.latestRainSeq;
                    this.lastRainTime = Date.now();
                    this.lastParentRainTime = Date.now(); // Reset stall timer

                    // Synthesize a RAIN message to heal children
                    const rainMsg: ProtocolMessage = {
                        t: 'RAIN',
                        v: 1,
                        gameId: this.gameId,
                        src: this.peer.id, // We are the source of this synthetic rain
                        msgId: uuidv4(),
                        rainSeq: this.rainSeq,
                        path: [this.peer.id]
                    };
                    this.broadcast(rainMsg);
                }

                this.reqStateTarget = null; // Reset since we got a response
                break;

            case 'REQ_COUSINS':
                // Handle cousin discovery request from child
                this.log(`[Node] REQ_COUSINS from ${msg.src} (depth: ${msg.requesterDepth}, count: ${msg.desiredCount})`);

                // Build local cousin candidates at the same depth from other children's subtrees
                let cousinCandidates: string[] = [];
                const targetDepth = msg.requesterDepth;
                const requesterHops = targetDepth - this.myDepth; // How many hops down from us

                // Look through other children's descendants at the same depth
                this.children.forEach((childConn, childId) => {
                    // Skip the requester's branch
                    if (childId === msg.src || this.descendantToNextHop.get(msg.src) === childId) {
                        return;
                    }

                    const descendants = this.childDescendants.get(childId);
                    if (descendants) {
                        descendants.forEach(desc => {
                            // Check if this descendant is at the same depth as requester
                            if (desc.hops === requesterHops) {
                                cousinCandidates.push(desc.id);
                            }
                        });
                    }

                    // Also check if direct child matches depth
                    if (requesterHops === 1) {
                        cousinCandidates.push(childId);
                    }
                });

                // If we found local candidates, randomize and return
                if (cousinCandidates.length > 0) {
                    // Prefer different branches: group by uncle branch and pick one from each
                    const byBranch = new Map<string, string[]>();
                    cousinCandidates.forEach(candId => {
                        const branch = this.descendantToNextHop.get(candId) || candId;
                        if (!byBranch.has(branch)) {
                            byBranch.set(branch, []);
                        }
                        byBranch.get(branch)!.push(candId);
                    });

                    // Pick one random candidate from each branch
                    const selected: string[] = [];
                    byBranch.forEach(candidates => {
                        const pick = candidates[Math.floor(Math.random() * candidates.length)];
                        selected.push(pick);
                    });

                    // Shuffle and limit to desired count
                    const shuffled = this.shuffleArray(selected);
                    const finalCandidates = shuffled.slice(0, msg.desiredCount);

                    this.log(`[Node] Found ${finalCandidates.length} local cousin candidates for ${msg.src}`);

                    const cousinsMsg: CousinsMessage = {
                        t: 'COUSINS',
                        v: 1,
                        gameId: this.gameId,
                        src: this.peer.id,
                        msgId: uuidv4(),
                        replyTo: msg.msgId,
                        dest: msg.src,
                        candidates: finalCandidates,
                        path: [this.peer.id]
                    };

                    // Route back to requester using reverse path or routing
                    if (isFromChild) {
                        conn.send(cousinsMsg);
                    } else {
                        // Forward back using routing
                        this.routeMessageToTarget(msg.src, cousinsMsg);
                    }
                } else {
                    // No local candidates, forward upstream if possible
                    this.log(`[Node] No local cousins found, forwarding REQ_COUSINS upstream`);
                    if (this.parent && this.parent.open) {
                        this.parent.send(msg);
                    } else {
                        // Send empty response
                        const cousinsMsg: CousinsMessage = {
                            t: 'COUSINS',
                            v: 1,
                            gameId: this.gameId,
                            src: this.peer.id,
                            msgId: uuidv4(),
                            replyTo: msg.msgId,
                            dest: msg.src,
                            candidates: [],
                            path: [this.peer.id]
                        };
                        conn.send(cousinsMsg);
                    }
                }
                break;

            case 'COUSINS':
                // Received cousin candidate list
                this.log(`[Node] COUSINS received with ${msg.candidates.length} candidates`);

                // Attempt to connect to cousins (up to 2)
                const candidatesToTry = msg.candidates.slice(0, 2);
                candidatesToTry.forEach(cousinId => {
                    if (!this.cousins.has(cousinId) && cousinId !== this.peer.id) {
                        this.connectToCousin(cousinId);
                    }
                });
                break;

            case 'REBIND_ASSIGN':
                this.handleRebindAssign(msg);
                break;
        }
    }

    // --- Subtree Reporting ---
    private startSubtreeReporting() {
        if (this.subtreeInterval) return;
        this.subtreeInterval = setInterval(() => {
            if (this.parent && this.parent.open) {
                this.reportSubtree();
            }
        }, 5000);
    }

    private reportSubtree() {
        if (!this.parent) return;

        let myDescendants: { id: string, hops: number, freeSlots: number }[] = [];
        let myChildrenStatus: { id: string, state: string, lastRainSeq: number, freeSlots: number }[] = [];

        // Rebuild descendant-to-nextHop map
        this.descendantToNextHop.clear();

        this.children.forEach((conn, childId) => {
            const childCapacity = this.childCapacities.get(childId) || 0;

            // Direct child
            myDescendants.push({ id: childId, hops: 1, freeSlots: childCapacity });
            myChildrenStatus.push({ id: childId, state: 'OK', lastRainSeq: this.rainSeq, freeSlots: childCapacity });

            // Map direct child to itself
            this.descendantToNextHop.set(childId, childId);

            // Grandchildren and deeper
            const grandkids = this.childDescendants.get(childId);
            if (grandkids) {
                grandkids.forEach(gk => {
                    myDescendants.push({ id: gk.id, hops: gk.hops + 1, freeSlots: gk.freeSlots });
                    // Map all descendants of this child to this child as nextHop
                    this.descendantToNextHop.set(gk.id, childId);
                });
            }
        });

        const reportedChildren = Array.from(this.childDescendants.keys()).filter((id) => this.children.has(id)).length;
        let totalDescendants = 0;
        this.childDescendants.forEach((list) => {
            totalDescendants += list.length;
        });
        const subtreeCount = 1 + reportedChildren + totalDescendants;

        const msg: SubtreeStatus = {
            t: 'SUBTREE_STATUS',
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv4(),
            lastRainSeq: this.rainSeq,
            state: 'OK',
            children: myChildrenStatus,
            subtreeCount: subtreeCount,
            descendants: myDescendants,
            freeSlots: this.MAX_CHILDREN - this.children.size,
            path: [this.peer.id]
        };
        this.parent.send(msg);
    }

    // --- Parent Logic ---

    private handleIncomingConnection(conn: DataConnection) {
        const meta = conn.metadata;
        if (!meta || meta.gameId !== this.gameId || meta.secret !== this.secret) {
            conn.close();
            return;
        }

        if (meta.role === 'COUSIN') {
            this.log(`[Node] Registered incoming COUSIN connection from ${conn.peer}`);
            this.cousins.set(conn.peer, conn);
        }

        // Register data handler immediately to avoid race with early messages.
        conn.on('data', (data) => {
            if (this._paused) return; // Ignore incoming messages when paused
            const msg = data as ProtocolMessage;

            if (msg.t === 'ATTACH_REQUEST') {
                // Special case: Initial attachment handshake
                this.handleIncomingAttach(conn, msg);
            } else if (msg.t === 'SUBTREE_STATUS') {
                // Special case: SUBTREE_STATUS is aggregated locally, NOT forwarded
                // Each node summarizes and reports its own subtree on its schedule
                this.childDescendants.set(conn.peer, msg.descendants || []);
                this.childCapacities.set(conn.peer, msg.freeSlots);
            } else {
                // All other messages go through generic handler (including routing)
                this.handleMessage(conn, msg);
            }
        });

        conn.on('close', () => {
            this.log(`[Node] Connection closed: ${conn.peer}`);
            this.children.delete(conn.peer);
            this.cousins.delete(conn.peer);
            this.childDescendants.delete(conn.peer);
            this.childCapacities.delete(conn.peer);
            this.emitState();
            // Immediate report on child leave
            this.reportSubtree();
        });
    }



    private handleIncomingAttach(conn: DataConnection, msg: AttachRequest) {
        if (this.children.size >= this.MAX_CHILDREN) {
            // Smart redirect: find descendants with free slots
            const candidates: string[] = [];
            // 1. Check direct children
            this.children.forEach((childConn, childId) => {
                if ((this.childCapacities.get(childId) || 0) > 0) {
                    candidates.push(childId);
                }
            });
            // 2. Check descendants
            this.childDescendants.forEach((descendants) => {
                descendants.forEach(d => {
                    if (d.freeSlots > 0) {
                        candidates.push(d.id);
                    }
                });
            });

            // Shuffle and limit to 10
            const shuffled = this.shuffleArray(candidates);
            const redirectList = shuffled.slice(0, 10);

            const reject: AttachReject = {
                t: 'ATTACH_REJECT',
                v: 1,
                gameId: this.gameId,
                src: this.peer.id,
                msgId: uuidv4(),
                reason: 'FULL',
                redirect: redirectList,
                depthHint: this.myDepth + 1,
                path: [this.peer.id]
            };
            conn.send(reject);
        } else {
            this.children.set(conn.peer, conn);
            const accept: AttachAccept = {
                t: 'ATTACH_ACCEPT',
                v: 1,
                gameId: this.gameId,
                src: this.peer.id,
                msgId: uuidv4(),
                parentId: this.peer.id,
                level: this.myDepth,
                cousinCandidates: [],
                childrenMax: this.MAX_CHILDREN,
                childrenUsed: this.children.size,
                path: [this.peer.id]
            };
            conn.send(accept);
            this.emitState();

            // Immediately report new capacity to parent so Host has current freeSlots
            this.reportSubtree();
        }
    }

    private handleRebindAssign(msg: RebindAssign) {
        this.log(`[Node] REBIND_ASSIGN received with ${msg.newParentCandidates.length} candidates`);

        // Disconnect from current parent
        if (this.parent) {
            this.parent.close();
            this.parent = null;
            this.isAttached = false;
        }

        this.seeds = msg.newParentCandidates;
        this.attachAttempts = 0;
        this.state = NodeState.NORMAL; // Re-entering attach flow
        this.scheduleAttachRetry();
    }

    private broadcast(msg: ProtocolMessage) {
        this.children.forEach(c => {
            if (c.open) c.send(msg);
        });
    }

    private routeMessageToTarget(targetId: string, msg: ProtocolMessage) {
        // Helper to route a message to a specific target (used for routing COUSINS replies, etc.)
        const nextHop = this.descendantToNextHop.get(targetId);
        if (nextHop && this.children.has(nextHop)) {
            const conn = this.children.get(nextHop);
            if (conn && conn.open) {
                conn.send(msg);
                return;
            }
        }
        // Fallback: send to parent
        if (this.parent && this.parent.open) {
            this.parent.send(msg);
        }
    }

    private routeReply(msg: ProtocolMessage, sourceConn: DataConnection) {
        // Route a reply using explicit reverse-path routing
        // This allows replies to traverse cousin links if they were in the original path

        if (!msg.route || msg.route.length === 0) {
            // No explicit route, just send back on same connection
            sourceConn.send(msg);
            return;
        }

        // Find our position in the route
        const myIndex = msg.route.indexOf(this.peer.id);
        let nextHopId: string;

        if (myIndex === -1) {
            // We are likely the originator of this reply (or start of route), so send to first hop
            nextHopId = msg.route[0];
        } else if (myIndex < msg.route.length - 1) {
            // We are in the list, forward to next
            nextHopId = msg.route[myIndex + 1];
        } else {
            // We're the destination (last in route), deliver locally (shouldn't happen for outgoing reply usually)
            return;
        }

        // Try to find the connection (could be parent, child, or cousin)
        let targetConn: DataConnection | null = null;

        // Check if nextHop is parent
        if (this.parent && this.parent.peer === nextHopId) {
            targetConn = this.parent;
        }
        // Check children
        else if (this.children.has(nextHopId)) {
            targetConn = this.children.get(nextHopId)!;
        }
        // Check cousins
        else if (this.cousins.has(nextHopId)) {
            targetConn = this.cousins.get(nextHopId)!;
        }

        if (targetConn && targetConn.open) {
            targetConn.send(msg);
        } else if (sourceConn.open) {
            // Fallback to the incoming connection when route lookup fails.
            this.log(`[Node] Cannot route reply - next hop ${nextHopId} not connected. Falling back to sourceConn.`);
            sourceConn.send(msg);
        } else {
            this.log(`[Node] Cannot route reply - next hop ${nextHopId} not connected. Route: ${JSON.stringify(msg.route)}`);
        }
    }

    public sendToHost(msg: ProtocolMessage) {
        this.log(`[Node] sendToHost called. Parent: ${this.parent?.peer || 'NONE'}, Open: ${this.parent?.open || false}`);
        if (this.parent && this.parent.open) {
            msg.path = [this.peer.id];
            this.parent.send(msg);
            this.log(`[Node] Sent ${msg.t} to parent ${this.parent.peer}`);
        } else {
            this.log(`[Node] sendToHost FAILED - no open parent connection!`);
        }
    }

    public pingHost() {
        this.log(`[Node] pingHost() called. isAttached=${this.isAttached}, depth=${this.myDepth}`);
        const msgId = uuidv4();

        // Track send time for latency calculation
        this.pendingPings.set(msgId, Date.now());

        this.sendToHost({
            t: 'PING',
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: msgId,
            dest: 'HOST'
        });
    }

    private requestCousins() {
        this.log(`[Node] Requesting cousins (depth=${this.myDepth}). Parent: ${this.parent?.peer}, Open: ${this.parent?.open}`);

        if (!this.parent) return;

        this.log(`[Node] Requesting cousins (depth=${this.myDepth})`);

        const reqCousins: ReqCousins = {
            t: 'REQ_COUSINS',
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv4(),
            requesterDepth: this.myDepth,
            desiredCount: 2,
            path: [this.peer.id]
        };

        this.parent.send(reqCousins);
    }

    private connectToCousin(cousinId: string) {
        this.log(`[Node] Attempting to connect to cousin ${cousinId}`);

        const conn = this.peer.connect(cousinId, {
            reliable: true,
            metadata: { gameId: this.gameId, secret: this.secret, role: 'COUSIN' }
        });

        conn.on('open', () => {
            this.log(`[Node] Cousin connection established with ${cousinId}`);
            this.cousins.set(cousinId, conn);
            this.emitState();
        });

        conn.on('data', (data) => {
            if (this._paused) return;
            this.handleMessage(conn, data as ProtocolMessage);
        });

        conn.on('close', () => {
            this.log(`[Node] Cousin connection closed: ${cousinId}`);
            this.cousins.delete(cousinId);
            this.emitState();
        });

        conn.on('error', (err) => {
            this.log(`[Node] Cousin connection error with ${cousinId}: ${err}`);
            this.cousins.delete(cousinId);
        });
    }

    private startStallDetection() {
        if (this.stallDetectionInterval) return;
        this.stallDetectionInterval = setInterval(() => {
            if (this.state === NodeState.REBINDING || (this as any).state === 'REBINDING') {
                if (!this.isAttached) {
                    this.state = NodeState.WAITING_FOR_HOST;
                    this.emitState();
                }
            }

            if (!this.isAttached) return;

            const timeSinceRain = Date.now() - this.lastParentRainTime;

            // 6.2 Local Detection Rule: SUSPECT_UPSTREAM after 3 seconds
            if (timeSinceRain > 3000 && this.state === NodeState.NORMAL) {
                this.log(`[Node] Upstream stall detected (3s). Transitioning to SUSPECT_UPSTREAM`);
                this.state = NodeState.SUSPECT_UPSTREAM;
                this.emitState();
            }

            // 6.3 Patch Mode (Cousin Pull)
            if (this.state === NodeState.SUSPECT_UPSTREAM || this.state === NodeState.PATCHING) {
                const now = Date.now();

                // Rate limit REQ_STATE
                let limit = 2000; // default 2s

                if (this.state === NodeState.SUSPECT_UPSTREAM) {
                    // Transition to PATCHING immediately
                    this.state = NodeState.PATCHING;
                    this.patchStartTime = now;
                    this.reqStateCount = 0;
                    limit = 0; // Send first one immediately
                    this.log(`[Node] Entering PATCH MODE`);
                } else {
                    // 12. Rate Limits & Backoff
                    if (this.reqStateCount < 5) {
                        limit = 1000; // 1/s for first 5s
                    } else if (this.reqStateCount < 8) {
                        limit = 2000;
                    } else if (this.reqStateCount < 12) {
                        limit = 5000;
                    } else {
                        limit = 10000;
                    }
                }

                if (now - this.lastReqStateTime >= limit) {
                    this.sendReqStateToCousins();
                }

                // 6.4 Escalation: Rebind after 60-120 seconds
                const patchDuration = now - (this.patchStartTime || now);
                if (this.patchStartTime !== 0 && patchDuration > 60000) {
                    this.log(`[Node] Patch mode persisted > 60s. Escalating to REBINDING`);
                    this.state = NodeState.REBINDING;
                    this.requestRebind('UPSTREAM_STALL');
                }
            }


        }, 1000);
    }

    public requestPayload(type: string): Promise<boolean> {
        const msgId = uuidv4();
        const msg: ProtocolMessage = {
            t: 'REQ_PAYLOAD',
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId,
            dest: 'HOST',
            payloadType: type,
            path: [this.peer.id]
        };
        return new Promise<boolean>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingAcks.delete(msgId);
                reject(new Error(`Payload timeout for ${type}`));
            }, 10000);
            this.pendingAcks.set(msgId, { resolve, reject, timeout });

            // Send AFTER registering the pending ACK to handle synchronous replies (mocks)
            this.sendToHost(msg);
        });
    }

    private sendReqStateToCousins() {
        if (this.cousins.size > 0) {
            const cousinIds = Array.from(this.cousins.keys());
            // Randomly pick a cousin
            const targetId = cousinIds[Math.floor(Math.random() * cousinIds.length)];
            const cousinConn = this.cousins.get(targetId);

            if (cousinConn && cousinConn.open) {
                this.log(`[Node] Requesting state from cousin ${targetId}`);
                const reqState: ProtocolMessage = {
                    t: 'REQ_STATE',
                    v: 1,
                    gameId: this.gameId,
                    src: this.peer.id,
                    msgId: uuidv4(),
                    dest: targetId,
                    fromRainSeq: this.rainSeq,
                    fromGameSeq: this.lastGameSeq,
                    path: [this.peer.id]
                };
                cousinConn.send(reqState);
                this.lastReqStateTime = Date.now();
                this.reqStateTarget = 'COUSIN';
                this.reqStateCount++;
            }
        } else {
            // No cousins, request from host as fallback or request cousins
            if (Date.now() - this.lastReqStateTime > 5000) {
                this.log(`[Node] No cousins available, fallback state request to host`);
                const reqStateHost: ProtocolMessage = {
                    t: 'REQ_STATE',
                    v: 1,
                    gameId: this.gameId,
                    src: this.peer.id,
                    msgId: uuidv4(),
                    dest: 'HOST',
                    fromRainSeq: this.rainSeq,
                    fromGameSeq: this.lastGameSeq,
                    path: [this.peer.id]
                };
                this.sendToHost(reqStateHost);
                this.lastReqStateTime = Date.now();
                this.reqStateTarget = 'HOST';
                this.reqStateCount++;
            }
        }
    }

    private requestRebind(reason: string) {
        if (!this.parent || !this.parent.open) return;

        // Calculate total subtree size (children + descendants)
        let totalDescendants = 0;
        this.childDescendants.forEach(list => totalDescendants += list.length);
        const totalSubtree = 1 + this.children.size + totalDescendants;

        const rebindReq: ProtocolMessage = {
            t: 'REBIND_REQUEST',
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv4(),
            dest: 'HOST',
            lastRainSeq: this.rainSeq,
            lastGameSeq: this.lastGameSeq,
            subtreeCount: totalSubtree,
            reason: reason,
            path: [this.peer.id]
        };

        this.sendToHost(rebindReq);
    }

    public getPeerId(): string {
        return this.peer.id;
    }

    // --- Public Game API ---

    /**
     * Register callback for incoming game events
     */
    public onGameEventReceived(callback: (type: string, data: unknown, from: string) => void): void {
        this.onGameEvent = callback;
    }

    /**
     * Send a game command to the Host (upstream messages use GAME_CMD)
     * @param type Command type
     * @param data Command data
     * @param ack If true, returns Promise that resolves when ACK received
     */
    public sendGameEvent(type: string, data: unknown, ack: boolean = false): void | Promise<boolean> {
        const msgId = uuidv4();
        const msg: GameCmd = {
            t: 'GAME_CMD',
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId,
            cmd: { type, data },
            dest: 'HOST',
            path: [this.peer.id],
            ack: ack
        };

        this.sendToHost(msg);

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

    private onStateChange: ((state: any) => void) | null = null;
    public subscribe(callback: (state: any) => void) {
        this.onStateChange = callback;
        this.emitState();
    }
    private emitState() {
        if (this.onStateChange) {
            this.onStateChange({
                role: 'NODE',
                peerId: this.peer.id,
                peerOpen: this.peer.open,
                parentId: this.parent?.peer || null,
                children: Array.from(this.children.keys()),
                rainSeq: this.rainSeq,
                isAttached: this.isAttached,
                depth: this.myDepth,
                state: this.state
            });
        }
    }
}
