/**
 * Agent Wallet Derivation
 * 
 * Derives deterministic wallets for each agent from their unique dnaHash.
 * The dnaHash is computed on-chain from (skills, chainId, modelId) and
 * stored in the AgentFactory contract.
 * 
 * This ensures each agent has a unique, reproducible wallet tied to its
 * on-chain identity without requiring a shared master mnemonic.
 */

import { keccak256, toBytes } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, type WalletClient, type PublicClient } from "viem";
import { avalanche, avalancheFuji } from "viem/chains";

const USE_MAINNET = process.env.USE_MAINNET === "true";
const RPC_URL = process.env.AVALANCHE_RPC_URL || (USE_MAINNET
    ? "https://api.avax.network/ext/bc/C/rpc"
    : "https://avax-fuji.g.alchemy.com/v2/o8G3swVZ3cdpMzHKD6HWDpvzaNCgLrmX");

export interface AgentWallet {
    agentId: bigint;
    dnaHash: `0x${string}`;
    address: `0x${string}`;
    account: PrivateKeyAccount;
    walletClient: WalletClient;
    publicClient: PublicClient;
}

/**
 * Derive a unique wallet for an agent from its dnaHash
 * 
 * The dnaHash is already a keccak256 hash computed on-chain from:
 *   keccak256(abi.encodePacked(skills, chainId, modelId))
 * 
 * We use it directly as a private key seed with an additional derivation
 * layer to ensure it's a valid secp256k1 key.
 * 
 * @param agentId - The on-chain agent ID from AgentFactory
 * @param dnaHash - The agent's dnaHash from AgentFactory contract (bytes32)
 * @returns AgentWallet with address, account, and wallet client
 */
export function deriveAgentWallet(agentId: number | bigint, dnaHash: `0x${string}`): AgentWallet {
    if (!dnaHash || !dnaHash.startsWith("0x") || dnaHash.length !== 66) {
        throw new Error(`Invalid dnaHash: ${dnaHash}. Expected 32-byte hex string.`);
    }

    const id = BigInt(agentId);

    // Derive private key from dnaHash + agentId for additional uniqueness
    // This adds a layer of safety even if dnaHash collisions were possible
    const derivationSeed = keccak256(
        toBytes(`${dnaHash}:agent:${id}`)
    );

    // The derived hash is a valid 32-byte private key
    const privateKey = derivationSeed as `0x${string}`;
    const account = privateKeyToAccount(privateKey);

    const chain = USE_MAINNET ? avalanche : avalancheFuji;

    const walletClient = createWalletClient({
        account,
        chain,
        transport: http(RPC_URL),
    });

    const publicClient = createPublicClient({
        chain,
        transport: http(RPC_URL),
    });

    console.log(`[agent-wallet] Derived wallet for agent ${id} from dnaHash: ${account.address}`);

    return {
        agentId: id,
        dnaHash,
        address: account.address,
        account,
        walletClient,
        publicClient,
    };
}

/**
 * Check if an agent wallet has sufficient funds for gas
 * @param wallet - The agent wallet to check
 * @param minBalance - Minimum balance in wei (default 0.01 AVAX)
 */
export async function hasGasFunds(
    wallet: AgentWallet,
    minBalance: bigint = BigInt(10000000000000000) // 0.01 AVAX
): Promise<boolean> {
    try {
        const balance = await wallet.publicClient.getBalance({ address: wallet.address });
        return balance >= minBalance;
    } catch (error) {
        console.error(`[agent-wallet] Failed to check balance for ${wallet.address}:`, error);
        return false;
    }
}

/**
 * Get agent wallet balance
 */
export async function getWalletBalance(wallet: AgentWallet): Promise<bigint> {
    return wallet.publicClient.getBalance({ address: wallet.address });
}
