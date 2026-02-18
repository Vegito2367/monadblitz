"use client";

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";

const MAP_SIZE = 24;

type PlayerId = string;
type Player = { x: number; y: number; alive: boolean; score: number; name: string };
type KillFeedItem = { id: string; text: string; ts: number };

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
function loadOrCreateBurner(): ethers.Wallet | ethers.HDNodeWallet {
  if (typeof window === "undefined") {
    return ethers.Wallet.createRandom();
  }

  const key = "arena_burner_pk";
  const pk = sessionStorage.getItem(key);

  if (pk && pk.startsWith("0x") && pk.length === 66) {
    return new ethers.Wallet(pk);
  }

  const w = ethers.Wallet.createRandom();
  sessionStorage.setItem(key, w.privateKey);
  return w;
}

// -------------------- Arena ABI (events + nonce read) --------------------
const ARENA_ABI = [
  "function nonces(address) view returns (uint256)",
  "event NameSet(address indexed player, bytes12 name)",
  "event Joined(address indexed player, uint8 x, uint8 y, bytes12 name)",
  "event Moved(address indexed player, uint8 fromX, uint8 fromY, uint8 toX, uint8 toY)",
  "event Killed(address indexed killer, address indexed victim, uint32 killerScore, bytes12 killerName, bytes12 victimName)",
  "event Respawned(address indexed player, uint8 x, uint8 y, uint32 score)",
  "event Kicked(address indexed player, uint8 x, uint8 y, bytes12 name, uint256 lastActiveAt)",
] as const;

const arenaIface = new ethers.Interface(ARENA_ABI);

function bytes12ToString(b12: string): string {
  const raw = ethers.getBytes(b12);
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  return ethers.toUtf8String(raw.slice(0, end));
}

function toBytes12FromName(name: string): string {
  const trimmed = (name ?? "").trim().slice(0, 12);
  const bytes = ethers.toUtf8Bytes(trimmed);
  const sliced = bytes.length > 12 ? bytes.slice(0, 12) : bytes;
  const padded = ethers.zeroPadBytes(sliced, 12);
  return ethers.hexlify(padded); // 0x + 24 hex chars
}

enum ActionType {
  SET_NAME = 0,
  JOIN = 1,
  MOVE = 2,
}

function commonDomain(chainId: bigint, arenaAddress: string): string {
  return ethers.keccak256(
    ethers.solidityPacked(["uint256", "address"], [chainId, arenaAddress as `0x${string}`])
  );
}

function digestJoin(params: {
  chainId: bigint;
  arenaAddress: string;
  player: string;
  nonce: bigint;
  deadline: bigint;
}): string {
  const domain = commonDomain(params.chainId, params.arenaAddress);
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "uint8", "address", "uint256", "uint256"],
      [domain, ActionType.JOIN, params.player as `0x${string}`, params.nonce, params.deadline]
    )
  );
}

function digestMove(params: {
  chainId: bigint;
  arenaAddress: string;
  player: string;
  dir: number;
  nonce: bigint;
  deadline: bigint;
}): string {
  const domain = commonDomain(params.chainId, params.arenaAddress);
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "uint8", "address", "uint8", "uint256", "uint256"],
      [domain, ActionType.MOVE, params.player as `0x${string}`, params.dir, params.nonce, params.deadline]
    )
  );
}

function digestSetName(params: {
  chainId: bigint;
  arenaAddress: string;
  player: string;
  nameBytes12: string;
  nonce: bigint;
  deadline: bigint;
}): string {
  const domain = commonDomain(params.chainId, params.arenaAddress);
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "uint8", "address", "bytes12", "uint256", "uint256"],
      [
        domain,
        ActionType.SET_NAME,
        params.player as `0x${string}`,
        params.nameBytes12 as `0x${string}`,
        params.nonce,
        params.deadline,
      ]
    )
  );
}

// ------------------------------------------------------------------------

