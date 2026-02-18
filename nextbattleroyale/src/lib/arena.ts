import { ethers } from "ethers";

/** Minimal ABI for relayer + event decoding */
export const ARENA_ABI = [
  "function nonces(address) view returns (uint256)",
  "function joinFor(address player,uint256 nonce,uint256 deadline,bytes sig)",
  "function moveFor(address player,uint8 dir,uint256 nonce,uint256 deadline,bytes sig)",
  "function setNameFor(address player,bytes12 newName,uint256 nonce,uint256 deadline,bytes sig)",
  "function kickInactive(address player)",

  "event NameSet(address indexed player, bytes12 name)",
  "event Joined(address indexed player, uint8 x, uint8 y, bytes12 name)",
  "event Moved(address indexed player, uint8 fromX, uint8 fromY, uint8 toX, uint8 toY)",
  "event Killed(address indexed killer, address indexed victim, uint32 killerScore, bytes12 killerName, bytes12 victimName)",
  "event Respawned(address indexed player, uint8 x, uint8 y, uint32 score)",
  "event Kicked(address indexed player, uint8 x, uint8 y, bytes12 name, uint256 lastActiveAt)"
] as const;

export const arenaIface = new ethers.Interface(ARENA_ABI);

export enum ActionType {
  SET_NAME = 0,
  JOIN = 1,
  MOVE = 2,
}

/** keccak256(abi.encodePacked(chainid, address(this))) */
export function commonDomain(chainId: bigint, arenaAddress: string): string {
  return ethers.keccak256(
    ethers.solidityPacked(["uint256", "address"], [chainId, arenaAddress as `0x${string}`])
  );
}

export function digestJoin(params: {
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

export function digestMove(params: {
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

export function digestSetName(params: {
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

export function toBytes12FromName(name: string): string {
  const trimmed = (name ?? "").trim().slice(0, 12);
  const bytes = ethers.toUtf8Bytes(trimmed);
  const sliced = bytes.length > 12 ? bytes.slice(0, 12) : bytes;
  const padded = ethers.zeroPadBytes(sliced, 12);
  return ethers.hexlify(padded);
}

export function bytes12ToString(b12: string): string {
  // convert bytes12 hex -> utf8, strip trailing nulls
  const raw = ethers.getBytes(b12);
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  return ethers.toUtf8String(raw.slice(0, end));
}

export function verifyBurnerSignature(opts: { player: string; digest: string; sig: string }): boolean {
  const recovered = ethers.verifyMessage(ethers.getBytes(opts.digest), opts.sig);
  return recovered.toLowerCase() === opts.player.toLowerCase();
}