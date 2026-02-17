import { useEffect, useMemo, useRef, useState } from "react";

const MAP_SIZE = 64;
type PlayerId = string;
type Pos = { x: number; y: number };

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

export default function App() {
  const coarse = useIsCoarsePointer();

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

  // --- multiplayer state ---
  const [status, setStatus] = useState("Connecting…");
  const [myId, setMyId] = useState<PlayerId | null>(null);

  // keep players in a ref for fast rendering without rerender on every update
  const playersRef = useRef<Map<PlayerId, Pos>>(new Map());
  const [playerCount, setPlayerCount] = useState(0);

  // --- websocket connect ---
  useEffect(() => {
    // default: ws://<host>:8787 (same host as your Vite page)
    const wsUrl =
      new URLSearchParams(window.location.search).get("ws") ||
      `ws://${window.location.hostname}:8787`;

    const ws = new WebSocket(wsUrl);

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
        const map = new Map<PlayerId, Pos>();
        for (const [id, pos] of Object.entries(msg.players as Record<string, Pos>)) {
          map.set(id, pos);
        }
        playersRef.current = map;
        setPlayerCount(map.size);
        setStatus(`Connected: ${wsUrl} · You are ${msg.id}`);
        return;
      }

      if (msg.type === "player_joined") {
        playersRef.current.set(msg.id, msg.pos);
        setPlayerCount(playersRef.current.size);
        return;
      }

      if (msg.type === "player_moved") {
        playersRef.current.set(msg.id, msg.pos);
        return;
      }

      if (msg.type === "player_left") {
        playersRef.current.delete(msg.id);
        setPlayerCount(playersRef.current.size);
        return;
      }
    };

    // store ws on ref for move sends
    (window as any).__monad_ws__ = ws;

    return () => {
      try { ws.close(); } catch {}
      if ((window as any).__monad_ws__ === ws) delete (window as any).__monad_ws__;
    };
  }, []);

  // --- send move ---
  const sendMove = (dir: 0 | 1 | 2 | 3) => {
    const ws: WebSocket | undefined = (window as any).__monad_ws__;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "move", dir }));
  };

  // keyboard support
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "w") sendMove(0);
      else if (e.key === "ArrowDown" || e.key === "s") sendMove(1);
      else if (e.key === "ArrowLeft" || e.key === "a") sendMove(2);
      else if (e.key === "ArrowRight" || e.key === "d") sendMove(3);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- swipe controls on canvas ---
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const SWIPE_MIN_PX = coarse ? 18 : 12;

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.currentTarget as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start) return;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    if (adx < SWIPE_MIN_PX && ady < SWIPE_MIN_PX) return;

    if (adx > ady) sendMove(dx > 0 ? 3 : 2);
    else sendMove(dy > 0 ? 1 : 0);
  };

  // --- renderer (60fps) ---
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

      // players
      const me = myId?.toLowerCase();
      const players = playersRef.current;

      for (const [id, pos] of players.entries()) {
        const cx = pos.x * t + t / 2;
        const cy = pos.y * t + t / 2;
        const r = Math.max(2, t * 0.32);

        const isMe = me && id.toLowerCase() === me;

        // glow (keep your original look for non-me; red for me)
        if (isMe) {
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
          ctx.beginPath();
          ctx.arc(cx, cy, r * 2.3, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(120,180,255,0.20)";
          ctx.fill();

          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(180,220,255,0.92)"; // your existing default dot
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

  return (
    <div ref={containerRef} style={{ maxWidth: 1000, margin: "0 auto", padding: coarse ? 14 : 18 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <div style={{ fontSize: coarse ? 18 : 22, fontWeight: 850 }}>Monad Arena — Local Multiplayer</div>
          <div style={{ opacity: 0.78, marginTop: 6, fontSize: 14 }}>
            Players connected: <span className="kbd">{playerCount}</span>
          </div>
          <div style={{ opacity: 0.75, marginTop: 6, fontSize: 13 }}>
            {status}
            {myId ? (
              <>
                {" "}· You are <span className="kbd">{myId}</span> (red)
              </>
            ) : null}
          </div>
          <div style={{ opacity: 0.7, marginTop: 6, fontSize: 13 }}>
            Swipe on arena · buttons · <span className="kbd">WASD</span>/<span className="kbd">Arrows</span>
          </div>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14, marginTop: 14 }}>
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 18,
            padding: 12,
            overflow: "auto",
          }}
        >
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
              }}
            />
          </div>
        </div>

        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 18,
            padding: 14,
          }}
        >
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
            <button onClick={() => sendMove(0)} style={dpadBtnStyle}>↑</button>
            <div />
            <button onClick={() => sendMove(2)} style={dpadBtnStyle}>←</button>
            <button onClick={() => sendMove(1)} style={dpadBtnStyle}>↓</button>
            <button onClick={() => sendMove(3)} style={dpadBtnStyle}>→</button>
          </div>
          <div style={{ opacity: 0.75, marginTop: 12, fontSize: 13, textAlign: "center" }}>
            Tip: open this page on multiple phones to simulate crowd spam.
          </div>
        </div>
      </div>
    </div>
  );
}

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
