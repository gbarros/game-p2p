// src/Host.ts
import { v4 as uuidv4 } from "uuid";
var Host = class {
  constructor(gameId, secret, peer) {
    this.rainSeq = 0;
    this.gameSeq = 0;
    this.qrSeq = 0;
    this.children = /* @__PURE__ */ new Map();
    this.rainInterval = null;
    // Virtual Tree / Topology Map
    this.topology = /* @__PURE__ */ new Map();
    // ACK tracking for guaranteed delivery
    this.pendingAcks = /* @__PURE__ */ new Map();
    // Game event callback
    this.onGameEventCallback = null;
    // Game event cache for STATE responses (fallback for L1 nodes or when cousins unavailable)
    this.gameEventCache = [];
    this.MAX_CACHE_SIZE = 20;
    // Deduplication
    this.recentMsgIds = /* @__PURE__ */ new Set();
    this.MAX_MSG_ID_CACHE = 100;
    // UI helper
    this.onStateChange = null;
    this.gameId = gameId;
    this.secret = secret;
    this.peer = peer;
    this.peer.on("open", (id) => {
      console.log("Host Open:", id);
      this.startRain();
      this.emitState();
    });
    this.peer.on("error", (err) => {
      console.error("[Host] Peer Error:", err);
    });
    this.peer.on("connection", (conn) => {
      this.handleConnection(conn);
    });
  }
  handleConnection(conn) {
    const meta = conn.metadata;
    console.log("New connection:", conn.peer, meta);
    if (!meta || meta.gameId !== this.gameId || meta.secret !== this.secret) {
      console.warn(`[Host] Rejecting connection from ${conn.peer}: Invalid Metadata`, meta);
      conn.close();
      return;
    }
    conn.on("data", (data) => {
      this.handleMessage(conn, data);
    });
    conn.on("open", () => {
      console.log("New connection:", conn.peer);
    });
    conn.on("error", (err) => {
      console.error(`[Host] Connection error with ${conn.peer}:`, err);
    });
    conn.on("close", () => {
      console.log(`[Host] Connection closed: ${conn.peer}`);
      this.children.delete(conn.peer);
      this.removeFromTopology(conn.peer);
      this.emitState();
    });
  }
  removeFromTopology(l1PeerId) {
    for (const [id, node] of this.topology.entries()) {
      if (node.nextHop === l1PeerId) {
        this.topology.delete(id);
      }
    }
  }
  handleMessage(conn, msg) {
    if (msg.gameId !== this.gameId) {
      console.warn(`[Host] Rejecting message from ${msg.src}: gameId mismatch`);
      return;
    }
    if (this.recentMsgIds.has(msg.msgId)) {
      return;
    }
    this.recentMsgIds.add(msg.msgId);
    if (this.recentMsgIds.size > this.MAX_MSG_ID_CACHE) {
      const iterator = this.recentMsgIds.values();
      const first = iterator.next().value;
      if (first !== void 0) this.recentMsgIds.delete(first);
    }
    switch (msg.t) {
      case "PING":
        console.log(`[Host] PING from ${msg.src} path=${JSON.stringify(msg.path)}`);
        const reversePath = msg.path ? [...msg.path].reverse() : [msg.src];
        console.log(`[Host] Constructed reverse route: ${JSON.stringify(reversePath)}`);
        this.routeMessage(msg.src, {
          t: "PONG",
          v: 1,
          gameId: this.gameId,
          src: this.peer.id,
          msgId: uuidv4(),
          replyTo: msg.msgId,
          dest: msg.src,
          path: [this.peer.id],
          route: [this.peer.id, ...reversePath]
        });
        break;
      case "ACK":
        console.log(`[Host] ACK from ${msg.src} for msg ${msg.replyTo}`);
        if (msg.replyTo && this.pendingAcks.has(msg.replyTo)) {
          const pending = this.pendingAcks.get(msg.replyTo);
          clearTimeout(pending.timeout);
          pending.resolve(true);
          this.pendingAcks.delete(msg.replyTo);
        }
        break;
      case "GAME_CMD":
        console.log(`[Host] GAME_CMD from ${msg.src}: ${msg.cmd?.type}`);
        if (msg.ack) {
          this.routeMessage(msg.src, {
            t: "ACK",
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv4(),
            replyTo: msg.msgId,
            dest: msg.src,
            path: msg.path || []
          });
        }
        if (this.onGameEventCallback && msg.cmd) {
          this.onGameEventCallback(msg.cmd.type, msg.cmd.data, msg.src);
        }
        break;
      case "GAME_EVENT":
        console.log(`[Host] GAME_EVENT from ${msg.src}: ${msg.event?.type}`);
        if (msg.ack) {
          this.routeMessage(msg.src, {
            t: "ACK",
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv4(),
            replyTo: msg.msgId,
            dest: msg.src,
            path: msg.path || []
          });
        }
        if (this.onGameEventCallback && msg.event) {
          this.onGameEventCallback(msg.event.type, msg.event.data, msg.src);
        }
        break;
      case "REQ_PAYLOAD":
        console.log(`[Host] REQ_PAYLOAD from ${msg.src}: ${msg.payloadType}`);
        const payloadData = msg.payloadType === "INITIAL_STATE" ? { info: "Initial state payload" } : { info: "Generic payload" };
        this.routeMessage(msg.src, {
          t: "PAYLOAD",
          v: 1,
          gameId: this.gameId,
          src: this.peer.id,
          msgId: uuidv4(),
          replyTo: msg.msgId,
          dest: msg.src,
          payloadType: msg.payloadType,
          data: payloadData,
          path: [this.peer.id]
        });
        console.log(`[Host] Sent PAYLOAD response to ${msg.src}`);
        break;
      case "REBIND_REQUEST":
        console.log(`[Host] REBIND_REQUEST from ${msg.src} (reason: ${msg.reason})`);
        const rebindCandidates = this.getSmartRedirects().slice(0, 3);
        const rebindAssign = {
          t: "REBIND_ASSIGN",
          v: 1,
          gameId: this.gameId,
          src: this.peer.id,
          msgId: uuidv4(),
          replyTo: msg.msgId,
          dest: msg.src,
          newParentCandidates: rebindCandidates,
          priority: "TRY_IN_ORDER",
          path: []
        };
        this.routeMessage(msg.src, rebindAssign);
        break;
      case "SUBTREE_STATUS":
        this.handleSubtreeStatus(conn, msg);
        break;
      case "JOIN_REQUEST":
        console.log(`[Host] Accepted join from ${conn.peer}`);
        const hasSpace = this.children.size < 5;
        const seeds = this.getSmartSeeds();
        const accept = {
          t: "JOIN_ACCEPT",
          v: 1,
          gameId: this.gameId,
          src: this.peer.id,
          msgId: uuidv4(),
          playerId: uuidv4(),
          payload: { type: "INITIAL_STATE", data: { msg: "Welcome to the game" } },
          seeds,
          keepAlive: hasSpace,
          rainSeq: this.rainSeq,
          gameSeq: this.gameSeq,
          path: [this.peer.id]
        };
        conn.send(accept);
        if (hasSpace) {
          console.log(`[Host] Promoting ${conn.peer} to L1 child`);
          this.children.set(conn.peer, conn);
          this.topology.set(conn.peer, { nextHop: conn.peer, depth: 1, lastSeen: Date.now(), freeSlots: 3, state: "OK" });
          this.emitState();
        } else {
          console.log(`[Host] Host full, providing seeds to ${conn.peer} and disconnecting`);
          setTimeout(() => conn.close(), 100);
        }
        break;
      case "ATTACH_REQUEST":
        console.log(`[Host] ATTACH_REQUEST from ${conn.peer}`);
        if (this.children.size >= 5) {
          const reject = {
            t: "ATTACH_REJECT",
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv4(),
            reason: "FULL",
            redirect: this.getSmartRedirects(),
            depthHint: 1,
            path: [this.peer.id]
          };
          conn.send(reject);
        } else {
          this.children.set(conn.peer, conn);
          this.topology.set(conn.peer, { nextHop: conn.peer, depth: 1, lastSeen: Date.now(), freeSlots: 3, state: "OK" });
          this.emitState();
          const accept2 = {
            t: "ATTACH_ACCEPT",
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv4(),
            parentId: this.peer.id,
            level: 0,
            cousinCandidates: [],
            childrenMax: 5,
            childrenUsed: this.children.size,
            path: [this.peer.id]
          };
          conn.send(accept2);
        }
        break;
      case "REQ_STATE":
        console.log(`[Host] REQ_STATE from ${msg.src} (fromGameSeq: ${msg.fromGameSeq})`);
        const eventsToSend = this.gameEventCache.filter((e) => e.seq > msg.fromGameSeq).map((e) => ({ seq: e.seq, event: e.event }));
        const minSeqInCache = this.gameEventCache.length > 0 ? this.gameEventCache[0].seq : 0;
        const truncated = minSeqInCache > msg.fromGameSeq + 1;
        const reversePathForState = [...msg.path || []].reverse();
        this.routeMessage(msg.src, {
          t: "STATE",
          v: 1,
          gameId: this.gameId,
          src: this.peer.id,
          msgId: uuidv4(),
          replyTo: msg.msgId,
          dest: msg.src,
          latestRainSeq: this.rainSeq,
          latestGameSeq: this.gameSeq,
          events: eventsToSend,
          minGameSeqAvailable: minSeqInCache,
          truncated,
          path: [this.peer.id],
          route: [this.peer.id, ...reversePathForState]
        });
        break;
    }
  }
  handleSubtreeStatus(conn, msg) {
    const nextHop = conn.peer;
    this.topology.set(nextHop, {
      nextHop,
      depth: 1,
      lastSeen: Date.now(),
      freeSlots: msg.freeSlots,
      // This is the child's own capacity
      state: "OK"
    });
    if (msg.descendants && msg.descendants.length > 0) {
      msg.descendants.forEach((d) => {
        this.topology.set(d.id, {
          nextHop,
          depth: 1 + d.hops,
          lastSeen: Date.now(),
          freeSlots: d.freeSlots,
          state: "OK"
          // Assume OK for now
        });
      });
    }
    this.emitState();
  }
  routeMessage(targetId, msg) {
    const path = msg.path || [];
    path.push(this.peer.id);
    msg.path = path;
    if (this.children.has(targetId)) {
      const conn = this.children.get(targetId);
      if (conn && conn.open) {
        msg.route = [this.peer.id, targetId];
        conn.send(msg);
        return;
      }
    }
    const routeInfo = this.topology.get(targetId);
    if (routeInfo) {
      const conn = this.children.get(routeInfo.nextHop);
      if (conn && conn.open) {
        if (!msg.route) {
          msg.route = this.computeRoutePath(targetId);
        }
        conn.send(msg);
        return;
      } else {
        console.warn(`[Host] NextHop ${routeInfo.nextHop} dead for target ${targetId}`);
        this.topology.delete(targetId);
      }
    } else {
      console.warn(`[Host] No route to ${targetId}. Dropping message ${msg.t}`);
    }
  }
  /**
   * Compute the full routing path from host to a target node
   * This is needed for multi-hop forwarding
   */
  computeRoutePath(targetId) {
    const routeInfo = this.topology.get(targetId);
    if (!routeInfo) return [];
    return [this.peer.id, routeInfo.nextHop];
  }
  getSmartSeeds() {
    const candidates = Array.from(this.topology.entries()).filter(([id, node]) => node.freeSlots > 0 && node.depth < 4).sort((a, b) => {
      if (a[1].depth !== b[1].depth) {
        return a[1].depth - b[1].depth;
      }
      return b[1].freeSlots - a[1].freeSlots;
    }).map((entry) => entry[0]);
    const shuffled = this.weightedShuffle(candidates);
    if (shuffled.length < 5) {
      const childKeys = Array.from(this.children.keys()).filter((id) => !shuffled.includes(id));
      const extra = this.simpleShuffle(childKeys);
      shuffled.push(...extra);
    }
    return shuffled.slice(0, 10);
  }
  weightedShuffle(arr) {
    const result = [];
    const weights = arr.map((_, i) => Math.max(1, arr.length - i));
    const remaining = [...arr];
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
  simpleShuffle(arr) {
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  getSmartRedirects() {
    return this.getSmartSeeds();
  }
  startRain() {
    this.rainInterval = setInterval(() => {
      this.rainSeq++;
      this.emitState();
      const rain = {
        t: "RAIN",
        v: 1,
        gameId: this.gameId,
        src: this.peer.id,
        msgId: uuidv4(),
        rainSeq: this.rainSeq,
        path: [this.peer.id]
      };
      this.broadcast(rain);
    }, 1e3);
  }
  broadcast(msg) {
    this.children.forEach((conn) => {
      if (conn.open) {
        conn.send(msg);
      }
    });
  }
  getPeerId() {
    return this.peer.id;
  }
  /**
   * Generate QR payload / connection string for joiners (§4.1)
   * The host renders a QR that changes over time.
   * 
   * Required fields:
   * - v: protocol version (1)
   * - gameId: session id
   * - secret: join secret
   * - hostId: PeerJS ID of host
   * - seeds: array of PeerJS IDs (5-10) with known capacity
   * - qrSeq: monotonic sequence number
   * 
   * Optional fields:
   * - latestRainSeq: current rain sequence
   * - latestGameSeq: current game sequence
   * - mode: e.g., 'TREE'
   * 
   * @returns Connection string object suitable for QR encoding
   */
  getConnectionString() {
    this.qrSeq++;
    return {
      v: 1,
      gameId: this.gameId,
      secret: this.secret,
      hostId: this.peer.id,
      seeds: this.getSmartSeeds(),
      qrSeq: this.qrSeq,
      latestRainSeq: this.rainSeq,
      latestGameSeq: this.gameSeq,
      mode: "TREE"
    };
  }
  // --- Public Game API ---
  /**
   * Register callback for incoming game events from nodes
   */
  onGameEventReceived(callback) {
    this.onGameEventCallback = callback;
  }
  /**
   * Broadcast a game event to all connected nodes
   */
  broadcastGameEvent(type, data) {
    this.gameSeq++;
    const event = {
      t: "GAME_EVENT",
      v: 1,
      gameId: this.gameId,
      src: this.peer.id,
      msgId: uuidv4(),
      gameSeq: this.gameSeq,
      event: { type, data },
      path: [this.peer.id]
    };
    this.gameEventCache.push({ seq: this.gameSeq, event: { type, data } });
    if (this.gameEventCache.length > this.MAX_CACHE_SIZE) {
      this.gameEventCache.shift();
    }
    this.broadcast(event);
  }
  /**
   * Send a message to a specific peer
   * @param peerId Target peer ID
   * @param type Message type
   * @param data Message data
   * @param ack If true, returns Promise that resolves when ACK received
   */
  sendToPeer(peerId, type, data, ack = false) {
    const msgId = uuidv4();
    const msg = {
      t: "GAME_EVENT",
      v: 1,
      gameId: this.gameId,
      src: this.peer.id,
      msgId,
      gameSeq: ++this.gameSeq,
      event: { type, data },
      dest: peerId,
      path: [this.peer.id],
      ack
    };
    this.routeMessage(peerId, msg);
    if (ack) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingAcks.delete(msgId);
          reject(new Error(`ACK timeout for message ${msgId}`));
        }, 1e4);
        this.pendingAcks.set(msgId, { resolve, reject, timeout });
      });
    }
  }
  subscribe(callback) {
    this.onStateChange = callback;
    this.emitState();
  }
  emitState() {
    if (this.onStateChange) {
      const topologyData = [];
      this.topology.forEach((node, id) => {
        topologyData.push({
          id,
          depth: node.depth,
          nextHop: node.nextHop,
          freeSlots: node.freeSlots,
          state: node.state
        });
      });
      this.onStateChange({
        role: "HOST",
        peerId: this.peer.id,
        children: Array.from(this.children.keys()),
        rainSeq: this.rainSeq,
        topology: topologyData
        // Full topology for visualization
      });
    }
  }
};