export default function App() {
  const coarse = useIsCoarsePointer();
  const moveInFlightRef = useRef(false);
  const pendingDirRef = useRef<0 | 1 | 2 | 3 | null>(null);

  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const kickInFlightRef = useRef<Set<string>>(new Set());

  const norm = (a: string) => a.toLowerCase();
  // ----- Burner wallet -----
  const [burner, setBurner] = useState<ethers.Wallet | ethers.HDNodeWallet | null>(null);
  useEffect(() => {
    setBurner(loadOrCreateBurner());
  }, []);

  // --- canvas sizing ---
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tile, setTile] = useState<number>(10);


  function markSeen(id: string) {
    lastSeenRef.current.set(id.toLowerCase(), Date.now());
  }



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

  // --- authoritative state (now: chain events over RPC WS) ---
  const playersRef = useRef<Map<PlayerId, Player>>(new Map());

  // --- UI snapshots ---
  const [status, setStatus] = useState("Connecting…");
  const [myId, setMyId] = useState<PlayerId | null>(null);
  const [playerCount, setPlayerCount] = useState(0);
  const [myScore, setMyScore] = useState(0);
  const [leaderboard, setLeaderboard] = useState<Array<{ id: string; name: string; score: number }>>([]);
  const [killFeed, setKillFeed] = useState<KillFeedItem[]>([]);

  // --- Name modal gate ---
  const [nameInput, setNameInput] = useState<string>("");
  const [hasSetName, setHasSetName] = useState<boolean>(false);
  const [showNameModal, setShowNameModal] = useState<boolean>(false);

  useEffect(() => {
    const stored = localStorage.getItem("arena_name") ?? "";
    setNameInput(stored);
    const hasName = sanitizeName(stored).length > 0;
    setHasSetName(hasName);
    setShowNameModal(!hasName);
  }, []);

  useEffect(() => {
    if (!hasSetName) return; // don’t kick until you’ve started playing

    const interval = window.setInterval(async () => {
      const now = Date.now();

      for (const [id] of playersRef.current.entries()) {
        const addr = id.toLowerCase();

        // don't kick yourself
        if (myId && addr === myId.toLowerCase()) continue;

        const last = lastSeenRef.current.get(addr);
        if (!last) continue;

        // 15s timeout in contract; give a tiny buffer so we don’t spam reverts
        if (now - last < 16_000) continue;

        // avoid spamming kick calls from this client
        if (kickInFlightRef.current.has(addr)) continue;
        kickInFlightRef.current.add(addr);

        try {
          await fetch("/api/kick", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ player: id }),
          });
        } catch {
          console.error("Failed to kick", id);
          // ignore
        } finally {
          // allow retry later if still present
          window.setTimeout(() => {
            kickInFlightRef.current.delete(addr);
          }, 3_000);
        }
      }
    }, 3_000); // every 3 seconds

    return () => window.clearInterval(interval);
  }, [hasSetName, myId]);

  // --- event handlers (same shape as before) ---
  function onPlayerUpsert(id: PlayerId, player: Player) {
    const key = norm(id);
    playersRef.current.set(key, player);
    markSeen(id);
    setPlayerCount(playersRef.current.size);
    if (myId && id.toLowerCase() === myId.toLowerCase()) setMyScore(player.score);
  }

  function onPlayerMoved(id: PlayerId, pos: { x: number; y: number }) {
    const key = norm(id);
    const p = playersRef.current.get(key);
    if (!p) return;
    p.x = pos.x;
    p.y = pos.y;
    p.alive = true;
    markSeen(id);
  }

  function onPlayerNamed(id: PlayerId, name: string) {
    const key = norm(id);
    const p = playersRef.current.get(key);
    if (!p) return;
    p.name = name;
    markSeen(id);
  }

  function onPlayerScore(id: PlayerId, score: number) {
    const key = norm(id);
    const p = playersRef.current.get(key);
    if (!p) return;
    p.score = score;
    if (myId && id.toLowerCase() === myId.toLowerCase()) setMyScore(score);
  }

  function onKillFeedLine(text: string) {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setKillFeed((prev) => [{ id, text, ts: Date.now() }, ...prev].slice(0, 10));
  }

  // --- Chain connection (WS provider) ---
  const providerRef = useRef<ethers.WebSocketProvider | null>(null);
  const arenaRef = useRef<ethers.Contract | null>(null);
  const chainIdRef = useRef<bigint | null>(null);

  const arenaAddress = useMemo(() => process.env.NEXT_PUBLIC_ARENA_ADDRESS || "", []);
  const rpcWsUrl = useMemo(() => process.env.NEXT_PUBLIC_RPC_WS_URL || "", []);

  // Subscribe to contract events (replaces local ws server)
  useEffect(() => {
    if (!arenaAddress || !rpcWsUrl) {
      setStatus("Missing NEXT_PUBLIC_ARENA_ADDRESS or NEXT_PUBLIC_RPC_WS_URL");
      return;
    }
    if (!burner) return;

    setMyId(norm(burner.address));
    setStatus("Connecting to chain…");

    const provider = new ethers.WebSocketProvider(rpcWsUrl);
    providerRef.current = provider;

    const arena = new ethers.Contract(arenaAddress, ARENA_ABI, provider);
    arenaRef.current = arena;

    let alive = true;

    (async () => {
      try {
        const net = await provider.getNetwork();
        chainIdRef.current = net.chainId;

        if (!alive) return;

        setStatus(
          `Connected: chainId ${net.chainId.toString()} · Arena ${shortAddr(arenaAddress)} · You ${shortAddr(
            burner.address
          )}`
        );

        // If name already stored, set it onchain via relayer, then join (idempotent)
        const stored = sanitizeName(localStorage.getItem("arena_name") ?? "");
        if (stored) {
          await requestSetName(stored);
          setHasSetName(true);
          setShowNameModal(false);
        }
        await requestJoin();
      } catch (e: any) {
        setStatus(`RPC WS error: ${e?.message || String(e)}`);
      }
    })();

    const filter = { address: arenaAddress as `0x${string}` };

    const onLog = (log: ethers.Log) => {
      console.log("got log", log);
      try {
        const parsed = arenaIface.parseLog(log);
        if (!parsed) return;

        const ev = parsed.name;
        const args: any = parsed.args;

        if (ev === "Joined") {
          const id = norm(args.player as string);
          const x = Number(args.x);
          const y = Number(args.y);
          const name = bytes12ToString(args.name);
          onPlayerUpsert(id, { x, y, alive: true, score: 0, name });
          return;
        }

        if (ev === "NameSet") {
          const id = norm(args.player as string);
          const nm = bytes12ToString(args.name);
          // ensure player exists in map
          if (!playersRef.current.has(id)) {
            onPlayerUpsert(id, { x: 0, y: 0, alive: true, score: 0, name: nm });
          } else {
            onPlayerNamed(id, nm);
          }
          return;
        }

        if (ev === "Moved") {
          const id = norm(args.player as string);
          const toX = Number(args.toX);
          const toY = Number(args.toY);

          if (!playersRef.current.has(id)) {
            onPlayerUpsert(id, { x: toX, y: toY, alive: true, score: 0, name: "" });
          } else {
            onPlayerMoved(id, { x: toX, y: toY });
          }
          return;
        }

        if (ev === "Killed") {
          const killer = norm(args.killer as string);
          const victim = norm(args.victim as string);
          const killerScore = Number(args.killerScore);
          const killerName = bytes12ToString(args.killerName);
          const victimName = bytes12ToString(args.victimName);
          markSeen(killer);
          markSeen(victim);
          // Update killer score + name
          if (!playersRef.current.has(killer)) {
            onPlayerUpsert(killer, { x: 0, y: 0, alive: true, score: killerScore, name: killerName });
          } else {
            if (killerName) onPlayerNamed(killer, killerName);
            onPlayerScore(killer, killerScore);
          }

          // Victim score resets; respawn event will update location
          if (playersRef.current.has(victim)) {
            onPlayerScore(victim, 0);
          }

          onKillFeedLine(`${killerName || shortAddr(killer)} killed ${victimName || shortAddr(victim)} (+1)`);
          return;
        }

        if (ev === "Respawned") {
          const id = norm((args.player as string));
          const x = Number(args.x);
          const y = Number(args.y);
          const score = Number(args.score);
          const existing = playersRef.current.get(id);

          onPlayerUpsert(id, {
            x,
            y,
            alive: true,
            score,
            name: existing?.name ?? "",
          });
          return;
        }
        if (ev === "Kicked") {
          const player = norm(args.player as string);
          console.log("kicked", player, "hasKey?", playersRef.current.has(player), "keysSample", [...playersRef.current.keys()].slice(0, 3));
          playersRef.current.delete(player);
          lastSeenRef.current.delete(player);
          setPlayerCount(playersRef.current.size);

          const nm = bytes12ToString(args.name as string) || shortAddr(player);
          onKillFeedLine(`${nm} disconnected (inactive)`); // optional
          return;
        }

      } catch {
        console.warn("failed to parse log", log);
        // ignore
      }
    };

    provider.on(filter, onLog);
    async function backfill() {
      const latest = await provider.getBlockNumber();
      const fromBlock = Math.max(0, latest - 5000); // demo-safe range

      const logs = await provider.getLogs({
        address: arenaAddress as `0x${string}`,
        fromBlock,
        toBlock: latest,
      });

      logs.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber)
          return a.blockNumber - b.blockNumber;
        if ((a.transactionIndex ?? 0) !== (b.transactionIndex ?? 0))
          return (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0);
        return (a.index ?? 0) - (b.index ?? 0);
      });

      for (const l of logs) {
        onLog(l);
      }

      setPlayerCount(playersRef.current.size);
    }

    backfill().catch(console.error);

    setTimeout(async () => {
      if (nameInput) await requestSetName(nameInput);
      await requestJoin();
    }, 0);

    return () => {
      alive = false;
      try {
        provider.off(filter, onLog);
      } catch {
        console.warn("Failed to clean up provider event listener");
       }
      try {
        provider.destroy();
      } catch {
        console.warn("Failed to destroy provider");
       }
      providerRef.current = null;
      arenaRef.current = null;
      chainIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burner?.address, arenaAddress, rpcWsUrl]);

  // --- Relayer intent submission (POST /api/*) ---
  async function getNonce(player: string): Promise<bigint> {
    const arena = arenaRef.current;
    if (!arena) throw new Error("Arena not ready");
    return (await arena.nonces(player)) as bigint;
  }

  async function signDigest(digest: string): Promise<string> {
    if (!burner) throw new Error("Burner not ready");
    return burner.signMessage(ethers.getBytes(digest));
  }

  async function requestJoin() {
    if (!burner) return;
    const chainId = chainIdRef.current;
    if (!chainId) return;

    const player = burner.address;
    const nonce = await getNonce(player);
    const deadline = BigInt(0);

    const dig = digestJoin({ chainId, arenaAddress, player, nonce, deadline });
    const sig = await signDigest(dig);

    await fetch("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ player, nonce: nonce.toString(), deadline: deadline.toString(), sig }),
    }).catch(() => {
      console.error("Failed to join");
     });
  }

  async function requestSetName(name: string) {
    if (!burner) return;
    const chainId = chainIdRef.current;
    if (!chainId) return;

    const player = burner.address;
    const nonce = await getNonce(player);
    const deadline = BigInt(0);

    const nameBytes12 = toBytes12FromName(name);
    const dig = digestSetName({ chainId, arenaAddress, player, nameBytes12, nonce, deadline });
    const sig = await signDigest(dig);

    await fetch("/api/set-name", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ player, name, nonce: nonce.toString(), deadline: deadline.toString(), sig }),
    }).catch(() => { 
      console.error("Failed to set name");
    });
  }

  async function requestMove(dir: 0 | 1 | 2 | 3) {
    if (!hasSetName) return;
    if (!burner) return;

    // coalesce spam: keep only latest direction
    pendingDirRef.current = dir;

    // if a move is already being sent, just wait — latest dir will be sent next
    if (moveInFlightRef.current) return;

    moveInFlightRef.current = true;
    try {
      while (pendingDirRef.current !== null) {
        const d = pendingDirRef.current;
        pendingDirRef.current = null;

        const chainId = chainIdRef.current;
        if (!chainId) return;

        const player = burner.address;
        const nonce = await getNonce(player);
        const deadline = BigInt(0);

        const dig = digestMove({ chainId, arenaAddress, player, dir: d, nonce, deadline });
        const sig = await signDigest(dig);

        const res = await fetch("/api/move", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ player, dir: d, nonce: nonce.toString(), deadline: deadline.toString(), sig }),
        });

        // if relayer rejected, stop the loop (prevents infinite retries)
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          console.warn("move rejected", j);
          return;
        }
      }
    } finally {
      moveInFlightRef.current = false;
    }
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

  // leaderboard refresh loop
  useEffect(() => {
    const t = window.setInterval(() => {
      const arr = Array.from(playersRef.current.entries())
        .map(([id, p]) => ({ id, name: p.name || id.slice(0, 10), score: p.score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      setLeaderboard(arr);
      if (myId) setMyScore(playersRef.current.get(myId.toLowerCase())?.score ?? 0);
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

      const me = burner?.address?.toLowerCase();
      const players = playersRef.current;

      for (const [id, p] of players.entries()) {
        if (!p.alive) continue;
        const cx = p.x * t + t / 2;
        const cy = p.y * t + t / 2;
        const r = Math.max(2, t * 0.32);

        const isMe = me && id.toLowerCase() === me;

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
  }, [tile, burner?.address]);

  // ----- Name modal submit -----
  const submitName = async () => {
    const name = sanitizeName(nameInput);
    if (!name) return;

    localStorage.setItem("arena_name", name);
    setHasSetName(true);
    setShowNameModal(false);

    await requestSetName(name);
    await requestJoin(); // safe/idempotent
  };

  // block page scroll while modal open
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
                Burner wallet: <span className="kbd">{burner ? shortAddr(burner.address) : "..."}</span> (auto-created on
                this device)
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
            Name: <span className="kbd">{nameInput ? sanitizeName(nameInput) : "—"}</span> · Burner:{" "}
            <span className="kbd">{burner ? shortAddr(burner.address) : "..."}</span>
          </div>
          <div style={{ opacity: 0.7, marginTop: 6, fontSize: 13 }}>
            Chain WS: <span className="kbd">{rpcWsUrl ? rpcWsUrl : "—"}</span> · Arena:{" "}
            <span className="kbd">{arenaAddress ? shortAddr(arenaAddress) : "—"}</span>
          </div>
        </div>

        <div style={{ width: 320, display: "grid", gap: 12 }}>
          <div style={panelStyle}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Leaderboard</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {leaderboard.map((e) => (
                <div key={e.id} style={{ display: "flex", justifyContent: "space-between", opacity: 0.9 }}>
                  <span
                    style={{
                      color:
                        burner && burner.address.toLowerCase() === e.id.toLowerCase()
                          ? "rgba(255,120,120,0.95)"
                          : "rgba(180,220,255,0.92)",
                    }}
                  >
                    {burner && burner.address.toLowerCase() === e.id.toLowerCase() ? "YOU" : e.name}
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
                <div key={k.id} style={{ opacity: 0.85, fontSize: 13 }}>
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
              style={{
                width: arenaPx,
                height: arenaPx,
                borderRadius: 14,
                background: "rgba(0,0,0,0.28)",
                boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
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

// -------------------- styles --------------------
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