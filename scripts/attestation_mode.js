const SIMULATION_VALUES = new Set(["1", "true", "yes", "on", "simulation"]);
const REAL_VALUES = new Set(["0", "false", "no", "off", "real"]);

function parseBooleanLike(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (SIMULATION_VALUES.has(normalized)) return true;
  if (REAL_VALUES.has(normalized)) return false;
  return null;
}

function getAttestationMode() {
  const simulationFlag = parseBooleanLike(process.env.USE_SIMULATION);
  if (simulationFlag === true) return "simulation";
  if (simulationFlag === false) return "real";

  const mode = (process.env.ATTESTATION_MODE || "real").trim().toLowerCase();
  return mode === "simulation" ? "simulation" : "real";
}

function assertSimulationMode(context) {
  const mode = getAttestationMode();
  if (mode !== "simulation") {
    throw new Error(
      `${context} is simulation-only. Set ATTESTATION_MODE=simulation (or USE_SIMULATION=1).`
    );
  }
}

function assertRealMode(context) {
  const mode = getAttestationMode();
  if (mode !== "real") {
    throw new Error(
      `${context} requires real attestation mode. Set ATTESTATION_MODE=real (or USE_SIMULATION=0).`
    );
  }
}

module.exports = {
  getAttestationMode,
  assertSimulationMode,
  assertRealMode,
};
