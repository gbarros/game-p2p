/**
 * Connection rate limiter
 * Prevents spam and DoS by limiting connection attempts per peer
 */
export class RateLimiter {
    private connectionAttempts: Map<string, number[]> = new Map();
    private cleanupInterval: NodeJS.Timeout | null = null;
    private readonly rateLimit: number;
    private readonly timeWindow: number;
    private readonly cleanupIntervalMs: number;

    constructor(
        rateLimit: number = 5,
        timeWindow: number = 10000,
        cleanupIntervalMs: number = 30000
    ) {
        this.rateLimit = rateLimit;
        this.timeWindow = timeWindow;
        this.cleanupIntervalMs = cleanupIntervalMs;
    }

    /**
     * Start periodic cleanup of old connection attempts
     */
    public startCleanup(): void {
        if (this.cleanupInterval) return;

        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            this.connectionAttempts.forEach((attempts, peerId) => {
                const recent = attempts.filter(t => now - t < this.timeWindow);
                if (recent.length === 0) {
                    this.connectionAttempts.delete(peerId);
                } else {
                    this.connectionAttempts.set(peerId, recent);
                }
            });
        }, this.cleanupIntervalMs);
    }

    /**
     * Stop cleanup interval
     */
    public stopCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    /**
     * Check if a connection attempt should be allowed
     * @param peerId Peer attempting to connect
     * @returns true if allowed, false if rate limit exceeded
     */
    public allowConnection(peerId: string): boolean {
        const now = Date.now();
        const attempts = this.connectionAttempts.get(peerId) || [];
        const recentAttempts = attempts.filter(t => now - t < this.timeWindow);

        if (recentAttempts.length >= this.rateLimit) {
            return false;
        }

        // Track this attempt
        recentAttempts.push(now);
        this.connectionAttempts.set(peerId, recentAttempts);

        return true;
    }

    /**
     * Get current attempt count for a peer
     */
    public getAttemptCount(peerId: string): number {
        const now = Date.now();
        const attempts = this.connectionAttempts.get(peerId) || [];
        return attempts.filter(t => now - t < this.timeWindow).length;
    }

    /**
     * Clear all tracked attempts
     */
    public clear(): void {
        this.connectionAttempts.clear();
    }
}
