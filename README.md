# ⚡ BlitzArena: On-Chain Battle Royale

BlitzArena is a high-speed, gasless, on-chain battle royale game built for the **Monad** blockchain. It features a 24x24 grid where players compete for the highest score through movement-based combat.

The project is designed for a seamless "web2-like" user experience using **burner addresses** and a **meta-transaction relayer**, allowing players to jump straight into the action without worrying about gas fees or wallet confirmations.

## 🚀 Key Features

- **Gasless Gameplay**: A dedicated relayer handles all transaction costs. Players sign "intents," and the relayer submits them to Monad.
- **Zero-Friction UX**: Automatic burner address generation means no "Sign" popups for every move.
- **Collision Combat**: Simple but intense mechanics—moving into a tile occupied by another player results in a kill.
- **Instant Respawn**: Getting killed isn't the end. Players respawn instantly at a random location to keep the momentum going.
- **Inactivity Management**: An automated "kick" mechanic ensures the arena remains populated only by active players.
- **Real-Time Scoreboard**: Track your kills and compete for the top spot on the leaderboard.

## 🏗️ Architecture

The project is split into three main components:

### 1. Smart Contracts (`/arenacontracts`)

Built with **Foundry**, the core logic lives in `Arena.sol`. It manages player state, movement validation, combat, and EIP-191 signature verification for meta-transactions.

- **Map Size**: 24x24 grid.
- **Security**: Cross-chain replay protection via chain ID and contract address binding.

### 2. Relayer (`/relayer`)

A **Node.js/Express** service that acts as the bridge between players and the blockchain.

- **Transaction Queueing**: Serializes transactions to prevent nonce collisions.
- **Move Deduplication**: Smartly handles user spam by deduplicating in-flight move requests.
- **Rate Limiting**: Protects the RPC and relayer wallet from abuse.

### 3. Frontend (`/nextbattleroyale`)

A modern **Next.js** application providing a responsive and low-latency game interface.

- **State Management**: Uses ethers.js for event listening and state synchronization.
- **Burner Wallets**: Securely manages temporary session keys in the browser.

## ⚙️ How it Works

1. **Identity**: When you open the game, a **Burner Wallet** (private key) is automatically generated and stored in your browser's session storage. No setup is required.
2. **Intent**: Every action (joining, moving, setting a name) is signed by this burner wallet. This "intent" is a small piece of data that proves _you_ authorized the action.
3. **Relay**: Your signed intent is sent to the **Relayer API**.
4. **Execution**: The relayer verifies your signature and submits the transaction to the Monad blockchain using its own funds to pay for gas.
5. **Sync**: The frontend listens for blockchain events (`Moved`, `Killed`, etc.) and updates the game board in real-time for all players.

## 🛠️ Tech Stack

- **Blockchain**: Monad (Testnet)
- **Smart Contracts**: Solidity, Foundry, OpenZeppelin
- **Backend**: Node.js, Express, Ethers.js
- **Frontend**: Next.js, TypeScript, Tailwind CSS

## 🏁 Getting Started

### Prerequisites

- Node.js (v18+)
- Foundry (for contract development)
- A Monad Testnet account with some tokens (for the relayer)

### 1. Smart Contract Setup

```bash
cd arenacontracts
forge build
# To deploy:
forge create src/Arena.sol:Arena --account <your-account> --broadcast
```

### 2. Relayer Setup

Create a `.env` file in the `relayer` directory:

```env
RPC_URL=https://testnet-rpc.monad.xyz
ARENA_ADDRESS=0x...
RELAYER_PRIVATE_KEY=0x...
PORT=8787
```

Then run:

```bash
cd relayer
npm install
npm run dev
```

### 3. Frontend Setup

Create a `.env` file in the `nextbattleroyale` directory:

```env
NEXT_PUBLIC_ARENA_ADDRESS=0x...
NEXT_PUBLIC_RELAYER_URL=http://localhost:8787
NEXT_PUBLIC_CHAIN_ID=10143
```

Then run:

```bash
cd nextbattleroyale
npm install
npm run dev
```

## 🎮 How to Play

1. **Set Name**: Choose your warrior's name.
2. **Join**: Enter the arena.
3. **Move**: Use the UI controls (or arrow keys) to navigate the grid.
4. **Kill**: Move into an opponent's tile to eliminate them and increase your score.
5. **Survive**: Don't let others move into you!

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
