require('dotenv').config();

async function mintTokens(tokenAddress, recipientAddress, amount) {
  const TestToken = await ethers.getContractFactory("TestToken");
  const token = await TestToken.attach(tokenAddress);
  
  const tx = await token.mint(recipientAddress, amount);
  await tx.wait();
  
  console.log(`Minted ${ethers.utils.formatEther(amount)} tokens at ${tokenAddress}`);
}

async function main() {
  if (!process.env.TOKEN1_ADDRESS || !process.env.TOKEN2_ADDRESS) {
    throw new Error("Token addresses not found in .env file");
  }
  
  if (!process.env.RECIPIENT_ADDRESS) {
    throw new Error("Recipient address not found in .env file");
  }

  const mintAmount = ethers.utils.parseEther("1000");
  
  // Mint tokens for both contracts
  await mintTokens(process.env.TOKEN1_ADDRESS, process.env.RECIPIENT_ADDRESS, mintAmount);
  await mintTokens(process.env.TOKEN2_ADDRESS, process.env.RECIPIENT_ADDRESS, mintAmount);
  
  console.log("All tokens minted successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });