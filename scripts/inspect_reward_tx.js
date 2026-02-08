#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { assertRealMode } = require("./attestation_mode");

const DEFAULT_CONFIRMATIONS = 12;

const REWARD_EXECUTOR_ABI = [
  "event RewardExecuted(bytes32 indexed attestationTxHash, bytes32 indexed payloadHash, bytes32 indexed slotKey, address participant, uint256 shiftedKw)",
  "function executeReward(bytes32 attestationTxHash, bytes32 payloadHash, bytes32 slotKey, address participant, uint256 shiftedKw) external",
];

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

function asBoolStatus(status) {
  if (status === null || status === undefined) return null;
  return status === 1;
}

function decodeFunctionCall(iface, tx) {
  if (!tx || !tx.data || tx.data === "0x") return { name: null, selector: null, reason: "No tx input data" };
  const selector = tx.data.slice(0, 10);
  try {
    const decoded = iface.parseTransaction({ data: tx.data, value: tx.value });
    return { name: decoded ? decoded.name : null, selector, reason: null };
  } catch (_e) {
    return { name: null, selector, reason: "Unknown function selector for RewardExecutor ABI" };
  }
}

async function main() {
  assertRealMode("inspect_reward_tx.js");

  const rpcUrl = mustEnv("FLARE_RPC_URL");
  const expectedChainId = BigInt(mustEnv("FLARE_CHAIN_ID"));
  const rewardTxHash = mustEnv("REWARD_TX_HASH");
  const rewardContractAddress = normalizeAddress(mustEnv("REWARD_CONTRACT_ADDRESS"));
  const confirmationsRequired = Number(process.env.CONFIRMATIONS || DEFAULT_CONFIRMATIONS);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId) {
    throw new Error(
      `FLARE_CHAIN_ID mismatch. Expected ${expectedChainId}, got ${network.chainId}.`
    );
  }

  const tx = await provider.getTransaction(rewardTxHash);
  if (!tx) {
    throw new Error(`Reward tx not found: ${rewardTxHash}`);
  }
  const receipt = await provider.getTransactionReceipt(rewardTxHash);
  if (!receipt) {
    throw new Error(`Reward receipt not found yet: ${rewardTxHash}`);
  }

  const latestBlock = await provider.getBlockNumber();
  const confirmations = latestBlock - receipt.blockNumber + 1;
  const confirmed = confirmations >= confirmationsRequired;
  const status = asBoolStatus(receipt.status);

  const iface = new ethers.Interface(REWARD_EXECUTOR_ABI);
  const callInfo = decodeFunctionCall(iface, tx);

  const matchingLogs = receipt.logs.filter(
    (log) => normalizeAddress(log.address) === rewardContractAddress
  );

  const decodedEvents = [];
  const decodeErrors = [];
  for (const log of matchingLogs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "RewardExecuted") {
        decodedEvents.push({
          attestationTxHash: parsed.args.attestationTxHash,
          payloadHash: parsed.args.payloadHash,
          slotKey: parsed.args.slotKey,
          participant: parsed.args.participant,
          shiftedKw: parsed.args.shiftedKw.toString(),
          logIndex: log.index,
        });
      }
    } catch (err) {
      decodeErrors.push(err && (err.shortMessage || err.message || String(err)));
    }
  }

  const result = {
    txHash: rewardTxHash,
    blockNumber: receipt.blockNumber,
    confirmations,
    confirmationsRequired,
    confirmed,
    status,
    rewardContractAddress,
    functionName: callInfo.name,
    functionSelector: callInfo.selector,
    functionDecodeReason: callInfo.reason,
    decodedRewardEvents: decodedEvents,
    decodeErrors,
    chainId: network.chainId.toString(),
    checkedAtIso: new Date().toISOString(),
    raw: {
      tx: {
        from: tx.from,
        to: tx.to,
        nonce: tx.nonce,
        value: tx.value.toString(),
      },
      receipt: {
        status: receipt.status,
        gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : null,
        logsCount: receipt.logs ? receipt.logs.length : 0,
        matchingContractLogs: matchingLogs.length,
      },
    },
  };

  const outPath =
    optionalEnv("INSPECT_REWARD_OUT_PATH") ||
    path.join(__dirname, "..", "fdc-carbon", "out", "inspect_reward_result.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log("=== Reward Inspection Report ===");
  console.log(`Reward tx hash: ${result.txHash}`);
  console.log(`Block number: ${result.blockNumber}`);
  console.log(`Confirmations: ${result.confirmations} (need ${result.confirmationsRequired})`);
  console.log(`Reward confirmed: ${result.confirmed}`);
  console.log(`Status: ${result.status}`);
  console.log(`Contract address: ${result.rewardContractAddress}`);
  console.log(`Decoded function: ${result.functionName || "unknown"} (${result.functionSelector})`);
  if (!result.functionName && result.functionDecodeReason) {
    console.log(`Decode note: ${result.functionDecodeReason}`);
  }

  if (decodedEvents.length === 0) {
    console.log("RewardExecuted event: not found or could not decode");
    if (decodeErrors.length > 0) {
      console.log(`Decode errors: ${decodeErrors[0]}`);
    }
  } else {
    const event = decodedEvents[0];
    console.log(`RewardExecuted.attestationTxHash: ${event.attestationTxHash}`);
    console.log(`RewardExecuted.payloadHash: ${event.payloadHash}`);
    console.log(`RewardExecuted.slotKey: ${event.slotKey}`);
    console.log(`RewardExecuted.participant: ${event.participant}`);
    console.log(`RewardExecuted.shiftedKw: ${event.shiftedKw}`);
  }
  console.log(`Saved: ${outPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

