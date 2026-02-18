import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { ARENA_ABI } from "@/lib/arena";

export const runtime = "nodejs"; // ensure Node runtime (not edge)

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.player !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing player address" },
        { status: 400 }
      );
    }

    const player = body.player as string;

    if (!ethers.isAddress(player)) {
      return NextResponse.json(
        { ok: false, error: "Invalid player address" },
        { status: 400 }
      );
    }

    const rpcUrl = process.env.RPC_URL;
    const arenaAddress = process.env.ARENA_ADDRESS;
    const relayerPk = process.env.RELAYER_PRIVATE_KEY;

    if (!rpcUrl) {
      return NextResponse.json(
        { ok: false, error: "Missing RPC_URL" },
        { status: 500 }
      );
    }

    if (!arenaAddress) {
      return NextResponse.json(
        { ok: false, error: "Missing ARENA_ADDRESS" },
        { status: 500 }
      );
    }

    if (!relayerPk) {
      return NextResponse.json(
        { ok: false, error: "Missing RELAYER_PRIVATE_KEY" },
        { status: 500 }
      );
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(relayerPk, provider);
    const arena = new ethers.Contract(arenaAddress, ARENA_ABI, wallet);

    // Attempt kick
    const tx = await arena.kickInactive(player, {
      gasLimit: 250_000,
    });

    return NextResponse.json({
      ok: true,
      txHash: tx.hash,
    });
  } catch (err: any) {
    const message =
      err?.shortMessage ||
      err?.reason ||
      err?.message ||
      "Kick failed";

    return NextResponse.json(
      { ok: false, error: message },
      { status: 400 }
    );
  }
}