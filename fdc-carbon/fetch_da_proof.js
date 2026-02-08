#!/usr/bin/env node
/**
 * Fetches Merkle proof for a submitted FDC attestation request from DA layer.
 * Polls until proof is available or max attempts reached.
 */

const fs = require("fs");
const path = require("path");

const fetchFn = globalThis.fetch;

if (!fetchFn) {
  console.error("Global fetch is unavailable. Use Node.js >= 18.");
  process.exit(1);
}

const DEFAULTS = {
  daBase: "https://ctn2-data-availability.flare.network",
  requestPath: path.join(__dirname, "out", "request_submission.json"),
  outPath: path.join(__dirname, "out", "da_proof.json"),
  endpointLatest: "/api/v0/fdc/get-proof-round-bytes",
  endpointRound: "/api/v1/fdc/proof-by-request-round",
  maxAttempts: 40,
  intervalMs: 15000,
};

function must(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasNonEmptyProof(data) {
  return !!(data && Array.isArray(data.proof) && data.proof.length > 0);
}

async function fetchLatestVotingRound(daBase) {
  const res = await fetchFn(`${daBase}/api/v0/fsp/latest-voting-round`);
  if (!res.ok) return null;
  const data = await res.json();
  return Number(data.voting_round_id);
}

async function fetchOnceLatest({ daBase, endpoint, requestBytes }) {
  const res = await fetchFn(`${daBase}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestBytes }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_e) {
    data = { raw: text };
  }

  return { status: res.status, ok: res.ok, data };
}

async function fetchOnceRound({ daBase, endpoint, votingRoundId, requestBytes }) {
  const res = await fetchFn(`${daBase}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      votingRoundId: Number(votingRoundId),
      requestBytes,
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_e) {
    data = { raw: text };
  }

  return { status: res.status, ok: res.ok, data };
}

async function main() {
  const votingRoundId = process.env.VOTING_ROUND_ID;
  const daBase = process.env.DA_BASE || DEFAULTS.daBase;
  const endpointLatest = process.env.DA_ENDPOINT_LATEST || DEFAULTS.endpointLatest;
  const endpointRound = process.env.DA_ENDPOINT_ROUND || DEFAULTS.endpointRound;
  const requestPath = process.env.REQUEST_SUBMISSION_PATH || DEFAULTS.requestPath;
  const outPath = process.env.OUT_PATH || DEFAULTS.outPath;
  const maxAttempts = Number(process.env.MAX_ATTEMPTS || DEFAULTS.maxAttempts);
  const intervalMs = Number(process.env.INTERVAL_MS || DEFAULTS.intervalMs);

  if (!fs.existsSync(requestPath)) {
    throw new Error(`Request submission file not found: ${requestPath}`);
  }
  const requestJson = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  const requestBytes = requestJson.abiEncodedRequest;
  if (!requestBytes || !requestBytes.startsWith("0x")) {
    throw new Error(`abiEncodedRequest missing in ${requestPath}`);
  }

  let last;
  for (let i = 1; i <= maxAttempts; i++) {
    if (votingRoundId) {
      last = await fetchOnceRound({
        daBase,
        endpoint: endpointRound,
        votingRoundId,
        requestBytes,
      });
      if (last.ok && hasNonEmptyProof(last.data)) {
        const output = {
          votingRoundId: Number(votingRoundId),
          requestBytes,
          daBase,
          endpoint: endpointRound,
          fetchedAtIso: new Date().toISOString(),
          response: last.data,
        };
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
        console.log(`Proof fetched for round ${votingRoundId}`);
        console.log(`Saved: ${outPath}`);
        return;
      }
    } else {
      const latestRound = await fetchLatestVotingRound(daBase);
      if (Number.isFinite(latestRound)) {
        for (const round of [latestRound - 2, latestRound - 1, latestRound, latestRound + 1]) {
          last = await fetchOnceRound({
            daBase,
            endpoint: endpointRound,
            votingRoundId: round,
            requestBytes,
          });
          if (last.ok && hasNonEmptyProof(last.data)) {
            const output = {
              votingRoundId: round,
              requestBytes,
              daBase,
              endpoint: endpointRound,
              fetchedAtIso: new Date().toISOString(),
              response: last.data,
            };
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
            console.log(`Proof fetched for round ${round}`);
            console.log(`Saved: ${outPath}`);
            return;
          }
        }
      }

      last = await fetchOnceLatest({
        daBase,
        endpoint: endpointLatest,
        requestBytes,
      });
      if (last.ok && hasNonEmptyProof(last.data)) {
        const output = {
          votingRoundId: null,
          requestBytes,
          daBase,
          endpoint: endpointLatest,
          fetchedAtIso: new Date().toISOString(),
          response: last.data,
        };
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
        console.log(`Latest proof fetched for request bytes`);
        console.log(`Saved: ${outPath}`);
        return;
      }
    }
    console.log(
      `Attempt ${i}/${maxAttempts} -> status ${last.status}; proof not ready yet`
    );
    await sleep(intervalMs);
  }

  throw new Error(
    `Proof not available after ${maxAttempts} attempts. Last response: ${JSON.stringify(last)}`
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
