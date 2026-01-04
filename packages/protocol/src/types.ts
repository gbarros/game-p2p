export type PeerId = string;
export type GameId = string;
export type MsgId = string;

// --- Message Types ---

export interface BaseMessage {
    t: string;
    v: number;
    gameId: GameId;
    src: PeerId;
    msgId: MsgId;
    seq?: number;
    replyTo?: MsgId;
    path?: PeerId[];      // Path tracing (who has touched this message) - trace only, NOT for routing
    route?: PeerId[];     // Explicit routing path (full path from host to target for host-originated unicast)
    dest?: PeerId;        // Destination node ID. 'HOST' for Host, specific ID, or undefined for local-only
    ack?: boolean;        // If true, receiver should send ACK back
}

// 9.1 Bootstrap & Join

export interface JoinRequest extends BaseMessage {
    t: 'JOIN_REQUEST';
    secret: string;
    clientInfo?: Record<string, unknown>;
}

export interface JoinAccept extends BaseMessage {
    t: 'JOIN_ACCEPT';
    playerId: PeerId;
    payload: { type: string; data: unknown };
    seeds: PeerId[]; // Restored for Step A optimization
    keepAlive: boolean; // Optimization: Stay connected if Host has space
    rainSeq: number;
    gameSeq: number;
}

export interface JoinReject extends BaseMessage {
    t: 'JOIN_REJECT';
    reason: string;
}

export interface AttachRequest extends BaseMessage {
    t: 'ATTACH_REQUEST';
    wantRole: 'CHILD';
    depth: number;
}

export interface AttachAccept extends BaseMessage {
    t: 'ATTACH_ACCEPT';
    parentId: PeerId;
    level: number;
    cousinCandidates: PeerId[];
    childrenMax: number;
    childrenUsed: number;
}

export interface AttachReject extends BaseMessage {
    t: 'ATTACH_REJECT';
    reason: string;
    redirect: PeerId[]; // Smart redirect candidates
    depthHint: number;
}

// 9.2 Heartbeat & Health

export interface RainMessage extends BaseMessage {
    t: 'RAIN';
    rainSeq: number;
}

export interface ReqState extends BaseMessage {
    t: 'REQ_STATE';
    fromRainSeq: number;
    fromGameSeq: number;
}

export interface StateMessage extends BaseMessage {
    t: 'STATE';
    latestRainSeq: number;
    latestGameSeq: number;
    events?: { seq: number; event: GameEvent['event'] }[];
    minGameSeqAvailable?: number;
    truncated?: boolean;
}

export interface ReqCousins extends BaseMessage {
    t: 'REQ_COUSINS';
    requesterDepth: number;
    desiredCount: number;
}

export interface CousinsMessage extends BaseMessage {
    t: 'COUSINS';
    candidates: PeerId[];
}

export interface SubtreeStatus extends BaseMessage {
    t: 'SUBTREE_STATUS';
    lastRainSeq: number;
    state: 'OK' | 'SUSPECT' | 'PARTITIONED' | 'OFFLINE';
    children: { id: PeerId; state: string; lastRainSeq: number; freeSlots: number }[];
    subtreeCount: number;
    // List of all nodes in subtree with their distance from this node
    descendants: { id: PeerId; hops: number; freeSlots: number }[];
    freeSlots: number;
}

// 9.3 Repair / Rebalance

export interface RebindRequest extends BaseMessage {
    t: 'REBIND_REQUEST';
    lastRainSeq: number;
    lastGameSeq: number;
    subtreeCount: number;
    reason: string;
}

export interface RebindAssign extends BaseMessage {
    t: 'REBIND_ASSIGN';
    newParentCandidates: PeerId[];
    priority: 'TRY_IN_ORDER';
}

// 9.4 Game-Generic Messaging

export interface GameEvent extends BaseMessage {
    t: 'GAME_EVENT';
    gameSeq: number;
    event: {
        type: string;
        data: unknown;
    };
}

export interface GameCmd extends BaseMessage {
    t: 'GAME_CMD';
    cmd: { type: string; data: unknown };
}

export interface GameAck extends BaseMessage {
    t: 'GAME_ACK';
    ok: boolean;
}

// 9.5 Heavy Payload

export interface ReqPayload extends BaseMessage {
    t: 'REQ_PAYLOAD';
    payloadType: string;
}

export interface PayloadMessage extends BaseMessage {
    t: 'PAYLOAD';
    payloadType: string;
    data: unknown;
}

// 9.6 Debug / Ping / Ack

export interface PingMessage extends BaseMessage {
    t: 'PING';
}

export interface PongMessage extends BaseMessage {
    t: 'PONG';
}

export interface AckMessage extends BaseMessage {
    t: 'ACK';
}

export type ProtocolMessage =
    | JoinRequest
    | JoinAccept
    | JoinReject
    | AttachRequest
    | AttachAccept
    | AttachReject
    | RainMessage
    | ReqState
    | StateMessage
    | ReqCousins
    | CousinsMessage
    | SubtreeStatus
    | RebindRequest
    | RebindAssign
    | GameEvent
    | GameCmd
    | GameAck
    | ReqPayload
    | PayloadMessage
    | PingMessage
    | PongMessage
    | AckMessage;
