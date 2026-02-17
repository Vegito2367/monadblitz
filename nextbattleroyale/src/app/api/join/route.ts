import { NextResponse } from "next/server";
import { getArena} from "../_shared";
import { digestJoin, verifyBurnerSignature } from "@/lib/arena";
export const runtime = "nodejs";

type Body = { player: string; nonce: string; deadline: string; sig: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const player = body.player;
    const nonce = BigInt(body.nonce);
    const deadline = BigInt(body.deadline);
    const sig = body.sig;

    const { arena, chainId, arenaAddress } = await getArena();

    const digest = digestJoin({ chainId, arenaAddress, player, nonce, deadline });
    if (!verifyBurnerSignature({ player, digest, sig })) {
      return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 400 });
    }

    const tx = await arena.joinFor(player, nonce, deadline, sig);
    return NextResponse.json({ ok: true, txHash: tx.hash });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.reason || e?.message || String(e) }, { status: 400 });
  }
}