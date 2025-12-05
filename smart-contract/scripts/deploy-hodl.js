// scripts/deploy-hodl.js
const hre = require("hardhat");

async function main() {
  const entryFeeEth = process.env.ENTRY_FEE_ETH || "0.0003";
  const entryFeeWei = hre.ethers.parseEther(entryFeeEth);

  const HodlOrDie = await hre.ethers.getContractFactory("HodlOrDie");
  const contract = await HodlOrDie.deploy(entryFeeWei);
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log("HodlOrDie deployed to:", addr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
