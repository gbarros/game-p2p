import Peer, { DataConnection } from 'peerjs';
import { ProtocolMessage } from '../types.js';

export class NodeConnectionManager {
    private _parent: DataConnection | null = null;
    private _children: Map<string, DataConnection> = new Map();
    private _cousins: Map<string, DataConnection> = new Map();

    constructor(
        private peer: Peer,
        private log: (msg: string) => void
    ) { }

    public get parent(): DataConnection | null {
        return this._parent;
    }

    public set parent(conn: DataConnection | null) {
        this._parent = conn;
    }

    public get children(): Map<string, DataConnection> {
        return this._children;
    }

    public get cousins(): Map<string, DataConnection> {
        return this._cousins;
    }

    public setParent(conn: DataConnection | null) {
        this._parent = conn;
    }

    public addChild(conn: DataConnection) {
        this._children.set(conn.peer, conn);
    }

    public addCousin(conn: DataConnection) {
        this._cousins.set(conn.peer, conn);
    }

    public removeConnection(peerId: string) {
        if (this._parent && this._parent.peer === peerId) {
            this._parent = null;
        }
        this._children.delete(peerId);
        this._cousins.delete(peerId);
    }

    public broadcast(msg: ProtocolMessage) {
        this._children.forEach(c => {
            if (c.open) c.send(msg);
        });
    }

    public sendToParent(msg: ProtocolMessage) {
        if (this._parent && this._parent.open) {
            this._parent.send(msg);
        } else {
            this.log(`[NodeConnectionManager] Cannot send to parent - not connected`);
        }
    }

    public routeReply(msg: ProtocolMessage, sourceConn: DataConnection) {
        if (!msg.route || msg.route.length === 0) {
            sourceConn.send(msg);
            return;
        }

        const myIndex = msg.route.indexOf(this.peer.id);
        let nextHopId: string;

        if (myIndex === -1) {
            nextHopId = msg.route[0];
        } else if (myIndex < msg.route.length - 1) {
            nextHopId = msg.route[myIndex + 1];
        } else {
            return;
        }

        let targetConn: DataConnection | null = null;

        if (this._parent && this._parent.peer === nextHopId) {
            targetConn = this._parent;
        } else if (this._children.has(nextHopId)) {
            targetConn = this._children.get(nextHopId)!;
        } else if (this._cousins.has(nextHopId)) {
            targetConn = this._cousins.get(nextHopId)!;
        }

        if (targetConn && targetConn.open) {
            targetConn.send(msg);
        } else if (sourceConn.open) {
            this.log(`[NodeConnectionManager] Cannot route reply - next hop ${nextHopId} not connected. Fallback to source.`);
            sourceConn.send(msg);
        }
    }
}
