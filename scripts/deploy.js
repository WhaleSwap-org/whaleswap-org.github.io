require('dotenv').config();
const fs = require('fs');

async function updateEnvFile(token1Address, token2Address) {
  try {
    // Read existing .env content
    let envContent = fs.readFileSync('.env', 'utf8');
    
    // Replace or add TOKEN addresses
    const envVars = envContent.split('\n');
    const updatedVars = envVars.filter(line => 
      !line.startsWith('TOKEN1_ADDRESS=') && 
      !line.startsWith('TOKEN2_ADDRESS=')
    );
    
    // Add new token addresses
    updatedVars.push(`TOKEN1_ADDRESS=${token1Address}`);
    updatedVars.push(`TOKEN2_ADDRESS=${token2Address}`);
    
    // Write back to .env
    fs.writeFileSync('.env', updatedVars.join('\n'));
    console.log("Token addresses updated in .env file");
  } catch (error) {
    console.error("Error updating .env file:", error);
    throw error;
  }
}

async function logContractLink(address) {
  console.log(`Contract deployed to: ${address}`);
  console.log(`View on Amoy Explorer: https://www.oklink.com/amoy/address/${address}\n`);
}

async function main() {
  const TestToken = await ethers.getContractFactory("TestToken");
  
  // Deploy first token
  const token1 = await TestToken.deploy("Test Token 1", "TEST1");
  await token1.deployed();
  await logContractLink(token1.address);
  
  // Deploy second token
  const token2 = await TestToken.deploy("Test Token 2", "TEST2");
  await token2.deployed();
  await logContractLink(token2.address);

  // Update .env file with new addresses
  await updateEnvFile(token1.address, token2.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });