import Peer from 'peerjs';

type PeerId = string;
type GameId = string;
type MsgId = string;
interface BaseMessage {
    t: string;
    v: number;
    gameId: GameId;
    src: PeerId;
    msgId: MsgId;
    seq?: number;
    replyTo?: MsgId;
    path?: PeerId[];
    route?: PeerId[];
    dest?: PeerId;
    ack?: boolean;
}
interface JoinRequest extends BaseMessage {
    t: 'JOIN_REQUEST';
    secret: string;
    clientInfo?: Record<string, unknown>;
}
interface JoinAccept extends BaseMessage {
    t: 'JOIN_ACCEPT';
    playerId: PeerId;
    payload: {
        type: string;
        data: unknown;
    };
    seeds: PeerId[];
    keepAlive: boolean;
    rainSeq: number;
    gameSeq: number;
}
interface JoinReject extends BaseMessage {
    t: 'JOIN_REJECT';
    reason: string;
}
interface AttachRequest extends BaseMessage {
    t: 'ATTACH_REQUEST';
    wantRole: 'CHILD';
    depth: number;
}
interface AttachAccept extends BaseMessage {
    t: 'ATTACH_ACCEPT';
    parentId: PeerId;
    level: number;
    cousinCandidates: PeerId[];
    childrenMax: number;
    childrenUsed: number;
}
interface AttachReject extends BaseMessage {
    t: 'ATTACH_REJECT';
    reason: string;
    redirect: PeerId[];
    depthHint: number;
}
interface RainMessage extends BaseMessage {
    t: 'RAIN';
    rainSeq: number;
}
interface ReqState extends BaseMessage {
    t: 'REQ_STATE';
    fromRainSeq: number;
    fromGameSeq: number;
}
interface StateMessage extends BaseMessage {
    t: 'STATE';
    latestRainSeq: number;
    latestGameSeq: number;
    events?: {
        seq: number;
        event: GameEvent['event'];
    }[];
    minGameSeqAvailable?: number;
    truncated?: boolean;
}
interface ReqCousins extends BaseMessage {
    t: 'REQ_COUSINS';
    requesterDepth: number;
    desiredCount: number;
}
interface CousinsMessage extends BaseMessage {
    t: 'COUSINS';
    candidates: PeerId[];
}
interface SubtreeStatus extends BaseMessage {
    t: 'SUBTREE_STATUS';
    lastRainSeq: number;
    state: 'OK' | 'SUSPECT' | 'PARTITIONED' | 'OFFLINE';
    children: {
        id: PeerId;
        state: string;
        lastRainSeq: number;
        freeSlots: number;
    }[];
    subtreeCount: number;
    descendants: {
        id: PeerId;
        hops: number;
        freeSlots: number;
    }[];
    freeSlots: number;
}
interface RebindRequest extends BaseMessage {
    t: 'REBIND_REQUEST';
    lastRainSeq: number;
    lastGameSeq: number;
    subtreeCount: number;
    reason: string;
}
interface RebindAssign extends BaseMessage {
    t: 'REBIND_ASSIGN';
    newParentCandidates: PeerId[];
    priority: 'TRY_IN_ORDER';
}
interface GameEvent extends BaseMessage {
    t: 'GAME_EVENT';
    gameSeq: number;
    event: {
        type: string;
        data: unknown;
    };
}
interface GameCmd extends BaseMessage {
    t: 'GAME_CMD';
    cmd: {
        type: string;
        data: unknown;
    };
}
interface GameAck extends BaseMessage {
    t: 'GAME_ACK';
    ok: boolean;
}
interface ReqPayload extends BaseMessage {
    t: 'REQ_PAYLOAD';
    payloadType: string;
}
interface PayloadMessage extends BaseMessage {
    t: 'PAYLOAD';
    payloadType: string;
    data: unknown;
}
interface PingMessage extends BaseMessage {
    t: 'PING';
}
interface PongMessage extends BaseMessage {
    t: 'PONG';
}
interface AckMessage extends BaseMessage {
    t: 'ACK';
}
type ProtocolMessage = JoinRequest | JoinAccept | JoinReject | AttachRequest | AttachAccept | AttachReject | RainMessage | ReqState | StateMessage | ReqCousins | CousinsMessage | SubtreeStatus | RebindRequest | RebindAssign | GameEvent | GameCmd | GameAck | ReqPayload | PayloadMessage | PingMessage | PongMessage | AckMessage;

