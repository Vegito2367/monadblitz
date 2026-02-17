import { NextResponse } from "next/server";
import { getArena } from "../_shared";
import { digestMove, verifyBurnerSignature } from "@/lib/arena";
export const runtime = "nodejs";

type Body = { player: string; dir: number; nonce: string; deadline: string; sig: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const player = body.player;
    const dir = body.dir;
    const nonce = BigInt(body.nonce);
    const deadline = BigInt(body.deadline);
    const sig = body.sig;

    if (![0, 1, 2, 3].includes(dir)) {
      return NextResponse.json({ ok: false, error: "Invalid dir" }, { status: 400 });
    }

    const { arena, chainId, arenaAddress } = await getArena();

    const digest = digestMove({ chainId, arenaAddress, player, dir, nonce, deadline });
    if (!verifyBurnerSignature({ player, digest, sig })) {
      return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 400 });
    }

    const tx = await arena.moveFor(player, dir, nonce, deadline, sig , {
        gasLimit: 250_000, // increase gas limit for move (sometimes fails with default)
    });
    return NextResponse.json({ ok: true, txHash: tx.hash });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.reason || e?.message || String(e) }, { status: 400 });
  }
}