#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { checkAttestation } = require("./check_attestation");
const { assertRealMode } = require("./attestation_mode");

const DEFAULT_CONFIRMATIONS = 12;

const FDC_HUB_METHOD_ABI = [
  "function requestAttestation(bytes _data) external payable",
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

function asBoolStatus(status) {
  if (status === null || status === undefined) return null;
  return status === 1;
}

function decodeHubMethod(transaction) {
  if (!transaction || !transaction.data || transaction.data === "0x") {
    return { methodName: null, methodSelector: null, decoded: null, reason: "No input data" };
  }

  const methodSelector = transaction.data.slice(0, 10);
  const iface = new ethers.Interface(FDC_HUB_METHOD_ABI);
  try {
    const decoded = iface.parseTransaction({
      data: transaction.data,
      value: transaction.value,
    });
    return {
      methodName: decoded ? decoded.name : null,
      methodSelector,
      decoded: decoded
        ? {
            name: decoded.name,
            value: transaction.value.toString(),
            args: decoded.args ? decoded.args.map((x) => String(x)).slice(0, 1) : [],
          }
        : null,
      reason: null,
    };
  } catch (_e) {
    return {
      methodName: null,
      methodSelector,
      decoded: null,
      reason: "Unknown ABI for selector on FDC hub",
    };
  }
}

async function main() {
  assertRealMode("inspect_attestation_tx.js");

  const rpcUrl = mustEnv("FLARE_RPC_URL");
  const expectedChainId = BigInt(mustEnv("FLARE_CHAIN_ID"));
  const txHash = mustEnv("ATTESTATION_TX_HASH");
  const confirmationsRequired = Number(process.env.CONFIRMATIONS || DEFAULT_CONFIRMATIONS);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId) {
    throw new Error(
      `FLARE_CHAIN_ID mismatch. Expected ${expectedChainId}, got ${network.chainId}.`
    );
  }

  const tx = await provider.getTransaction(txHash);
  if (!tx) {
    throw new Error(`Attestation tx not found: ${txHash}`);
  }
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error(`Attestation receipt not found yet: ${txHash}`);
  }

  const latestBlock = await provider.getBlockNumber();
  const confirmations = latestBlock - receipt.blockNumber + 1;
  const confirmed = confirmations >= confirmationsRequired;
  const status = asBoolStatus(receipt.status);
  const method = decodeHubMethod(tx);

  if (!process.env.FDC_ATTESTATION_CONTRACT && tx.to) {
    process.env.FDC_ATTESTATION_CONTRACT = tx.to;
  }
  process.env.ATTESTATION_TX_HASH = txHash;

  let verificationPassed = null;
  let verificationFunction = null;
  let verificationError = null;
  let payloadHashValid = null;
  let timestampValid = null;
  try {
    const check = await checkAttestation();
    verificationPassed = Boolean(check.verificationPassed);
    verificationFunction = check.verificationFunction || null;
    payloadHashValid = check.payloadHashValid;
    timestampValid = check.timestampValid;
  } catch (err) {
    verificationError = err && (err.shortMessage || err.message || String(err));
  }

  const result = {
    txHash,
    blockNumber: receipt.blockNumber,
    confirmations,
    confirmationsRequired,
    confirmed,
    to: tx.to,
    status,
    methodName: method.methodName,
    methodSelector: method.methodSelector,
    methodDecodeReason: method.reason,
    verificationPassed,
    verificationFunction,
    verificationError,
    payloadHashValid,
    timestampValid,
    chainId: network.chainId.toString(),
    checkedAtIso: new Date().toISOString(),
    raw: {
      tx: {
        from: tx.from,
        to: tx.to,
        nonce: tx.nonce,
        value: tx.value.toString(),
        dataLength: tx.data ? tx.data.length : 0,
      },
      receipt: {
        status: receipt.status,
        gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : null,
        logsCount: receipt.logs ? receipt.logs.length : 0,
      },
    },
  };

  const outPath =
    optionalEnv("INSPECT_ATTESTATION_OUT_PATH") ||
    path.join(__dirname, "..", "fdc-carbon", "out", "inspect_attestation_result.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log("=== Attestation Inspection Report ===");
  console.log(`Tx hash: ${result.txHash}`);
  console.log(`Block number: ${result.blockNumber}`);
  console.log(`Confirmations: ${result.confirmations} (need ${result.confirmationsRequired})`);
  console.log(`Confirmed: ${result.confirmed}`);
  console.log(`To: ${result.to}`);
  console.log(`Status: ${result.status}`);
  console.log(`Decoded method: ${result.methodName || "unknown"} (${result.methodSelector})`);
  if (!result.methodName && result.methodDecodeReason) {
    console.log(`Decode note: ${result.methodDecodeReason}`);
  }
  if (result.verificationError) {
    console.log(`verifyWeb2Json passed: unknown (${result.verificationError})`);
  } else {
    console.log(`verifyWeb2Json passed: ${result.verificationPassed}`);
    console.log(`Verification function used: ${result.verificationFunction || "unknown"}`);
    console.log(`Payload hash valid: ${result.payloadHashValid}`);
    console.log(`Timestamp valid: ${result.timestampValid}`);
  }
  console.log(`Saved: ${outPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

