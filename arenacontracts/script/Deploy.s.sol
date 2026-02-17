// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {Arena} from "../src/Arena.sol";

contract Deploy is Script {
    function run() external returns (Arena arena) {
        vm.startBroadcast();
        arena = new Arena();
        vm.stopBroadcast();
    }
}