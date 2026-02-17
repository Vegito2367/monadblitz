import { useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";

const MAP_SIZE = 64;

type PlayerId = string;
type Player = { x: number; y: number; alive: boolean; score: number; name: string };
type KillFeedItem = { text: string; ts: number };

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function useIsCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(pointer: coarse)");
    if (!mq) return;
    const onChange = () => setCoarse(!!mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return coarse;
}

function sanitizeName(name: string) {
  const trimmed = (name ?? "").trim().slice(0, 12);
  return trimmed.replace(/[^a-zA-Z0-9 _.-]/g, "");
}

function shortAddr(a: string) {
  return a.slice(0, 6) + "…" + a.slice(-4);
}

/** Burner wallet infra: persist private key locally so refresh keeps identity */
function loadOrCreateBurner(): ethers.Wallet {
  const key = "arena_burner_pk";
  const pk = localStorage.getItem(key);
  if (pk && pk.startsWith("0x") && pk.length === 66) {
    return new ethers.Wallet(pk);
  }
  const w = ethers.Wallet.createRandom();
  localStorage.setItem(key, w.privateKey);
  return w;
}

export default function App() {
  const coarse = useIsCoarsePointer();

  // ----- Burner wallet (infra only, not used for WS auth yet) -----
  const burner = useMemo(() => loadOrCreateBurner(), []);
  // Later you’ll connect burner to a provider or just sign typed data locally.

  async function signIntent(payload: object) {
    // Placeholder signing scheme for later onchain/relayer:
    // Keep it simple now: sign a JSON string. Later: switch to EIP-712.
    const msg = JSON.stringify(payload);
    return burner.signMessage(msg);
  }

  // --- canvas sizing ---
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tile, setTile] = useState<number>(10);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const calc = () => {
      const w = Math.min(el.clientWidth, 720);
      const t = Math.floor(w / MAP_SIZE);
      setTile(clamp(t, 6, 16));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    window.addEventListener("orientationchange", calc);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", calc);
    };
  }, []);

  const arenaPx = useMemo(() => MAP_SIZE * tile, [tile]);

  // --- authoritative state (WS today; chain events later) ---
  const playersRef = useRef<Map<PlayerId, Player>>(new Map());

  // --- UI snapshots ---
  const [status, setStatus] = useState("Connecting…");
  const [myId, setMyId] = useState<PlayerId | null>(null);
  const [playerCount, setPlayerCount] = useState(0);
  const [myScore, setMyScore] = useState(0);
  const [leaderboard, setLeaderboard] = useState<Array<{ id: string; name: string; score: number }>>([]);
  const [killFeed, setKillFeed] = useState<KillFeedItem[]>([]);

  // --- Name modal gate ---
  const [nameInput, setNameInput] = useState<string>(() => localStorage.getItem("arena_name") ?? "");
  const [hasSetName, setHasSetName] = useState<boolean>(() => {
    const stored = localStorage.getItem("arena_name") ?? "";
    return sanitizeName(stored).length > 0;
  });
  const [showNameModal, setShowNameModal] = useState<boolean>(() => {
    const stored = localStorage.getItem("arena_name") ?? "";
    return sanitizeName(stored).length === 0;
  });

  // --- event handlers (keep these when swapping to onchain) ---
  function onPlayerUpsert(id: PlayerId, player: Player) {
    playersRef.current.set(id, player);
    setPlayerCount(playersRef.current.size);
    if (myId && id === myId) setMyScore(player.score);
  }

  function onPlayerLeft(id: PlayerId) {
    playersRef.current.delete(id);
    setPlayerCount(playersRef.current.size);
  }

  function onPlayerMoved(id: PlayerId, pos: { x: number; y: number }) {
    const p = playersRef.current.get(id);
    if (!p) return;
    p.x = pos.x;
    p.y = pos.y;
    p.alive = true;
  }

  function onPlayerNamed(id: PlayerId, name: string) {
    const p = playersRef.current.get(id);
    if (!p) return;
    p.name = name;
  }

  function onPlayerScore(id: PlayerId, score: number) {
    const p = playersRef.current.get(id);
    if (!p) return;
    p.score = score;
    if (myId && id === myId) setMyScore(score);
  }

  function onKillFeedLine(text: string) {
    setKillFeed((prev) => {
      const next = [{ text, ts: Date.now() }, ...prev];
      return next.slice(0, 10);
    });
  }

  // --- WS transport ---
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const wsUrl =
      new URLSearchParams(window.location.search).get("ws") ||
      `ws://${window.location.hostname}:8787`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setStatus(`Connected: ${wsUrl}`);
    ws.onerror = () => setStatus(`WS error (is server running?)`);
    ws.onclose = () => setStatus(`Disconnected`);

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === "welcome") {
        setMyId(msg.id);

        const map = new Map<PlayerId, Player>();
        for (const [id, player] of Object.entries(msg.players as Record<string, Player>)) {
          map.set(id, player);
        }
        playersRef.current = map;
        setPlayerCount(map.size);
        setMyScore(map.get(msg.id)?.score ?? 0);
        setStatus(`Connected: ${wsUrl} · You are ${msg.id} (red) · Burner: ${shortAddr(burner.address)}`);

        // If name already stored, immediately set it on server
        const stored = sanitizeName(localStorage.getItem("arena_name") ?? "");
        if (stored) {
          requestSetName(stored);
          setHasSetName(true);
          setShowNameModal(false);
        }
        return;
      }

      if (msg.type === "player_joined") {
        onPlayerUpsert(msg.id, msg.player);
        return;
      }

      if (msg.type === "player_left") {
        onPlayerLeft(msg.id);
        return;
      }

      if (msg.type === "player_moved") {
        onPlayerMoved(msg.id, msg.pos);
        return;
      }

      if (msg.type === "player_named") {
        onPlayerNamed(msg.id, msg.name);
        return;
      }

      if (msg.type === "player_score") {
        onPlayerScore(msg.id, msg.score);
        return;
      }

      if (msg.type === "kill_feed") {
        const line = `${msg.killerName} killed ${msg.victimName} (+1)`;
        onKillFeedLine(line);
        onPlayerScore(msg.killer, msg.killerScore);
        return;
      }

      if (msg.type === "player_respawned") {
        onPlayerUpsert(msg.id, msg.player);
        return;
      }
    };

    return () => {
      try {
        ws.close();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burner.address]);

  // --- intent functions (later become tx submission) ---
  function requestMove(dir: 0 | 1 | 2 | 3) {
    if (!hasSetName) return; // gate playing
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Later: use burner signatures and relay/onchain.
    // For now: plain WS message.
    ws.send(JSON.stringify({ type: "move", dir }));
  }

  function requestSetName(name: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "set_name", name }));
  }

  // keyboard support
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!hasSetName) return;
      if (e.key === "ArrowUp" || e.key === "w") requestMove(0);
      else if (e.key === "ArrowDown" || e.key === "s") requestMove(1);
      else if (e.key === "ArrowLeft" || e.key === "a") requestMove(2);
      else if (e.key === "ArrowRight" || e.key === "d") requestMove(3);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasSetName]);

  // swipe controls on canvas
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const SWIPE_MIN_PX = coarse ? 18 : 12;

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!hasSetName) return;
    (e.currentTarget as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!hasSetName) return;
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start) return;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    if (adx < SWIPE_MIN_PX && ady < SWIPE_MIN_PX) return;

    if (adx > ady) requestMove(dx > 0 ? 3 : 2);
    else requestMove(dy > 0 ? 1 : 0);
  };

  // leaderboard refresh loop
  useEffect(() => {
    const t = window.setInterval(() => {
      const arr = Array.from(playersRef.current.entries())
        .map(([id, p]) => ({ id, name: p.name || id.slice(0, 10), score: p.score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      setLeaderboard(arr);
      if (myId) setMyScore(playersRef.current.get(myId)?.score ?? 0);
    }, 250);
    return () => window.clearInterval(t);
  }, [myId]);

  // --- renderer ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const t = tile;
      const W = MAP_SIZE * t;
      const H = MAP_SIZE * t;

      const dpr = window.devicePixelRatio || 1;
      const wantW = Math.floor(W * dpr);
      const wantH = Math.floor(H * dpr);
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW;
        canvas.height = wantH;
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      ctx.clearRect(0, 0, W, H);

      // grid
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      for (let i = 0; i <= MAP_SIZE; i++) {
        const p = i * t;
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, H);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, p);
        ctx.lineTo(W, p);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      const me = myId?.toLowerCase();
      const players = playersRef.current;

      for (const [id, p] of players.entries()) {
        if (!p.alive) continue; // server currently instant respawns anyway
        const cx = p.x * t + t / 2;
        const cy = p.y * t + t / 2;
        const r = Math.max(2, t * 0.32);

        const isMe = me && id.toLowerCase() === me;

        if (isMe) {
          // RED for current player
          ctx.beginPath();
          ctx.arc(cx, cy, r * 2.3, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,80,80,0.22)";
          ctx.fill();

          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,80,80,0.95)";
          ctx.fill();

          ctx.beginPath();
          ctx.arc(cx, cy, r + 0.9, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,255,255,0.70)";
          ctx.stroke();
        } else {
          // default dot style
          ctx.beginPath();
          ctx.arc(cx, cy, r * 2.3, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(120,180,255,0.20)";
          ctx.fill();

          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(180,220,255,0.92)";
          ctx.fill();

          ctx.beginPath();
          ctx.arc(cx, cy, r + 0.75, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,255,255,0.65)";
          ctx.stroke();
        }
      }
    };

    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tile, myId]);

  // ----- Name modal submit -----
  const submitName = async () => {
    const name = sanitizeName(nameInput);
    if (!name) return;

    localStorage.setItem("arena_name", name);
    setHasSetName(true);
    setShowNameModal(false);
    requestSetName(name);

    // “infra”: example of signing something with burner (not used yet)
    // Useful for your future relay:
    // const sig = await signIntent({ action: "set_name", name, ts: Date.now() });
    // console.log("burner signature example:", sig);
  };

  // block page scroll while modal open (optional but nice on mobile)
  useEffect(() => {
    if (!showNameModal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [showNameModal]);

  return (
    <div ref={containerRef} style={{ maxWidth: 1200, margin: "0 auto", padding: coarse ? 14 : 18 }}>
      {/* Name modal gate */}
      {showNameModal && (
        <div style={modalBackdrop}>
          <div style={modalCard}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>Enter your name</div>
            <div style={{ opacity: 0.75, marginTop: 6, lineHeight: 1.4, fontSize: 13 }}>
              Required to play. Your name appears in the kill feed.
            </div>

            <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
              <input
                autoFocus
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="e.g. tej"
                maxLength={12}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitName();
                }}
                style={nameInputStyle}
              />
              <button
                onClick={submitName}
                disabled={!sanitizeName(nameInput)}
                style={{ borderRadius: 12, padding: "12px 12px", fontWeight: 850 }}
              >
                Start playing
              </button>

              <div style={{ opacity: 0.6, fontSize: 12 }}>
                Burner wallet: <span className="kbd">{shortAddr(burner.address)}</span> (auto-created on this device)
              </div>
            </div>
          </div>
        </div>
      )}

      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: coarse ? 18 : 22, fontWeight: 850 }}>Monad Arena — Instant Respawn</div>
          <div style={{ opacity: 0.78, marginTop: 6, fontSize: 14 }}>
            Players: <span className="kbd">{playerCount}</span> · Your kills: <span className="kbd">{myScore}</span>
          </div>
          <div style={{ opacity: 0.75, marginTop: 6, fontSize: 13 }}>{status}</div>
          <div style={{ opacity: 0.7, marginTop: 6, fontSize: 13 }}>
            Name: <span className="kbd">{sanitizeName(localStorage.getItem("arena_name") ?? "") || "—"}</span> · Burner:{" "}
            <span className="kbd">{shortAddr(burner.address)}</span>
          </div>
        </div>

        <div style={{ width: 320, display: "grid", gap: 12 }}>
          <div style={panelStyle}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Leaderboard</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {leaderboard.map((e) => (
                <div key={e.id} style={{ display: "flex", justifyContent: "space-between", opacity: 0.9 }}>
                  <span style={{ color: myId === e.id ? "rgba(255,120,120,0.95)" : "rgba(180,220,255,0.92)" }}>
                    {myId === e.id ? "YOU" : e.name}
                  </span>
                  <span className="kbd">{e.score}</span>
                </div>
              ))}
              {leaderboard.length === 0 && <div style={{ opacity: 0.7 }}>No players yet</div>}
            </div>
          </div>

          <div style={panelStyle}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Kill feed</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {killFeed.map((k) => (
                <div key={k.ts} style={{ opacity: 0.85, fontSize: 13 }}>
                  {k.text}
                </div>
              ))}
              {killFeed.length === 0 && <div style={{ opacity: 0.7, fontSize: 13 }}>No kills yet</div>}
            </div>
          </div>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14, marginTop: 14 }}>
        <div style={{ ...panelStyle, padding: 12, overflow: "auto" }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <canvas
              ref={canvasRef}
              aria-label="Arena"
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              style={{
                width: arenaPx,
                height: arenaPx,
                borderRadius: 14,
                background: "rgba(0,0,0,0.28)",
                boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
                touchAction: "none",
                opacity: hasSetName ? 1 : 0.5,
              }}
            />
          </div>
        </div>

        <div style={{ ...panelStyle, padding: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Move</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "64px 64px 64px",
              gridTemplateRows: "64px 64px 64px",
              gap: 10,
              justifyContent: "center",
            }}
          >
            <div />
            <button onClick={() => requestMove(0)} style={dpadBtnStyle} disabled={!hasSetName}>
              ↑
            </button>
            <div />
            <button onClick={() => requestMove(2)} style={dpadBtnStyle} disabled={!hasSetName}>
              ←
            </button>
            <button onClick={() => requestMove(1)} style={dpadBtnStyle} disabled={!hasSetName}>
              ↓
            </button>
            <button onClick={() => requestMove(3)} style={dpadBtnStyle} disabled={!hasSetName}>
              →
            </button>
          </div>
          <div style={{ opacity: 0.75, marginTop: 12, fontSize: 13, textAlign: "center" }}>
            Collide into someone to kill them. If you die, you instantly respawn with score reset.
          </div>
        </div>
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 16,
};

const dpadBtnStyle: React.CSSProperties = {
  borderRadius: 16,
  fontSize: 22,
  fontWeight: 900,
  padding: 0,
  display: "grid",
  placeItems: "center",
  height: 64,
  width: 64,
  background: "rgba(255,255,255,0.08)",
};

const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "grid",
  placeItems: "center",
  zIndex: 9999,
  padding: 16,
};

const modalCard: React.CSSProperties = {
  width: "min(420px, 100%)",
  background: "rgba(20,24,30,0.96)",
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 18,
  padding: 16,
  boxShadow: "0 20px 50px rgba(0,0,0,0.55)",
};

const nameInputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.14)",
  color: "rgba(255,255,255,0.92)",
  borderRadius: 12,
  padding: "12px 12px",
  outline: "none",
  fontSize: 16,
};
