'use client';

import { useState, useEffect, useRef } from 'react';
import { Host, Node } from '@game-p2p/protocol';
import Peer from 'peerjs';
import { HostTopologyTree } from './components/HostTopologyTree';

export default function Home() {
  const [mode, setMode] = useState<'NONE' | 'HOST' | 'JOIN'>('NONE');
  const [gameId, setGameId] = useState('game-1');
  const [secret, setSecret] = useState('secret-1');
  const [hostId, setHostId] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [myPeerId, setMyPeerId] = useState<string>('');

  const hostRef = useRef<Host | null>(null);
  const nodeRef = useRef<Node | null>(null);
  const [nodeState, setNodeState] = useState<any>(null); // For visualization

  const addLog = (msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  // Override console.log to capture protocol logs
  useEffect(() => {
    const originalLog = console.log;
    console.log = (...args) => {
      originalLog(...args);
      // Filter for protocol logs if needed, or just capture everything relevant
      addLog(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };
    return () => {
      console.log = originalLog;
    };
  }, []);

  const startHost = () => {
    addLog('Starting Host...');
    try {
      const peerId = `host-${crypto.randomUUID()}`;
      const peer = new Peer(peerId, {
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
      const host = new Host(gameId, secret, peer);
      hostRef.current = host;

      // Subscribe to state
      host.subscribe((state) => setNodeState(state));

      // Wait a bit for peer to open (Host class logs 'Host Open')
      setTimeout(() => {
        setMyPeerId(host.getPeerId());
      }, 1000);
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    }
  };

  const joinGame = () => {
    if (!hostId) {
      addLog('Error: Host Peer ID required');
      return;
    }
    addLog(`Joining game as Peer... target Host: ${hostId}`);
    try {
      const peer = new Peer({
        host: 'localhost',
        port: 9000,
        path: '/',
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });
      const node = new Node(gameId, secret, peer);
      nodeRef.current = node;

      // Subscribe to state
      node.subscribe((state) => setNodeState(state));

      node.bootstrap(hostId);

      // Wait for ID to be available
      if (node.getPeerId()) {
        setMyPeerId(node.getPeerId());
      } else {
        // It might be async if node is waiting for open
        const interval = setInterval(() => {
          if (node.getPeerId()) {
            setMyPeerId(node.getPeerId());
            clearInterval(interval);
          }
        }, 500);
      }
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    }
  };

  return (
    <main className="min-h-screen p-8 bg-gray-900 text-gray-100 font-mono">
      <h1 className="text-3xl font-bold mb-8 text-blue-400">Game P2P Overlay Protocol</h1>

      <div className="mb-8 p-4 bg-gray-800 rounded border border-gray-700">
        <h2 className="text-xl mb-4">Configuration</h2>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Game ID</label>
            <input
              className="w-full bg-gray-900 border border-gray-600 p-2 rounded"
              value={gameId} onChange={e => setGameId(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Secret</label>
            <input
              className="w-full bg-gray-900 border border-gray-600 p-2 rounded"
              value={secret} onChange={e => setSecret(e.target.value)}
            />
          </div>
        </div>

        <div className="flex gap-4">
          <button
            onClick={() => setMode('HOST')}
            className={`px-4 py-2 rounded ${mode === 'HOST' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
          >
            Host Game
          </button>
          <button
            onClick={() => setMode('JOIN')}
            className={`px-4 py-2 rounded ${mode === 'JOIN' ? 'bg-green-600' : 'bg-gray-700 hover:bg-gray-600'}`}
          >
            Join Game
          </button>
        </div>
      </div>

      {mode === 'HOST' && (
        <div className="mb-8 p-4 bg-blue-900/20 border border-blue-800 rounded">
          <h2 className="text-xl mb-4 text-blue-300">Host Mode</h2>
          {!hostRef.current ? (
            <button
              onClick={startHost}
              className="bg-blue-600 hover:bg-blue-500 px-6 py-2 rounded font-bold"
            >
              Start Hosting
            </button>
          ) : (
            <div className="space-y-2">
              <div className="p-2 bg-blue-900/50 rounded">
                <span className="text-gray-400">My Peer ID:</span>
                <span className="ml-2 font-bold text-white select-all">{myPeerId || 'Initializing...'}</span>
              </div>
              <p className="text-sm text-green-400">Host running. Waiting for connections...</p>
            </div>
          )}
        </div>
      )}

      {mode === 'JOIN' && (
        <div className="mb-8 p-4 bg-green-900/20 border border-green-800 rounded">
          <h2 className="text-xl mb-4 text-green-300">Join Mode</h2>
          {!nodeRef.current ? (
            <div className="flex gap-4">
              <input
                placeholder="Enter Host Peer ID"
                className="flex-1 bg-gray-900 border border-gray-600 p-2 rounded"
                value={hostId} onChange={e => setHostId(e.target.value)}
              />
              <button
                onClick={joinGame}
                className="bg-green-600 hover:bg-green-500 px-6 py-2 rounded font-bold"
              >
                Connect
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="p-2 bg-green-900/50 rounded">
                <span className="text-gray-400">My Peer ID:</span>
                <span className="ml-2 font-bold text-white">{myPeerId || 'Initializing...'}</span>
              </div>
              <p className="text-sm text-green-400">Node running. Check logs for status.</p>
              <button
                onClick={() => nodeRef.current?.pingHost()}
                className="mt-2 bg-yellow-600 hover:bg-yellow-500 px-4 py-1 rounded text-sm text-white font-bold"
              >
                Ping Host
              </button>
            </div>
          )}
        </div>
      )}

      <div className="p-4 bg-black rounded border border-gray-800 h-96 overflow-y-auto font-mono text-xs">
        <div className="flex justify-between mb-2 sticky top-0 bg-black pb-2 border-b border-gray-800">
          <span className="font-bold text-gray-500">SYSTEM LOGS</span>
          <button onClick={() => setLogs([])} className="text-gray-500 hover:text-white">Clear</button>
        </div>
        {logs.map((log, i) => (
          <div key={i} className="mb-1 border-b border-gray-900 pb-1 last:border-0 text-gray-300 break-all">
            {log}
          </div>
        ))}
      </div>

      {/* Visualization Panel */}
      {nodeState && (
        <div className="fixed bottom-8 right-8 w-96 bg-gray-900 border-2 border-purple-500 rounded p-4 shadow-xl max-h-[70vh] overflow-y-auto">
          <h3 className="text-purple-400 font-bold mb-3">Network Topology</h3>

          {/* Host mode: show full topology tree */}
          {mode === 'HOST' && nodeState.topology && (
            <HostTopologyTree
              hostId={nodeState.peerId}
              children={nodeState.children || []}
              topology={nodeState.topology || []}
            />
          )}

          {/* Node mode: show simple parent/children info */}
          {mode === 'JOIN' && (
            <div className="text-xs space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-400">Role:</span>
                <span className="font-bold text-white">{nodeState.role}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Depth:</span>
                <span className="font-bold text-yellow-400">L{nodeState.depth || '?'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">RAIN Seq:</span>
                <span className="font-bold text-yellow-400">{nodeState.rainSeq}</span>
              </div>

              {nodeState.parentId && (
                <div className="border-t border-gray-700 pt-2 mt-2">
                  <div className="text-gray-400 mb-1">Parent:</div>
                  <div className="bg-gray-800 p-1 rounded font-mono truncate text-green-300">
                    {nodeState.parentId}
                  </div>
                </div>
              )}

              <div className="border-t border-gray-700 pt-2 mt-2">
                <div className="flex justify-between mb-1">
                  <span className="text-gray-400">My Children:</span>
                  <span className="text-white font-bold">{nodeState.children?.length || 0}</span>
                </div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {(nodeState.children || []).map((child: string) => (
                    <div key={child} className="bg-gray-800 p-1 rounded font-mono truncate text-blue-300">
                      {child}
                    </div>
                  ))}
                  {(!nodeState.children || nodeState.children.length === 0) && <span className="text-gray-600 italic">No children</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

    </main>
  );
}
