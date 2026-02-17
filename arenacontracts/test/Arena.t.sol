// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {Arena} from "../src/Arena.sol";
import {MessageHashUtils} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";

contract ArenaTest is Test {
    Arena arena;

    // Burner “players”
    uint256 pkA = 0xA11CE;
    uint256 pkB = 0xB0B;
    address A;
    address B;

    // Relayer can be any address (msg.sender is not the player in meta-tx)
    address relayer = address(0x123456);


    function setUp() public {
        arena = new Arena();
        A = vm.addr(pkA);
        B = vm.addr(pkB);
    }

    // -------------------------
    // Helpers: hashing + signing
    // -------------------------

    function _domain() internal view returns (bytes32) {
        // must match Arena._commonDomain(): keccak256(abi.encodePacked(chainid, address(this)))
        return keccak256(abi.encodePacked(block.chainid, address(arena)));
    }

    function _digestSetName(address player, bytes12 name, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        // must match Arena._digestSetName()
        return keccak256(
            abi.encodePacked(
                _domain(),
                uint8(0), // ActionType.SET_NAME
                player,
                name,
                nonce,
                deadline
            )
        );
    }

    function _digestJoin(address player, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        // must match Arena._digestJoin()
        return keccak256(
            abi.encodePacked(
                _domain(),
                uint8(1), // ActionType.JOIN
                player,
                nonce,
                deadline
            )
        );
    }

    function _digestMove(address player, uint8 dir, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        // must match Arena._digestMove()
        return keccak256(
            abi.encodePacked(
                _domain(),
                uint8(2), // ActionType.MOVE
                player,
                dir,
                nonce,
                deadline
            )
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory sig) {
        // Arena uses MessageHashUtils.toEthSignedMessageHash(digest)
        bytes32 ethSigned = MessageHashUtils.toEthSignedMessageHash(digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethSigned);
        sig = abi.encodePacked(r, s, v);
    }

    // -------------------------
    // Helpers: storage wiring (for deterministic collision test)
    // -------------------------

    function _slotPlayers(address player) internal pure returns (bytes32) {
        // players mapping is at storage slot 0
        return keccak256(abi.encode(player, uint256(0)));
    }

    function _slotNameOf(address player) internal pure returns (bytes32) {
        // nameOf mapping is at storage slot 1
        return keccak256(abi.encode(player, uint256(1)));
    }

    function _slotTileOccupant(uint16 tileId) internal pure returns (bytes32) {
        // tileOccupant mapping is at storage slot 2
        return keccak256(abi.encode(uint256(tileId), uint256(2)));
    }

    function _slotNonces(address player) internal pure returns (bytes32) {
        // nonces mapping is at storage slot 3
        return keccak256(abi.encode(player, uint256(3)));
    }

    function _packPlayer(uint8 x, uint8 y, uint32 score, bool joined) internal pure returns (bytes32) {
        // Player struct in Arena:
        // struct Player { uint8 x; uint8 y; uint32 score; bool joined; }
        // Packed into a single slot in order, starting from least-significant bits:
        // x at bits [0..7]
        // y at bits [8..15]
        // score at bits [16..47]
        // joined at bits [48..55]
        uint256 v = uint256(x);
        v |= uint256(y) << 8;
        v |= uint256(score) << 16;
        v |= (joined ? uint256(1) : uint256(0)) << 48;
        return bytes32(v);
    }

    function _tileId(uint8 x, uint8 y) internal pure returns (uint16) {
        return uint16(uint16(x) + uint16(y) * uint16(64));
    }

    function _storeAddress(bytes32 slot, address value) internal {
        // address stored right-aligned (lower 20 bytes)
        vm.store(address(arena), slot, bytes32(uint256(uint160(value))));
    }

    // -------------------------
    // Tests
    // -------------------------

    function test_setNameFor_stores_and_increments_nonce() public {
        bytes12 name = bytes12("tej");
        uint256 nonce = arena.nonces(A);
        uint256 deadline = block.timestamp + 60;

        bytes32 d = _digestSetName(A, name, nonce, deadline);
        bytes memory sig = _sign(pkA, d);

        vm.prank(relayer);
        vm.expectEmit(true, false, false, true, address(arena));
        emit Arena.NameSet(A, name);
        arena.setNameFor(A, name, nonce, deadline, sig);

        assertEq(arena.nameOf(A), name);
        assertEq(arena.nonces(A), nonce + 1);
    }

    function test_joinFor_spawns_and_occupies_tile() public {
        uint256 nonce = arena.nonces(A);
        uint256 deadline = block.timestamp + 60;

        bytes32 d = _digestJoin(A, nonce, deadline);
        bytes memory sig = _sign(pkA, d);

        vm.prank(relayer);
        arena.joinFor(A, nonce, deadline, sig);

        (uint8 x, uint8 y, uint32 score, bool joined) = arena.players(A);
        assertTrue(joined);
        assertEq(score, 0);

        uint16 tid = _tileId(x, y);
        assertEq(arena.tileOccupant(tid), A);
        assertEq(arena.nonces(A), nonce + 1);
    }

    function test_moveFor_moves_player_and_updates_occupancy() public {
        // join first
        {
            uint256 nonce0 = arena.nonces(A);
            uint256 deadline0 = block.timestamp + 60;
            bytes32 dj = _digestJoin(A, nonce0, deadline0);
            bytes memory sigj = _sign(pkA, dj);
            vm.prank(relayer);
            arena.joinFor(A, nonce0, deadline0, sigj);
        }

        (uint8 x0, uint8 y0, , ) = arena.players(A);

        // move right (dir=3)
        uint8 dir = 3;
        uint256 nonce = arena.nonces(A);
        uint256 deadline = block.timestamp + 60;

        bytes32 dm = _digestMove(A, dir, nonce, deadline);
        bytes memory sigm = _sign(pkA, dm);

        vm.prank(relayer);
        arena.moveFor(A, dir, nonce, deadline, sigm);

        (uint8 x1, uint8 y1, , ) = arena.players(A);

        // Either moved or stayed if at edge
        if (x0 < 63) {
            assertEq(x1, x0 + 1);
            assertEq(y1, y0);
        } else {
            assertEq(x1, x0);
            assertEq(y1, y0);
        }

        // occupancy: old tile empty, new tile occupied
        uint16 oldTid = _tileId(x0, y0);
        uint16 newTid = _tileId(x1, y1);
        if (newTid != oldTid) {
            assertEq(arena.tileOccupant(oldTid), address(0));
        }
        assertEq(arena.tileOccupant(newTid), A);

        // nonce advanced
        assertEq(arena.nonces(A), nonce + 1);
    }

    function test_replay_nonce_reverts() public {
        // join A
        {
            uint256 nonce0 = arena.nonces(A);
            uint256 deadline0 = block.timestamp + 60;
            bytes32 dj = _digestJoin(A, nonce0, deadline0);
            bytes memory sigj = _sign(pkA, dj);
            vm.prank(relayer);
            arena.joinFor(A, nonce0, deadline0, sigj);
        }

        uint8 dir = 1;
        uint256 nonce = arena.nonces(A);
        uint256 deadline = block.timestamp + 60;

        bytes32 dm = _digestMove(A, dir, nonce, deadline);
        bytes memory sigm = _sign(pkA, dm);

        vm.prank(relayer);
        arena.moveFor(A, dir, nonce, deadline, sigm);

        // same nonce again should revert BadNonce
        vm.prank(relayer);
        vm.expectRevert(Arena.BadNonce.selector);
        arena.moveFor(A, dir, nonce, deadline, sigm);
    }

    function test_bad_signature_reverts() public {
        bytes12 name = bytes12("evil");
        uint256 nonce = arena.nonces(A);
        uint256 deadline = block.timestamp + 60;

        // digest says A, but signed by pkB
        bytes32 d = _digestSetName(A, name, nonce, deadline);
        bytes memory sig = _sign(pkB, d);

        vm.prank(relayer);
        vm.expectRevert(Arena.BadSig.selector);
        arena.setNameFor(A, name, nonce, deadline, sig);
    }

    function test_collision_kills_victim_resets_score_and_respawns_immediately() public {
    uint8 ax = 10;
    uint8 ay = 10;
    uint8 bx = 11;
    uint8 by = 10;

    uint16 aTid = _tileId(ax, ay);
    uint16 bTid = _tileId(bx, by);

    // 1) Set names properly via meta-tx (no vm.store for nameOf)
    {
        // A name
        bytes12 aName = bytes12("KILLER");
        uint256 nA = arena.nonces(A);
        uint256 dl = block.timestamp + 60;
        bytes32 dA = _digestSetName(A, aName, nA, dl);
        bytes memory sA = _sign(pkA, dA);
        vm.prank(relayer);
        arena.setNameFor(A, aName, nA, dl, sA);

        // B name
        bytes12 bName = bytes12("VICTIM");
        uint256 nB = arena.nonces(B);
        bytes32 dB = _digestSetName(B, bName, nB, dl);
        bytes memory sB = _sign(pkB, dB);
        vm.prank(relayer);
        arena.setNameFor(B, bName, nB, dl, sB);
    }

    // 2) Force board state via storage: A at (10,10), B at (11,10)
    vm.store(address(arena), _slotPlayers(A), _packPlayer(ax, ay, 0, true));
    vm.store(address(arena), _slotPlayers(B), _packPlayer(bx, by, 7, true));
    _storeAddress(_slotTileOccupant(aTid), A);
    _storeAddress(_slotTileOccupant(bTid), B);

    // 3) Move A right into B
    uint8 dir = 3;
    uint256 nonce = arena.nonces(A); // IMPORTANT: nonce advanced by setNameFor
    uint256 deadline = block.timestamp + 60;
    bytes32 dm = _digestMove(A, dir, nonce, deadline);
    bytes memory sig = _sign(pkA, dm);

    // Expect Killed (full check)
    vm.expectEmit(true, true, false, true, address(arena));
    emit Arena.Killed(A, B, 1, bytes12("KILLER"), bytes12("VICTIM"));

    // Expect Respawned (only check indexed player topic, ignore data x/y)
    vm.expectEmit(true, false, false, false, address(arena));
    emit Arena.Respawned(B, 0, 0, 0);

    // Expect Moved (full check)
    vm.expectEmit(true, false, false, true, address(arena));
    emit Arena.Moved(A, ax, ay, bx, by);

    vm.prank(relayer);
    arena.moveFor(A, dir, nonce, deadline, sig);

    // 4) State assertions
    (uint8 ax2, uint8 ay2, uint32 aScore, bool aJoined) = arena.players(A);
    assertTrue(aJoined);
    assertEq(ax2, bx);
    assertEq(ay2, by);
    assertEq(aScore, 1);

    (uint8 bx2, uint8 by2, uint32 bScore, bool bJoined) = arena.players(B);
    assertTrue(bJoined);
    assertEq(bScore, 0);
    assertFalse(bx2 == bx && by2 == by);

    assertEq(arena.tileOccupant(_tileId(bx, by)), A);
    assertEq(arena.tileOccupant(_tileId(bx2, by2)), B);
    assertEq(arena.tileOccupant(_tileId(ax, ay)), address(0));

    assertEq(arena.nonces(A), nonce + 1);
}


function test_joinFor_is_idempotent() public {
    // First join
    uint256 nonce0 = arena.nonces(A);
    uint256 deadline = block.timestamp + 60;

    bytes32 d0 = _digestJoin(A, nonce0, deadline);
    bytes memory s0 = _sign(pkA, d0);

    vm.prank(relayer);
    arena.joinFor(A, nonce0, deadline, s0);

    (uint8 x1, uint8 y1, uint32 score1, bool joined1) = arena.players(A);
    assertTrue(joined1);
    assertEq(score1, 0);

    uint16 tid1 = _tileId(x1, y1);
    assertEq(arena.tileOccupant(tid1), A);

    // Second join (new nonce required)
    uint256 nonce1 = arena.nonces(A);
    bytes32 d1 = _digestJoin(A, nonce1, deadline);
    bytes memory s1 = _sign(pkA, d1);

    vm.prank(relayer);
    arena.joinFor(A, nonce1, deadline, s1);

    // State should not change
    (uint8 x2, uint8 y2, uint32 score2, bool joined2) = arena.players(A);
    assertTrue(joined2);
    assertEq(x2, x1);
    assertEq(y2, y1);
    assertEq(score2, score1);

    // Occupancy should still be exactly on the same tile
    uint16 tid2 = _tileId(x2, y2);
    assertEq(tid2, tid1);
    assertEq(arena.tileOccupant(tid2), A);
}

function test_invariant_move_updates_occupancy_old_tile_empty_new_tile_is_player() public {
    // Join first
    {
        uint256 nonceJ = arena.nonces(A);
        uint256 deadline = block.timestamp + 60;
        bytes32 dj = _digestJoin(A, nonceJ, deadline);
        bytes memory sj = _sign(pkA, dj);
        vm.prank(relayer);
        arena.joinFor(A, nonceJ, deadline, sj);
    }

    (uint8 x0, uint8 y0,,) = arena.players(A);
    uint16 oldTile = _tileId(x0, y0);

    // Choose a dir that actually moves if possible
    // Try: up, down, left, right until we get a different tile
    uint8[4] memory dirs = [uint8(0), 1, 2, 3];
    uint8 chosenDir = 0;
    bool willMove = false;
    uint8 tx_;
    uint8 ty_;

    for (uint256 i = 0; i < 4; i++) {
        (tx_, ty_) = _applyDirPure(x0, y0, dirs[i]);
        if (tx_ != x0 || ty_ != y0) {
            chosenDir = dirs[i];
            willMove = true;
            break;
        }
    }

    // If spawned in a corner, there is still always at least 2 moves possible, but just in case:
    assertTrue(willMove);

    uint16 newTileExpected = _tileId(tx_, ty_);

    // Move
    uint256 nonceM = arena.nonces(A);
    uint256 deadlineM = block.timestamp + 60;
    bytes32 dm = _digestMove(A, chosenDir, nonceM, deadlineM);
    bytes memory sm = _sign(pkA, dm);

    vm.prank(relayer);
    arena.moveFor(A, chosenDir, nonceM, deadlineM, sm);

    (uint8 x1, uint8 y1,,) = arena.players(A);
    uint16 newTileActual = _tileId(x1, y1);

    // Must match computed target
    assertEq(newTileActual, newTileExpected);

    // Invariant: new tile occupant is player
    assertEq(arena.tileOccupant(newTileActual), A);

    // Invariant: old tile is empty after moving
    assertEq(arena.tileOccupant(oldTile), address(0));
}

function _applyDirPure(uint8 x, uint8 y, uint8 dir) internal pure returns (uint8, uint8) {
    unchecked {
        if (dir == 0) { // up
            if (y == 0) return (x, y);
            return (x, y - 1);
        } else if (dir == 1) { // down
            if (y == 63) return (x, y);
            return (x, y + 1);
        } else if (dir == 2) { // left
            if (x == 0) return (x, y);
            return (x - 1, y);
        } else { // right
            if (x == 63) return (x, y);
            return (x + 1, y);
        }
    }
}



}
