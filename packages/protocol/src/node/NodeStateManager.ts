import { NodeState } from '../Node.js';

export class NodeStateManager {
    private _state: NodeState = NodeState.NORMAL;
    private _rainSeq: number = 0;
    private _lastRainTime: number = Date.now();
    private _lastParentRainTime: number = Date.now();
    private _patchStartTime: number = 0;
    private _isAttached: boolean = false;

    // Configuration
    private readonly STALL_THRESHOLD = 3000;

    constructor(private log: (msg: string) => void) { }

    public get state(): NodeState {
        return this._state;
    }

    public set state(s: NodeState) {
        this._state = s;
    }

    public get rainSeq(): number {
        return this._rainSeq;
    }

    public set rainSeq(seq: number) {
        this._rainSeq = seq;
    }

    public get lastRainTime(): number {
        return this._lastRainTime;
    }

    public get lastParentRainTime(): number {
        return this._lastParentRainTime;
    }

    public set lastParentRainTime(time: number) {
        this._lastParentRainTime = time;
    }

    public get patchStartTime(): number {
        return this._patchStartTime;
    }

    public set patchStartTime(time: number) {
        this._patchStartTime = time;
    }

    public get isAttached(): boolean {
        return this._isAttached;
    }

    public set isAttached(attached: boolean) {
        this._isAttached = attached;
    }

    public setAttached(attached: boolean) {
        this._isAttached = attached;
    }

    public processRain(rainSeq: number, fromParent: boolean = false): boolean {
        // If from parent, we always update seq if newer
        if (rainSeq > this._rainSeq) {
            this._rainSeq = rainSeq;
            this._lastRainTime = Date.now();

            if (fromParent) {
                this._lastParentRainTime = Date.now();

                // Recovery from non-normal state
                if (this._state !== NodeState.NORMAL) {
                    this.log(`[NodeStateManager] Received RAIN from parent, transitioning to NORMAL`);
                    this.transitionTo(NodeState.NORMAL);
                }
            }
            return true;
        }
        return false;
    }

    public transitionTo(newState: NodeState) {
        if (this._state === newState) return;

        this._state = newState;

        if (newState === NodeState.NORMAL) {
            this._patchStartTime = 0;
        } else if (newState === NodeState.PATCHING) {
            this._patchStartTime = Date.now();
        }
    }

    public checkStall(): boolean {
        if (!this._isAttached) return false;

        const timeSinceRain = Date.now() - this._lastParentRainTime;

        // 6.2 Local Detection Rule: SUSPECT_UPSTREAM after 3 seconds
        if (timeSinceRain > this.STALL_THRESHOLD && this._state === NodeState.NORMAL) {
            this.log(`[NodeStateManager] Upstream stall detected (${timeSinceRain}ms). Transitioning to SUSPECT_UPSTREAM`);
            this.transitionTo(NodeState.SUSPECT_UPSTREAM);
            return true;
        }
        return false;
    }

    public getHealthStatus(): 'HEALTHY' | 'DEGRADED' | 'OFFLINE' {
        if (!this._isAttached) return 'OFFLINE';
        const timeSinceRain = Date.now() - this._lastRainTime;
        if (timeSinceRain > 5000) return 'OFFLINE'; // > 5s no rain
        if (timeSinceRain > 2000) return 'DEGRADED'; // > 2s no rain
        return 'HEALTHY';
    }
}
