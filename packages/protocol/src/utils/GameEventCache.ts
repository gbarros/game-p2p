/**
 * Cache for game events with automatic eviction
 * Used for state recovery when nodes fall behind
 */
export class GameEventCache {
    private cache: Array<{ seq: number; event: { type: string; data: unknown } }> = [];
    private maxSize: number;

    constructor(maxSize: number = 50) {
        this.maxSize = maxSize;
    }

    /**
     * Add an event to the cache
     * @param seq Sequence number
     * @param event Event data
     */
    public add(seq: number, event: { type: string; data: unknown }): void {
        this.cache.push({ seq, event });

        // Auto-evict oldest if over size
        if (this.cache.length > this.maxSize) {
            this.cache.shift();
        }
    }

    /**
     * Get events after a specific sequence number
     * @param fromSeq Starting sequence (exclusive)
     * @returns Array of events with seq > fromSeq
     */
    public getEventsAfter(fromSeq: number): Array<{ seq: number; event: { type: string; data: unknown } }> {
        return this.cache.filter(e => e.seq > fromSeq);
    }

    /**
     * Get the minimum sequence number available in cache
     * @returns Minimum seq or 0 if cache is empty
     */
    public getMinSeq(): number {
        return this.cache.length > 0 ? this.cache[0].seq : 0;
    }

    /**
     * Check if cache has been truncated (missing events between fromSeq and oldest cached)
     * @param fromSeq Requested sequence
     * @returns true if there's a gap
     */
    public isTruncated(fromSeq: number): boolean {
        const minSeq = this.getMinSeq();
        return minSeq > (fromSeq + 1);
    }

    /**
     * Set maximum cache size and trim if needed
     */
    public setMaxSize(size: number): void {
        if (size < 0) {
            throw new Error('Cache size must be >= 0');
        }
        this.maxSize = size;

        // Trim existing cache if needed
        while (this.cache.length > this.maxSize) {
            this.cache.shift();
        }
    }

    /**
     * Get current cache size
     */
    public size(): number {
        return this.cache.length;
    }

    /**
     * Clear all cached events
     */
    public clear(): void {
        this.cache = [];
    }

    /**
     * Get all cached events
     */
    public getAll(): Array<{ seq: number; event: { type: string; data: unknown } }> {
        return [...this.cache];
    }
}
