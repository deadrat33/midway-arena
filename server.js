const express = require("express");
const http = require("http");
const WebSocket = require("ws");

// Basic Express app to serve the client
const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ====== GAME STATE ======
let arenaState = {
  factions: [], // [{ id, colorHue, cx, cy }]
  agents: [],   // [{ id, x, y, vx, vy, factionId, radius, energy }]
  tick: 0
};

function makeFactionId() {
  return "F" + Math.random().toString(36).slice(2, 8);
}

function makeAgentId() {
  return "A" + Math.random().toString(36).slice(2, 8);
}

function randomHue() {
  return Math.floor(Math.random() * 360);
}

// Logical arena size
const ARENA_WIDTH = 1280;
const ARENA_HEIGHT = 720;

function ensureInitialFactions() {
  if (arenaState.factions.length === 0 && arenaState.agents.length === 0) {
    const f1 = {
      id: makeFactionId(),
      colorHue: randomHue(),
      cx: ARENA_WIDTH * 0.3,
      cy: ARENA_HEIGHT * 0.5
    };
    const f2 = {
      id: makeFactionId(),
      colorHue: (f1.colorHue + 180) % 360,
      cx: ARENA_WIDTH * 0.7,
      cy: ARENA_HEIGHT * 0.5
    };
    arenaState.factions.push(f1, f2);

    spawnAgentsForFaction(f1, 70);
    spawnAgentsForFaction(f2, 70);
  }
}

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
      id: makeAgentId(),
      x,
      y,
      vx,
      vy,
      factionId: faction.id,
      radius: 3 + Math.random() * 2,
      energy: 1 + Math.random() * 0.5
    });
  }
}

function spawnNewFaction() {
  const faction = {
    id: makeFactionId(),
    colorHue: randomHue(),
    cx: ARENA_WIDTH * (0.2 + 0.6 * Math.random()),
    cy: ARENA_HEIGHT * (0.2 + 0.8 * Math.random())
  };
  arenaState.factions.push(faction);
  spawnAgentsForFaction(faction, 60);
}

function applyChaosNudge() {
  for (const a of arenaState.agents) {
    a.vx += (Math.random() - 0.5) * 1.8;
    a.vy += (Math.random() - 0.5) * 1.8;
  }
}

// ====== PHYSICS LOOP ======
function stepSimulation(dtUnits) {
  const agents = arenaState.agents;
  const factions = arenaState.factions;

  for (const agent of agents) {
    const jitter = 0.12;
    agent.vx += (Math.random() - 0.5) * jitter * dtUnits;
    agent.vy += (Math.random() - 0.5) * jitter * dtUnits;

    const faction = factions.find((f) => f.id === agent.factionId);
    if (faction) {
      const fx = (faction.cx - agent.x) * 0.0008 * dtUnits;
      const fy = (faction.cy - agent.y) * 0.0008 * dtUnits;
      agent.vx += fx;
      agent.vy += fy;
    }

    const maxSpeed = 2.5;
    const speed = Math.hypot(agent.vx, agent.vy);
    if (speed > maxSpeed) {
      agent.vx = (agent.vx / speed) * maxSpeed;
      agent.vy = (agent.vy / speed) * maxSpeed;
    }

    agent.x += agent.vx * dtUnits;
    agent.y += agent.vy * dtUnits;

    if (agent.x < 0) agent.x += ARENA_WIDTH;
    if (agent.x > ARENA_WIDTH) agent.x -= ARENA_WIDTH;
    if (agent.y < 0) agent.y += ARENA_HEIGHT;
    if (agent.y > ARENA_HEIGHT) agent.y -= ARENA_HEIGHT;

    agent.energy -= 0.0008 * dtUnits;
  }

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (a.energy <= 0) continue;
    for (let j = i + 1; j < agents.length; j++) {
      const b = agents[j];
      if (b.energy <= 0) continue;
      if (a.factionId === b.factionId) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const sumR = a.radius + b.radius;
      if (dx * dx + dy * dy <= sumR * sumR) {
        let winner, loser;
        if (Math.abs(a.energy - b.energy) < 0.05) {
          winner = Math.random() < 0.5 ? a : b;
          loser = winner === a ? b : a;
        } else if (a.energy > b.energy) {
          winner = a;
          loser = b;
        } else {
          winner = b;
          loser = a;
        }

        winner.energy += loser.energy * 0.5;
        loser.energy = 0;

        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dx / dist;
        const ny = dy / dist;
        winner.vx += nx * 0.2;
        winner.vy += ny * 0.2;
      }
    }
  }

  arenaState.agents = arenaState.agents.filter((a) => a.energy > 0);

  const aliveFactionIds = new Set(arenaState.agents.map((a) => a.factionId));
  arenaState.factions = arenaState.factions.filter((f) =>
    aliveFactionIds.has(f.id)
  );

  arenaState.tick++;
}

// ====== WEBSOCKET BROADCAST ======
function broadcastState() {
  const payload = JSON.stringify({
    type: "state",
    state: arenaState
  });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ====== WEBSOCKET SERVER ======
wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.send(
    JSON.stringify({
      type: "state",
      state: arenaState
    })
  );

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "command") {
        if (data.command === "spawnFaction") {
          spawnNewFaction();
        } else if (data.command === "chaosNudge") {
          applyChaosNudge();
        }
      }
    } catch (err) {
      console.error("Invalid message:", err);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

// ====== MAIN LOOP ======
const FIXED_DT_MS = 16;
let lastSimTime = Date.now();

const BROADCAST_INTERVAL_MS = 250;
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
}, 5);

// ====== START SERVER ======
server.listen(PORT, () => {
  console.log(`Midway server running on port ${PORT}`);
});
