/**
 * Array utility functions for protocol
 */

/**
 * Fisher-Yates shuffle algorithm
 * @param array Array to shuffle
 * @returns New shuffled array
 */
export function shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Weighted shuffle - items earlier in array have higher probability of staying near front
 * Useful for prioritizing shallow/high-capacity nodes while maintaining randomness
 * @param array Array to shuffle
 * @returns Weighted shuffled array
 */
export function weightedShuffle<T>(array: T[]): T[] {
    const result: T[] = [];
    const weights = array.map((_, i) => Math.max(1, array.length - i));
    const remaining = [...array];

    while (remaining.length > 0) {
        const totalWeight = weights.slice(0, remaining.length).reduce((a, b) => a + b, 0);
        let random = Math.random() * totalWeight;
        let selectedIndex = 0;

        for (let i = 0; i < remaining.length; i++) {
            random -= weights[i];
            if (random <= 0) {
                selectedIndex = i;
                break;
            }
        }

        result.push(remaining.splice(selectedIndex, 1)[0]);
    }

    return result;
}
