// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/**
 * @title RewardExecutor
 * @notice Minimal on-chain "reward executed" recorder.
 *
 * This contract intentionally does NOT verify FDC proofs on-chain.
 * Verification is done off-chain via IFdcVerification (see scripts/check_attestation.js),
 * then this contract is called only after confirmation.
 *
 * No token minting / incentive logic here: just an auditable on-chain event + replay protection.
 */
contract RewardExecutor {
    address public owner;

    // Replay protection: one reward execution per attestation tx hash.
    mapping(bytes32 => bool) public executedAttestations;

    event RewardExecuted(
        bytes32 indexed attestationTxHash,
        bytes32 indexed payloadHash,
        bytes32 indexed slotKey,
        address participant,
        uint256 shiftedKw
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "RewardExecutor: not owner");
        _;
    }

    constructor(address _owner) {
        require(_owner != address(0), "RewardExecutor: owner is zero");
        owner = _owner;
    }

    function setOwner(address _owner) external onlyOwner {
        require(_owner != address(0), "RewardExecutor: owner is zero");
        owner = _owner;
    }

    /**
     * @notice Records one reward execution.
     * @dev Designed to be the smallest possible mainnet/testnet tx for validation.
     */
    function executeReward(
        bytes32 attestationTxHash,
        bytes32 payloadHash,
        bytes32 slotKey,
        address participant,
        uint256 shiftedKw
    ) external onlyOwner {
        require(!executedAttestations[attestationTxHash], "RewardExecutor: already executed");
        executedAttestations[attestationTxHash] = true;
        emit RewardExecuted(attestationTxHash, payloadHash, slotKey, participant, shiftedKw);
    }
}

