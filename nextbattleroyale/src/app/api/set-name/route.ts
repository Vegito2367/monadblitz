import { NextResponse } from "next/server";
import { getArena } from "../_shared";
import { digestSetName, toBytes12FromName, verifyBurnerSignature } from "@/lib/arena";
export const runtime = "nodejs";

type Body = { player: string; name: string; nonce: string; deadline: string; sig: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const player = body.player;
    const name = (body.name ?? "").trim();
    const nonce = BigInt(body.nonce);
    const deadline = BigInt(body.deadline);
    const sig = body.sig;

    if (!name) return NextResponse.json({ ok: false, error: "Name required" }, { status: 400 });

    const { arena, chainId, arenaAddress } = await getArena();

    const nameBytes12 = toBytes12FromName(name);
    const digest = digestSetName({ chainId, arenaAddress, player, nameBytes12, nonce, deadline });
    if (!verifyBurnerSignature({ player, digest, sig })) {
      return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 400 });
    }

    const tx = await arena.setNameFor(player, nameBytes12, nonce, deadline, sig);
    return NextResponse.json({ ok: true, txHash: tx.hash });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.reason || e?.message || String(e) }, { status: 400 });
  }
}