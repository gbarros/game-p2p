'use client';

import React from 'react';

interface TopologyNode {
    id: string;
    depth: number;
    nextHop: string;
    freeSlots: number;
}

interface HostTopologyTreeProps {
    hostId: string;
    children: string[]; // Direct L1 children
    topology: TopologyNode[]; // Full topology from Host
}

export function HostTopologyTree({ hostId, children, topology }: HostTopologyTreeProps) {
    // Build hierarchical tree from flat topology data
    // Host is root (depth 0)
    // L1 children are in `children` array (depth 1)
    // L2+ are in `topology` with their nextHop pointing to their parent

    const getDepthColor = (depth: number): string => {
        const colors = ['text-purple-400', 'text-blue-400', 'text-green-400', 'text-yellow-400', 'text-orange-400', 'text-red-400'];
        return colors[Math.min(depth, colors.length - 1)];
    };

    // Render a single node
    const renderNode = (id: string, depth: number, isHost: boolean = false): React.ReactNode => {
        // Find children of this node
        const nodeChildren = topology.filter(n => n.nextHop === id && n.depth === depth + 1);
        // For L1 nodes, their children are in topology with depth 2 and nextHop = hostId (the L1's id)
        // Actually nextHop for L2 should be the L1 id, not host id. Let me reconsider.

        // Actually `nextHop` for any node is "which L1 child leads to it" from Host's perspective.
        // So L2 nodes have nextHop = their L1 parent, but L3 nodes also have nextHop = L1 (not L2).
        // This makes it hard to build a true tree from Host's perspective alone.

        // Simpler approach: group by depth and show as levels

        return (
            <div key={id} style={{ marginLeft: depth * 24 }} className="py-0.5">
                <span className={`font-mono text-xs ${getDepthColor(depth)}`}>
                    {isHost ? '🏠 ' : '├─ '}
                    <span className="font-bold">{id.slice(0, 12)}...</span>
                    <span className="text-gray-500 ml-2">L{depth}</span>
                </span>
            </div>
        );
    };

    // Since Host topology only knows nextHop (L1 that routes to node), 
    // we'll show a simplified view: Host → L1s → L2s grouped by L1
    const l1Nodes = children;
    const l2PlusNodes = topology.filter(n => n.depth >= 2);

    return (
        <div className="bg-gray-800 p-3 rounded border border-purple-500/50">
            <h4 className="text-purple-400 font-bold text-sm mb-2">🌳 Host Virtual Tree</h4>

            {/* Host (root) */}
            <div className="font-mono text-xs text-purple-400 font-bold">
                🏠 {hostId ? `${hostId.slice(0, 12)}...` : 'Initializing...'} <span className="text-gray-500">L0 (Host)</span>
            </div>

            {/* L1 Children (direct) */}
            {l1Nodes.length > 0 ? (
                <div className="ml-4 border-l border-gray-700 pl-2 mt-1">
                    {l1Nodes.map(childId => {
                        // Find L2+ nodes that route through this L1
                        const descendants = l2PlusNodes.filter(n => n.nextHop === childId);

                        return (
                            <div key={childId}>
                                <div className="font-mono text-xs text-blue-400 py-0.5">
                                    ├─ <span className="font-bold">{childId.slice(0, 12)}...</span>
                                    <span className="text-gray-500 ml-2">L1</span>
                                    {descendants.length > 0 && (
                                        <span className="text-gray-600 ml-1">({descendants.length} descendants)</span>
                                    )}
                                </div>

                                {/* L2+ descendants under this L1 */}
                                {descendants.length > 0 && (
                                    <div className="ml-4 border-l border-gray-700 pl-2">
                                        {descendants.map(desc => (
                                            <div key={desc.id} className="font-mono text-xs py-0.5" style={{ color: getDepthColor(desc.depth).replace('text-', '') }}>
                                                <span className={getDepthColor(desc.depth)}>
                                                    ├─ <span className="font-bold">{desc.id.slice(0, 12)}...</span>
                                                    <span className="text-gray-500 ml-2">L{desc.depth}</span>
                                                    <span className="text-gray-600 ml-1">(slots: {desc.freeSlots})</span>
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="ml-4 text-gray-600 text-xs italic mt-1">No children yet</div>
            )}

            {/* Legend */}
            <div className="mt-3 pt-2 border-t border-gray-700 flex gap-3 text-xs">
                <span className="text-purple-400">●L0</span>
                <span className="text-blue-400">●L1</span>
                <span className="text-green-400">●L2</span>
                <span className="text-yellow-400">●L3+</span>
            </div>
        </div>
    );
}
