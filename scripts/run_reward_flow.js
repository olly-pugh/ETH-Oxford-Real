#!/usr/bin/env node

const { ethers } = require("ethers");
const { checkAttestation } = require("./check_attestation");
const { assertRealMode } = require("./attestation_mode");

const DEFAULT_CONFIRMATIONS = 12;
const DEFAULT_REWARD_FUNCTION_ABI = {
  inputs: [
    { name: "attestationTxHash", type: "bytes32" },
    { name: "payloadHash", type: "bytes32" },
    { name: "slotKey", type: "bytes32" },
    { name: "participant", type: "address" },
    { name: "shiftedKw", type: "uint256" },
  ],
  name: "executeReward",
  outputs: [],
  stateMutability: "nonpayable",
  type: "function",
};

const LEGACY_FLEXDAO_FUNCTION_ABI = {
  inputs: [
    {
      components: [
        { name: "participant", type: "address" },
        { name: "shiftedKw", type: "uint256" },
      ],
      name: "participants",
      type: "tuple[]",
    },
  ],
  name: "submitFlexEvent",
  outputs: [],
  stateMutability: "nonpayable",
  type: "function",
};

function mustEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
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

async function runRewardFlow() {
  assertRealMode("run_reward_flow.js");

  const confirmationsRequired = Number(
    process.env.CONFIRMATIONS || DEFAULT_CONFIRMATIONS
  );
  const dryRun = process.env.DRY_RUN !== "0";
  const signerMode = (process.env.SIGNER_MODE || "private_key").trim().toLowerCase();

  const attestation = await checkAttestation();
  if (!attestation.verificationPassed) {
    throw new Error("Attestation verification failed. Reward flow blocked.");
  }
  if (!attestation.confirmed || attestation.confirmations < confirmationsRequired) {
    throw new Error(
      `Attestation has ${attestation.confirmations} confirmations; requires ${confirmationsRequired}.`
    );
  }
  if (!attestation.payloadHashValid || !attestation.timestampValid) {
    throw new Error("Attestation payload hash/timestamp validation failed.");
  }

  const rpcUrl = mustEnv("FLARE_RPC_URL");
  const expectedChainId = BigInt(mustEnv("FLARE_CHAIN_ID"));
  const rewardContractAddress = normalizeAddress(mustEnv("REWARD_CONTRACT_ADDRESS"));
  const functionName = process.env.REWARD_FUNCTION_NAME || "executeReward";
  const functionAbi = process.env.REWARD_FUNCTION_ABI_JSON
    ? JSON.parse(process.env.REWARD_FUNCTION_ABI_JSON)
    : process.env.REWARD_FUNCTION_NAME === "submitFlexEvent"
      ? LEGACY_FLEXDAO_FUNCTION_ABI
      : DEFAULT_REWARD_FUNCTION_ABI;
  const functionArgs = process.env.REWARD_FUNCTION_ARGS_JSON
    ? JSON.parse(process.env.REWARD_FUNCTION_ARGS_JSON)
    : null;

  if (!Array.isArray(functionArgs)) {
    throw new Error(
      "REWARD_FUNCTION_ARGS_JSON must be a JSON array, e.g. '[\"0xslot\", [{\"participant\":\"0x...\",\"shiftedKw\":\"1000\"}]]'."
    );
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId) {
    throw new Error(
      `FLARE_CHAIN_ID mismatch. Expected ${expectedChainId}, got ${network.chainId}.`
    );
  }

  const iface = new ethers.Interface([functionAbi]);
  const calldata = iface.encodeFunctionData(functionName, functionArgs);
  const feeData = await provider.getFeeData();

  // Best-effort gas estimate. Some nodes require a `from`; MetaMask mode can pass SIGNER_ADDRESS.
  const signerAddressEnv = optionalEnv("SIGNER_ADDRESS");
  const estimateFrom = signerAddressEnv ? normalizeAddress(signerAddressEnv) : undefined;
  let estimatedGas = null;
  try {
    estimatedGas = await provider.estimateGas({
      to: rewardContractAddress,
      ...(estimateFrom ? { from: estimateFrom } : {}),
      data: calldata,
    });
  } catch (_e) {
    estimatedGas = null;
  }

  if (dryRun) {
    console.log("Reward flow dry-run only.");
    console.log(`Attestation confirmed: ${attestation.confirmed}`);
    console.log(`Estimated gas: ${estimatedGas ? estimatedGas.toString() : "N/A"}`);
    console.log(`Max fee per gas: ${(feeData.maxFeePerGas || 0n).toString()}`);
    console.log(`Reward contract: ${rewardContractAddress}`);
    console.log(`Function: ${functionName}`);
    console.log(`Calldata: ${calldata}`);

    if (signerMode === "metamask") {
      console.log("MetaMask mode: copy the tx request below.");
      const fromForMetamask = estimateFrom || "<your_metamask_address>";
      const txRequest = {
        from: fromForMetamask,
        to: rewardContractAddress,
        data: calldata,
        value: "0x0",
        chainId: asHexQuantity(expectedChainId),
        ...(estimatedGas ? { gas: asHexQuantity(estimatedGas) } : {}),
        ...(feeData.maxFeePerGas ? { maxFeePerGas: asHexQuantity(feeData.maxFeePerGas) } : {}),
        ...(feeData.maxPriorityFeePerGas
          ? { maxPriorityFeePerGas: asHexQuantity(feeData.maxPriorityFeePerGas) }
          : {}),
      };
      console.log(JSON.stringify(txRequest, null, 2));
      console.log(
        `MetaMask console snippet: await ethereum.request({ method: "eth_sendTransaction", params: [${JSON.stringify(
          txRequest
        )}] })`
      );
    }

    return {
      dryRun: true,
      attestation,
      estimatedGas: estimatedGas ? estimatedGas.toString() : null,
      maxFeePerGas: (feeData.maxFeePerGas || 0n).toString(),
      rewardContractAddress,
      functionName,
      calldata,
    };
  }

  if (signerMode === "metamask") {
    const rewardTxHash = optionalEnv("REWARD_TX_HASH");
    if (!rewardTxHash) {
      const fromForMetamask = estimateFrom || "<your_metamask_address>";
      const txRequest = {
        from: fromForMetamask,
        to: rewardContractAddress,
        data: calldata,
        value: "0x0",
        chainId: asHexQuantity(expectedChainId),
        ...(estimatedGas ? { gas: asHexQuantity(estimatedGas) } : {}),
        ...(feeData.maxFeePerGas ? { maxFeePerGas: asHexQuantity(feeData.maxFeePerGas) } : {}),
        ...(feeData.maxPriorityFeePerGas
          ? { maxPriorityFeePerGas: asHexQuantity(feeData.maxPriorityFeePerGas) }
          : {}),
      };
      console.log("MetaMask live mode: send this transaction, then rerun with REWARD_TX_HASH.");
      console.log(JSON.stringify(txRequest, null, 2));
      console.log(
        `MetaMask console snippet: await ethereum.request({ method: "eth_sendTransaction", params: [${JSON.stringify(
          txRequest
        )}] })`
      );
      return {
        dryRun: false,
        attestation,
        rewardTxHash: null,
        rewardBlockNumber: null,
      };
    }

    const receipt = await provider.getTransactionReceipt(rewardTxHash);
    if (!receipt) {
      throw new Error(`REWARD_TX_HASH not found yet: ${rewardTxHash}`);
    }
    const latestBlock = await provider.getBlockNumber();
    const confirmations = latestBlock - receipt.blockNumber + 1;
    const confirmed = confirmations >= confirmationsRequired;

    console.log(`Reward tx hash: ${rewardTxHash}`);
    console.log(`Reward tx block number: ${receipt.blockNumber}`);
    console.log(`Reward confirmations: ${confirmations} (need ${confirmationsRequired})`);
    console.log(`Reward confirmed: ${confirmed}`);

    if (!confirmed) {
      throw new Error("Reward tx not confirmed enough yet.");
    }

    return {
      dryRun: false,
      attestation,
      rewardTxHash,
      rewardBlockNumber: receipt.blockNumber,
    };
  }

  const signerKey = mustEnv("FLARE_SIGNER_KEY");
  const signer = new ethers.Wallet(signerKey, provider);
  const rewardContract = new ethers.Contract(rewardContractAddress, [functionAbi], signer);

  const tx = await rewardContract[functionName](...functionArgs);
  const receipt = await tx.wait(1);

  console.log(`Reward tx hash: ${tx.hash}`);
  console.log(`Reward tx block number: ${receipt.blockNumber}`);
  console.log("Reward flow complete.");

  return {
    dryRun: false,
    attestation,
    rewardTxHash: tx.hash,
    rewardBlockNumber: receipt.blockNumber,
  };
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--attestation" && args[i + 1]) {
      process.env.ATTESTATION_TX_HASH = args[i + 1];
      i++;
    } else if (args[i] === "--dry-run") {
      process.env.DRY_RUN = "1";
    } else if (args[i] === "--execute") {
      process.env.DRY_RUN = "0";
    }
  }
}

if (require.main === module) {
  parseCliArgs();
  runRewardFlow().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { runRewardFlow };
