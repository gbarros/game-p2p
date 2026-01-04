'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Node, NodeState } from '@game-p2p/protocol';
import Peer from 'peerjs';
import { v4 as uuidv4 } from 'uuid';
import { TopologyTree } from './TopologyTree';

interface NodeConfig {
    id: string; // Internal simulator ID
    peerId: string; // The PeerJS ID we want for this node
}

interface SimulatorNodeState {
    role: 'NODE' | 'HOST';
    peerId: string;
    peerOpen: boolean;
    parentId: string | null;
    children: string[];
    rainSeq: number;
    isAttached: boolean;
    depth: number;
    state: NodeState;
}

interface MetaNode {
    config: NodeConfig;
    instance: Node | null; // Null if "killed" (offline)
    state: SimulatorNodeState | null;
    logs: string[];
    status: 'ONLINE' | 'DEAD';
}

const GAME_ID = 'game-1';
const SECRET = 'secret-1';

export default function LocalSimulatorPage() {
    const [nodes, setNodes] = useState<MetaNode[]>([]);
    const [hostId, setHostId] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const nodesRef = useRef<MetaNode[]>([]);

    // Keep ref in sync
    useEffect(() => {
        nodesRef.current = nodes;
    }, [nodes]);

    const logSystem = useCallback((msg: string) => {
        const time = new Date().toLocaleTimeString();
        setLogs(prev => [`[${time}] ${msg}`, ...prev].slice(0, 100));
    }, []);

    // Create a new node instance for a given MetaNode config
    const createNodeInstance = useCallback((config: NodeConfig) => {
        const logger = (msg: string) => {
            const time = new Date().toLocaleTimeString();
            setNodes(prev => prev.map(n => {
                if (n.config.id === config.id) {
                    return { ...n, logs: [...n.logs, `[${time}] ${msg}`].slice(-50) };
                }
                return n;
            }));
            console.log(`[${config.peerId}][${time}] ${msg}`);
        };

        // Pass existing peerId to constructor to ensure identity persistence
        const peer = new Peer(config.peerId, {
            // host: 'localhost',
            // port: 9000,
            // path: '/',
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            },
            debug: 2
        });
        const node = new Node(GAME_ID, SECRET, peer, logger);

        let hasBootstrapped = false;

        // CRITICAL: Register subscribe IMMEDIATELY after Node construction
        // to avoid missing the initial state emission if peer opens quickly
        node.subscribe((data: any) => {
            const state = data as SimulatorNodeState;
            console.log('Node subscribe called', config.peerId, data);
            if (state.peerOpen && !hasBootstrapped) {
                hasBootstrapped = true;
                logSystem(`Node ${state.peerId.slice(0, 8)} ready, bootstrapping...`);
                node.bootstrap(hostId);
            }

            setNodes(prev => prev.map(n => {
                if (n.config.id === config.id) {
                    return { ...n, state: data as SimulatorNodeState, peerId: (data as SimulatorNodeState).peerId };
                }
                return n;
            }));
        });

        return node;
    }, [hostId, logSystem]);

    const addNode = useCallback(() => {
        if (!hostId) {
            alert('Please enter a Host ID first');
            return;
        }

        const id = uuidv4();
        // Pre-generate a Peer ID so we can persist it across kill/revive
        const peerId = uuidv4();

        const config: NodeConfig = { id, peerId };
        const instance = createNodeInstance(config);

        const newMetaNode: MetaNode = {
            config,
            instance,
            state: null,
            logs: [],
            status: 'ONLINE'
        };

        setNodes(prev => [...prev, newMetaNode]);
        logSystem(`Created Node ${peerId.slice(0, 8)}`);
    }, [hostId, logSystem, createNodeInstance]);

    const removeNode = useCallback((id: string) => {
        const node = nodesRef.current.find(n => n.config.id === id);
        if (node && node.instance) {
            node.instance.close();
        }
        setNodes(prev => prev.filter(n => n.config.id !== id));
        logSystem(`Removed Node ${id.slice(0, 8)}`);
    }, [logSystem]);

    // "Kill" = destroy instance but keep MetaNode
    const killNode = useCallback((id: string) => {
        setNodes(prev => prev.map(n => {
            if (n.config.id === id) {
                if (n.instance) {
                    n.instance.close();
                }
                logSystem(`Killed Node ${n.config.peerId.slice(0, 8)} (Simulated Crash)`);
                // When killed, we keep the last known state but mark as detached/offline
                const deadState = n.state ? { ...n.state, isAttached: false } : null;
                return { ...n, instance: null, status: 'DEAD', state: deadState };
            }
            return n;
        }));
    }, [logSystem]);

    // "Revive" = recreate instance with same ID
    const reviveNode = useCallback((id: string) => {
        const node = nodesRef.current.find(n => n.config.id === id);
        if (!node) return;

        logSystem(`Reviving Node ${node.config.peerId.slice(0, 8)}...`);
        const newInstance = createNodeInstance(node.config);

        setNodes(prev => prev.map(n => {
            if (n.config.id === id) {
                return { ...n, instance: newInstance, status: 'ONLINE' };
            }
            return n;
        }));
    }, [createNodeInstance, logSystem]);

    const pingHost = useCallback((id: string) => {
        const node = nodesRef.current.find(n => n.config.id === id);
        if (node && node.instance) {
            node.instance.pingHost();
            logSystem(`Node ${node.config.peerId.slice(0, 8)} sent PING`);
        }
    }, [logSystem]);

    const togglePause = useCallback((id: string) => {
        const node = nodesRef.current.find(n => n.config.id === id);
        if (node && node.instance) {
            const isPaused = node.instance.isPaused();
            node.instance.togglePause(!isPaused);
            logSystem(`Node ${node.config.peerId.slice(0, 8)} ${!isPaused ? 'PAUSED' : 'RESUMED'}`);
            setNodes(prev => [...prev]);
        }
    }, [logSystem]);

    const burstNodes = useCallback((count: number) => {
        for (let i = 0; i < count; i++) {
            setTimeout(() => addNode(), i * 300);
        }
    }, [addNode]);

    const killAll = useCallback(() => {
        nodesRef.current.forEach(n => n.instance?.close());
        setNodes([]);
        logSystem('Removed all nodes');
    }, [logSystem]);

    return (
        <div className="p-6 font-sans w-full max-w-[1800px] mx-auto bg-gray-900 min-h-screen text-white">
            <h1 className="text-3xl font-bold mb-6 text-blue-400">🔬 Local Network Simulator</h1>

            {/* Controls - Full Width */}
            <div className="mb-6 p-4 bg-gray-800 rounded-lg flex flex-wrap gap-4 items-end">
                <div>
                    <label className="block text-sm font-semibold mb-1 text-gray-300">Target Host ID</label>
                    <input
                        type="text"
                        value={hostId}
                        onChange={e => {
                            // Sanitize: trim whitespace and remove any leading colons
                            const sanitized = e.target.value.trim().replace(/^:+/, '');
                            setHostId(sanitized);
                        }}
                        className="p-2 border border-gray-600 rounded w-80 bg-gray-700 text-white font-mono text-sm"
                        placeholder="Paste Host Peer ID from main tab"
                    />
                </div>
                <button
                    onClick={addNode}
                    className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
                >
                    ➕ Add Node
                </button>
                <button
                    onClick={() => burstNodes(5)}
                    className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 transition"
                >
                    🚀 Burst (5)
                </button>
                <button
                    onClick={() => burstNodes(10)}
                    className="bg-orange-600 text-white px-4 py-2 rounded hover:bg-orange-700 transition"
                >
                    💥 Swarm (10)
                </button>
                <button
                    onClick={killAll}
                    className="bg-red-700 text-white px-4 py-2 rounded hover:bg-red-600 transition"
                >
                    ☠️ Remove All
                </button>
                <div className="ml-auto text-sm text-gray-400">
                    Nodes: <span className="text-white font-bold">{nodes.length}</span>
                </div>
            </div>

            {/* Topology - Full Width */}
            <div className="mb-6">
                <TopologyTree
                    hostId={hostId}
                    nodes={nodes.map(n => ({
                        id: n.config.id,
                        peerId: n.config.peerId,
                        state: n.state
                    }))}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={setSelectedNodeId}
                    onPingNode={pingHost}
                    onKillNode={killNode}
                />
            </div>

            {/* Two-column layout for Nodes and Logs */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                {/* Nodes List - Takes 2 columns */}
                <div className="xl:col-span-2">
                    <h2 className="text-xl font-semibold mb-4 text-green-400">
                        Active Nodes ({nodes.length})
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[500px] overflow-y-auto pr-2">
                        {nodes.map(node => (
                            <div key={node.config.id} className={`p-3 border rounded-lg text-sm transition-all ${node.status === 'DEAD'
                                ? 'bg-red-900/20 border-red-900'
                                : 'bg-gray-800 border-gray-700'
                                } ${selectedNodeId === node.config.id ? 'ring-2 ring-blue-500' : ''}`}>

                                <div className="flex justify-between items-start mb-2">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <div className={`font-bold font-mono truncate ${node.status === 'DEAD' ? 'text-red-500 line-through' : 'text-blue-400'}`}>
                                                {node.config.peerId.slice(0, 14)}...
                                            </div>
                                            {node.status !== 'DEAD' && node.instance && (
                                                <div title={`Health: ${node.instance.getHealthStatus()}`}>
                                                    {node.instance.getHealthStatus() === 'HEALTHY' && '💚'}
                                                    {node.instance.getHealthStatus() === 'DEGRADED' && '💛'}
                                                    {node.instance.getHealthStatus() === 'OFFLINE' && '❤️'}
                                                </div>
                                            )}
                                        </div>

                                        {node.state && node.status !== 'DEAD' && (
                                            <div className="text-xs mt-1 space-y-0.5">
                                                <div>
                                                    <span className="text-gray-400">Depth:</span>{' '}
                                                    <span className="text-yellow-400">{node.state.depth ?? '?'}</span>
                                                    {' | '}
                                                    <span className="text-gray-400">Kids:</span>{' '}
                                                    <span className="text-cyan-400">{node.state.children?.length || 0}</span>
                                                </div>
                                                <div>
                                                    {node.state.isAttached ? (
                                                        <span className="text-green-400">✓ Attached</span>
                                                    ) : (
                                                        <span className="text-orange-400">⏳ Pending</span>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        {node.status === 'DEAD' && (
                                            <div className="text-xs text-red-400 mt-1 font-bold">OFFLINE (KILLED)</div>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => removeNode(node.config.id)}
                                        className="text-gray-500 hover:text-red-400 text-xs px-1"
                                        title="Remove completely"
                                    >
                                        ✕
                                    </button>
                                </div>

                                <div className="flex gap-1 mt-2">
                                    {node.status === 'ONLINE' && node.instance ? (
                                        <>
                                            <button
                                                onClick={() => pingHost(node.config.id)}
                                                className="bg-gray-700 hover:bg-gray-600 px-2 py-0.5 text-xs rounded transition flex-1"
                                            >
                                                📡 Ping
                                            </button>
                                            <button
                                                onClick={() => togglePause(node.config.id)}
                                                className={`${node.instance.isPaused() ? 'bg-yellow-700 hover:bg-yellow-600' : 'bg-gray-700 hover:bg-gray-600'} px-2 py-0.5 text-xs rounded transition flex-1`}
                                            >
                                                {node.instance.isPaused() ? '▶ Run' : '⏸ Pause'}
                                            </button>
                                            <button
                                                onClick={() => killNode(node.config.id)}
                                                className="bg-red-800 hover:bg-red-700 px-2 py-0.5 text-xs rounded transition flex-1"
                                                title="Simulate Crash (Kill Process)"
                                            >
                                                ☠️ Kill
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            onClick={() => reviveNode(node.config.id)}
                                            className="bg-green-700 hover:bg-green-600 px-2 py-1 text-xs rounded transition flex-1 font-bold"
                                        >
                                            ♻️ REVIVE (Restart Process)
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                        {nodes.length === 0 && (
                            <div className="col-span-full text-gray-500 italic p-4 text-center border border-dashed border-gray-700 rounded">
                                No nodes running. Add some!
                            </div>
                        )}
                    </div>
                </div>

                {/* Logs - Takes 1 column */}
                <div>
                    <h2 className="text-xl font-semibold mb-4 text-green-400 flex justify-between items-center">
                        <span>📋 {selectedNodeId ? 'Node Logs' : 'System Logs'}</span>
                        {selectedNodeId && (
                            <button
                                onClick={() => setSelectedNodeId(null)}
                                className="text-xs bg-gray-700 px-2 py-1 rounded hover:bg-gray-600 text-white"
                            >
                                Show System
                            </button>
                        )}
                    </h2>
                    <div className="bg-black text-green-400 p-3 rounded h-[500px] overflow-y-auto font-mono text-xs border border-gray-700 flex flex-col-reverse">
                        {(selectedNodeId
                            ? (nodes.find(n => n.config.id === selectedNodeId)?.logs || [])
                            : logs
                        ).length === 0 ? (
                            <div className="text-gray-600 italic mt-auto">Logs will appear here...</div>
                        ) : (
                            (selectedNodeId
                                ? (nodes.find(n => n.config.id === selectedNodeId)?.logs || [])
                                : logs
                            ).map((log, i) => <div key={i} className="py-0.5 border-b border-gray-900 break-words">{log}</div>)
                        )}
                    </div>
                    {selectedNodeId && (
                        <div className="mt-2 text-xs text-gray-400">
                            Viewing logs for selected node. Click "Show System" or deselect node to view global logs.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
