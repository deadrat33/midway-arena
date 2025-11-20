const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ====== ARENA CONFIG ======
const ARENA_WIDTH = 1280;
const ARENA_HEIGHT = 720;

function randomHue() {
  return Math.floor(Math.random() * 360);
}

function makeFactionId() {
  return Math.random().toString(36).slice(2, 8);
}

const arenaState = {
  agents: [],
  factions: [],
  tick: 0,
  playerFocus: {} // playerId -> { x, y, ttl }
};

// ====== SPAWNING ======
function spawnAgentsForFaction(faction, count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * 80;
    const x = faction.cx + Math.cos(angle) * dist;
    const y = faction.cy + Math.sin(angle) * dist;
    const speed = 0.6 + Math.random() * 0.8;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;

    arenaState.agents.push({
      factionId: faction.id,
      x,
      y,
      vx,
      vy,
      radius: 3,
      energy: 1
    });
  }
}

function spawnNewFaction(ownerId) {
  const faction = {
    id: makeFactionId(),
    colorHue: randomHue(),
    ownerId: ownerId || null,
    cx: ARENA_WIDTH * (0.2 + 0.6 * Math.random()),
    cy: ARENA_HEIGHT * (0.2 + 0.8 * Math.random())
  };
  arenaState.factions.push(faction);
  spawnAgentsForFaction(faction, 33);
}

function ensureInitialFactions() {
  if (arenaState.factions.length === 0) {
    const f1 = {
      id: makeFactionId(),
      colorHue: randomHue(),
      ownerId: null,
      cx: ARENA_WIDTH * 0.3,
      cy: ARENA_HEIGHT * 0.5
    };
    const f2 = {
      id: makeFactionId(),
      colorHue: (f1.colorHue + 180) % 360,
      ownerId: null,
      cx: ARENA_WIDTH * 0.7,
      cy: ARENA_HEIGHT * 0.5
    };
    arenaState.factions.push(f1, f2);
    spawnAgentsForFaction(f1, 33);
    spawnAgentsForFaction(f2, 33);
  }
}

// Optional chaos/nudge
function addChaos() {
  for (const a of arenaState.agents) {
    a.vx += (Math.random() - 0.5) * 1.8;
    a.vy += (Math.random() - 0.5) * 1.8;
  }
}

// ====== PHYSICS LOOP ======
function stepSimulation(dtUnits) {
  const agents = arenaState.agents;
  const factions = arenaState.factions;

  // Fast faction lookup
  const factionMap = {};
  for (const f of factions) factionMap[f.id] = f;

  for (const agent of agents) {
    // jitter
    const jitter = 0.12;
    agent.vx += (Math.random() - 0.5) * jitter * dtUnits;
    agent.vy += (Math.random() - 0.5) * jitter * dtUnits;

    // attraction to faction center or player focus
    const faction = factionMap[agent.factionId];
    if (faction) {
      let targetX = faction.cx;
      let targetY = faction.cy;

      if (faction.ownerId && arenaState.playerFocus[faction.ownerId]) {
        const focus = arenaState.playerFocus[faction.ownerId];
        targetX = focus.x;
        targetY = focus.y;
        // decay focus over time
        focus.ttl -= dtUnits * 0.016;
        if (focus.ttl <= 0) {
          delete arenaState.playerFocus[faction.ownerId];
        }
      }

      const fx = (targetX - agent.x) * 0.0008 * dtUnits;
      const fy = (targetY - agent.y) * 0.0008 * dtUnits;
      agent.vx += fx;
      agent.vy += fy;
    }

    // clamp speed (optimized)
    const maxSpeed = 2.5;
    const speedSq = agent.vx * agent.vx + agent.vy * agent.vy;
    if (speedSq > maxSpeed * maxSpeed) {
      const mag = Math.sqrt(speedSq);
      agent.vx = (agent.vx / mag) * maxSpeed;
      agent.vy = (agent.vy / mag) * maxSpeed;
    }

    // integrate position
    agent.x += agent.vx * dtUnits;
    agent.y += agent.vy * dtUnits;

    // wrap around arena
    if (agent.x < 0) agent.x += ARENA_WIDTH;
    if (agent.x > ARENA_WIDTH) agent.x -= ARENA_WIDTH;
    if (agent.y < 0) agent.y += ARENA_HEIGHT;
    if (agent.y > ARENA_HEIGHT) agent.y -= ARENA_HEIGHT;

    // energy drain
    agent.energy -= 0.0008 * dtUnits;
  }

  // remove dead agents
  for (let i = agents.length - 1; i >= 0; i--) {
    if (agents[i].energy <= 0) {
      agents.splice(i, 1);
    }
  }

  arenaState.tick++;
}

// ====== SNAPSHOT BROADCAST ======
function broadcastState() {
  const snapshot = {
    tick: arenaState.tick,
    factions: arenaState.factions.map((f) => ({
      id: f.id,
      colorHue: f.colorHue,
      ownerId: f.ownerId || null,
      cx: f.cx,
      cy: f.cy
    })),
    agents: arenaState.agents.map((a) => ({
      x: a.x,
      y: a.y,
      r: a.radius,
      factionId: a.factionId
    }))
  };

  const payload = JSON.stringify({
    type: "state",
    state: snapshot
  });

  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ====== WEBSOCKET HANDLERS ======
wss.on("connection", (ws) => {
  console.log("Client connected");

  // send a quick hello / initial state
  ws.send(
    JSON.stringify({
      type: "hello",
      message: "Connected to Midway server"
    })
  );

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "spawnFaction") {
      spawnNewFaction(msg.playerId || null);
    } else if (msg.type === "addChaos") {
      addChaos();
    } else if (msg.type === "focusPoint") {
      if (
        msg.playerId &&
        typeof msg.x === "number" &&
        typeof msg.y === "number"
      ) {
        arenaState.playerFocus[msg.playerId] = {
          x: msg.x,
          y: msg.y,
          ttl: 2.0
        };
      }
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

// ====== MAIN LOOP ======
const FIXED_DT_MS = 16;
let lastSimTime = Date.now();

const BROADCAST_INTERVAL_MS = 100;
let lastBroadcastTime = Date.now();

setInterval(() => {
  const now = Date.now();

  ensureInitialFactions();

  if (now - lastSimTime >= FIXED_DT_MS) {
    const steps = Math.floor((now - lastSimTime) / FIXED_DT_MS);
    for (let i = 0; i < steps; i++) {
      stepSimulation(FIXED_DT_MS / 16.666);
    }
    lastSimTime += steps * FIXED_DT_MS;
  }

  if (now - lastBroadcastTime >= BROADCAST_INTERVAL_MS) {
    lastBroadcastTime = now;
    broadcastState();
  }
}, 16);

server.listen(PORT, () => {
  console.log(`Midway server listening on port ${PORT}`);
});
