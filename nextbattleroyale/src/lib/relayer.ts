import { ethers } from "ethers";
import { ARENA_ABI } from "@/lib/arena";

// Persist across hot reloads in dev
const g = globalThis as any;

export function getRelayer() {
  if (g.__RELAYER__) return g.__RELAYER__;

  const RPC_URL = process.env.RPC_URL!;
  const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY!;
  const ARENA_ADDRESS = process.env.ARENA_ADDRESS!;

  if (!RPC_URL) throw new Error("Missing RPC_URL");
  if (!RELAYER_PRIVATE_KEY) throw new Error("Missing RELAYER_PRIVATE_KEY");
  if (!ARENA_ADDRESS) throw new Error("Missing ARENA_ADDRESS");

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // NonceManager prevents relayer-nonce collisions inside ONE process
  const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const signer = new ethers.NonceManager(wallet);

  const arena = new ethers.Contract(ARENA_ADDRESS, ARENA_ABI, signer);

  // Simple in-process FIFO queue (serializes all tx sends)
  let tail = Promise.resolve();
  const enqueue = async <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  g.__RELAYER__ = { provider, signer, arena, enqueue };
  return g.__RELAYER__ as {
    provider: ethers.JsonRpcProvider;
    signer: ethers.NonceManager;
    arena: ethers.Contract;
    enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  };
}