import "dotenv/config";
import express from "express";
import cors from "cors";
import { ethers } from "ethers";

// ---- env ----
const RPC_URL = process.env.RPC_URL!;
const ARENA_ADDRESS = process.env.ARENA_ADDRESS!;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY!;
const CHAIN_ID = BigInt(process.env.CHAIN_ID || "10143");
const PORT = Number(process.env.PORT || "8787");

// Optional: lock down who can call you (recommended once deployed)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!RPC_URL) throw new Error("Missing RPC_URL");
if (!ARENA_ADDRESS) throw new Error("Missing ARENA_ADDRESS");
if (!RELAYER_PRIVATE_KEY) throw new Error("Missing RELAYER_PRIVATE_KEY");

// ---- minimal ABI ----
const ARENA_ABI = [
  "function nonces(address) view returns (uint256)",
  "function joinFor(address player,uint256 nonce,uint256 deadline,bytes sig)",
  "function moveFor(address player,uint8 dir,uint256 nonce,uint256 deadline,bytes sig)",
  "function setNameFor(address player,bytes12 newName,uint256 nonce,uint256 deadline,bytes sig)",
  "function kickInactive(address player)",
] as const;

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

function digestJoin(params: { player: string; nonce: bigint; deadline: bigint }): string {
  const domain = commonDomain(CHAIN_ID, ARENA_ADDRESS);
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "uint8", "address", "uint256", "uint256"],
      [domain, ActionType.JOIN, params.player as `0x${string}`, params.nonce, params.deadline]
    )
  );
}

function digestMove(params: { player: string; dir: number; nonce: bigint; deadline: bigint }): string {
  const domain = commonDomain(CHAIN_ID, ARENA_ADDRESS);
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "uint8", "address", "uint8", "uint256", "uint256"],
      [domain, ActionType.MOVE, params.player as `0x${string}`, params.dir, params.nonce, params.deadline]
    )
  );
}

function digestSetName(params: { player: string; nameBytes12: string; nonce: bigint; deadline: bigint }): string {
  const domain = commonDomain(CHAIN_ID, ARENA_ADDRESS);
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

function verifyBurnerSignature(opts: { player: string; digest: string; sig: string }): boolean {
  const recovered = ethers.verifyMessage(ethers.getBytes(opts.digest), opts.sig);
  return recovered.toLowerCase() === opts.player.toLowerCase();
}

function isAddr(x: string) {
  try {
    ethers.getAddress(x);
    return true;
  } catch {
    return false;
  }
}

function normalizeErr(e: any) {
  const msg = e?.shortMessage || e?.reason || e?.message || String(e);
  const code = e?.code;
  const data = e?.data;
  return { code, msg, data };
}

// ---- provider / signer / contract ----
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

// NonceManager prevents nonce races inside this single process
const signer = new ethers.NonceManager(wallet);
const arena = new ethers.Contract(ARENA_ADDRESS, ARENA_ABI, signer) as any;

// ---- single FIFO queue for all txs ----
let tail = Promise.resolve();
async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

// ---- spam controls ----

// Simple in-memory rate limiting per IP (hackathon safe)
const ipHits = new Map<string, { count: number; resetAt: number }>();
function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 2000; // 2s
  const max = 25; // 25 requests per 2s per IP (tune)

  const entry = ipHits.get(ip);
  if (!entry || now > entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }
  entry.count += 1;
  if (entry.count > max) {
    return res.status(429).json({ ok: false, error: "Rate limited" });
  }
  next();
}

// Per-player move dedupe: if they spam while a move tx is still in-flight, just accept but don't send another tx.
// This dramatically reduces “higher priority” / nonce issues when users spam buttons.
const moveInFlight = new Map<string, Promise<any>>();

async function enqueueMoveOnce(player: string, fn: () => Promise<any>) {
  const key = player.toLowerCase();
  const existing = moveInFlight.get(key);
  if (existing) return { deduped: true, promise: existing };

  const p = enqueue(async () => {
    try {
      return await fn();
    } finally {
      moveInFlight.delete(key);
    }
  });

  moveInFlight.set(key, p);
  return { deduped: false, promise: p };
}

// ---- server ----
const app = express();

// CORS: allow your Vercel domain(s). For hackathon you can use "*".
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/postman
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // allow all if not set
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: false,
  })
);

app.use(express.json({ limit: "200kb" }));
app.use(rateLimit);

// Health: proves the relayer can talk to chain and has funds
app.get("/health", async (_req, res) => {
  try {
    const [net, bal] = await Promise.all([provider.getNetwork(), provider.getBalance(wallet.address)]);
    res.json({
      ok: true,
      chainId: net.chainId.toString(),
      relayer: wallet.address,
      relayerBalance: ethers.formatEther(bal),
      arena: ARENA_ADDRESS,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: normalizeErr(e) });
  }
});

