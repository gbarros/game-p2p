import { v4 as uuidv4 } from 'uuid';
import {
    AckMessage,
    ProtocolMessage,
    PeerId,
    GameEvent,
    StateMessage,
    CousinsMessage,
    ReqCousins,
    GameCmd
} from '../types.js';

/**
 * Utility functions for building protocol messages
 * Reduces boilerplate and ensures consistency
 */

/**
 * Reverse a path array for return routing
 * @param path Original path
 * @returns Reversed path
 */
export function reversePath(path: PeerId[] | undefined): PeerId[] {
    return path ? [...path].reverse() : [];
}

/**
 * Create an ACK message with reverse-path routing
 * @param gameId Game session ID
 * @param src Source peer ID
 * @param replyTo Message ID being acknowledged
 * @param dest Destination peer ID
 * @param incomingPath Original message path
 * @returns ACK message
 */
export function createAckMessage(
    gameId: string,
    src: PeerId,
    replyTo: string,
    dest: PeerId,
    incomingPath?: PeerId[]
): AckMessage {
    const reversedPath = reversePath(incomingPath);
    return {
        t: 'ACK',
        v: 1,
        gameId,
        src,
        msgId: uuidv4(),
        replyTo,
        dest,
        path: [src],
        route: [src, ...reversedPath]
    };
}

/**
 * Create a PONG message with reverse-path routing
 * @param gameId Game session ID
 * @param src Source peer ID
 * @param replyTo PING message ID
 * @param dest Destination peer ID
 * @param incomingPath Original PING path
 * @returns PONG message
 */
export function createPongMessage(
    gameId: string,
    src: PeerId,
    replyTo: string,
    dest: PeerId,
    incomingPath?: PeerId[]
): ProtocolMessage {
    const reversedPath = reversePath(incomingPath);
    return {
        t: 'PONG',
        v: 1,
        gameId,
        src,
        msgId: uuidv4(),
        replyTo,
        dest,
        path: [src],
        route: [src, ...reversedPath]
    };
}

/**
 * Create a STATE message for state recovery responses
 * @param gameId Game session ID
 * @param src Source peer ID
 * @param replyTo REQ_STATE message ID
 * @param dest Destination peer ID
 * @param latestRainSeq Current rain sequence
 * @param latestGameSeq Current game sequence
 * @param events Events to send
 * @param minGameSeqAvailable Minimum sequence in cache
 * @param truncated Whether cache was truncated
 * @param incomingPath Original request path
 * @returns STATE message
 */
export function createStateMessage(
    gameId: string,
    src: PeerId,
    replyTo: string,
    dest: PeerId,
    latestRainSeq: number,
    latestGameSeq: number,
    events: Array<{ seq: number; event: { type: string; data: unknown } }>,
    minGameSeqAvailable: number,
    truncated: boolean,
    incomingPath?: PeerId[]
): StateMessage {
    const reversedPath = reversePath(incomingPath);
    return {
        t: 'STATE',
        v: 1,
        gameId,
        src,
        msgId: uuidv4(),
        replyTo,
        dest,
        latestRainSeq,
        latestGameSeq,
        events,
        minGameSeqAvailable,
        truncated,
        path: [src],
        route: [src, ...reversedPath]
    };
}

/**
 * Create a GAME_EVENT message
 * @param gameId Game session ID
 * @param src Source peer ID
 * @param gameSeq Game sequence number
 * @param type Event type
 * @param data Event data
 * @param dest Optional destination peer ID
 * @param ack Whether to request acknowledgment
 * @returns GAME_EVENT message
 */
export function createGameEvent(
    gameId: string,
    src: PeerId,
    gameSeq: number,
    type: string,
    data: unknown,
    dest?: PeerId,
    ack?: boolean
): GameEvent {
    return {
        t: 'GAME_EVENT',
        v: 1,
        gameId,
        src,
        msgId: uuidv4(),
        gameSeq,
        event: { type, data },
        dest,
        path: [src],
        ack
    };
}

/**
 * Add current peer to message path (for forwarding)
 * @param msg Message to update
 * @param peerId Current peer ID
 * @returns Updated message with peer added to path
 */
export function addToPath<T extends ProtocolMessage>(msg: T, peerId: PeerId): T {
    const currentPath = msg.path ? [...msg.path] : [];
    if (!currentPath.includes(peerId)) {
        currentPath.push(peerId);
    }
    return { ...msg, path: currentPath };
}

/**
 * Create a COUSINS message response
 * @param gameId Game session ID
 * @param src Source peer ID
 * @param replyTo REQ_COUSINS message ID
 * @param dest Destination peer ID
 * @param candidates Array of cousin candidate peer IDs
 * @param incomingPath Original request path
 * @returns COUSINS message
 */
export function createCousinsMessage(
    gameId: string,
    src: PeerId,
    replyTo: string,
    dest: PeerId,
    candidates: string[],
    incomingPath?: PeerId[]
): CousinsMessage {
    const reversedPath = reversePath(incomingPath);
    return {
        t: 'COUSINS',
        v: 1,
        gameId,
        src,
        msgId: uuidv4(),
        replyTo,
        dest,
        candidates,
        path: [src],
        route: [src, ...reversedPath]
    };
}

/**
 * Create a REQ_COUSINS message
 * @param gameId Game session ID
 * @param src Source peer ID
 * @param requesterDepth Requester's depth in tree
 * @param desiredCount Number of cousins desired
 * @returns REQ_COUSINS message
 */
export function createReqCousinsMessage(
    gameId: string,
    src: PeerId,
    requesterDepth: number,
    desiredCount: number = 2
): ReqCousins {
    return {
        t: 'REQ_COUSINS',
        v: 1,
        gameId,
        src,
        msgId: uuidv4(),
        requesterDepth,
        desiredCount,
        path: [src]
    };
}

/**
 * Create a REQ_STATE message
 * @param gameId Game session ID
 * @param src Source peer ID
 * @param dest Destination peer ID
 * @param fromRainSeq Starting rain sequence
 * @param fromGameSeq Starting game sequence
 * @returns REQ_STATE message
 */
export function createReqStateMessage(
    gameId: string,
    src: PeerId,
    dest: PeerId,
    fromRainSeq: number,
    fromGameSeq: number
): ProtocolMessage {
    return {
        t: 'REQ_STATE',
        v: 1,
        gameId,
        src,
        msgId: uuidv4(),
        dest,
        fromRainSeq,
        fromGameSeq,
        path: [src]
    };
}

/**
 * Create a GAME_CMD message (upstream game commands)
 * @param gameId Game session ID
 * @param src Source peer ID
 * @param type Command type
 * @param data Command data
 * @param ack Whether to request acknowledgment
 * @returns GAME_CMD message
 */
export function createGameCmd(
    gameId: string,
    src: PeerId,
    type: string,
    data: unknown,
    ack: boolean = false
): GameCmd {
    return {
        t: 'GAME_CMD',
        v: 1,
        gameId,
        src,
        msgId: uuidv4(),
        cmd: { type, data },
        dest: 'HOST',
        path: [src],
        ack
    };
}

/**
 * Create a REQ_PAYLOAD message
 * @param gameId Game session ID
 * @param src Source peer ID
 * @param payloadType Type of payload being requested
 * @returns REQ_PAYLOAD message
 */
export function createReqPayloadMessage(
    gameId: string,
    src: PeerId,
    payloadType: string
): ProtocolMessage {
    return {
        t: 'REQ_PAYLOAD',
        v: 1,
        gameId,
        src,
        msgId: uuidv4(),
        dest: 'HOST',
        payloadType,
        path: [src]
    };
}
