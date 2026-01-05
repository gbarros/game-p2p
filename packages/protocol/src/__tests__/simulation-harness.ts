import { vi } from 'vitest';
import type { Node as NodeClass } from '../Node.js';

export async function settleTimers(steps = 20, stepMs = 10) {
    for (let i = 0; i < steps; i += 1) {
        await vi.advanceTimersByTimeAsync(stepMs);
    }
}

export async function waitFor(
    condition: () => boolean,
    {
        timeoutMs = 10_000,
        stepMs = 50
    }: {
        timeoutMs?: number;
        stepMs?: number;
    } = {}
) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (condition()) return;
        await vi.advanceTimersByTimeAsync(stepMs);
    }
    throw new Error(`Timed out after ${timeoutMs}ms`);
}

export function bootstrapLikeWorker(node: NodeClass, hostId: string) {
    let bootstrapped = false;
    const states: any[] = [];

    node.subscribe((state: any) => {
        states.push(state);
        if (!bootstrapped && state.peerOpen) {
            node.bootstrap(hostId);
            bootstrapped = true;
        }
    });

    return {
        states,
        getLastState() {
            if (states.length === 0) throw new Error('No state captured');
            return states[states.length - 1];
        }
    };
}

