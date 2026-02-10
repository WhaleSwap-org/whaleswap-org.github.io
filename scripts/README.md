# Token Deployment and Minting Scripts

This repository contains scripts for deploying and minting ERC20 test tokens on the Amoy network.

## Prerequisites

- Node.js installed
- Hardhat environment set up
- `.env` file configured with:
  ```plaintext
  PRIVATE_KEY=your_wallet_private_key
  RECIPIENT_ADDRESS=your_recipient_address
  ```

## Scripts Overview

### 1. Deploy Script (`scripts/deploy.js`)
Deploys two ERC20 test tokens and automatically saves/updates their addresses to the `.env` file.

**Features:**
- Deploys "Test Token 1" (TEST1) and "Test Token 2" (TEST2)
- Automatically saves/updates contract addresses to `.env`
- Provides deployment confirmation and addresses in console

**Usage:**
```bash
npx hardhat run scripts/deploy.js --network amoy
```

### 2. Mint Script (`scripts/mint.js`)
Mints tokens for both deployed contracts to a specified recipient address.

**Features:**
- Mints 1000 tokens for each contract
- Validates environment variables before execution
- Provides minting confirmation for each token
- Error handling for missing configurations

**Usage:**
```bash
npx hardhat run scripts/mint.js --network amoy
```

## Environment Variables

After running the deploy script, your `.env` file should contain:
```plaintext
PRIVATE_KEY=your_wallet_private_key
RECIPIENT_ADDRESS=your_recipient_address
TOKEN1_ADDRESS=deployed_token1_address
TOKEN2_ADDRESS=deployed_token2_address
```

## Network Configuration

Add Amoy network configuration to your `hardhat.config.js`:
```javascript
networks: {
  amoy: {
    url: "https://rpc.amoy.technology",
    chainId: 80002,
    accounts: [process.env.PRIVATE_KEY]
  }
}
```

## Deployment Steps

### Amoy Network Deployment
```bash
# 1. Get Amoy testnet ETH from faucet
# Visit: https://faucet.amoy.technology

# 2. Deploy tokens to Amoy
npx hardhat run scripts/deploy.js --network amoy

# 3. Mint tokens on Amoy
npx hardhat run scripts/mint.js --network amoy
```

### Local Testing (Optional)
If you want to test locally before deploying to Amoy:
```bash
# Start Anvil in a separate terminal
anvil

# Deploy and mint locally
npx hardhat run scripts/deploy.js --network anvil
npx hardhat run scripts/mint.js --network anvil
```

### Verifying Transactions
- View your transactions on Amoy Explorer: `https://www.oklink.com/amoy/tx/<your-transaction-hash>`
- For local testing: Transactions visible in Anvil console output

## Code References

### Deploy Script
See the full implementation in [`scripts/deploy.js`](./deploy.js)

### Mint Script
See the full implementation in [`scripts/mint.js`](./mint.js)

## Notes

- Make sure to have sufficient Amoy testnet POL in your deployer account for gas fees
- The mint amount is set to 1000 tokens by default
- Both scripts will exit with status code 1 if any errors occur
- For Amoy testnet:
  - Get test ETH from: https://faucet.polygon.technology/ or polygon discord
  - Network Details:
    - RPC URL: https://rpc-amoy.polygon.technology
    - Chain ID: 80002
    - Explorer: https://www.oklink.com/amoy
- Scripts can be used with any EVM-compatible network by adding appropriate network configuration