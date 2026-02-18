# WhaleSwap Token Swap DApp

A decentralized application for over-the-counter token swaps on Polygon networks.

## Networks Supported
- Polygon Mainnet
- Polygon Amoy Testnet
- Only these deployed chains are selectable in the app right now.

## Prerequisites
- Node.js
- MetaMask
- Test tokens for testing (on respective networks)
- An `.env` file in the root directory

## Environment Setup
1. Create a `.env` file in the root directory with the following variables:
```env
PRIVATE_KEY=your_private_key
CONTRACT_ADDRESS=0xF9D874860d5801233dd84569fad8513e0037A5d9
RECIPIENT_ADDRESS=your_recipient_address
TOKEN1_ADDRESS=0xd85e481D10f8d77762e6215E87C5900D8b098e94
TOKEN2_ADDRESS=0xcDC1F663207f1ec636C5AF85C1D669A4a3d02fB3
YOUR_ALCHEMY_KEY=your_alchemy_key
```

## Network Configuration
Chain support is defined in `js/config.js`. The selector only exposes chains that have deployed contract config:

```javascript
{
    "137": {
        slug: "polygon",
        displayName: "Polygon Mainnet",
        chainId: "0x89",
        contractAddress: "0x2F786290BAe87D1e8c01A97e6529030bbCF9f147"
    },
    "80002": {
        slug: "amoy",
        name: "Amoy",
        displayName: "Polygon Amoy Testnet",
        chainId: "0x13882",
        contractAddress: "0x7A64764074971839bd5A3022beA2450CBc51dEC8"
    }
}
```

## Getting Started (locally)

1. Install dependencies:
```bash
npm install
```

2. Ensure your `.env` file is properly configured

3. Start the node server:
```bash
http-server
```

4. Connect your wallet. On mismatch, the chain selector can request wallet switch between Polygon Mainnet and Amoy.

## Features
- Create swap orders
- Fill existing orders
- Cancel your orders
- View active orders
- Network switching support
- Real-time order updates

## Testing
1. Validate both supported chains (`polygon`, `amoy`) via selector and `?chain=` URL.
2. Get test tokens from the Polygon faucet for Amoy testing.
3. Ensure your wallet has sufficient native token for gas on selected chain.

## Security Notes
- Always verify token addresses
- Check order details carefully before swapping
- Never share your private keys
- Use trusted token contracts only

## Network Details

### Polygon Mainnet
- Chain ID: 137 (0x89)
- Primary RPC URL: https://polygon-rpc.com
- Explorer: https://polygonscan.com
- Native Currency: MATIC (18 decimals)

### Polygon Amoy Testnet
- Chain ID: 80002 (0x13882)
- Primary RPC URL: https://rpc-amoy.polygon.technology
- Fallback RPC URLs:
  - https://rpc.ankr.com/polygon_amoy
  - https://polygon-amoy.blockpi.network/v1/rpc/public
  - https://polygon-amoy.public.blastapi.io
- Explorer: https://www.oklink.com/amoy
- Faucet: https://faucet.polygon.technology/
- Native Currency: POL (18 decimals)

## Support
For issues and feature requests, please open an issue on the repository.
