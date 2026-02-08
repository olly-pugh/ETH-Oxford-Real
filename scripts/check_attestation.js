#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { assertRealMode } = require("./attestation_mode");

const DEFAULT_VERIFICATION_ADDRESS = "0x906507E0B64bcD494Db73bd0459d1C667e14B933";
const DEFAULT_CONFIRMATIONS = 12;

const VERIFY_FUNCTION_ABI = {
  inputs: [
    {
      components: [
        {
          components: [
            { name: "attestationType", type: "bytes32" },
            { name: "sourceId", type: "bytes32" },
            { name: "votingRound", type: "uint256" },
            { name: "lowestUsedTimestamp", type: "uint256" },
            {
              components: [
                { name: "url", type: "string" },
                { name: "postprocessJq", type: "string" },
                { name: "abi_signature", type: "string" },
              ],
              name: "requestBody",
              type: "tuple",
            },
          ],
          name: "request",
          type: "tuple",
        },
        {
          components: [{ name: "abi_encoded_data", type: "bytes" }],
          name: "responseBody",
          type: "tuple",
        },
      ],
      name: "data",
      type: "tuple",
    },
    {
      name: "proofs",
      type: "bytes32[]",
    },
  ],
  name: "verifyJsonApi",
  outputs: [{ name: "_proved", type: "bool" }],
  stateMutability: "view",
  type: "function",
};

const VERIFY_WEB2JSON_FUNCTION_ABI = {
  inputs: [
    {
      components: [
        { name: "merkleProof", type: "bytes32[]" },
        {
          name: "data",
          type: "tuple",
          components: [
            { name: "attestationType", type: "bytes32" },
            { name: "sourceId", type: "bytes32" },
            { name: "votingRound", type: "uint64" },
            { name: "lowestUsedTimestamp", type: "uint64" },
            {
              name: "requestBody",
              type: "tuple",
              components: [
                { name: "url", type: "string" },
                { name: "httpMethod", type: "string" },
                { name: "headers", type: "string" },
                { name: "queryParams", type: "string" },
                { name: "body", type: "string" },
                { name: "postProcessJq", type: "string" },
                { name: "abiSignature", type: "string" },
              ],
            },
            {
              name: "responseBody",
              type: "tuple",
              components: [{ name: "abiEncodedData", type: "bytes" }],
            },
          ],
        },
      ],
      name: "_proof",
      type: "tuple",
    },
  ],
  name: "verifyWeb2Json",
  outputs: [{ name: "_proved", type: "bool" }],
  stateMutability: "view",
  type: "function",
};

const FDC_HUB_ABI = ["function requestFee() external view returns (uint256)"];

function mustEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function fileIfExists(filePath) {
  if (!filePath) return null;
  return fs.existsSync(filePath) ? filePath : null;
}

function normalizeAddress(value) {
  return ethers.getAddress(value);
}

