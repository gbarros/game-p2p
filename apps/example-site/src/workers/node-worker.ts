// Polyfill for PeerJS in Web Worker
if (typeof self !== 'undefined' && typeof window === 'undefined') {
    (self as any).window = self;
}

// Global type needed for the import to typecheck if not using 'any'
import type { Node as NodeClass } from '@game-p2p/protocol';
import { v4 as uuidv4 } from 'uuid';

// Type definitions for Worker messages
type ValidCommand = 'START' | 'STOP' | 'PING_HOST' | 'DISCONNECT';

interface WorkerCommand {
    type: ValidCommand;
    payload?: any;
}

let node: NodeClass | null = null;
let reportingInterval: NodeJS.Timeout | null = null;

const GAME_ID = 'simulation-game';
const SECRET = 'simulation-secret';

// Handle messages from the main thread
self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
    const { type, payload } = event.data;

    try {
        switch (type) {
            case 'START':
                if (!node) {
                    // Dynamic import to ensure polyfill applies first
                    const { Node } = await import('@game-p2p/protocol');
                    const { default: Peer } = await import('peerjs');

                    const peer = new Peer();
                    node = new Node(GAME_ID, SECRET, peer);
                    let bootstrapped = false;

                    // Hook into Node's internal state emission
                    node.subscribe((state: any) => {
                        self.postMessage({ type: 'STATE_UPDATE', payload: state });

                        // Strict sequencing: Only bootstrap once Peer is fully Open (has ID)
                        if (state.peerId && !bootstrapped) {
                            console.log(`[Worker] Peer Ready (${state.peerId}). Bootstrapping...`);
                            node!.bootstrap(payload.hostId);
                            bootstrapped = true;
                        }
                    });

                    // Periodic log of basic status
                    reportingInterval = setInterval(() => {
                        if (node && bootstrapped) {
                            self.postMessage({
                                type: 'STATUS_REPORT',
                                payload: {
                                    peerId: node.getPeerId(),
                                    alive: true
                                }
                            });
                        }
                    }, 5000);
                }
                break;

            case 'STOP':
                if (node) {
                    // Node doesn't have a 'destroy' method exposed, but we can stop reporting
                    // and let GC handle it, or we should add a cleanup method to Node.
                    // For now, we just nullify it to simulate "death".
                    // Ideally Node.ts should have a destroy/close method.
                    if (reportingInterval) clearInterval(reportingInterval);
                    node = null;
                    self.postMessage({ type: 'STOPPED' });
                }
                break;

            case 'PING_HOST':
                if (node) {
                    node.pingHost();
                }
                break;
        }
    } catch (err: any) {
        self.postMessage({ type: 'ERROR', payload: err.message });
    }
};
