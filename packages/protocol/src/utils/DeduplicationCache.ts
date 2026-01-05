/**
 * Message deduplication cache
 * Tracks recently seen message IDs to prevent duplicate processing
 */
export class DeduplicationCache {
    private recentMsgIds: Set<string> = new Set();
    private readonly maxSize: number;
    private readonly cleanupPercentage: number;

    constructor(maxSize: number = 100, cleanupPercentage: number = 0.2) {
        this.maxSize = maxSize;
        this.cleanupPercentage = cleanupPercentage;
    }

    /**
     * Check if a message ID has been seen before
     * @param msgId Message ID to check
     * @returns true if this is a duplicate, false if new
     */
    public isDuplicate(msgId: string): boolean {
        if (this.recentMsgIds.has(msgId)) {
            return true;
        }

        this.recentMsgIds.add(msgId);

        // Batch cleanup when threshold exceeded
        if (this.recentMsgIds.size > this.maxSize) {
            this.cleanup();
        }

        return false;
    }

    /**
     * Clean up oldest entries (removes configured percentage)
     */
    private cleanup(): void {
        const toRemove = Math.floor(this.maxSize * this.cleanupPercentage);
        const iterator = this.recentMsgIds.values();

        for (let i = 0; i < toRemove; i++) {
            const item = iterator.next().value;
            if (item !== undefined) {
                this.recentMsgIds.delete(item);
            }
        }
    }

    /**
     * Clear all cached message IDs
     */
    public clear(): void {
        this.recentMsgIds.clear();
    }

    /**
     * Get current cache size
     */
    public size(): number {
        return this.recentMsgIds.size;
    }
}
