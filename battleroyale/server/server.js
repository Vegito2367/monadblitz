// server/server.js
import { WebSocketServer } from "ws";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const MAP_SIZE = 64;

const wss = new WebSocketServer({ port: PORT });

/**
 * players: id -> { x, y, alive, score, name }
 * sockets: ws -> id
 * tileOccupant: "x,y" -> id
 */
const players = new Map();
const sockets = new Map();
const tileOccupant = new Map();

function key(x, y) {
  return `${x},${y}`;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function randPos() {
  return {
    x: Math.floor(Math.random() * MAP_SIZE),
    y: Math.floor(Math.random() * MAP_SIZE),
  };
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function spawnUnoccupied(maxTries = 80) {
  for (let i = 0; i < maxTries; i++) {
    const p = randPos();
    if (!tileOccupant.has(key(p.x, p.y))) return p;
  }
  // fallback (rare)
  return randPos();
}

function computeMove(pos, dir) {
  let { x, y } = pos;
  if (dir === 0) y -= 1; // up
  else if (dir === 1) y += 1; // down
  else if (dir === 2) x -= 1; // left
  else if (dir === 3) x += 1; // right
  return { x: clamp(x, 0, MAP_SIZE - 1), y: clamp(y, 0, MAP_SIZE - 1) };
}

function removeFromTile(pid) {
  const p = players.get(pid);
  if (!p) return;
  const k = key(p.x, p.y);
  if (tileOccupant.get(k) === pid) tileOccupant.delete(k);
}

function placeOnTile(pid) {
  const p = players.get(pid);
  if (!p) return;
  tileOccupant.set(key(p.x, p.y), pid);
}

function sanitizeName(name) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim().slice(0, 12);
  // keep simple safe chars
  return trimmed.replace(/[^a-zA-Z0-9 _.-]/g, "");
}

function publicPlayersObject() {
  return Object.fromEntries(players);
}

wss.on("connection", (ws) => {
  const id = `p_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  sockets.set(ws, id);

  const pos = spawnUnoccupied();
  const player = { x: pos.x, y: pos.y, alive: true, score: 0, name: "" };
  players.set(id, player);
  tileOccupant.set(key(pos.x, pos.y), id);

  // full state
  send(ws, {
    type: "welcome",
    id,
    mapSize: MAP_SIZE,
    players: publicPlayersObject(),
  });

  broadcast({ type: "player_joined", id, player });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const pid = sockets.get(ws);
    if (!pid) return;

    // Set username
    if (msg.type === "set_name") {
      const me = players.get(pid);
      if (!me) return;
      me.name = sanitizeName(msg.name);
      broadcast({ type: "player_named", id: pid, name: me.name });
      return;
    }

    // Move
    if (msg.type === "move") {
      const dir = msg.dir;
      if (![0, 1, 2, 3].includes(dir)) return;

      const me = players.get(pid);
      if (!me || !me.alive) return;

      const from = { x: me.x, y: me.y };
      const to = computeMove(from, dir);

      // no movement at edge
      if (to.x === from.x && to.y === from.y) return;

      const toKey = key(to.x, to.y);
      const victimId = tileOccupant.get(toKey);

      // moving: free old tile
      removeFromTile(pid);

      if (victimId && victimId !== pid) {
        const victim = players.get(victimId);
        if (victim && victim.alive) {
          // killer gets +1
          me.score += 1;

          // victim dies -> score reset + immediate respawn
          victim.score = 0;
          victim.alive = false;
          removeFromTile(victimId);

          // broadcast kill feed event
          broadcast({
            type: "kill_feed",
            killer: pid,
            victim: victimId,
            killerName: me.name || pid,
            victimName: victim.name || victimId,
            killerScore: me.score,
          });

          // immediate respawn victim
          const resp = spawnUnoccupied();
          victim.x = resp.x;
          victim.y = resp.y;
          victim.alive = true;
          placeOnTile(victimId);

          broadcast({
            type: "player_respawned",
            id: victimId,
            player: victim, // includes score reset = 0
          });
        }
      }

      // move killer into destination
      me.x = to.x;
      me.y = to.y;
      me.alive = true;
      placeOnTile(pid);

      broadcast({ type: "player_moved", id: pid, pos: { x: me.x, y: me.y } });
      broadcast({ type: "player_score", id: pid, score: me.score }); // lightweight score sync
      return;
    }
  });

  ws.on("close", () => {
    const pid = sockets.get(ws);
    sockets.delete(ws);
    if (!pid) return;
    removeFromTile(pid);
    players.delete(pid);
    broadcast({ type: "player_left", id: pid });
  });
});

console.log(`WS server running on ws://localhost:${PORT}`);