app.post("/join", async (req, res) => {
  try {
    const { player, nonce, deadline, sig } = req.body as {
      player: string;
      nonce: string;
      deadline: string;
      sig: string;
    };

    if (!isAddr(player)) return res.status(400).json({ ok: false, error: "Bad player address" });
    if (typeof sig !== "string" || !sig.startsWith("0x")) return res.status(400).json({ ok: false, error: "Bad sig" });

    const n = BigInt(nonce);
    const dl = BigInt(deadline);

    const dig = digestJoin({ player, nonce: n, deadline: dl });
    if (!verifyBurnerSignature({ player, digest: dig, sig })) {
      return res.status(400).json({ ok: false, error: "Bad burner sig" });
    }

    const tx = await enqueue(() => arena.joinFor(player, n, dl, sig, { gasLimit: 250000n }));

    return res.json({ ok: true, hash: tx.hash });
  } catch (e: any) {
    const err = normalizeErr(e);
    return res.status(400).json({ ok: false, error: err.msg, code: err.code });
  }
});

app.post("/set-name", async (req, res) => {
  try {
    const { player, nameBytes12, nonce, deadline, sig } = req.body as {
      player: string;
      nameBytes12: string;
      nonce: string;
      deadline: string;
      sig: string;
    };

    if (!isAddr(player)) return res.status(400).json({ ok: false, error: "Bad player address" });
    if (typeof nameBytes12 !== "string" || !nameBytes12.startsWith("0x") || nameBytes12.length !== 26) {
      return res.status(400).json({ ok: false, error: "Bad nameBytes12 (must be 12 bytes hex)" });
    }

    const n = BigInt(nonce);
    const dl = BigInt(deadline);

    const dig = digestSetName({ player, nameBytes12, nonce: n, deadline: dl });
    if (!verifyBurnerSignature({ player, digest: dig, sig })) {
      return res.status(400).json({ ok: false, error: "Bad burner sig" });
    }

    const tx = await enqueue(() => arena.setNameFor(player, nameBytes12, n, dl, sig, { gasLimit: 250000n }));

    return res.json({ ok: true, hash: tx.hash });
  } catch (e: any) {
    const err = normalizeErr(e);
    return res.status(400).json({ ok: false, error: err.msg, code: err.code });
  }
});

app.post("/move", async (req, res) => {
  try {
    const { player, dir, nonce, deadline, sig } = req.body as {
      player: string;
      dir: number;
      nonce: string;
      deadline: string;
      sig: string;
    };

    if (!isAddr(player)) return res.status(400).json({ ok: false, error: "Bad player address" });

    const d = Number(dir);
    if (![0, 1, 2, 3].includes(d)) return res.status(400).json({ ok: false, error: "Bad dir" });

    const n = BigInt(nonce);
    const dl = BigInt(deadline);

    const dig = digestMove({ player, dir: d, nonce: n, deadline: dl });
    if (!verifyBurnerSignature({ player, digest: dig, sig })) {
      return res.status(400).json({ ok: false, error: "Bad burner sig" });
    }

    // Dedup move spam per player while in-flight
    const { deduped, promise } = await enqueueMoveOnce(player, () =>
      arena.moveFor(player, d, n, dl, sig, { gasLimit: 300000n })
    );

    // If it was deduped, we respond quickly — client can rely on events for final state.
    if (deduped) {
      return res.json({ ok: true, deduped: true });
    }

    const tx = await promise;
    return res.json({ ok: true, hash: tx.hash });
  } catch (e: any) {
    const err = normalizeErr(e);

    // Common RPC annoyance — don’t panic the client, just treat as rejected
    // e.g. "An existing transaction had higher priority"
    const m = (err.msg || "").toLowerCase();
    if (m.includes("higher priority") || m.includes("nonce too low") || m.includes("replacement transaction underpriced")) {
      return res.status(409).json({ ok: false, error: err.msg, code: err.code });
    }

    return res.status(400).json({ ok: false, error: err.msg, code: err.code });
  }
});

app.post("/kick", async (req, res) => {
  try {
    const { player } = req.body as { player: string };
    if (!isAddr(player)) return res.status(400).json({ ok: false, error: "Bad player address" });

    const tx = await enqueue(() => arena.kickInactive(player, { gasLimit: 200000n }));
    return res.json({ ok: true, hash: tx.hash });
  } catch (e: any) {
    const err = normalizeErr(e);
    return res.status(400).json({ ok: false, error: err.msg, code: err.code });
  }
});

// IMPORTANT: bind to 0.0.0.0 for cloud hosts
app.listen(PORT, "0.0.0.0", () => {
  console.log(`relayer listening on :${PORT}`);
  console.log(`arena=${ARENA_ADDRESS} chainId=${CHAIN_ID.toString()}`);
  console.log(`relayer=${wallet.address}`);
});