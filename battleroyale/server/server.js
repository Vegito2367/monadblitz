// server/server.js
// Minimal WS server for local multiplayer.
// Run: node server/server.js
// Then open the Vite site on your phone and it will connect to ws://<laptop-ip>:8787

import { WebSocketServer } from "ws";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const MAP_SIZE = 64;

const wss = new WebSocketServer({ port: PORT });

/**
 * players: id -> { x, y }
 * sockets: ws -> id
 */
const players = new Map();
const sockets = new Map();

function randPos() {
  return { x: Math.floor(Math.random() * MAP_SIZE), y: Math.floor(Math.random() * MAP_SIZE) };
}

function broadcast(msgObj) {
  const msg = JSON.stringify(msgObj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function send(ws, msgObj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msgObj));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function move(pos, dir) {
  let { x, y } = pos;
  if (dir === 0) y -= 1;      // up
  else if (dir === 1) y += 1; // down
  else if (dir === 2) x -= 1; // left
  else if (dir === 3) x += 1; // right
  return { x: clamp(x, 0, MAP_SIZE - 1), y: clamp(y, 0, MAP_SIZE - 1) };
}

wss.on("connection", (ws) => {
  // assign player id
  const id = `p_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  sockets.set(ws, id);

  // spawn
  players.set(id, randPos());

  // send full state to new client
  send(ws, { type: "welcome", id, mapSize: MAP_SIZE, players: Object.fromEntries(players) });

  // notify others
  broadcast({ type: "player_joined", id, pos: players.get(id) });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const pid = sockets.get(ws);
    if (!pid) return;

    if (msg.type === "move") {
      const dir = msg.dir;
      if (![0,1,2,3].includes(dir)) return;

      const pos = players.get(pid);
      if (!pos) return;

      const next = move(pos, dir);
      players.set(pid, next);

      // broadcast just this player's update
      broadcast({ type: "player_moved", id: pid, pos: next });
    }
  });

  ws.on("close", () => {
    const pid = sockets.get(ws);
    sockets.delete(ws);
    if (pid) {
      players.delete(pid);
      broadcast({ type: "player_left", id: pid });
    }
  });
});

console.log(`WS server running on ws://localhost:${PORT}`);
