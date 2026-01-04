export type EventHandler = (...args: unknown[]) => void;

class Emitter {
    private handlers: Map<string, Set<EventHandler>> = new Map();

    public on(event: string, handler: EventHandler) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event)!.add(handler);
        return this;
    }

    public off(event: string, handler?: EventHandler) {
        if (!this.handlers.has(event)) return this;
        if (!handler) {
            this.handlers.delete(event);
            return this;
        }
        this.handlers.get(event)!.delete(handler);
        return this;
    }

    public once(event: string, handler: EventHandler) {
        const wrapper: EventHandler = (...args: unknown[]) => {
            this.off(event, wrapper);
            handler(...args);
        };
        this.on(event, wrapper);
        return this;
    }

    public emit(event: string, ...args: unknown[]) {
        const handlers = this.handlers.get(event);
        if (!handlers) return false;
        handlers.forEach((handler) => handler(...args));
        return true;
    }
}

export class FakeDataConnection extends Emitter {
    public peer: string;
    public metadata: Record<string, unknown> | undefined;
    public open = false;
    public sent: unknown[] = [];
    public _other: FakeDataConnection | null = null;

    constructor(peer: string, metadata?: Record<string, unknown>) {
        super();
        this.peer = peer;
        this.metadata = metadata;
    }

    public send(data: unknown) {
        this.sent.push(data);
        if (!this.open || !this._other) return;
        this._other.emit('data', data);
    }

    public close() {
        if (!this.open) return;
        this.open = false;
        this.emit('close');
        if (this._other && this._other.open) {
            this._other.open = false;
            this._other.emit('close');
        }
    }
}

export class FakePeer extends Emitter {
    private static counter = 0;
    private static registry = new Map<string, FakePeer>();

    public id: string;
    public open = false;

    constructor(id?: string) {
        super();
        FakePeer.counter += 1;
        this.id = id || `peer-${FakePeer.counter}`;
        FakePeer.registry.set(this.id, this);

        setTimeout(() => {
            this.open = true;
            this.emit('open', this.id);
        }, 0);
    }

    public connect(peerId: string, options?: { metadata?: Record<string, unknown> }) {
        const remote = FakePeer.registry.get(peerId);
        if (!remote) {
            throw new Error(`Unknown peer: ${peerId}`);
        }

        const localConn = new FakeDataConnection(peerId, options?.metadata);
        const remoteConn = new FakeDataConnection(this.id, options?.metadata);
        localConn._other = remoteConn;
        remoteConn._other = localConn;

        setTimeout(() => {
            remote.emit('connection', remoteConn);
        }, 0);

        setTimeout(() => {
            localConn.open = true;
            remoteConn.open = true;
            localConn.emit('open');
            remoteConn.emit('open');
        }, 0);

        return localConn;
    }

    public destroy() {
        this.open = false;
        FakePeer.registry.delete(this.id);
        this.emit('close');
    }

    public static reset() {
        FakePeer.counter = 0;
        FakePeer.registry.clear();
    }
}

export function resetPeers() {
    FakePeer.reset();
}
