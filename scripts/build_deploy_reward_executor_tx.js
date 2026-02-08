#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function mustEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return String(value);
}

function optionalEnv(name) {
  const value = process.env[name];
  return value ? String(value) : null;
}

function normalizeAddress(value) {
  return ethers.getAddress(value);
}

function asHexQuantity(n) {
  return ethers.toBeHex(BigInt(n));
}

function writeOut(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

async function main() {
  const rpcUrl = mustEnv("FLARE_RPC_URL");
  const expectedChainId = BigInt(mustEnv("FLARE_CHAIN_ID"));

  const signerAddress = normalizeAddress(mustEnv("SIGNER_ADDRESS"));
  const ownerAddress = normalizeAddress(optionalEnv("OWNER_ADDRESS") || signerAddress);

  const artifactPath =
    process.env.REWARD_EXECUTOR_ARTIFACT ||
    path.join(
      __dirname,
      "..",
      "artifacts",
      "contracts",
      "RewardExecutor.sol",
      "RewardExecutor.json"
    );

  // Load the artifact lazily so users see a clear error if compile wasn't run.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const artifact = require(artifactPath);
  if (!artifact || !artifact.abi || !artifact.bytecode) {
    throw new Error(`Invalid artifact at ${artifactPath}. Did you run "npm run compile"?`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId) {
    throw new Error(
      `FLARE_CHAIN_ID mismatch. Expected ${expectedChainId}, got ${network.chainId}.`
    );
  }

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode);
  const deployTx = await factory.getDeployTransaction(ownerAddress);
  const data = deployTx.data;

  const feeData = await provider.getFeeData();
  let gas = null;
  try {
    gas = await provider.estimateGas({ from: signerAddress, data });
  } catch (_e) {
    gas = null;
  }

  const txRequest = {
    from: signerAddress,
    // Contract creation: omit `to`
    data,
    value: "0x0",
    chainId: asHexQuantity(expectedChainId),
    ...(gas ? { gas: asHexQuantity(gas) } : {}),
    ...(feeData.maxFeePerGas ? { maxFeePerGas: asHexQuantity(feeData.maxFeePerGas) } : {}),
    ...(feeData.maxPriorityFeePerGas
      ? { maxPriorityFeePerGas: asHexQuantity(feeData.maxPriorityFeePerGas) }
      : {}),
  };

  const outDir = path.join(__dirname, "..", "fdc-carbon", "out");
  const jsonOutPath = path.join(outDir, "metamask_deploy_reward_executor_tx.json");
  const jsOutPath = path.join(outDir, "metamask_deploy_reward_executor_tx.js");
  const snippet = `// MetaMask deploy tx for RewardExecutor (contract creation).
// Prereqs: MetaMask connected, on the correct network, and this page authorized.
// Run once: await ethereum.request({ method: "eth_requestAccounts" })
(async () => {
  try {
    const tx = ${JSON.stringify(txRequest, null, 2)};
    const chainId = await ethereum.request({ method: "eth_chainId" });
    console.log("MetaMask chainId", chainId);
    if (!/^0x[0-9a-fA-F]*$/.test(tx.data) || tx.data.length % 2 !== 0) {
      throw new Error("Bad tx.data hex string (truncated or contains non-hex). Re-generate from the script.");
    }
    console.log("Sending deploy tx...");
    const txHash = await ethereum.request({ method: "eth_sendTransaction", params: [tx] });
    console.log("DEPLOY_TX_HASH", txHash);
    console.log("Waiting for receipt (poll in console if null)...");
    const receipt = await ethereum.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    console.log("DEPLOY_RECEIPT", receipt);
  } catch (e) {
    console.error("DEPLOY_ERROR", e);
    throw e;
  }
})();\n`;

  writeOut(jsonOutPath, `${JSON.stringify(txRequest, null, 2)}\n`);
  writeOut(jsOutPath, snippet);

  console.log("MetaMask deploy tx (RewardExecutor):");
  console.log(JSON.stringify(txRequest, null, 2));
  console.log(`Saved deploy tx JSON: ${jsonOutPath}`);
  console.log(`Saved console snippet: ${jsOutPath}`);
  console.log("MetaMask console snippet:");
  console.log(snippet.trimEnd());

  const deployTxHash = optionalEnv("DEPLOY_TX_HASH");
  if (deployTxHash) {
    const receipt = await provider.getTransactionReceipt(deployTxHash);
    if (!receipt) {
      console.log(`DEPLOY_TX_HASH not found yet: ${deployTxHash}`);
      return;
    }
    console.log(`Deployed contract address: ${receipt.contractAddress}`);
    console.log(`Deploy block number: ${receipt.blockNumber}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
