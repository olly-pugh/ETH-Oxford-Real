#!/usr/bin/env node
/**
 * Calls on-chain verification contract with DA proof payload.
 *
 * Default verify function is IFdcVerification.verifyJsonApi(IJsonApi.Proof).
 * You can override ABI via VERIFY_FUNCTION_ABI (human-readable) or
 * VERIFY_FUNCTION_ABI_JSON (JSON fragment).
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DEFAULTS = {
  rpcUrl: "https://coston2-api.flare.network/ext/C/rpc",
  verificationAddress: "0x906507E0B64bcD494Db73bd0459d1C667e14B933",
  proofPath: path.join(__dirname, "out", "da_proof.json"),
  outPath: path.join(__dirname, "out", "verification_result.json"),
};

const DEFAULT_VERIFY_JSONAPI_ABI = {
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
    { name: "proofs", type: "bytes32[]" },
  ],
  name: "verifyJsonApi",
  outputs: [{ name: "_proved", type: "bool" }],
  stateMutability: "view",
  type: "function",
};

const DEFAULT_VERIFY_WEB2JSON_ABI = {
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

function extractProofPayload(daProofJson) {
  if (daProofJson && daProofJson.response && daProofJson.response.proof) {
    return daProofJson.response;
  }
  if (daProofJson && daProofJson.response && daProofJson.response.response) {
    return daProofJson.response.response;
  }
  if (daProofJson && daProofJson.response && daProofJson.response.proof) {
    return daProofJson.response;
  }
  if (daProofJson && daProofJson.proof && daProofJson.data) {
    return daProofJson;
  }
  throw new Error("Could not locate proof payload in DA proof JSON");
}

function normalizeForVerifyJsonApi(raw) {
  const response = raw.response || {};
  const request = response.request || response;
  const requestBody = request.requestBody || {};
  const responseBody = response.responseBody || {};

  const normalizedData = {
    request: {
      attestationType: request.attestationType,
      sourceId: request.sourceId,
      votingRound: request.votingRound,
      lowestUsedTimestamp: request.lowestUsedTimestamp,
      requestBody: {
        url: requestBody.url,
        postprocessJq: requestBody.postprocessJq ?? requestBody.postProcessJq ?? "",
        abi_signature: requestBody.abi_signature ?? requestBody.abiSignature ?? "",
      },
    },
    responseBody: {
      abi_encoded_data:
        responseBody.abi_encoded_data ?? responseBody.abiEncodedData ?? "0x",
    },
  };

  return {
    data: normalizedData,
    proofs: raw.proof || [],
  };
}

function normalizeForVerifyWeb2Json(raw) {
  return {
    merkleProof: raw.proof || [],
    data: raw.response || {},
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || DEFAULTS.rpcUrl;
  const verificationAddress =
    process.env.FDC_VERIFICATION_ADDRESS || DEFAULTS.verificationAddress;
  const proofPath = process.env.PROOF_PATH || DEFAULTS.proofPath;
  const outPath = process.env.OUT_PATH || DEFAULTS.outPath;

  const verifyFunctionName = process.env.VERIFY_FUNCTION_NAME || "verifyWeb2Json";
  const verifyFunctionAbi =
    process.env.VERIFY_FUNCTION_ABI_JSON
      ? JSON.parse(process.env.VERIFY_FUNCTION_ABI_JSON)
      : process.env.VERIFY_FUNCTION_ABI ||
        (verifyFunctionName === "verifyJsonApi"
          ? DEFAULT_VERIFY_JSONAPI_ABI
          : DEFAULT_VERIFY_WEB2JSON_ABI);

  if (!fs.existsSync(proofPath)) {
    throw new Error(`Proof file not found: ${proofPath}`);
  }
  const daProofJson = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  const proofPayload = extractProofPayload(daProofJson);
  const normalizedJsonApi = normalizeForVerifyJsonApi(proofPayload);
  const normalizedWeb2Json = normalizeForVerifyWeb2Json(proofPayload);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const verifier = new ethers.Contract(
    verificationAddress,
    [verifyFunctionAbi],
    provider
  );

  const fn = verifyFunctionName || "verifyJsonApi";

  let result;
  if (fn === "verifyWeb2Json") {
    result = await verifier[fn](normalizedWeb2Json);
  } else if (Array.isArray(verifyFunctionAbi.inputs) && verifyFunctionAbi.inputs.length === 2) {
    result = await verifier[fn](normalizedJsonApi.data, normalizedJsonApi.proofs);
  } else {
    result = await verifier[fn](normalizedJsonApi);
  }

  const output = {
    rpcUrl,
    verificationAddress,
    verifyFunctionAbi,
    verifyFunctionName: fn,
    result: typeof result === "boolean" ? result : String(result),
    checkedAtIso: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`Verification call completed.`);
  console.log(`Result: ${output.result}`);
  console.log(`Saved: ${outPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
