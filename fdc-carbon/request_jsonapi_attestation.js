#!/usr/bin/env node
/**
 * Live Flare FDC Web2Json attestation request:
 * 1) Computes MIC from exact api_response.json bytes
 * 2) Calls verifier /verifier/web2/Web2Json/prepareRequest
 * 3) Calls verifier /verifier/web2/Web2Json/mic and checks expected MIC
 * 3) Submits requestAttestation(...) to FdcHub on Coston2
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const fetchFn = globalThis.fetch;

if (!fetchFn) {
  console.error("Global fetch is unavailable. Use Node.js >= 18.");
  process.exit(1);
}

const DEFAULTS = {
  rpcUrl: "https://coston2-api.flare.network/ext/C/rpc",
  verifierBase: "https://fdc-verifiers-testnet.flare.network",
  fdcHubAddress: "0x48aC463d7975828989331F4De43341627b9c5f1D",
  apiUrl: "https://api.carbonintensity.org.uk/intensity/2026-01-31T00:00Z/2026-02-07T00:00Z",
  jq: ".data | tostring",
  apiResponsePath: path.join(__dirname, "api_response.json"),
  outPath: path.join(__dirname, "out", "request_submission.json"),
};

const FDC_HUB_ABI = [
  "function requestFee() external view returns (uint256)",
  "function requestAttestation(bytes _data) external payable",
];

function must(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function sha256Hex(buffer) {
  return `0x${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

const WEB2JSON_ATTESTATION_TYPE =
  "0x576562324a736f6e000000000000000000000000000000000000000000000000";
const PUBLIC_WEB2_SOURCE_ID =
  "0x5075626c69635765623200000000000000000000000000000000000000000000";

function buildWeb2JsonRequest({ apiUrl, postProcessJq, abiSignature }) {
  return {
    attestationType: WEB2JSON_ATTESTATION_TYPE,
    sourceId: PUBLIC_WEB2_SOURCE_ID,
    requestBody: {
      url: apiUrl,
      httpMethod: "GET",
      headers: "",
      queryParams: "",
      body: "",
      postProcessJq,
      abiSignature,
    },
  };
}

async function prepareRequest({
  verifierBase,
  verifierApiKey,
  apiUrl,
  postProcessJq,
  abiSignature,
}) {
  const payload = buildWeb2JsonRequest({ apiUrl, postProcessJq, abiSignature });

  const res = await fetchFn(`${verifierBase}/verifier/web2/Web2Json/prepareRequest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": verifierApiKey,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `prepareRequest failed (${res.status}): ${JSON.stringify(data)}`
    );
  }
  if (!data || !data.abiEncodedRequest || !data.abiEncodedRequest.startsWith("0x")) {
    throw new Error(`prepareRequest response missing abiEncodedRequest`);
  }
  return { abiEncodedRequest: data.abiEncodedRequest, prepareResponse: data };
}

async function fetchVerifierMic({
  verifierBase,
  verifierApiKey,
  requestPayload,
}) {
  const res = await fetchFn(`${verifierBase}/verifier/web2/Web2Json/mic`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": verifierApiKey,
    },
    body: JSON.stringify(requestPayload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`mic failed (${res.status}): ${JSON.stringify(data)}`);
  }
  if (data.status !== "VALID") {
    throw new Error(`Verifier MIC status is not VALID: ${JSON.stringify(data)}`);
  }
  if (!data.messageIntegrityCode) {
    throw new Error(`Verifier MIC missing messageIntegrityCode`);
  }
  return data;
}

async function main() {
  const privateKey = must("PRIVATE_KEY");
  const verifierApiKey = must("VERIFIER_API_KEY");

  const rpcUrl = process.env.RPC_URL || DEFAULTS.rpcUrl;
  const verifierBase = process.env.VERIFIER_BASE || DEFAULTS.verifierBase;
  const fdcHubAddress = process.env.FDC_HUB_ADDRESS || DEFAULTS.fdcHubAddress;
  const apiUrl = process.env.API_URL || DEFAULTS.apiUrl;
  const postProcessJq = process.env.POST_PROCESS_JQ || DEFAULTS.jq;
  const abiSignature = process.env.ABI_SIGNATURE || "string";
  const apiResponsePath = process.env.API_RESPONSE_PATH || DEFAULTS.apiResponsePath;
  const outPath = process.env.OUT_PATH || DEFAULTS.outPath;
  const expectedMic = process.env.EXPECTED_MIC;
  const strictVerifierMicCheck = process.env.STRICT_VERIFIER_MIC === "1";
  const fallbackFeeEther = process.env.FDC_FEE_C2FLR || "0.01";

  if (!fs.existsSync(apiResponsePath)) {
    throw new Error(`api_response file not found: ${apiResponsePath}`);
  }

  const exactBytes = fs.readFileSync(apiResponsePath);
  const computedMic = sha256Hex(exactBytes);

  if (expectedMic && expectedMic.toLowerCase() !== computedMic.toLowerCase()) {
    throw new Error(
      `MIC mismatch: expected ${expectedMic} but computed ${computedMic}`
    );
  }

  const requestPayload = buildWeb2JsonRequest({
    apiUrl,
    postProcessJq,
    abiSignature,
  });

  console.log("Step 1/4: prepareRequest");
  const { abiEncodedRequest, prepareResponse } = await prepareRequest({
    verifierBase,
    verifierApiKey,
    apiUrl,
    postProcessJq,
    abiSignature,
  });

  console.log("Step 2/4: verifier MIC");
  const micResponse = await fetchVerifierMic({
    verifierBase,
    verifierApiKey,
    requestPayload,
  });
  const verifierMic = micResponse.messageIntegrityCode;
  if (
    strictVerifierMicCheck &&
    expectedMic &&
    expectedMic.toLowerCase() !== verifierMic.toLowerCase()
  ) {
    throw new Error(
      `Verifier MIC mismatch: expected ${expectedMic} but verifier returned ${verifierMic}`
    );
  }

  console.log("Step 3/4: submit to FdcHub");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const fdcHub = new ethers.Contract(fdcHubAddress, FDC_HUB_ABI, signer);

  let requestFee;
  try {
    requestFee = await fdcHub.requestFee();
  } catch (_e) {
    requestFee = ethers.parseEther(fallbackFeeEther);
  }
  const tx = await fdcHub.requestAttestation(abiEncodedRequest, { value: requestFee });
  const receipt = await tx.wait();

  const output = {
    network: "coston2",
    rpcUrl,
    verifierBase,
    fdcHubAddress,
    apiUrl,
    postProcessJq,
    abiSignature,
    apiResponsePath,
    computedMic,
    verifierMic,
    expectedMic: expectedMic || null,
    strictVerifierMicCheck,
    abiEncodedRequest,
    requestFeeWei: requestFee.toString(),
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    submittedAtIso: new Date().toISOString(),
    prepareResponse,
    micResponse,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("Step 4/4: done");
  console.log(`MIC: ${computedMic}`);
  console.log(`Attestation request tx: ${tx.hash}`);
  console.log(`Saved: ${outPath}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  if (err && err.cause) {
    console.error("Cause:", err.cause.message || err.cause);
  }
  if (err && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
