// scripts/registry-check.js
// Node + ethers v6
const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider("https://coston2-api.flare.network/ext/C/rpc");
const registryAddress = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

const abi = [
  "function getContractAddressByName(string name) view returns (address)"
];

const candidates = [
  "IJsonApiVerification",
  "IJsonAPiVerification",
  "IJsonAPIverification",
  "JsonApiVerification",
  "JsonApiVerifier",
  "IJsonApiVerifierV1",
  "IJsonApiVerifier",
  "IJsonApiVerificationV2",
  "JsonApiVerifierV2"
];

async function main() {
  const registry = new ethers.Contract(registryAddress, abi, provider);

  for (const name of candidates) {
    try {
      const addr = await registry.getContractAddressByName(name);
      console.log(`${name} -> ${addr}`);
    } catch (err) {
      console.error(`${name} -> error:`, err.message || err);
    }
  }
}

main().catch(console.error);

