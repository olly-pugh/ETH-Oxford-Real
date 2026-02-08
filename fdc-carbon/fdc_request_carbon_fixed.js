// fdc_request_carbon_fixed.js
// Legacy helper kept for reference, but made safe for hackathon submission:
// - No hardcoded keys
// - MIC computed over exact bytes
// Prefer using fdc-carbon/request_jsonapi_attestation.js for the current Web2Json flow.

const fetch = globalThis.fetch;
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return String(v);
}

function optionalEnv(name, fallback) {
  const v = process.env[name];
  return v ? String(v) : fallback;
}

const RPC = optionalEnv("RPC_URL", "https://coston2-api.flare.network/ext/C/rpc");
const PRIVATE_KEY = mustEnv("PRIVATE_KEY");
const FDC_HUB_ADDRESS = optionalEnv(
  "FDC_HUB_ADDRESS",
  "0x48aC463d7975828989331F4De43341627b9c5f1D"
);
const API_URL = optionalEnv(
  "API_URL",
  "https://api.carbonintensity.org.uk/intensity/2026-01-31T00:00Z/2026-02-07T00:00Z"
);
const JQ = optionalEnv(
  "JQ",
  ".data | map({t: .from, carbon_gCO2_per_kWh: .intensity.forecast})"
);
const FEE_WEI = ethers.parseEther(optionalEnv("FDC_FEE_C2FLR", "0.01"));
const VERIFIER_BASE = optionalEnv("VERIFIER_BASE", "https://fdc-verifiers-testnet.flare.network");
const VERIFIER_API_KEY = mustEnv("VERIFIER_API_KEY");
const API_RESPONSE_PATH = optionalEnv("API_RESPONSE_PATH", path.join(__dirname, "api_response.json"));

async function prepareAbiEncodedRequest(mic) {
  // Build the request body matching verifier swagger for JsonApi prepareRequest
  const payload = {
    attestationType: "0x4a736f6e41706900000000000000000000000000000000000000000000000000", // "JsonApi" padded hex
    sourceId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    requestBody: {
      url: API_URL,
      jq: JQ,
      expectedResponseHash: mic,
      emissionTimestamp: Math.floor(Date.now() / 1000).toString()
    }
  };

  const res = await fetch(`${VERIFIER_BASE}/verifier/jsonapi/prepareRequest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': VERIFIER_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Verifier prepareRequest failed: ${JSON.stringify(data)}`);
  if (!data.abiEncodedRequest) throw new Error(`Verifier did not return abiEncodedRequest: ${JSON.stringify(data)}`);
  return data.abiEncodedRequest; // hex string starting with 0x
}

async function main() {
  // 0) read exact bytes and compute MIC
  if (!fs.existsSync(API_RESPONSE_PATH)) {
    console.error(
      `api_response.json not found: ${API_RESPONSE_PATH}. Fetch and save exact API bytes first.`
    );
    process.exit(1);
  }
  const bodyBytes = fs.readFileSync(API_RESPONSE_PATH);
  const mic = `0x${crypto.createHash("sha256").update(bodyBytes).digest("hex")}`;
  console.log("MIC computed from saved file:", mic);

  // 1) prepare abiEncodedRequest via verifier
  console.log("Calling verifier prepareRequest to get abiEncodedRequest...");
  const abiEncodedRequest = await prepareAbiEncodedRequest(mic);
  console.log("Received abiEncodedRequest (truncated):", abiEncodedRequest.slice(0,120) + '...');

  // 2) submit to FDC hub
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const fdcHub = new ethers.Contract(FDC_HUB_ADDRESS, ["function requestAttestation(bytes abiEncodedRequest) payable"], wallet);

  console.log("Submitting requestAttestation to FDC hub...");
  const tx = await fdcHub.requestAttestation(abiEncodedRequest, { value: FEE_WEI });
  console.log("tx sent:", tx.hash);
  const receipt = await tx.wait();
  console.log("tx mined in block:", receipt.blockNumber, "blockHash:", receipt.blockHash);
  // Save tx info for later
  fs.writeFileSync(
    "attestation_tx.json",
    JSON.stringify({ txHash: tx.hash, blockNumber: receipt.blockNumber }, null, 2)
  );
  console.log(
    "Saved attestation_tx.json - next: compute roundId and fetch proof from DA layer once the round finalises."
  );
}

main().catch(err => {
  console.error("Error:", err && err.message ? err.message : err);
  process.exit(1);
});
