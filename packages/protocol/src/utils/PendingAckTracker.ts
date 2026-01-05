/**
 * Tracks pending ACKs for messages requiring acknowledgment
 * Provides Promise-based async waiting with timeout
 */
export class PendingAckTracker {
    private pendingAcks: Map<string, {
        resolve: (value: boolean) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    }> = new Map();

    private readonly defaultTimeout: number;

    constructor(defaultTimeout: number = 10000) {
        this.defaultTimeout = defaultTimeout;
    }

    /**
     * Create a promise that waits for an ACK
     * @param msgId Message ID to wait for
     * @param timeoutMs Optional timeout override
     * @returns Promise that resolves when ACK received or rejects on timeout
     */
    public waitForAck(msgId: string, timeoutMs?: number): Promise<boolean> {
        const timeout = timeoutMs ?? this.defaultTimeout;

        return new Promise<boolean>((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                this.pendingAcks.delete(msgId);
                reject(new Error(`ACK timeout for message ${msgId}`));
            }, timeout);

            this.pendingAcks.set(msgId, { resolve, reject, timeout: timeoutHandle });
        });
    }

    /**
     * Resolve a pending ACK
     * @param msgId Message ID that was acknowledged
     * @returns true if ACK was pending, false if not found
     */
    public resolve(msgId: string): boolean {
        const pending = this.pendingAcks.get(msgId);
        if (!pending) {
            return false;
        }

        clearTimeout(pending.timeout);
        pending.resolve(true);
        this.pendingAcks.delete(msgId);
        return true;
    }

    /**
     * Reject a pending ACK with an error
     * @param msgId Message ID to reject
     * @param error Error to reject with
     * @returns true if ACK was pending, false if not found
     */
    public reject(msgId: string, error: Error): boolean {
        const pending = this.pendingAcks.get(msgId);
        if (!pending) {
            return false;
        }

        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pendingAcks.delete(msgId);
        return true;
    }

    /**
     * Clear all pending ACKs and reject their promises
     * @param error Error to reject with (default: "Tracker cleared")
     */
    public clear(error?: Error): void {
        const err = error || new Error('Tracker cleared');
        this.pendingAcks.forEach((pending) => {
            clearTimeout(pending.timeout);
            pending.reject(err);
        });
        this.pendingAcks.clear();
    }

    /**
     * Get count of pending ACKs
     */
    public size(): number {
        return this.pendingAcks.size;
    }

    /**
     * Check if an ACK is pending
     */
    public isPending(msgId: string): boolean {
        return this.pendingAcks.has(msgId);
    }
}
