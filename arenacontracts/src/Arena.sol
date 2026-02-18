// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice 64x64 grid PvP arena with collision kills + instant respawn + score.
///         Designed for gasless burner play via relayer meta-tx (Option A).
contract Arena {
    using ECDSA for bytes32;

    // ---------- Config ----------
    uint8 public constant MAP_SIZE = 64;

    // ---------- Storage ----------
    struct Player {
        uint8 x;
        uint8 y;
        uint32 score;
        bool joined;
    }

    // player identity is the burner address
    mapping(address => Player) public players;

    // fixed-size name (cheap)
    mapping(address => bytes12) public nameOf;

    // tileId => occupant (0 if empty)
    mapping(uint16 => address) public tileOccupant;

    // replay protection for meta-tx
    mapping(address => uint256) public nonces;

    mapping(address => uint256) public lastActiveAt;
uint256 public constant INACTIVITY_TIMEOUT = 15;

    // ---------- Events ----------
    event NameSet(address indexed player, bytes12 name);

    event Joined(address indexed player, uint8 x, uint8 y, bytes12 name);

    event Moved(
        address indexed player,
        uint8 fromX,
        uint8 fromY,
        uint8 toX,
        uint8 toY
    );

    event Killed(
        address indexed killer,
        address indexed victim,
        uint32 killerScore,
        bytes12 killerName,
        bytes12 victimName
    );

    event Respawned(address indexed player, uint8 x, uint8 y, uint32 score);

    event Kicked(address indexed player, uint8 x, uint8 y, bytes12 name, uint256 lastActiveAt);

    // ---------- Errors ----------
    error BadSig();
    error Expired();
    error BadNonce();
    error NotJoined();
    error InvalidDir();
    error NameEmpty();
    error NotInactive();
    error NotActive();

    // ---------- Intent Types ----------
    // We'll use EIP-191 style hashing first (simple), then upgrade to EIP-712 if you want.
    // IMPORTANT: Include (address(this), chainid) in signed payload to prevent cross-chain replay.

    enum ActionType {
        SET_NAME,
        JOIN,
        MOVE
    }

    // ---------- External: Gasless entrypoints ----------
    function setNameFor(
        address player,
        bytes12 newName,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _checkDeadline(deadline);
        _useNonce(player, nonce);
        if (newName == bytes12(0)) revert NameEmpty();

        bytes32 digest = _digestSetName(player, newName, nonce, deadline);
        _verify(player, digest, sig);
        
        nameOf[player] = newName;
        lastActiveAt[player] = block.timestamp;
        emit NameSet(player, newName);
    }

    function joinFor(
        address player,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _checkDeadline(deadline);
        _useNonce(player, nonce);

        bytes32 digest = _digestJoin(player, nonce, deadline);
        _verify(player, digest, sig);
        lastActiveAt[player] = block.timestamp;
        _joinIfNeeded(player);
    }

    function moveFor(
        address player,
        uint8 dir,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _checkDeadline(deadline);
        _useNonce(player, nonce);

        bytes32 digest = _digestMove(player, dir, nonce, deadline);
        _verify(player, digest, sig);
lastActiveAt[player] = block.timestamp;
        _move(player, dir);
    }

    // ---------- Internal logic ----------
    function _joinIfNeeded(address player) internal {
        Player storage p = players[player];

        if (!p.joined) {
            (uint8 sx, uint8 sy) = _spawn(player, 0); // salt=0 for join
            p.x = sx;
            p.y = sy;
            p.score = 0;
            p.joined = true;

            tileOccupant[_tileId(sx, sy)] = player;
            lastActiveAt[player] = block.timestamp;
            emit Joined(player, sx, sy, nameOf[player]);
        }
        // if already joined: no-op (idempotent)
    }

    function _move(address player, uint8 dir) internal {
        if (dir > 3) revert InvalidDir();

        Player storage me = players[player];
        if (!me.joined) revert NotJoined();

        uint8 fromX = me.x;
        uint8 fromY = me.y;

        (uint8 toX, uint8 toY) = _applyDir(fromX, fromY, dir);

        // edge: no movement
        if (toX == fromX && toY == fromY) return;

        uint16 fromTile = _tileId(fromX, fromY);
        uint16 toTile = _tileId(toX, toY);

        // vacate current tile first
        tileOccupant[fromTile] = address(0);

        address victim = tileOccupant[toTile];

        if (victim != address(0) && victim != player) {
            // kill victim: reset score and respawn immediately
            Player storage v = players[victim];

            // victim must have joined to exist; if not, treat as empty
            if (v.joined) {
                lastActiveAt[player] = block.timestamp;
                me.score += 1;

                // clear victim tile
                tileOccupant[toTile] = address(0);

                // reset victim score
                v.score = 0;

                emit Killed(
                    player,
                    victim,
                    me.score,
                    nameOf[player],
                    nameOf[victim]
                );

                // respawn victim (avoid collisions)
                (uint8 rx, uint8 ry) = _spawn(victim, uint256(me.score) + uint256(toTile));
                v.x = rx;
                v.y = ry;
                tileOccupant[_tileId(rx, ry)] = victim;

                emit Respawned(victim, rx, ry, 0);
            }
        }

        // move player into destination
        me.x = toX;
        me.y = toY;
        tileOccupant[toTile] = player;

        emit Moved(player, fromX, fromY, toX, toY);
        // Note: score changes are already emitted in Killed. Keep events lean.
    }

    function _applyDir(uint8 x, uint8 y, uint8 dir) internal pure returns (uint8, uint8) {
        unchecked {
            if (dir == 0) { // up
                if (y == 0) return (x, y);
                return (x, y - 1);
            } else if (dir == 1) { // down
                if (y == MAP_SIZE - 1) return (x, y);
                return (x, y + 1);
            } else if (dir == 2) { // left
                if (x == 0) return (x, y);
                return (x - 1, y);
            } else { // right (dir == 3)
                if (x == MAP_SIZE - 1) return (x, y);
                return (x + 1, y);
            }
        }
    }

    function _spawn(address player, uint256 salt) internal view returns (uint8, uint8) {
        // Not secure randomness — fine for hackathon testnet.
        // We'll try a few probes to find an empty tile.
        uint256 seed = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            block.number,
            player,
            salt,
            address(this)
        )));

        for (uint256 i = 0; i < 40; i++) {
            uint256 h = uint256(keccak256(abi.encodePacked(seed, i)));
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 x = uint8(h % MAP_SIZE);
            uint8 y = uint8((h >> 8) % MAP_SIZE);
            if (tileOccupant[_tileId(x, y)] == address(0)) return (x, y);
        }

        // fallback: return something (may collide in extreme crowding)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 fx = uint8(seed % MAP_SIZE);
        uint8 fy = uint8((seed >> 8) % MAP_SIZE);
        return (fx, fy);
    }

    function _tileId(uint8 x, uint8 y) internal pure returns (uint16) {
        // x + y*64 fits in uint16
        return uint16(uint16(x) + uint16(y) * uint16(MAP_SIZE));
    }

    // ---------- Signature verification ----------
    function _verify(address signer, bytes32 digest, bytes calldata sig) internal pure {
        // EIP-191: "\x19Ethereum Signed Message:\n32" + digest
        bytes32 ethSigned = MessageHashUtils.toEthSignedMessageHash(digest);
        address recovered = ECDSA.recover(ethSigned, sig);
        if (recovered != signer) revert BadSig();
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (deadline != 0 && block.timestamp > deadline) revert Expired();
    }

    function _useNonce(address player, uint256 nonce) internal {
        if (nonces[player] != nonce) revert BadNonce();
        nonces[player] = nonce + 1;
    }

    // ---------- Digests ----------
    function _commonDomain() internal view returns (bytes32) {
        // binds signatures to chain + contract
        return keccak256(abi.encodePacked(block.chainid, address(this)));
    }

    function _digestSetName(
        address player,
        bytes12 newName,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            _commonDomain(),
            ActionType.SET_NAME,
            player,
            newName,
            nonce,
            deadline
        ));
    }

    function _digestJoin(address player, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            _commonDomain(),
            ActionType.JOIN,
            player,
            nonce,
            deadline
        ));
    }

    function _digestMove(
        address player,
        uint8 dir,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            _commonDomain(),
            ActionType.MOVE,
            player,
            dir,
            nonce,
            deadline
        ));
    }

    function kickInactive(address player) external {
    Player storage p = players[player];
    if (!p.joined) revert NotActive();

    uint256 last = lastActiveAt[player];
    if (block.timestamp <= last + INACTIVITY_TIMEOUT) revert NotInactive();

    uint8 x = p.x;
    uint8 y = p.y;

    // clear occupancy if they still occupy their recorded tile
    uint16 tile = _tileId(x, y);
    if (tileOccupant[tile] == player) {
        tileOccupant[tile] = address(0);
    }

    bytes12 nm = nameOf[player];

    // wipe state so they can't "resume"
    p.score = 0;
    p.joined = false;
    nameOf[player] = bytes12(0);
    lastActiveAt[player] = 0;

    emit Kicked(player, x, y, nm, last);
}
}
