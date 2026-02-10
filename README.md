# WhaleSwap Token Swap DApp

A decentralized application for over-the-counter token swaps on BNB Smart Chain and Polygon.

## Networks Supported
- Polygon Mainnet
- BNB Smart Chain
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
CONTRACT_ADDRESS=0x324d9b90A07D587B4FA0D68c22645B9c8D321079
RECIPIENT_ADDRESS=your_recipient_address
TOKEN1_ADDRESS=0xd85e481D10f8d77762e6215E87C5900D8b098e94
TOKEN2_ADDRESS=0xcDC1F663207f1ec636C5AF85C1D669A4a3d02fB3
YOUR_ALCHEMY_KEY=your_alchemy_key
```

## Network Configuration
Chain support is defined in `js/config.js`. The selector only exposes chains that have deployed contract config:

```javascript
{
    "56": {
        slug: "bnb",
        displayName: "BNB Smart Chain",
        chainId: "0x38",
        contractAddress: "0x324d9b90A07D587B4FA0D68c22645B9c8D321079"
    },
    "137": {
        slug: "polygon",
        displayName: "Polygon Mainnet",
        chainId: "0x89",
        contractAddress: "0x324d9b90A07D587B4FA0D68c22645B9c8D321079"
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

4. Connect your wallet. On mismatch, the chain selector can request wallet switch between Polygon Mainnet and BNB Smart Chain.

## Features
- Create swap orders
- Fill existing orders
- Cancel your orders
- View active orders
- Network switching support
- Real-time order updates

## Testing
1. Validate both supported chains (`polygon`, `bnb`) via selector and `?chain=` URL.
2. Verify your wallet can switch between BNB Smart Chain and Polygon Mainnet.
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
- Contract: 0x324d9b90A07D587B4FA0D68c22645B9c8D321079

### BNB Smart Chain
- Chain ID: 56 (0x38)
- Primary RPC URL: https://bsc-dataseed.binance.org
- Explorer: https://bscscan.com
- Native Currency: BNB (18 decimals)
- Contract: 0x324d9b90A07D587B4FA0D68c22645B9c8D321079

## Support
For issues and feature requests, please open an issue on the repository.