declare class Host {
    private peer;
    private gameId;
    private secret;
    private rainSeq;
    private gameSeq;
    private qrSeq;
    private children;
    private rainInterval;
    private topology;
    private pendingAcks;
    private onGameEventCallback;
    private gameEventCache;
    private readonly MAX_CACHE_SIZE;
    private recentMsgIds;
    private readonly MAX_MSG_ID_CACHE;
    constructor(gameId: string, secret: string, peer: Peer);
    private handleConnection;
    private removeFromTopology;
    private handleMessage;
    private handleSubtreeStatus;
    private routeMessage;
    /**
     * Compute the full routing path from host to a target node
     * This is needed for multi-hop forwarding
     */
    private computeRoutePath;
    private getSmartSeeds;
    private weightedShuffle;
    private simpleShuffle;
    private getSmartRedirects;
    private startRain;
    private broadcast;
    getPeerId(): string;
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
    getConnectionString(): {
        v: number;
        gameId: string;
        secret: string;
        hostId: string;
        seeds: string[];
        qrSeq: number;
        latestRainSeq?: number;
        latestGameSeq?: number;
        mode?: string;
    };
    /**
     * Register callback for incoming game events from nodes
     */
    onGameEventReceived(callback: (type: string, data: unknown, from: string) => void): void;
    /**
     * Broadcast a game event to all connected nodes
     */
    broadcastGameEvent(type: string, data: unknown): void;
    /**
     * Send a message to a specific peer
     * @param peerId Target peer ID
     * @param type Message type
     * @param data Message data
     * @param ack If true, returns Promise that resolves when ACK received
     */
    sendToPeer(peerId: string, type: string, data: unknown, ack?: boolean): void | Promise<boolean>;
    private onStateChange;
    subscribe(callback: (state: any) => void): void;
    private emitState;
}

declare enum NodeState {
    NORMAL = "NORMAL",
    SUSPECT_UPSTREAM = "SUSPECT_UPSTREAM",
    PATCHING = "PATCHING",
    REBINDING = "REBINDING",
    WAITING_FOR_HOST = "WAITING_FOR_HOST"
}
declare class Node {
    private peer;
    private gameId;
    private secret;
    private parent;
    private seeds;
    private children;
    private childDescendants;
    private childCapacities;
    private MAX_CHILDREN;
    private rainSeq;
    private lastRainTime;
    private isAttached;
    private subtreeInterval;
    private myDepth;
    private state;
    private patchStartTime;
    private _paused;
    private _logger;
    private pendingPings;
    private pendingAcks;
    private onGameEvent;
    private cousins;
    private lastGameSeq;
    private gameEventCache;
    private MAX_CACHE_SIZE;
    private lastParentRainTime;
    private stallDetectionInterval;
    private lastReqStateTime;
    private reqStateTarget;
    private reqStateCount;
    private readonly MAX_ATTACH_ATTEMPTS;
    private readonly MAX_REDIRECT_DEPTH;
    private attachAttempts;
    private redirectDepth;
    private lastAttachTime;
    private attachRetryTimer;
    private authAttempts;
    private descendantToNextHop;
    private descendantsCount;
    private recentMsgIds;
    private readonly MAX_MSG_ID_CACHE;
    constructor(gameId: string, secret: string, peer: Peer, logger?: (msg: string) => void);
    setLogger(logger: (msg: string) => void): void;
    togglePause(paused: boolean): void;
    isPaused(): boolean;
    getHealthStatus(): 'HEALTHY' | 'DEGRADED' | 'OFFLINE';
    /**
     * Configure the game event cache size
     * @param size Number of events to cache (default: 20)
     */
    setGameEventCacheSize(size: number): void;
    close(): void;
    private log;
    private hostId;
    bootstrap(hostId: string): void;
    private authenticateWithHost;
    private attemptAttachToNetwork;
    private scheduleAttachRetry;
    private handleAttachResponse;
    private shuffleArray;
    private handleMessage;
    private startSubtreeReporting;
    private reportSubtree;
    private handleIncomingConnection;
    private handleIncomingAttach;
    private handleRebindAssign;
    private broadcast;
    private routeMessageToTarget;
    private routeReply;
    sendToHost(msg: ProtocolMessage): void;
    pingHost(): void;
    private requestCousins;
    private connectToCousin;
    private startStallDetection;
    requestPayload(type: string): Promise<boolean>;
    private sendReqStateToCousins;
    private requestRebind;
    getPeerId(): string;
    /**
     * Register callback for incoming game events
     */
    onGameEventReceived(callback: (type: string, data: unknown, from: string) => void): void;
    /**
     * Send a game command to the Host (upstream messages use GAME_CMD)
     * @param type Command type
     * @param data Command data
     * @param ack If true, returns Promise that resolves when ACK received
     */
    sendGameEvent(type: string, data: unknown, ack?: boolean): void | Promise<boolean>;
    private onStateChange;
    subscribe(callback: (state: any) => void): void;
    private emitState;
}

declare const VERSION = "1.0.0";

export { type AckMessage, type AttachAccept, type AttachReject, type AttachRequest, type BaseMessage, type CousinsMessage, type GameAck, type GameCmd, type GameEvent, type GameId, Host, type JoinAccept, type JoinReject, type JoinRequest, type MsgId, Node, NodeState, type PayloadMessage, type PeerId, type PingMessage, type PongMessage, type ProtocolMessage, type RainMessage, type RebindAssign, type RebindRequest, type ReqCousins, type ReqPayload, type ReqState, type StateMessage, type SubtreeStatus, VERSION };
