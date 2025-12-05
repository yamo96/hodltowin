const hre = require("hardhat");

async function main() {
  const entryFee = hre.ethers.parseEther("0.0003"); // ~1$ örnek
  // İlk round bitiş zamanını (timestamp) manuel gir: örn: şimdi + 7 gün
  const now = Math.floor(Date.now() / 1000);
  const firstRoundEnd = now + 7 * 24 * 60 * 60;

  const HodlOrDieWeekly = await hre.ethers.getContractFactory("HodlOrDieWeekly");
  const contract = await HodlOrDieWeekly.deploy(entryFee, firstRoundEnd);
  await contract.waitForDeployment();

  console.log("HodlOrDieWeekly deployed to:", await contract.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});