// src/Node.ts
import { v4 as uuidv42 } from "uuid";
var NodeState = /* @__PURE__ */ ((NodeState2) => {
  NodeState2["NORMAL"] = "NORMAL";
  NodeState2["SUSPECT_UPSTREAM"] = "SUSPECT_UPSTREAM";
  NodeState2["PATCHING"] = "PATCHING";
  NodeState2["REBINDING"] = "REBINDING";
  NodeState2["WAITING_FOR_HOST"] = "WAITING_FOR_HOST";
  return NodeState2;
})(NodeState || {});
var Node = class {
  constructor(gameId, secret, peer, logger) {
    // Parent Connection
    this.parent = null;
    // Topology Learning
    this.seeds = [];
    // Children (Acting as Parent)
    this.children = /* @__PURE__ */ new Map();
    this.childDescendants = /* @__PURE__ */ new Map();
    this.childCapacities = /* @__PURE__ */ new Map();
    this.MAX_CHILDREN = 3;
    // State
    this.rainSeq = 0;
    this.lastRainTime = Date.now();
    this.isAttached = false;
    this.subtreeInterval = null;
    this.myDepth = 0;
    this.state = "NORMAL" /* NORMAL */;
    this.patchStartTime = 0;
    // Simulation Controls
    this._paused = false;
    this._logger = (msg) => console.log(msg);
    this.pendingPings = /* @__PURE__ */ new Map();
    // msgId -> timestamp
    this.pendingAcks = /* @__PURE__ */ new Map();
    // Callback for game events
    this.onGameEvent = null;
    // Cousin connections for patch mode (S=2 connections at same depth, different parent)
    this.cousins = /* @__PURE__ */ new Map();
    this.lastGameSeq = 0;
    this.gameEventCache = [];
    this.MAX_CACHE_SIZE = 20;
    // Configurable cache size (default 20)
    this.lastParentRainTime = Date.now();
    this.stallDetectionInterval = null;
    this.lastReqStateTime = 0;
    // Track when we last sent REQ_STATE
    this.reqStateTarget = null;
    // Track where we sent REQ_STATE
    this.reqStateCount = 0;
    // Track number of REQ_STATE sent for rate limiting
    // Join robustness
    this.MAX_ATTACH_ATTEMPTS = 10;
    this.MAX_REDIRECT_DEPTH = 5;
    this.attachAttempts = 0;
    this.redirectDepth = 0;
    this.lastAttachTime = 0;
    this.attachRetryTimer = null;
    this.authAttempts = 0;
    // Descendant routing map: descendantId -> nextHop childId
    this.descendantToNextHop = /* @__PURE__ */ new Map();
    this.descendantsCount = 0;
    // Deduplication
    this.recentMsgIds = /* @__PURE__ */ new Set();
    this.MAX_MSG_ID_CACHE = 100;
    // ---------------------------
    this.hostId = null;
    this.onStateChange = null;
    this.gameId = gameId;
    this.secret = secret;
    this.peer = peer;
    if (logger) this._logger = logger;
    this.peer.on("open", (id) => {
      this.log(`[Node] Peer Open: ${id}`);
      this.emitState();
    });
    this.peer.on("error", (err) => {
      this.log(`[Node] Peer Error: ${err}`);
    });
  }
  // --- Simulation Controls ---
  setLogger(logger) {
    this._logger = logger;
  }
  togglePause(paused) {
    this._paused = paused;
    this.log(`[Node] Paused state set to: ${paused}`);
    this.emitState();
  }
  isPaused() {
    return this._paused;
  }
  getHealthStatus() {
    if (!this.isAttached) return "OFFLINE";
    const timeSinceRain = Date.now() - this.lastRainTime;
    if (timeSinceRain > 5e3) return "OFFLINE";
    if (timeSinceRain > 2e3) return "DEGRADED";
    return "HEALTHY";
  }
  /**
   * Configure the game event cache size
   * @param size Number of events to cache (default: 20)
   */
  setGameEventCacheSize(size) {
    if (size < 0) {
      this.log("[Node] Warning: Cache size must be >= 0, using default of 20");
      this.MAX_CACHE_SIZE = 20;
      return;
    }
    this.MAX_CACHE_SIZE = size;
    while (this.gameEventCache.length > this.MAX_CACHE_SIZE) {
      this.gameEventCache.shift();
    }
    this.log(`[Node] Game event cache size set to ${size}`);
  }
  close() {
    this.log("[Node] Closing (Simulated Kill)...");
    if (this.subtreeInterval) clearInterval(this.subtreeInterval);
    if (this.stallDetectionInterval) clearInterval(this.stallDetectionInterval);
    this.peer.destroy();
  }
  log(msg, ...args) {
    const formatted = args.length > 0 ? `${msg} ${args.map((a) => JSON.stringify(a)).join(" ")}` : msg;
    this._logger(formatted);
  }
  // Step A: Bootstrap (Auth)
  bootstrap(hostId) {
    this.hostId = hostId;
    this.authAttempts = 0;
    if (this.peer.open) {
      this.log("[Node] Peer is open, bootstrapping...");
      this.authenticateWithHost(hostId);
    } else {
      this.log("[Node] Waiting to open before bootstrapping...");
      this.peer.once("open", () => {
        this.authenticateWithHost(hostId);
      });
    }
  }
  authenticateWithHost(hostId) {
    this.log(`[Node] Authenticating with Host ${hostId}...`);
    this.log(`[Node] Creating connection with metadata: gameId=${this.gameId}, secret=${this.secret}`);
    const conn = this.peer.connect(hostId, {
      reliable: true,
      metadata: { gameId: this.gameId, secret: this.secret }
    });
    this.log(`[Node] Connection object created, peer: ${conn.peer}, open: ${conn.open}`);
    const onOpen = () => {
      const req = {
        t: "JOIN_REQUEST",
        v: 1,
        gameId: this.gameId,
        src: this.peer.id,
        msgId: uuidv42(),
        secret: this.secret,
        path: [this.peer.id]
      };
      conn.send(req);
    };
    if (conn.open) {
      onOpen();
    } else {
      conn.on("open", onOpen);
    }
    conn.on("data", (data) => {
      if (this._paused) return;
      const msg = data;
      if (msg.t === "JOIN_ACCEPT") {
        this.log("[Node] Join Accepted.");
        this.seeds = msg.seeds || [];
        if (msg.keepAlive) {
          this.log("[Node] Host kept connection. Attached as L1.");
          this.parent = conn;
          this.isAttached = true;
          this.myDepth = 1;
          this.emitState();
          conn.off("data");
          conn.on("data", (d) => {
            if (this._paused) return;
            this.handleMessage(conn, d);
          });
          conn.on("close", () => {
            this.log("[Node] Parent (Host) connection closed");
            this.parent = null;
            this.isAttached = false;
            this.emitState();
          });
          this.startSubtreeReporting();
          this.startStallDetection();
        } else {
          this.log(`[Node] Host provided seeds: [${this.seeds.join(", ")}]. Disconnecting to attach to seeds.`);
          conn.close();
          this.scheduleAttachRetry();
        }
      } else if (msg.t === "JOIN_REJECT") {
        this.log(`[Node] Join Rejected: ${msg.reason}`);
        conn.close();
      }
    });
    conn.on("error", (e) => {
      this.log(`[Node] Auth Error: ${e}`);
      if (e.toString().includes("Negotiation") && this.authAttempts < 5) {
        this.log(`[Node] Retrying auth in 500ms... (Attempt ${this.authAttempts + 1}/5)`);
        this.authAttempts++;
        setTimeout(() => {
          if (!this.isAttached) this.authenticateWithHost(hostId);
        }, 500 + Math.random() * 500);
      }
    });
    conn.on("close", () => {
      this.log(`[Node] Auth connection to ${hostId} closed`);
    });
  }
  // Step B: Attach to Network (Recursive with robustness)
  attemptAttachToNetwork() {
    this.log(`[Node] attemptAttachToNetwork called. isAttached=${this.isAttached}, attempts=${this.attachAttempts}, seeds=${JSON.stringify(this.seeds)}`);
    if (this.isAttached) {
      this.log("[Node] Already attached, skipping attemptAttachToNetwork");
      return;
    }
    if (this.attachAttempts >= this.MAX_ATTACH_ATTEMPTS) {
      this.log("[Node] Max attach attempts reached, falling back to host");
      this.attachAttempts = 0;
      this.redirectDepth = 0;
      if (this.hostId) {
        this.authenticateWithHost(this.hostId);
      }
      return;
    }
    if (this.redirectDepth >= this.MAX_REDIRECT_DEPTH) {
      this.log("[Node] Max redirect depth reached, resetting");
      this.redirectDepth = 0;
      this.attachAttempts = 0;
      if (this.hostId) {
        this.authenticateWithHost(this.hostId);
      }
      return;
    }
    let targetId;
    if (this.seeds.length > 0) {
      targetId = this.seeds[Math.floor(Math.random() * this.seeds.length)];
    } else {
      this.log("[Node] No seeds! Falling back to host...");
      if (this.hostId) {
        this.authenticateWithHost(this.hostId);
      }
      return;
    }
    this.attachAttempts++;
    this.lastAttachTime = Date.now();
    this.log(`[Node] Attempting to attach to ${targetId}...`);
    const conn = this.peer.connect(targetId, {
      reliable: true,
      metadata: { gameId: this.gameId, secret: this.secret }
    });
    conn.on("open", () => {
      const req = {
        t: "ATTACH_REQUEST",
        v: 1,
        gameId: this.gameId,
        src: this.peer.id,
        msgId: uuidv42(),
        wantRole: "CHILD",
        depth: this.redirectDepth,
        // Track redirect depth
        path: [this.peer.id]
      };
      conn.send(req);
    });
    conn.on("data", (data) => this.handleAttachResponse(conn, data));
    conn.on("error", (err) => {
      this.log(`[Node] Failed to connect to ${targetId}`, err);
      this.seeds = this.seeds.filter((s) => s !== targetId);
      this.scheduleAttachRetry();
    });
  }
  scheduleAttachRetry() {
    if (this.attachRetryTimer) clearTimeout(this.attachRetryTimer);
    if (this.attachAttempts === 0) {
      this.attemptAttachToNetwork();
      return;
    }
    const backoffMs = Math.min(500 * Math.pow(2, this.attachAttempts - 1), 5e3);
    this.log(`[Node] Retrying attach after ${backoffMs}ms backoff (attempt ${this.attachAttempts})`);
    this.attachRetryTimer = setTimeout(() => {
      this.attachRetryTimer = null;
      this.attemptAttachToNetwork();
    }, backoffMs);
  }
  handleAttachResponse(conn, msg) {
    if (msg.t === "ATTACH_ACCEPT") {
      this.log(`[Node] Attached to parent ${conn.peer}`);
      this.parent = conn;
      this.isAttached = true;
      this.myDepth = (msg.level || 0) + 1;
      this.attachAttempts = 0;
      this.redirectDepth = 0;
      this.emitState();
      conn.off("data");
      conn.on("data", (data) => {
        if (this._paused) return;
        this.handleMessage(conn, data);
      });
      conn.on("close", () => {
        this.log("[Node] Parent connection closed");
        this.parent = null;
        this.isAttached = false;
        this.emitState();
      });
      if (this.myDepth > 1) {
        this.requestCousins();
      }
      this.startSubtreeReporting();
      this.startStallDetection();
    } else if (msg.t === "ATTACH_REJECT") {
      this.log(`[Node] Attach Rejected by ${conn.peer}. Redirects: ${JSON.stringify(msg.redirect)}`);
      conn.close();
      this.redirectDepth++;
      if (msg.redirect && msg.redirect.length > 0) {
        this.seeds = this.shuffleArray(msg.redirect);
      }
      this.scheduleAttachRetry();
    }
  }
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  handleMessage(conn, msg) {
    if (msg.gameId !== this.gameId) {
      this.log(`[Node] Rejecting message from ${msg.src}: gameId mismatch`);
      return;
    }
    if (this.recentMsgIds.has(msg.msgId)) {
      return;
    }
    this.recentMsgIds.add(msg.msgId);
    if (this.recentMsgIds.size > this.MAX_MSG_ID_CACHE) {
      const iterator = this.recentMsgIds.values();
      const first = iterator.next().value;
      if (first !== void 0) this.recentMsgIds.delete(first);
    }
    const isFromParent = this.parent && conn.peer === this.parent.peer;
    const isFromChild = this.children.has(conn.peer);
    const isFromCousin = this.cousins.has(conn.peer);
    if (msg.dest && msg.dest !== this.peer.id) {
      const currentPath = msg.path ? [...msg.path] : [];
      if (!currentPath.includes(this.peer.id)) {
        currentPath.push(this.peer.id);
      }
      const forwardedMsg = { ...msg, path: currentPath };
      if (forwardedMsg.dest === "HOST") {
        if (this.parent && this.parent.open) {
          this.log(`[Node] Routing ${forwardedMsg.t} UP to HOST`);
          this.parent.send(forwardedMsg);
        } else {
          this.log(`[Node] Cannot route to HOST - no parent connection, dropping message`);
        }
        return;
      }
      if (isFromChild) {
        if (this.parent && this.parent.open) {
          this.log(`[Node] Routing ${forwardedMsg.t} UP to parent (dest: ${forwardedMsg.dest})`);
          this.parent.send(forwardedMsg);
        } else {
          this.log(`[Node] Cannot route UP - no parent connection`);
        }
      } else if (isFromParent) {
        let nextHop;
        if (forwardedMsg.route) {
          const myIndex = forwardedMsg.route.indexOf(this.peer.id);
          if (myIndex >= 0 && myIndex < forwardedMsg.route.length - 1) {
            nextHop = forwardedMsg.route[myIndex + 1];
          }
        }
        if (!nextHop && forwardedMsg.dest) {
          nextHop = this.descendantToNextHop.get(forwardedMsg.dest);
        }
        if (nextHop && this.children.has(nextHop)) {
          this.log(`[Node] Routing ${forwardedMsg.t} DOWN to next hop ${nextHop} (dest: ${forwardedMsg.dest})`);
          this.children.get(nextHop).send(forwardedMsg);
        } else {
          this.log(`[Node] No route found for child ${forwardedMsg.dest}, routing UP to parent as fallback`);
          if (this.parent && this.parent.open) {
            this.parent.send(forwardedMsg);
          }
        }
      }
      return;
    }
    switch (msg.t) {
      case "RAIN":
        if (isFromParent) {
          if (msg.rainSeq <= this.rainSeq) return;
          this.rainSeq = msg.rainSeq;
          this.lastRainTime = Date.now();
          this.lastParentRainTime = Date.now();
          if (this.state !== "NORMAL" /* NORMAL */) {
            this.log(`[Node] Received RAIN from parent, transitioning to NORMAL`);
            this.state = "NORMAL" /* NORMAL */;
            this.patchStartTime = 0;
            this.reqStateCount = 0;
          }
          this.reqStateTarget = null;
          const currentPath = msg.path ? [...msg.path] : [];
          if (!currentPath.includes(this.peer.id)) {
            currentPath.push(this.peer.id);
          }
          this.broadcast({ ...msg, path: currentPath });
        }
        break;
      case "SUBTREE_STATUS":
        if (msg.descendants && msg.freeSlots !== void 0) {
          this.childDescendants.set(conn.peer, msg.descendants);
        }
        break;
      case "PING":
        this.log(`[Node] PING received from ${msg.src}, sending PONG`);
        const reversePath = [...msg.path || []].reverse();
        const pongMsg = {
          t: "PONG",
          v: 1,
          gameId: this.gameId,
          src: this.peer.id,
          msgId: uuidv42(),
          replyTo: msg.msgId,
          dest: msg.src,
          path: [this.peer.id],
          route: [this.peer.id, ...reversePath]
          // Explicit reverse-path routing including self
        };
        this.routeReply(pongMsg, conn);
        break;
      case "PONG":
        if (msg.replyTo && this.pendingPings.has(msg.replyTo)) {
          const sendTime = this.pendingPings.get(msg.replyTo);
          const latency = Date.now() - sendTime;
          this.pendingPings.delete(msg.replyTo);
          this.log(`[Node] PONG received from ${msg.src} - RTT: ${latency}ms (hops: ${(msg.path || []).length})`);
        } else {
          this.log(`[Node] PONG received from ${msg.src} via path: ${JSON.stringify(msg.path)}`);
        }
        break;
      case "ACK":
        if (msg.replyTo && this.pendingAcks.has(msg.replyTo)) {
          const pending = this.pendingAcks.get(msg.replyTo);
          clearTimeout(pending.timeout);
          pending.resolve(true);
          this.pendingAcks.delete(msg.replyTo);
          this.log(`[Node] ACK received for msg ${msg.replyTo}`);
        }
        break;
      case "GAME_EVENT":
        this.log(`[Node] GAME_EVENT from ${msg.src}: ${msg.event?.type}`);
        if (msg.gameSeq !== void 0) {
          if (msg.gameSeq <= this.lastGameSeq) return;
          this.lastGameSeq = msg.gameSeq;
        }
        if (msg.event) {
          this.gameEventCache.push({ seq: msg.gameSeq || 0, event: msg.event });
          if (this.gameEventCache.length > this.MAX_CACHE_SIZE) {
            this.gameEventCache.shift();
          }
        }
        if (msg.ack) {
          const reversePath2 = msg.path ? [...msg.path].reverse() : [msg.src];
          const ackMsg = {
            t: "ACK",
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv42(),
            replyTo: msg.msgId,
            dest: msg.src,
            path: [this.peer.id],
            route: [this.peer.id, ...reversePath2]
          };
          this.routeReply(ackMsg, conn);
        }
        if (this.onGameEvent && msg.event) {
          this.onGameEvent(msg.event.type, msg.event.data, msg.src);
        }
        if (isFromParent) {
          const currentPath = msg.path ? [...msg.path] : [];
          if (!currentPath.includes(this.peer.id)) {
            currentPath.push(this.peer.id);
          }
          this.broadcast({ ...msg, path: currentPath });
        }
        break;
      case "PAYLOAD":
        this.log(`[Node] PAYLOAD received from ${msg.src} (type: ${msg.payloadType}). ReplyTo: ${msg.replyTo}. Pending: ${Array.from(this.pendingAcks.keys()).join(",")}`);
        if (msg.replyTo && this.pendingAcks.has(msg.replyTo)) {
          const pending = this.pendingAcks.get(msg.replyTo);
          clearTimeout(pending.timeout);
          pending.resolve(true);
          this.pendingAcks.delete(msg.replyTo);
        }
        break;
      case "REQ_STATE":
        this.log(`[Node] REQ_STATE from ${msg.src} (fromGameSeq: ${msg.fromGameSeq})`);
        const eventsToSend = this.gameEventCache.filter((e) => e.seq > msg.fromGameSeq).map((e) => ({ seq: e.seq, event: e.event }));
        const minSeqInCache = this.gameEventCache.length > 0 ? this.gameEventCache[0].seq : 0;
        const truncated = minSeqInCache > msg.fromGameSeq + 1;
        const reversePathForState = [...msg.path || []].reverse();
        const stateMsg = {
          t: "STATE",
          v: 1,
          gameId: this.gameId,
          src: this.peer.id,
          msgId: uuidv42(),
          replyTo: msg.msgId,
          dest: msg.src,
          latestRainSeq: this.rainSeq,
          latestGameSeq: this.lastGameSeq,
          events: eventsToSend,
          minGameSeqAvailable: minSeqInCache,
          truncated,
          path: [this.peer.id],
          route: [this.peer.id, ...reversePathForState]
          // Explicit reverse-path routing including self
        };
        this.routeReply(stateMsg, conn);
        break;
      case "STATE":
        this.log(`[Node] STATE received from ${msg.src} with ${msg.events?.length || 0} events`);
        if (msg.events && msg.events.length > 0) {
          const newEvents = [];
          msg.events.forEach((item) => {
            const eventSeq = item.seq;
            const event = item.event;
            if (eventSeq <= this.lastGameSeq) {
              return;
            }
            this.gameEventCache.push({ seq: eventSeq, event });
            if (this.gameEventCache.length > this.MAX_CACHE_SIZE) {
              this.gameEventCache.shift();
            }
            newEvents.push({ seq: eventSeq, event });
            if (this.onGameEvent) {
              this.onGameEvent(event.type, event.data, msg.src);
            }
          });
          this.lastGameSeq = Math.max(this.lastGameSeq, msg.latestGameSeq);
          newEvents.forEach(({ seq, event }) => {
            const gameEvent = {
              t: "GAME_EVENT",
              v: 1,
              gameId: this.gameId,
              src: this.peer.id,
              msgId: uuidv42(),
              gameSeq: seq,
              event,
              path: [this.peer.id]
            };
            this.broadcast(gameEvent);
          });
        }
        if (msg.latestRainSeq > this.rainSeq) {
          this.log(`[Node] STATE advanced rainSeq from ${this.rainSeq} to ${msg.latestRainSeq}. Forwarding RAIN downstream.`);
          this.rainSeq = msg.latestRainSeq;
          this.lastRainTime = Date.now();
          this.lastParentRainTime = Date.now();
          const rainMsg = {
            t: "RAIN",
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            // We are the source of this synthetic rain
            msgId: uuidv42(),
            rainSeq: this.rainSeq,
            path: [this.peer.id]
          };
          this.broadcast(rainMsg);
        }
        this.reqStateTarget = null;
        break;
      case "REQ_COUSINS":
        this.log(`[Node] REQ_COUSINS from ${msg.src} (depth: ${msg.requesterDepth}, count: ${msg.desiredCount})`);
        let cousinCandidates = [];
        const targetDepth = msg.requesterDepth;
        const requesterHops = targetDepth - this.myDepth;
        this.children.forEach((childConn, childId) => {
          if (childId === msg.src || this.descendantToNextHop.get(msg.src) === childId) {
            return;
          }
          const descendants = this.childDescendants.get(childId);
          if (descendants) {
            descendants.forEach((desc) => {
              if (desc.hops === requesterHops) {
                cousinCandidates.push(desc.id);
              }
            });
          }
          if (requesterHops === 1) {
            cousinCandidates.push(childId);
          }
        });
        if (cousinCandidates.length > 0) {
          const byBranch = /* @__PURE__ */ new Map();
          cousinCandidates.forEach((candId) => {
            const branch = this.descendantToNextHop.get(candId) || candId;
            if (!byBranch.has(branch)) {
              byBranch.set(branch, []);
            }
            byBranch.get(branch).push(candId);
          });
          const selected = [];
          byBranch.forEach((candidates) => {
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            selected.push(pick);
          });
          const shuffled = this.shuffleArray(selected);
          const finalCandidates = shuffled.slice(0, msg.desiredCount);
          this.log(`[Node] Found ${finalCandidates.length} local cousin candidates for ${msg.src}`);
          const cousinsMsg = {
            t: "COUSINS",
            v: 1,
            gameId: this.gameId,
            src: this.peer.id,
            msgId: uuidv42(),
            replyTo: msg.msgId,
            dest: msg.src,
            candidates: finalCandidates,
            path: [this.peer.id]
          };
          if (isFromChild) {
            conn.send(cousinsMsg);
          } else {
            this.routeMessageToTarget(msg.src, cousinsMsg);
          }
        } else {
          this.log(`[Node] No local cousins found, forwarding REQ_COUSINS upstream`);
          if (this.parent && this.parent.open) {
            this.parent.send(msg);
          } else {
            const cousinsMsg = {
              t: "COUSINS",
              v: 1,
              gameId: this.gameId,
              src: this.peer.id,
              msgId: uuidv42(),
              replyTo: msg.msgId,
              dest: msg.src,
              candidates: [],
              path: [this.peer.id]
            };
            conn.send(cousinsMsg);
          }
        }
        break;
      case "COUSINS":
        this.log(`[Node] COUSINS received with ${msg.candidates.length} candidates`);
        const candidatesToTry = msg.candidates.slice(0, 2);
        candidatesToTry.forEach((cousinId) => {
          if (!this.cousins.has(cousinId) && cousinId !== this.peer.id) {
            this.connectToCousin(cousinId);
          }
        });
        break;
      case "REBIND_ASSIGN":
        this.handleRebindAssign(msg);
        break;
    }
  }
  // --- Subtree Reporting ---
  startSubtreeReporting() {
    this.subtreeInterval = setInterval(() => {
      if (this.parent && this.parent.open) {
        this.reportSubtree();
      }
    }, 5e3);
  }
  reportSubtree() {
    if (!this.parent) return;
    let myDescendants = [];
    let myChildrenStatus = [];
    this.descendantToNextHop.clear();
    this.children.forEach((conn, childId) => {
      const childCapacity = this.childCapacities.get(childId) || 0;
      myDescendants.push({ id: childId, hops: 1, freeSlots: childCapacity });
      myChildrenStatus.push({ id: childId, state: "OK", lastRainSeq: this.rainSeq, freeSlots: childCapacity });
      this.descendantToNextHop.set(childId, childId);
      const grandkids = this.childDescendants.get(childId);
      if (grandkids) {
        grandkids.forEach((gk) => {
          myDescendants.push({ id: gk.id, hops: gk.hops + 1, freeSlots: gk.freeSlots });
          this.descendantToNextHop.set(gk.id, childId);
        });
      }
    });
    const msg = {
      t: "SUBTREE_STATUS",
      v: 1,
      gameId: this.gameId,
      src: this.peer.id,
      msgId: uuidv42(),
      lastRainSeq: this.rainSeq,
      state: "OK",
      children: myChildrenStatus,
      subtreeCount: myDescendants.length,
      descendants: myDescendants,
      freeSlots: this.MAX_CHILDREN - this.children.size,
      path: [this.peer.id]
    };
    this.parent.send(msg);
  }
  // --- Parent Logic ---
  handleIncomingConnection(conn) {
    const meta = conn.metadata;
    if (!meta || meta.gameId !== this.gameId || meta.secret !== this.secret) {
      conn.close();
      return;
    }
    if (meta.role === "COUSIN") {
      this.log(`[Node] Registered incoming COUSIN connection from ${conn.peer}`);
      this.cousins.set(conn.peer, conn);
    }
    conn.on("data", (data) => {
      if (this._paused) return;
      const msg = data;
      if (msg.t === "ATTACH_REQUEST") {
        this.handleIncomingAttach(conn, msg);
      } else if (msg.t === "SUBTREE_STATUS") {
        this.childDescendants.set(conn.peer, msg.descendants || []);
        this.childCapacities.set(conn.peer, msg.freeSlots);
      } else {
        this.handleMessage(conn, msg);
      }
    });
    conn.on("close", () => {
      this.log(`[Node] Connection closed: ${conn.peer}`);
      this.children.delete(conn.peer);
      this.cousins.delete(conn.peer);
      this.childDescendants.delete(conn.peer);
      this.childCapacities.delete(conn.peer);
      this.emitState();
      this.reportSubtree();
    });
  }
  handleIncomingAttach(conn, msg) {
    if (this.children.size >= this.MAX_CHILDREN) {
      const candidates = [];
      this.children.forEach((childConn, childId) => {
        if ((this.childCapacities.get(childId) || 0) > 0) {
          candidates.push(childId);
        }
      });
      this.childDescendants.forEach((descendants) => {
        descendants.forEach((d) => {
          if (d.freeSlots > 0) {
            candidates.push(d.id);
          }
        });
      });
      const shuffled = this.shuffleArray(candidates);
      const redirectList = shuffled.slice(0, 10);
      const reject = {
        t: "ATTACH_REJECT",
        v: 1,
        gameId: this.gameId,
        src: this.peer.id,
        msgId: uuidv42(),
        reason: "FULL",
        redirect: redirectList,
        depthHint: this.myDepth + 1,
        path: [this.peer.id]
      };
      conn.send(reject);
    } else {
      this.children.set(conn.peer, conn);
      const accept = {
        t: "ATTACH_ACCEPT",
        v: 1,
        gameId: this.gameId,
        src: this.peer.id,
        msgId: uuidv42(),
        parentId: this.peer.id,
        level: this.myDepth,
        cousinCandidates: [],
        childrenMax: this.MAX_CHILDREN,
        childrenUsed: this.children.size,
        path: [this.peer.id]
      };
      conn.send(accept);
      this.emitState();
      this.reportSubtree();
    }
  }
  handleRebindAssign(msg) {
    this.log(`[Node] REBIND_ASSIGN received with ${msg.newParentCandidates.length} candidates`);
    if (this.parent) {
      this.parent.close();
      this.parent = null;
      this.isAttached = false;
    }
    this.seeds = msg.newParentCandidates;
    this.attachAttempts = 0;
    this.state = "NORMAL" /* NORMAL */;
    this.scheduleAttachRetry();
  }
  broadcast(msg) {
    this.children.forEach((c) => {
      if (c.open) c.send(msg);
    });
  }
  routeMessageToTarget(targetId, msg) {
    const nextHop = this.descendantToNextHop.get(targetId);
    if (nextHop && this.children.has(nextHop)) {
      const conn = this.children.get(nextHop);
      if (conn && conn.open) {
        conn.send(msg);
        return;
      }
    }
    if (this.parent && this.parent.open) {
      this.parent.send(msg);
    }
  }
  routeReply(msg, sourceConn) {
    if (!msg.route || msg.route.length === 0) {
      sourceConn.send(msg);
      return;
    }
    const myIndex = msg.route.indexOf(this.peer.id);
    let nextHopId;
    if (myIndex === -1) {
      nextHopId = msg.route[0];
    } else if (myIndex < msg.route.length - 1) {
      nextHopId = msg.route[myIndex + 1];
    } else {
      return;
    }
    let targetConn = null;
    if (this.parent && this.parent.peer === nextHopId) {
      targetConn = this.parent;
    } else if (this.children.has(nextHopId)) {
      targetConn = this.children.get(nextHopId);
    } else if (this.cousins.has(nextHopId)) {
      targetConn = this.cousins.get(nextHopId);
    }
    if (targetConn && targetConn.open) {
      targetConn.send(msg);
    } else {
      this.log(`[Node] Cannot route reply - next hop ${nextHopId} not connected. Route: ${JSON.stringify(msg.route)}`);
    }
  }
  sendToHost(msg) {
    this.log(`[Node] sendToHost called. Parent: ${this.parent?.peer || "NONE"}, Open: ${this.parent?.open || false}`);
    if (this.parent && this.parent.open) {
      msg.path = [this.peer.id];
      this.parent.send(msg);
      this.log(`[Node] Sent ${msg.t} to parent ${this.parent.peer}`);
    } else {
      this.log(`[Node] sendToHost FAILED - no open parent connection!`);
    }
  }
  pingHost() {
    this.log(`[Node] pingHost() called. isAttached=${this.isAttached}, depth=${this.myDepth}`);
    const msgId = uuidv42();
    this.pendingPings.set(msgId, Date.now());
    this.sendToHost({
      t: "PING",
      v: 1,
      gameId: this.gameId,
      src: this.peer.id,
      msgId,
      dest: "HOST"
    });
  }
  requestCousins() {
    this.log(`[Node] Requesting cousins (depth=${this.myDepth}). Parent: ${this.parent?.peer}, Open: ${this.parent?.open}`);
    if (!this.parent) return;
    this.log(`[Node] Requesting cousins (depth=${this.myDepth})`);
    const reqCousins = {
      t: "REQ_COUSINS",
      v: 1,
      gameId: this.gameId,
      src: this.peer.id,
      msgId: uuidv42(),
      requesterDepth: this.myDepth,
      desiredCount: 2,
      path: [this.peer.id]
    };
    this.parent.send(reqCousins);
  }
  connectToCousin(cousinId) {
    this.log(`[Node] Attempting to connect to cousin ${cousinId}`);
    const conn = this.peer.connect(cousinId, {
      reliable: true,
      metadata: { gameId: this.gameId, secret: this.secret, role: "COUSIN" }
    });
    conn.on("open", () => {
      this.log(`[Node] Cousin connection established with ${cousinId}`);
      this.cousins.set(cousinId, conn);
      this.emitState();
    });
    conn.on("data", (data) => {
      if (this._paused) return;
      this.handleMessage(conn, data);
    });
    conn.on("close", () => {
      this.log(`[Node] Cousin connection closed: ${cousinId}`);
      this.cousins.delete(cousinId);
      this.emitState();
    });
    conn.on("error", (err) => {
      this.log(`[Node] Cousin connection error with ${cousinId}: ${err}`);
      this.cousins.delete(cousinId);
    });
  }
  startStallDetection() {
    this.stallDetectionInterval = setInterval(() => {
      if (this.state === "REBINDING" /* REBINDING */ || this.state === "REBINDING") {
        if (!this.isAttached) {
          this.state = "WAITING_FOR_HOST" /* WAITING_FOR_HOST */;
          this.emitState();
        }
      }
      if (!this.isAttached) return;
      const timeSinceRain = Date.now() - this.lastParentRainTime;
      if (timeSinceRain > 3e3 && this.state === "NORMAL" /* NORMAL */) {
        this.log(`[Node] Upstream stall detected (3s). Transitioning to SUSPECT_UPSTREAM`);
        this.state = "SUSPECT_UPSTREAM" /* SUSPECT_UPSTREAM */;
        this.emitState();
      }
      if (this.state === "SUSPECT_UPSTREAM" /* SUSPECT_UPSTREAM */ || this.state === "PATCHING" /* PATCHING */) {
        const now = Date.now();
        let limit = 2e3;
        if (this.state === "SUSPECT_UPSTREAM" /* SUSPECT_UPSTREAM */) {
          this.state = "PATCHING" /* PATCHING */;
          this.patchStartTime = now;
          this.reqStateCount = 0;
          limit = 0;
          this.log(`[Node] Entering PATCH MODE`);
        } else {
          if (this.reqStateCount < 5) {
            limit = 1e3;
          } else if (this.reqStateCount < 8) {
            limit = 2e3;
          } else if (this.reqStateCount < 12) {
            limit = 5e3;
          } else {
            limit = 1e4;
          }
        }
        if (now - this.lastReqStateTime >= limit) {
          this.sendReqStateToCousins();
        }
        const patchDuration = now - (this.patchStartTime || now);
        if (this.patchStartTime !== 0 && patchDuration > 6e4) {
          this.log(`[Node] Patch mode persisted > 60s. Escalating to REBINDING`);
          this.state = "REBINDING" /* REBINDING */;
          this.requestRebind("UPSTREAM_STALL");
        }
      }
    }, 1e3);
  }
  requestPayload(type) {
    const msgId = uuidv42();
    const msg = {
      t: "REQ_PAYLOAD",
      v: 1,
      gameId: this.gameId,
      src: this.peer.id,
      msgId,
      dest: "HOST",
      payloadType: type,
      path: [this.peer.id]
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(msgId);
        reject(new Error(`Payload timeout for ${type}`));
      }, 1e4);
      this.pendingAcks.set(msgId, { resolve, reject, timeout });
      this.sendToHost(msg);
    });
  }
  sendReqStateToCousins() {
    if (this.cousins.size > 0) {
      const cousinIds = Array.from(this.cousins.keys());
      const targetId = cousinIds[Math.floor(Math.random() * cousinIds.length)];
      const cousinConn = this.cousins.get(targetId);
      if (cousinConn && cousinConn.open) {
        this.log(`[Node] Requesting state from cousin ${targetId}`);
        const reqState = {
          t: "REQ_STATE",
          v: 1,
          gameId: this.gameId,
          src: this.peer.id,
          msgId: uuidv42(),
          dest: targetId,
          fromRainSeq: this.rainSeq,
          fromGameSeq: this.lastGameSeq,
          path: [this.peer.id]
        };
        cousinConn.send(reqState);
        this.lastReqStateTime = Date.now();
        this.reqStateTarget = "COUSIN";
        this.reqStateCount++;
      }
    } else {
      if (Date.now() - this.lastReqStateTime > 5e3) {
        this.log(`[Node] No cousins available, fallback state request to host`);
        const reqStateHost = {
          t: "REQ_STATE",
          v: 1,
          gameId: this.gameId,
          src: this.peer.id,
          msgId: uuidv42(),
          dest: "HOST",
          fromRainSeq: this.rainSeq,
          fromGameSeq: this.lastGameSeq,
          path: [this.peer.id]
        };
        this.sendToHost(reqStateHost);
        this.lastReqStateTime = Date.now();
        this.reqStateTarget = "HOST";
        this.reqStateCount++;
      }
    }
  }
  requestRebind(reason) {
    if (!this.parent || !this.parent.open) return;
    let totalDescendants = 0;
    this.childDescendants.forEach((list) => totalDescendants += list.length);
    const totalSubtree = this.children.size + totalDescendants;
    const rebindReq = {
      t: "REBIND_REQUEST",
      v: 1,
      gameId: this.gameId,
      src: this.peer.id,
      msgId: uuidv42(),
      dest: "HOST",
      lastRainSeq: this.rainSeq,
      lastGameSeq: this.lastGameSeq,
      subtreeCount: totalSubtree,
      reason,
      path: [this.peer.id]
    };
    this.sendToHost(rebindReq);
  }
  getPeerId() {
    return this.peer.id;
  }
  // --- Public Game API ---
  /**
   * Register callback for incoming game events
   */
  onGameEventReceived(callback) {
    this.onGameEvent = callback;
  }
  /**
   * Send a game command to the Host (upstream messages use GAME_CMD)
   * @param type Command type
   * @param data Command data
   * @param ack If true, returns Promise that resolves when ACK received
   */
  sendGameEvent(type, data, ack = false) {
    const msgId = uuidv42();
    const msg = {
      t: "GAME_CMD",
      v: 1,
      gameId: this.gameId,
      src: this.peer.id,
      msgId,
      cmd: { type, data },
      dest: "HOST",
      path: [this.peer.id],
      ack
    };
    this.sendToHost(msg);
    if (ack) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingAcks.delete(msgId);
          reject(new Error(`ACK timeout for message ${msgId}`));
        }, 1e4);
        this.pendingAcks.set(msgId, { resolve, reject, timeout });
      });
    }
  }
  subscribe(callback) {
    this.onStateChange = callback;
    this.emitState();
  }
  emitState() {
    if (this.onStateChange) {
      this.onStateChange({
        role: "NODE",
        peerId: this.peer.id,
        peerOpen: this.peer.open,
        parentId: this.parent?.peer || null,
        children: Array.from(this.children.keys()),
        rainSeq: this.rainSeq,
        isAttached: this.isAttached,
        depth: this.myDepth,
        state: this.state
      });
    }
  }
};

// src/index.ts
var VERSION = "1.0.0";
export {
  Host,
  Node,
  NodeState,
  VERSION
};
