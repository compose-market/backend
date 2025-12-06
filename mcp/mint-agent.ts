/**
 * On-Chain Agent Mint Script
 * 
 * Mints a new agent on Avalanche Fuji via AgentFactory contract
 */
import { createThirdwebClient, getContract, sendAndConfirmTransaction, prepareContractCall } from "thirdweb";
import { privateKeyToAccount } from "thirdweb/wallets";
import { avalancheFuji } from "thirdweb/chains";
import { keccak256, toHex } from "viem";

// Load environment
import "dotenv/config";

const PRIVATE_KEY = (process.env.DEPLOYER_KEY || "").startsWith("0x")
    ? process.env.DEPLOYER_KEY as `0x${string}`
    : `0x${process.env.DEPLOYER_KEY}` as `0x${string}`;
const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY!;
const AGENT_FACTORY_ADDRESS = "0xb6d62374Ba0076bE2c1020b6a8BBD1b3c67052F7" as `0x${string}`;

if (!PRIVATE_KEY || PRIVATE_KEY === "0x") {
    throw new Error("DEPLOYER_KEY is required");
}

const client = createThirdwebClient({
    secretKey: THIRDWEB_SECRET_KEY,
});

const account = privateKeyToAccount({
    client,
    privateKey: PRIVATE_KEY,
});

console.log("=".repeat(60));
console.log("On-Chain Agent Minting - Avalanche Fuji");
console.log("=".repeat(60));
console.log("Wallet:", account.address);
console.log("AgentFactory:", AGENT_FACTORY_ADDRESS);

// Agent configuration
const agentConfig = {
    name: "Compose E2E Test Agent",
    description: "Autonomous agent for E2E testing with knowledge, memory, and capability request features",
    model: "asi1-mini",
    framework: "langchain",
    skills: ["knowledge-retrieval", "memory", "capability-request", "conversation"],
};

// Generate UNIQUE DNA hash with timestamp to avoid collision
const dnaInput = JSON.stringify({
    skills: agentConfig.skills,
    chain: 43113,
    model: agentConfig.model,
    timestamp: Date.now(), // Ensures uniqueness
    nonce: Math.random().toString(36).slice(2),
});
const dnaHash = keccak256(toHex(dnaInput));

console.log("DNA Hash:", dnaHash);
console.log("Agent:", agentConfig.name);

// Agent card URI (using a test IPFS placeholder - in production would upload to IPFS)
const agentCardUri = `ipfs://test-agent-${Date.now()}`;

async function mintAgent() {
    const contract = getContract({
        client,
        chain: avalancheFuji,
        address: AGENT_FACTORY_ADDRESS,
    });

    console.log("\nPreparing mint transaction...");

    const transaction = prepareContractCall({
        contract,
        method: "function mintAgent(bytes32 dnaHash, uint256 units, uint256 price, bool cloneable, string agentCardUri) returns (uint256 agentId)",
        params: [
            dnaHash,                    // dnaHash: unique identifier
            BigInt(0),                  // units: 0 = unlimited
            BigInt(5000),               // price: $0.005 per call (5000 = 0.005 USDC with 6 decimals)
            true,                       // cloneable: true
            agentCardUri,               // agentCardUri
        ],
    });

    console.log("Sending transaction...");

    const receipt = await sendAndConfirmTransaction({
        transaction,
        account,
    });

    console.log("\n" + "=".repeat(60));
    console.log("✅ AGENT MINTED SUCCESSFULLY!");
    console.log("=".repeat(60));
    console.log("Transaction Hash:", receipt.transactionHash);
    console.log("Explorer:", `https://testnet.snowtrace.io/tx/${receipt.transactionHash}`);
    console.log("\nDNA Hash:", dnaHash);

    // Parse logs to get agentId
    console.log("\nLogs:", JSON.stringify(receipt.logs.slice(0, 3), null, 2));

    return receipt;
}

mintAgent().catch(console.error);