function sha256Hex(bytes) {
  return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseRequestRange(url) {
  const marker = "/intensity/";
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  const tail = url.slice(idx + marker.length);
  const chunks = tail.split("/");
  if (chunks.length < 2) return null;
  const start = Date.parse(chunks[0]);
  const end = Date.parse(chunks[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    startIso: chunks[0],
    endIso: chunks[1],
    startMs: start,
    endMs: end,
    valid: end > start,
  };
}

function extractDaProofPayload(daProofJson) {
  if (daProofJson && daProofJson.response && daProofJson.response.proof) {
    return daProofJson.response;
  }
  if (
    daProofJson &&
    daProofJson.response &&
    daProofJson.response.response &&
    daProofJson.response.proof
  ) {
    return daProofJson.response;
  }
  if (daProofJson && daProofJson.proof && daProofJson.response) {
    return daProofJson;
  }
  throw new Error("Could not find DA proof payload.");
}

function buildVerifyJsonApiProof(rawPayload) {
  const response = rawPayload.response || {};
  const request = response.request || response;
  const requestBody = request.requestBody || {};
  const responseBody = response.responseBody || {};

  return {
    data: {
      request: {
        attestationType: request.attestationType,
        sourceId: request.sourceId,
        votingRound: BigInt(request.votingRound || 0),
        lowestUsedTimestamp: BigInt(request.lowestUsedTimestamp || 0),
        requestBody: {
          url: requestBody.url || "",
          postprocessJq: requestBody.postprocessJq || requestBody.postProcessJq || "",
          abi_signature: requestBody.abi_signature || requestBody.abiSignature || "",
        },
      },
      responseBody: {
        abi_encoded_data:
          responseBody.abi_encoded_data || responseBody.abiEncodedData || "0x",
      },
    },
    proofs: rawPayload.proof || [],
  };
}

function validatePayloadHash({ apiResponsePath, expectedMic, submissionData }) {
  let computedMic = null;
  let micMatchesExpected = null;
  let micMatchesSubmission = null;

  if (apiResponsePath && fs.existsSync(apiResponsePath)) {
    computedMic = sha256Hex(fs.readFileSync(apiResponsePath));
    if (expectedMic) {
      micMatchesExpected = computedMic.toLowerCase() === expectedMic.toLowerCase();
    }
    if (submissionData && submissionData.computedMic) {
      micMatchesSubmission =
        computedMic.toLowerCase() === String(submissionData.computedMic).toLowerCase();
    }
  }

  const payloadHashValid =
    micMatchesExpected === false || micMatchesSubmission === false ? false : true;

  return {
    computedMic,
    micMatchesExpected,
    micMatchesSubmission,
    payloadHashValid,
  };
}

function buildVerifyWeb2JsonProof(rawPayload) {
  return {
    merkleProof: rawPayload.proof || [],
    data: rawPayload.response || {},
  };
}

async function checkAttestation() {
  assertRealMode("check_attestation.js");

  const rpcUrl = mustEnv("FLARE_RPC_URL");
  const expectedChainId = BigInt(mustEnv("FLARE_CHAIN_ID"));
  const fdcAttestationContract = normalizeAddress(mustEnv("FDC_ATTESTATION_CONTRACT"));
  const verificationAddress = normalizeAddress(
    process.env.FDC_VERIFICATION_CONTRACT || DEFAULT_VERIFICATION_ADDRESS
  );
  const confirmationsRequired = Number(
    process.env.CONFIRMATIONS || DEFAULT_CONFIRMATIONS
  );
  const txHash =
    process.env.ATTESTATION_TX_HASH ||
    (() => {
      const requestPath = fileIfExists(
        process.env.REQUEST_SUBMISSION_PATH ||
          path.join(__dirname, "..", "fdc-carbon", "out", "request_submission.json")
      );
      if (!requestPath) return null;
      const requestJson = readJson(requestPath);
      return requestJson.txHash || null;
    })();

  if (!txHash) {
    throw new Error(
      "Attestation tx hash missing. Set ATTESTATION_TX_HASH or REQUEST_SUBMISSION_PATH."
    );
  }

  const requestSubmissionPath = fileIfExists(
    process.env.REQUEST_SUBMISSION_PATH ||
      path.join(__dirname, "..", "fdc-carbon", "out", "request_submission.json")
  );
  const daProofPath = fileIfExists(
    process.env.DA_PROOF_PATH || path.join(__dirname, "..", "fdc-carbon", "out", "da_proof.json")
  );
  const apiResponsePath = fileIfExists(
    process.env.API_RESPONSE_PATH || path.join(__dirname, "..", "fdc-carbon", "api_response.json")
  );
  const expectedMic = process.env.EXPECTED_MIC || null;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId) {
    throw new Error(
      `FLARE_CHAIN_ID mismatch. Expected ${expectedChainId}, got ${network.chainId}.`
    );
  }

  const tx = await provider.getTransaction(txHash);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!tx || !receipt) {
    throw new Error(`Could not fetch transaction/receipt for ${txHash}`);
  }

  const receiptTo = normalizeAddress(receipt.to);
  if (receiptTo !== fdcAttestationContract) {
    throw new Error(
      `Attestation tx target mismatch. Expected ${fdcAttestationContract}, got ${receiptTo}.`
    );
  }

  const latestBlock = await provider.getBlockNumber();
  const confirmations = latestBlock - receipt.blockNumber + 1;
  const confirmed = confirmations >= confirmationsRequired;

  const contractLogsInTx = receipt.logs.filter(
    (log) => normalizeAddress(log.address) === fdcAttestationContract
  );
  const blockLogs = await provider.getLogs({
    address: fdcAttestationContract,
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  const matchingBlockLogs = blockLogs.filter((log) => log.transactionHash === txHash);

  let requestFeeWei = null;
  try {
    const hub = new ethers.Contract(fdcAttestationContract, FDC_HUB_ABI, provider);
    requestFeeWei = (await hub.requestFee()).toString();
  } catch (_err) {
    requestFeeWei = null;
  }

  if (!daProofPath) {
    throw new Error("DA proof file missing. Set DA_PROOF_PATH.");
  }
  const daProofJson = readJson(daProofPath);
  const proofPayload = extractDaProofPayload(daProofJson);
  const verifyProof = buildVerifyJsonApiProof(proofPayload);
  const verifyWeb2Proof = buildVerifyWeb2JsonProof(proofPayload);

  let verificationPassed = false;
  let verificationFunction = "verifyJsonApi";
  let verificationError = null;
  try {
    const verifier = new ethers.Contract(verificationAddress, [VERIFY_FUNCTION_ABI], provider);
    verificationPassed = await verifier.verifyJsonApi(
      verifyProof.data,
      verifyProof.proofs
    );
  } catch (err) {
    verificationError = err;
    try {
      const verifierWeb2 = new ethers.Contract(
        verificationAddress,
        [VERIFY_WEB2JSON_FUNCTION_ABI],
        provider
      );
      verificationPassed = await verifierWeb2.verifyWeb2Json(verifyWeb2Proof);
      verificationFunction = "verifyWeb2Json";
      verificationError = null;
    } catch (_fallbackErr) {
      throw err;
    }
  }

  const submissionData = requestSubmissionPath ? readJson(requestSubmissionPath) : null;
  const payloadHash = validatePayloadHash({
    apiResponsePath,
    expectedMic,
    submissionData,
  });

  const attestationBlock = await provider.getBlock(receipt.blockNumber);
  const lowestUsedTimestamp = Number(verifyProof.data.request.lowestUsedTimestamp);
  const blockTimestamp = Number(attestationBlock.timestamp);
  const timestampRange = parseRequestRange(verifyProof.data.request.requestBody.url);
  const timestampValid =
    (lowestUsedTimestamp === 0 || blockTimestamp >= lowestUsedTimestamp) &&
    (!timestampRange || timestampRange.valid);

  const result = {
    txHash,
    blockNumber: receipt.blockNumber,
    confirmationsRequired,
    confirmations,
    confirmed,
    verificationPassed: Boolean(verificationPassed),
    verificationFunction,
    payloadHashValid: payloadHash.payloadHashValid,
    timestampValid,
    chainId: network.chainId.toString(),
    fdcAttestationContract,
    verificationAddress,
    attestationLogsInReceipt: contractLogsInTx.length,
    attestationLogsInBlock: matchingBlockLogs.length,
    requestFeeWei,
    payloadHash,
    lowestUsedTimestamp,
    blockTimestamp,
    requestTimestampRange: timestampRange,
    checkedAtIso: new Date().toISOString(),
    verificationFallbackError: verificationError ? (verificationError.shortMessage || verificationError.message || String(verificationError)) : null,
  };

  const outPath =
    process.env.CHECK_ATTESTATION_OUT_PATH ||
    path.join(__dirname, "..", "fdc-carbon", "out", "check_attestation_result.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(`Attestation tx hash: ${result.txHash}`);
  console.log(`Block number: ${result.blockNumber}`);
  console.log(`Confirmed: ${result.confirmed}`);
  console.log(`Verification passed: ${result.verificationPassed}`);
  console.log(`Verification function: ${result.verificationFunction}`);
  console.log(`Payload hash valid: ${result.payloadHashValid}`);
  console.log(`Timestamp valid: ${result.timestampValid}`);
  console.log(`Saved: ${outPath}`);

  return result;
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--id" && args[i + 1]) {
      process.env.ATTESTATION_TX_HASH = args[i + 1];
      i++;
    }
  }
}

if (require.main === module) {
  parseCliArgs();
  checkAttestation().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  checkAttestation,
  VERIFY_FUNCTION_ABI,
};
