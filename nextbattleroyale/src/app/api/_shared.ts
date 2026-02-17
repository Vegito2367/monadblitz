import { ethers } from "ethers";
import { ARENA_ABI } from "@/lib/arena";

export const runtime = "nodejs"; // required for ethers + serverless

export function env() {
  const RPC_URL = process.env.RPC_URL!;
  const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY!;
  const ARENA_ADDRESS = process.env.ARENA_ADDRESS!;
  if (!RPC_URL) throw new Error("Missing RPC_URL");
  if (!RELAYER_PRIVATE_KEY) throw new Error("Missing RELAYER_PRIVATE_KEY");
  if (!ARENA_ADDRESS) throw new Error("Missing ARENA_ADDRESS");
  return { RPC_URL, RELAYER_PRIVATE_KEY, ARENA_ADDRESS };
}

export async function getArena() {
  const { RPC_URL, RELAYER_PRIVATE_KEY, ARENA_ADDRESS } = env();
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const arena = new ethers.Contract(ARENA_ADDRESS, ARENA_ABI, relayer);
  const net = await provider.getNetwork();
  return { provider, relayer, arena, chainId: net.chainId, arenaAddress: ARENA_ADDRESS };
}