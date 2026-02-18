import { NextResponse } from "next/server";
import { getRelayer } from "@/lib/relayer";
import { digestMove, verifyBurnerSignature } from "@/lib/arena";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { player, dir, nonce, deadline, sig } = body;

    const ARENA_ADDRESS = process.env.ARENA_ADDRESS!;
    const chainId = BigInt(process.env.CHAIN_ID || "10143");

    // verify burner sig (your existing logic)
    const dig = digestMove({
      chainId,
      arenaAddress: ARENA_ADDRESS,
      player,
      dir: Number(dir),
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
    });

    if (!verifyBurnerSignature({ player, digest: dig, sig })) {
      return NextResponse.json({ ok: false, error: "Bad burner sig" }, { status: 400 });
    }

    const { arena, enqueue } = getRelayer();

    const tx = await enqueue(async () => {
      // IMPORTANT: set gasLimit to avoid estimateGas spam (also helps RPC limits)
      return arena.moveFor(player, Number(dir), BigInt(nonce), BigInt(deadline), sig, {
        gasLimit: 250000,
      });
    });

    return NextResponse.json({ ok: true, hash: tx.hash });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 });
  }
}