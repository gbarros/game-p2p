import Peer, { DataConnection } from 'peerjs';
import { v4 as uuidv4 } from 'uuid';
import {
    ProtocolMessage,
    JoinRequest,
    AttachRequest,
    AttachAccept,
    AttachReject,
    SubtreeStatus,
    RebindAssign
} from './types.js';
import {
    DeduplicationCache,
    RateLimiter,
    GameEventCache,
    PendingAckTracker,
    shuffleArray,
    createAckMessage,
    createPongMessage,
    createStateMessage,
    createGameEvent,
    createCousinsMessage,
    createReqCousinsMessage,
    createReqStateMessage,
    createGameCmd,
    createReqPayloadMessage,
    addToPath,
    PROTOCOL_CONSTANTS
} from './utils/index.js';
import { NodeStateManager } from './node/NodeStateManager.js';
import { NodeConnectionManager } from './node/NodeConnectionManager.js';

// Re-export NodeState for compatibility or just use it from manager
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

    // Managers
    private stateManager: NodeStateManager;
    private connManager: NodeConnectionManager;

    // Topology Learning
    private seeds: string[] = [];

    // Children Metadata
    private childDescendants: Map<string, { id: string, hops: number, freeSlots: number }[]> = new Map();
    private childCapacities: Map<string, number> = new Map();

    private MAX_CHILDREN = PROTOCOL_CONSTANTS.MAX_NODE_CHILDREN;

    private subtreeInterval: NodeJS.Timeout | null = null;
    private myDepth: number = 0;

    // Simulation Controls
    private _paused: boolean = false;
    private _logger: (msg: string) => void = (msg) => console.log(msg);
    private pendingPings: Map<string, number> = new Map(); // msgId -> timestamp

    // Callback for game events
    private onGameEvent: ((type: string, data: unknown, from: string) => void) | null = null;

    private lastGameSeq: number = 0;
    private stallDetectionInterval: NodeJS.Timeout | null = null;
    private lastReqStateTime: number = 0; // Track when we last sent REQ_STATE
    private reqStateCount: number = 0; // Track number of REQ_STATE sent for rate limiting
    private rebindJitter: number = 0; // Random jitter (0-10s) for rebind timing to avoid storms

    // Join robustness
    private readonly MAX_ATTACH_ATTEMPTS = PROTOCOL_CONSTANTS.MAX_ATTACH_ATTEMPTS;
    private readonly MAX_REDIRECT_DEPTH = PROTOCOL_CONSTANTS.MAX_REDIRECT_DEPTH;
    private attachAttempts: number = 0;
    private redirectDepth: number = 0;
    private attachRetryTimer: NodeJS.Timeout | null = null;
    private authAttempts: number = 0;

    // Descendant routing map: descendantId -> nextHop childId
    private descendantToNextHop: Map<string, string> = new Map();

    // Utility classes
    private dedupCache: DeduplicationCache;
    private rateLimiter: RateLimiter;
    private gameEventCache: GameEventCache;
    private ackTracker: PendingAckTracker;

    private hostId: string | null = null;

    constructor(gameId: string, secret: string, peer: Peer, logger?: (msg: string) => void) {
        this.gameId = gameId;
        this.secret = secret;
        this.peer = peer;
        if (logger) this._logger = logger;

        // Initialize Managers
        this.stateManager = new NodeStateManager((msg) => this.log(msg));
        this.connManager = new NodeConnectionManager(peer, (msg) => this.log(msg));

        // Initialize utility classes
        // Initialize utility classes
        this.dedupCache = new DeduplicationCache(PROTOCOL_CONSTANTS.DEDUP_CACHE_SIZE);
        this.rateLimiter = new RateLimiter(
            PROTOCOL_CONSTANTS.RATE_LIMIT_TOKENS,
            PROTOCOL_CONSTANTS.RATE_LIMIT_WINDOW,
            PROTOCOL_CONSTANTS.RATE_LIMIT_BAN
        );
        this.gameEventCache = new GameEventCache(PROTOCOL_CONSTANTS.GAME_EVENT_CACHE_SIZE_NODE);
        this.ackTracker = new PendingAckTracker(PROTOCOL_CONSTANTS.ACK_TRACKER_TIMEOUT);

        this.peer.on('open', (id) => {
            this.log(`[Node] Peer Open: ${id}`);
            this.emitState();
            this.rateLimiter.startCleanup();
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
        return this.stateManager.getHealthStatus();
    }

    /**
     * Configure the game event cache size
     * @param size Number of events to cache (default: 50)
     */
    public setGameEventCacheSize(size: number) {
        try {
            this.gameEventCache.setMaxSize(size);
            this.log(`[Node] Game event cache size set to ${size}`);
        } catch (e) {
            this.log('[Node] Warning: Cache size must be >= 0, using default of 50');
        }
    }

    public close() {
        this.log('[Node] Closing (Simulated Kill)...');

        // Clear all pending ACKs and reject promises
        this.ackTracker.clear(new Error('Node closing'));

        // Clear pending pings
        this.pendingPings.clear();

        // Stop any intervals
        if (this.subtreeInterval) clearInterval(this.subtreeInterval);
        if (this.stallDetectionInterval) clearInterval(this.stallDetectionInterval);
        if (this.attachRetryTimer) clearTimeout(this.attachRetryTimer);
        this.rateLimiter.stopCleanup();

        this.subtreeInterval = null;
        this.stallDetectionInterval = null;
        this.attachRetryTimer = null;

        // Close peer connection
        this.peer.destroy();
    }

    private log(msg: string, ...args: any[]) {
        // Custom logger only supports string, so we try to format simple args
        const formatted = args.length > 0 ? `${msg} ${args.map(a => JSON.stringify(a)).join(' ')}` : msg;
        this._logger(formatted);
    }

    // ---------------------------

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
                    this.connManager.setParent(conn);
                    this.stateManager.setAttached(true);
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
                        this.connManager.setParent(null);
                        this.stateManager.setAttached(false);
                        this.emitState();
                        // When a live parent connection drops, re-enter attach flow promptly.
                        // Clear seeds so we preferentially re-auth to host (as an L1).
                        this.seeds = [];
                        this.attachAttempts = 0;
                        this.redirectDepth = 0;
                        this.scheduleAttachRetry();
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
                    if (!this.stateManager.isAttached) this.authenticateWithHost(hostId);
                }, 500 + Math.random() * 500);
            }
        });

        conn.on('close', () => {
            this.log(`[Node] Auth connection to ${hostId} closed`);
        });
    }

    // Step B: Attach to Network (Recursive with robustness)
    private attemptAttachToNetwork() {
        this.log(`[Node] attemptAttachToNetwork called. isAttached=${this.stateManager.isAttached}, attempts=${this.attachAttempts}, seeds=${JSON.stringify(this.seeds)}`);
        if (this.stateManager.isAttached) {
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
            this.connManager.setParent(conn);
            this.stateManager.setAttached(true);
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
                this.connManager.setParent(null);
                this.stateManager.setAttached(false);
                this.emitState();
                // Parent disconnects should trigger a prompt re-attach attempt (crash handling).
                this.scheduleAttachRetry();
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
                this.seeds = shuffleArray(msg.redirect);
            }

            // Exponential backoff
            this.scheduleAttachRetry();
        }
    }

    private handleMessage(conn: DataConnection, msg: ProtocolMessage) {
        // Validate gameId on all inbound messages
        if (msg.gameId !== this.gameId) {
            this.log(`[Node] Rejecting message from ${msg.src}: gameId mismatch`);
            return;
        }

        // Deduplication using utility
        if (this.dedupCache.isDuplicate(msg.msgId)) {
            return;
        }

        const isFromParent = this.connManager.parent && conn.peer === this.connManager.parent.peer;
        const isFromChild = this.connManager.children.has(conn.peer);
        // const isFromCousin = this.connManager.cousins.has(conn.peer); // Used implicitly in routing

        // Check if message needs routing (has a dest that's not us)
        if (msg.dest && msg.dest !== this.peer.id) {
            // Message is not for us, route it
            const forwardedMsg = addToPath(msg, this.peer.id);

            // Special handling for HOST destination - always route upward
            if (forwardedMsg.dest === 'HOST') {
                this.log(`[Node] Routing ${forwardedMsg.t} UP to HOST`);
                this.connManager.sendToParent(forwardedMsg);
                return;
            }

            if (isFromChild) {
                // Came from DOWN → route UP (toward Host)
                this.log(`[Node] Routing ${forwardedMsg.t} UP to parent (dest: ${forwardedMsg.dest})`);
                this.connManager.sendToParent(forwardedMsg);
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

                if (nextHop && this.connManager.children.has(nextHop)) {
                    this.log(`[Node] Routing ${forwardedMsg.t} DOWN to next hop ${nextHop} (dest: ${forwardedMsg.dest})`);
                    this.connManager.children.get(nextHop)!.send(forwardedMsg);
                } else {
                    this.log(`[Node] No route found for child ${forwardedMsg.dest}, routing UP to parent as fallback`);
                    this.connManager.sendToParent(forwardedMsg);
                }
            }
            return;
        }

        // --- Message is for us or has no dest (local processing) ---
        switch (msg.t) {
            case 'RAIN':
                if (isFromParent) {
                    const updated = this.stateManager.processRain(msg.rainSeq, true);
                    if (!updated) return;

                    this.emitState();

                    const forwardedMsg = addToPath(msg, this.peer.id);
                    this.connManager.broadcast(forwardedMsg);
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
                const pongMsg = createPongMessage(this.gameId, this.peer.id, msg.msgId, msg.src, msg.path);
                // Route using the reverse path (may go through cousins)
                this.connManager.routeReply(pongMsg, conn);
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
                if (msg.replyTo) {
                    this.ackTracker.resolve(msg.replyTo);
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
                    this.gameEventCache.add(msg.gameSeq || 0, msg.event);
                }

                // Send ACK if requested - strictly use reverse of incoming path
                if (msg.ack) {
                    const ackMsg = createAckMessage(this.gameId, this.peer.id, msg.msgId, msg.src, msg.path);
                    // Route using the reverse path
                    this.connManager.routeReply(ackMsg, conn);
                }
                // Notify callback if registered
                if (this.onGameEvent && msg.event) {
                    this.onGameEvent(msg.event.type, msg.event.data, msg.src);
                }

                // Broadcast to children if from parent (tree propagation)
                if (isFromParent) {
                    const forwardedMsg = addToPath(msg, this.peer.id);
                    this.connManager.broadcast(forwardedMsg);
                }
                break;

            case 'PAYLOAD':
                this.log(`[Node] PAYLOAD received from ${msg.src} (type: ${msg.payloadType}). ReplyTo: ${msg.replyTo}. Pending: ${Array.from(this.ackTracker['pendingAcks'].keys()).join(',')}`);
                // Trigger any waiting promises for this payload (using replyTo as key)
                if (msg.replyTo) {
                    this.ackTracker.resolve(msg.replyTo);
                }
                break;

            case 'REQ_STATE':
                // Handle state request from cousin or child
                this.log(`[Node] REQ_STATE from ${msg.src} (fromGameSeq: ${msg.fromGameSeq})`);

                const eventsToSend = this.gameEventCache.getEventsAfter(msg.fromGameSeq);
                const minSeqInCache = this.gameEventCache.getMinSeq();
                const truncated = this.gameEventCache.isTruncated(msg.fromGameSeq);

                const stateMsg = createStateMessage(
                    this.gameId,
                    this.peer.id,
                    msg.msgId,
                    msg.src,
                    this.stateManager.rainSeq,
                    this.lastGameSeq,
                    eventsToSend,
                    minSeqInCache,
                    truncated,
                    msg.path
                );

                // Route using the reverse path
                this.connManager.routeReply(stateMsg, conn);
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
                            return;
                        }

                        // Add to cache
                        this.gameEventCache.add(eventSeq, event);
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
                        const gameEvent = createGameEvent(this.gameId, this.peer.id, seq, event.type, event.data);
                        this.connManager.broadcast(gameEvent);
                    });
                }

                if (msg.latestRainSeq > this.stateManager.rainSeq) {
                    this.log(`[Node] STATE advanced rainSeq from ${this.stateManager.rainSeq} to ${msg.latestRainSeq}. Forwarding RAIN downstream.`);
                    this.stateManager.processRain(msg.latestRainSeq, true);

                    // Synthesize a RAIN message to heal children
                    const rainMsg: ProtocolMessage = {
                        t: 'RAIN',
                        v: 1,
                        gameId: this.gameId,
                        src: this.peer.id, // We are the source of this synthetic rain
                        msgId: uuidv4(),
                        rainSeq: this.stateManager.rainSeq,
                        path: [this.peer.id]
                    };
                    this.connManager.broadcast(rainMsg);
                }

                break;

            case 'REQ_COUSINS':
                // Handle cousin discovery request from child
                this.log(`[Node] REQ_COUSINS from ${msg.src} (depth: ${msg.requesterDepth}, count: ${msg.desiredCount})`);

                // Build local cousin candidates at the same depth from other children's subtrees
                let cousinCandidates: string[] = [];
                const targetDepth = msg.requesterDepth;
                const requesterHops = targetDepth - this.myDepth; // How many hops down from us

                // Look through other children's descendants at the same depth
                this.connManager.children.forEach((_childConn, childId) => {
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
                    const shuffled = shuffleArray(selected);
                    const finalCandidates = shuffled.slice(0, msg.desiredCount);

                    this.log(`[Node] Found ${finalCandidates.length} local cousin candidates for ${msg.src}`);

                    const cousinsMsg = createCousinsMessage(
                        this.gameId,
                        this.peer.id,
                        msg.msgId,
                        msg.src,
                        finalCandidates,
                        msg.path
                    );

                    // Route back to requester using reverse path
                    this.connManager.routeReply(cousinsMsg, conn);
                } else {
                    // No local candidates, forward upstream if possible
                    this.log(`[Node] No local cousins found, forwarding REQ_COUSINS upstream`);
                    if (this.connManager.parent && this.connManager.parent.open) {
                        this.connManager.parent.send(msg);
                    } else {
                        // Send empty response
                        const cousinsMsg = createCousinsMessage(
                            this.gameId,
                            this.peer.id,
                            msg.msgId,
                            msg.src,
                            [],
                            msg.path
                        );
                        this.connManager.routeReply(cousinsMsg, conn);
                    }
                }
                break;

            case 'COUSINS':
                // Received cousin candidate list
                this.log(`[Node] COUSINS received with ${msg.candidates.length} candidates`);

                // Attempt to connect to cousins (up to 2)
                const candidatesToTry = msg.candidates.slice(0, 2);
                candidatesToTry.forEach(cousinId => {
                    if (!this.connManager.cousins.has(cousinId) && cousinId !== this.peer.id) {
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
            if (this.connManager.parent && this.connManager.parent.open) {
                this.reportSubtree();
            }
        }, PROTOCOL_CONSTANTS.SUBTREE_REPORT_INTERVAL);
    }

    private reportSubtree() {
        if (!this.connManager.parent) return;

        let myDescendants: { id: string, hops: number, freeSlots: number }[] = [];
        let myChildrenStatus: { id: string, state: string, lastRainSeq: number, freeSlots: number }[] = [];

        // Rebuild descendant-to-nextHop map
        this.descendantToNextHop.clear();

        this.connManager.children.forEach((_conn, childId) => {
            const childCapacity = this.childCapacities.get(childId) || 0;

            // Direct child
            myDescendants.push({ id: childId, hops: 1, freeSlots: childCapacity });
            myChildrenStatus.push({ id: childId, state: 'OK', lastRainSeq: this.stateManager.rainSeq, freeSlots: childCapacity });

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

        const reportedChildren = Array.from(this.childDescendants.keys()).filter((id) => this.connManager.children.has(id)).length;
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
            lastRainSeq: this.stateManager.rainSeq,
            state: 'OK',
            children: myChildrenStatus,
            subtreeCount: subtreeCount,
            descendants: myDescendants,
            freeSlots: this.MAX_CHILDREN - this.connManager.children.size,
            path: [this.peer.id]
        };
        this.connManager.parent.send(msg);
    }

    // --- Parent Logic ---

    private handleIncomingConnection(conn: DataConnection) {
        // Rate limit check using utility
        if (!this.rateLimiter.allowConnection(conn.peer)) {
            const count = this.rateLimiter.getAttemptCount(conn.peer);
            this.log(`[Node] Rate limit exceeded for ${conn.peer} (${count} attempts), rejecting`);
            conn.close();
            return;
        }

        const meta = conn.metadata;
        if (!meta || meta.gameId !== this.gameId || meta.secret !== this.secret) {
            conn.close();
            return;
        }

        if (meta.role === 'COUSIN') {
            this.log(`[Node] Registered incoming COUSIN connection from ${conn.peer}`);
            this.connManager.addCousin(conn);
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
            this.connManager.removeConnection(conn.peer);
            this.childDescendants.delete(conn.peer);
            this.childCapacities.delete(conn.peer);
            this.emitState();
            // Immediate report on child leave
            this.reportSubtree();
        });
    }

    private handleIncomingAttach(conn: DataConnection, _msg: AttachRequest) {
        if (this.connManager.children.size >= this.MAX_CHILDREN) {
            // Smart redirect: find descendants with free slots
            const candidates: string[] = [];
            // 1. Check direct children
            this.connManager.children.forEach((_childConn, childId) => {
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
            const shuffled = shuffleArray(candidates);
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
            this.connManager.addChild(conn);
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
                childrenUsed: this.connManager.children.size,
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
        if (this.connManager.parent) {
            this.connManager.parent.close();
            this.connManager.setParent(null);
            this.stateManager.setAttached(false);
        }

        this.seeds = msg.newParentCandidates;
        this.attachAttempts = 0;
        this.stateManager.transitionTo(NodeState.NORMAL); // Re-entering attach flow
        this.scheduleAttachRetry();
    }

    public sendToHost(msg: ProtocolMessage) {
        this.log(`[Node] sendToHost called. Parent: ${this.connManager.parent?.peer || 'NONE'}, Open: ${this.connManager.parent?.open || false}`);
        if (this.connManager.parent && this.connManager.parent.open) {
            msg.path = [this.peer.id];
            this.connManager.parent.send(msg);
            this.log(`[Node] Sent ${msg.t} to parent ${this.connManager.parent.peer}`);
        } else {
            this.log(`[Node] sendToHost FAILED - no open parent connection!`);
        }
    }

    public pingHost() {
        this.log(`[Node] pingHost() called. isAttached=${this.stateManager.isAttached}, depth=${this.myDepth}`);
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
        this.log(`[Node] Requesting cousins (depth=${this.myDepth}). Parent: ${this.connManager.parent?.peer}, Open: ${this.connManager.parent?.open}`);

        if (!this.connManager.parent) return;

        this.log(`[Node] Requesting cousins (depth=${this.myDepth})`);

        const reqCousins = createReqCousinsMessage(this.gameId, this.peer.id, this.myDepth, 2);
        this.connManager.parent.send(reqCousins);
    }

    private connectToCousin(cousinId: string) {
        this.log(`[Node] Attempting to connect to cousin ${cousinId}`);

        const conn = this.peer.connect(cousinId, {
            reliable: true,
            metadata: { gameId: this.gameId, secret: this.secret, role: 'COUSIN' }
        });

        conn.on('open', () => {
            this.log(`[Node] Cousin connection established with ${cousinId}`);
            this.connManager.addCousin(conn);
            this.emitState();
        });

        conn.on('data', (data) => {
            if (this._paused) return;
            this.handleMessage(conn, data as ProtocolMessage);
        });

        conn.on('close', () => {
            this.log(`[Node] Cousin connection closed: ${cousinId}`);
            this.connManager.removeConnection(cousinId);
            this.emitState();
        });

        conn.on('error', (err) => {
            this.log(`[Node] Cousin connection error with ${cousinId}: ${err}`);
            this.connManager.removeConnection(cousinId);
        });
    }

    private startStallDetection() {
        if (this.stallDetectionInterval) return;
        this.stallDetectionInterval = setInterval(() => {
            if (this.stateManager.state === NodeState.REBINDING) {
                if (!this.stateManager.isAttached) {
                    this.stateManager.transitionTo(NodeState.WAITING_FOR_HOST);
                    this.emitState();
                }
            }

            if (!this.stateManager.isAttached) return;

            // Delegate detection logic to StateManager
            this.stateManager.checkStall();

            // 6.3 Patch Mode (Cousin Pull)
            if (this.stateManager.state === NodeState.SUSPECT_UPSTREAM || this.stateManager.state === NodeState.PATCHING) {
                const now = Date.now();

                // Rate limit REQ_STATE
                let limit = 2000; // default 2s

                if (this.stateManager.state === NodeState.SUSPECT_UPSTREAM) {
                    // Transition to PATCHING immediately
                    this.stateManager.transitionTo(NodeState.PATCHING);
                    this.reqStateCount = 0;
                    this.rebindJitter = Math.random() * 10000; // 0-10s jitter to avoid rebind storms
                    limit = 0; // Send first one immediately
                    this.log(`[Node] Entering PATCH MODE`);
                    this.emitState();
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

                // 6.4 Escalation: Rebind after 60-70 seconds (with jitter to avoid storms)
                const patchDuration = now - (this.stateManager.patchStartTime || now);
                const rebindThreshold = 60000 + this.rebindJitter; // 60s + 0-10s jitter
                if (this.stateManager.patchStartTime !== 0 && patchDuration > rebindThreshold) {
                    this.log(`[Node] Patch mode persisted > ${Math.floor(rebindThreshold / 1000)}s. Escalating to REBINDING`);
                    this.stateManager.transitionTo(NodeState.REBINDING);
                    this.emitState();
                    this.requestRebind('UPSTREAM_STALL');
                }
            }
        }, 1000);
    }

    public requestPayload(type: string): Promise<boolean> {
        const msg = createReqPayloadMessage(this.gameId, this.peer.id, type);
        const promise = this.ackTracker.waitForAck(msg.msgId);
        // Send AFTER registering the pending ACK to handle synchronous replies (mocks)
        this.sendToHost(msg);
        return promise;
    }

    private sendReqStateToCousins() {
        if (this.connManager.cousins.size > 0) {
            const cousinIds = Array.from(this.connManager.cousins.keys());
            // Randomly pick a cousin
            const targetId = cousinIds[Math.floor(Math.random() * cousinIds.length)];
            const cousinConn = this.connManager.cousins.get(targetId);

            if (cousinConn && cousinConn.open) {
                this.log(`[Node] Requesting state from cousin ${targetId}`);
                const reqState = createReqStateMessage(
                    this.gameId,
                    this.peer.id,
                    targetId,
                    this.stateManager.rainSeq,
                    this.lastGameSeq
                );
                cousinConn.send(reqState);
                this.lastReqStateTime = Date.now();
                this.reqStateCount++;
            }
        } else {
            // No cousins, request from host as fallback or request cousins
            if (Date.now() - this.lastReqStateTime > 5000) {
                this.log(`[Node] No cousins available, fallback state request to host`);
                const reqStateHost = createReqStateMessage(
                    this.gameId,
                    this.peer.id,
                    'HOST',
                    this.stateManager.rainSeq,
                    this.lastGameSeq
                );
                this.sendToHost(reqStateHost);
                this.lastReqStateTime = Date.now();
                this.reqStateCount++;
            }
        }
    }

    private requestRebind(reason: string) {
        if (!this.connManager.parent || !this.connManager.parent.open) return;

        // Calculate total subtree size (children + descendants)
        let totalDescendants = 0;
        this.childDescendants.forEach(list => totalDescendants += list.length);
        const totalSubtree = 1 + this.connManager.children.size + totalDescendants;

        const rebindReq: ProtocolMessage = {
            t: 'REBIND_REQUEST',
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv4(),
            dest: 'HOST',
            lastRainSeq: this.stateManager.rainSeq,
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
        const msg = createGameCmd(this.gameId, this.peer.id, type, data, ack);

        if (ack) {
            const promise = this.ackTracker.waitForAck(msg.msgId);
            // Send AFTER registering the pending ACK to handle synchronous replies (mocks)
            this.sendToHost(msg);
            return promise;
        }

        this.sendToHost(msg);
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
                parentId: this.connManager.parent?.peer || null,
                children: Array.from(this.connManager.children.keys()),
                rainSeq: this.stateManager.rainSeq,
                isAttached: this.stateManager.isAttached,
                depth: this.myDepth,
                state: this.stateManager.state
            });
        }
    }
}
