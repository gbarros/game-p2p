'use client';

import React, { useMemo, useState } from 'react';

interface NodeState {
    peerId: string | null;
    parentId: string | null;
    depth: number;
    children: string[];
    isAttached: boolean;
}

interface SimulatedNode {
    id: string;
    peerId: string | null;
    state: NodeState | null;
}

interface TopologyTreeProps {
    hostId: string;
    nodes: SimulatedNode[];
    selectedNodeId: string | null;
    onSelectNode: (id: string | null) => void;
    onPingNode: (id: string) => void;
    onKillNode: (id: string) => void;
}

interface TreeNode {
    id: string;
    peerId: string;
    depth: number;
    childCount: number;
    children: TreeNode[];
}

export function TopologyTree({ hostId, nodes, selectedNodeId, onSelectNode, onPingNode, onKillNode }: TopologyTreeProps) {
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);

    // Build a proper tree structure from flat nodes list
    const tree = useMemo(() => {
        const attachedNodes = nodes.filter(n => n.state?.isAttached && n.peerId);

        // Find L1 nodes (direct host children)
        const l1Nodes = attachedNodes.filter(n => n.state?.depth === 1);

        // Recursive function to build tree
        const buildSubtree = (node: SimulatedNode): TreeNode => {
            const children = attachedNodes.filter(n => n.state?.parentId === node.peerId);
            return {
                id: node.id,
                peerId: node.peerId!,
                depth: node.state?.depth || 0,
                childCount: node.state?.children?.length || 0,
                children: children.map(c => buildSubtree(c))
            };
        };

        return l1Nodes.map(n => buildSubtree(n));
    }, [nodes]);

    const depthColors: Record<number, string> = {
        1: 'text-blue-400',
        2: 'text-cyan-400',
        3: 'text-purple-400',
        4: 'text-pink-400',
        5: 'text-orange-400',
    };

    // Render a tree node recursively
    const renderNode = (node: TreeNode, isLast: boolean, depth: number): React.ReactNode => {
        const color = depthColors[node.depth] || 'text-gray-400';
        const isSelected = selectedNodeId === node.id;
        const isHovered = hoveredNode === node.id;
        const indent = depth * 24; // pixels per level

        return (
            <div key={node.id}>
                <div
                    className={`
                        flex items-center gap-2 py-1 px-2 rounded cursor-pointer transition-all
                        ${isSelected ? 'bg-blue-900/50 ring-1 ring-blue-500' : ''}
                        ${isHovered && !isSelected ? 'bg-gray-700/50' : ''}
                    `}
                    style={{ marginLeft: `${indent}px` }}
                    onClick={() => onSelectNode(isSelected ? null : node.id)}
                    onMouseEnter={() => setHoveredNode(node.id)}
                    onMouseLeave={() => setHoveredNode(null)}
                >
                    {/* Tree connector */}
                    <span className="text-gray-600 font-mono text-xs w-4">
                        {isLast ? '└' : '├'}
                    </span>

                    {/* Node info */}
                    <span className={`${color} font-mono`}>
                        L{node.depth}
                    </span>
                    <span className="text-gray-300 font-mono">
                        {node.peerId.slice(0, 10)}...
                    </span>

                    {node.childCount > 0 && (
                        <span className="text-gray-500 text-xs">
                            ({node.childCount} kids)
                        </span>
                    )}

                    {/* Inline controls on hover/select */}
                    {(isHovered || isSelected) && (
                        <div className="flex gap-1 ml-auto">
                            <button
                                onClick={(e) => { e.stopPropagation(); onPingNode(node.id); }}
                                className="bg-gray-600 hover:bg-gray-500 px-2 py-0.5 text-xs rounded"
                                title="Ping Host"
                            >
                                📡
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); onKillNode(node.id); }}
                                className="bg-red-800 hover:bg-red-700 px-2 py-0.5 text-xs rounded"
                                title="Kill Node"
                            >
                                ☠️
                            </button>
                        </div>
                    )}
                </div>

                {/* Render children */}
                {node.children.map((child, idx) =>
                    renderNode(child, idx === node.children.length - 1, depth + 1)
                )}
            </div>
        );
    };

    const attachedCount = nodes.filter(n => n.state?.isAttached).length;
    const pendingCount = nodes.filter(n => !n.state?.isAttached).length;

    return (
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            <div className="flex justify-between items-center mb-3">
                <h2 className="text-lg font-semibold text-green-400">🌳 Network Topology</h2>
                <div className="text-sm">
                    <span className="text-green-400">{attachedCount} attached</span>
                    {pendingCount > 0 && (
                        <span className="text-orange-400 ml-3">{pendingCount} pending</span>
                    )}
                </div>
            </div>

            <div className="font-mono text-sm bg-gray-900 rounded p-3 min-h-[200px] max-h-[500px] overflow-auto">
                {attachedCount > 0 ? (
                    <div>
                        {/* Host node */}
                        <div className="flex items-center gap-2 py-1 px-2 text-yellow-400 font-bold">
                            <span className="text-lg">🏠</span>
                            <span>Host: {hostId.slice(0, 14)}...</span>
                            <span className="text-gray-500 text-xs font-normal">
                                ({tree.length} L1 children)
                            </span>
                        </div>

                        {/* Tree nodes */}
                        {tree.length > 0 ? (
                            tree.map((node, idx) => renderNode(node, idx === tree.length - 1, 1))
                        ) : (
                            <div className="text-gray-500 ml-8 py-2">No L1 children yet...</div>
                        )}
                    </div>
                ) : (
                    <div className="text-gray-500 italic text-center py-8">
                        No attached nodes yet. Add some nodes above!
                    </div>
                )}
            </div>

            {/* Legend */}
            <div className="mt-3 flex gap-4 text-xs text-gray-500">
                <span><span className="text-blue-400">●</span> L1</span>
                <span><span className="text-cyan-400">●</span> L2</span>
                <span><span className="text-purple-400">●</span> L3</span>
                <span><span className="text-pink-400">●</span> L4</span>
                <span className="ml-auto text-gray-600">Click node to select • Hover for controls</span>
            </div>
        </div>
    );
}
