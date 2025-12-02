/**
 * Plugin Sync Script
 * 
 * Fetches GOAT and ElizaOS plugins from their respective registries:
 * - GOAT: npm registry API
 * - ElizaOS: generated-registry.json (rich metadata with descriptions, stars, topics)
 * 
 * Run with: npx tsx scripts/sync-plugins.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GOAT_NPM_SEARCH = "https://registry.npmjs.org/-/v1/search?text=@goat-sdk/plugin&size=250";
const ELIZA_REGISTRY_URL = "https://raw.githubusercontent.com/elizaos-plugins/registry/main/generated-registry.json";
const GOAT_OUTPUT = path.resolve(__dirname, "../data/goatPlugins.json");
const ELIZA_OUTPUT = path.resolve(__dirname, "../data/elizaPlugins.json");

// =============================================================================
// Types
// =============================================================================

export interface PluginRecord {
  id: string;
  name: string;
  slug: string;
  namespace: string;
  description: string;
  keywords: string[];
  version: string;
  repository?: string;
  homepage?: string;
  source: "goat" | "eliza";
  // Optional metadata
  stars?: number;
  language?: string | null;
  supportsV1?: boolean;
}

export interface PluginRegistryData {
  source: string;
  updatedAt: string;
  count: number;
  plugins: PluginRecord[];
}

// =============================================================================
// GOAT Plugin Fetching (npm registry)
// =============================================================================

interface NpmSearchResult {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      keywords?: string[];
      links?: {
        npm?: string;
        homepage?: string;
        repository?: string;
      };
    };
  }>;
  total: number;
}

async function fetchGoatPlugins(): Promise<PluginRecord[]> {
  console.log("\n[1/2] Fetching GOAT plugins from npm...");
  
  const res = await fetch(GOAT_NPM_SEARCH);
  if (!res.ok) {
    throw new Error(`npm API error: ${res.status}`);
  }
  
  const data: NpmSearchResult = await res.json();
  const plugins: PluginRecord[] = [];
  
  for (const obj of data.objects) {
    const pkg = obj.package;
    
    // Only include @goat-sdk/plugin-* packages
    if (!pkg.name.startsWith("@goat-sdk/plugin-")) {
      continue;
    }
    
    // Extract slug from package name
    const slug = pkg.name.replace("@goat-sdk/plugin-", "");
    
    // Generate description from slug since npm descriptions are just HTML garbage
    const humanName = slug
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    
    // Derive functionality from keywords and slug
    const keywords = pkg.keywords || ["ai", "agents", "web3"];
    let description = `GOAT SDK plugin for ${humanName}`;
    
    // Add context based on common DeFi patterns
    if (slug.includes("swap") || slug.includes("dex") || slug.includes("uniswap")) {
      description = `${humanName} - Token swaps and DEX trading`;
    } else if (slug.includes("bridge") || slug.includes("debridge")) {
      description = `${humanName} - Cross-chain bridge transfers`;
    } else if (slug.includes("nft") || slug.includes("721") || slug.includes("1155")) {
      description = `${humanName} - NFT minting and trading`;
    } else if (slug.includes("erc20") || slug.includes("token") || slug.includes("spl")) {
      description = `${humanName} - Token transfers and balances`;
    } else if (slug.includes("lend") || slug.includes("stake") || slug.includes("yield")) {
      description = `${humanName} - DeFi lending and staking`;
    } else if (keywords.includes("defi")) {
      description = `${humanName} - DeFi protocol integration`;
    } else if (keywords.includes("social")) {
      description = `${humanName} - Social protocol integration`;
    }
    
    plugins.push({
      id: `goat-${slug}`,
      name: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " "),
      slug,
      namespace: "goat-sdk",
      description,
      keywords: pkg.keywords || ["ai", "agents", "web3"],
      version: pkg.version,
      repository: pkg.links?.repository,
      homepage: pkg.links?.homepage,
      source: "goat",
    });
  }
  
  console.log(`  Found ${plugins.length} GOAT plugins`);
  return plugins;
}

// =============================================================================
// ElizaOS Plugin Fetching (generated-registry.json with rich metadata)
// =============================================================================

interface ElizaRegistryEntry {
  git: {
    repo: string;
    v0: { version: string | null; branch: string | null };
    v1: { version: string | null; branch: string | null };
  };
  npm: {
    repo: string;
    v0: string | null;
    v1: string | null;
  };
  supports: { v0: boolean; v1: boolean };
  description: string | null;
  homepage: string | null;
  topics: string[];
  stargazers_count: number;
  language: string | null;
}

interface ElizaGeneratedRegistry {
  lastUpdatedAt: string;
  registry: Record<string, ElizaRegistryEntry>;
}

async function fetchElizaPlugins(): Promise<PluginRecord[]> {
  console.log("\n[2/2] Fetching ElizaOS plugins from generated registry...");
  
  const res = await fetch(ELIZA_REGISTRY_URL);
  if (!res.ok) {
    throw new Error(`ElizaOS registry error: ${res.status}`);
  }
  
  const data: ElizaGeneratedRegistry = await res.json();
  const plugins: PluginRecord[] = [];
  
  for (const [pkgName, entry] of Object.entries(data.registry)) {
    // Extract type and slug from package name
    // e.g., "@elizaos/plugin-solana" -> type: "plugin", slug: "solana"
    const match = pkgName.match(/@[\w-]+\/(plugin|client|adapter)-(.+)/);
    if (!match) continue;
    
    const [, type, slug] = match;
    const id = `eliza-${type}-${slug}`;
    
    // Use real description if available, otherwise generate from slug
    const humanName = slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
    let description = entry.description;
    if (!description) {
      if (type === "plugin") description = `ElizaOS ${humanName} plugin`;
      else if (type === "client") description = `ElizaOS ${humanName} client integration`;
      else if (type === "adapter") description = `ElizaOS ${humanName} adapter`;
    }
    
    // Combine GitHub topics with slug-derived keywords
    const keywords = new Set<string>(["elizaos", type, slug]);
    entry.topics.forEach(t => keywords.add(t.toLowerCase()));
    
    // Derive category from topics and slug
    if (slug.includes("discord") || slug.includes("twitter") || slug.includes("telegram") || slug.includes("slack") || slug.includes("farcaster")) {
      keywords.add("social");
    }
    if (slug.includes("evm") || slug.includes("solana") || slug.includes("bnb") || slug.includes("near") || slug.includes("aptos") || slug.includes("sui")) {
      keywords.add("blockchain");
    }
    if (slug.includes("openai") || slug.includes("anthropic") || slug.includes("groq") || slug.includes("ollama") || slug.includes("llama")) {
      keywords.add("ai");
    }
    
    plugins.push({
      id,
      name: `${type === "client" ? "Client" : type === "adapter" ? "Adapter" : "Plugin"}: ${humanName}`,
      slug: `${type}-${slug}`,
      namespace: "elizaos",
      description: description || "",
      keywords: Array.from(keywords),
      version: entry.npm.v0 || entry.git.v0.version || "latest",
      repository: `https://github.com/${entry.git.repo}`,
      homepage: entry.homepage || undefined,
      source: "eliza",
      // Extra metadata
      stars: entry.stargazers_count,
      language: entry.language,
      supportsV1: entry.supports.v1,
    });
  }
  
  // Sort by stars (most popular first)
  plugins.sort((a, b) => ((b as any).stars || 0) - ((a as any).stars || 0));
  
  console.log(`  Found ${plugins.length} ElizaOS plugins`);
  return plugins;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Plugin Registry Sync                                        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // Fetch from all sources
  const goatPlugins = await fetchGoatPlugins();
  const elizaPlugins = await fetchElizaPlugins();

  // Ensure data directory exists
  await fs.mkdir(path.dirname(GOAT_OUTPUT), { recursive: true });

  // Write GOAT plugins
  const goatData: PluginRegistryData = {
    source: "npm:@goat-sdk/plugin-*",
    updatedAt: new Date().toISOString(),
    count: goatPlugins.length,
    plugins: goatPlugins,
  };
  await fs.writeFile(GOAT_OUTPUT, JSON.stringify(goatData, null, 2), "utf8");

  // Write ElizaOS plugins
  const elizaData: PluginRegistryData = {
    source: "github:elizaos-plugins/registry",
    updatedAt: new Date().toISOString(),
    count: elizaPlugins.length,
    plugins: elizaPlugins,
  };
  await fs.writeFile(ELIZA_OUTPUT, JSON.stringify(elizaData, null, 2), "utf8");

  // Stats
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Plugin Sync Complete                                        ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  GOAT plugins: ${goatPlugins.length.toString().padEnd(46)}║`);
  console.log(`║  ElizaOS plugins: ${elizaPlugins.length.toString().padEnd(43)}║`);
  console.log(`║  Total: ${(goatPlugins.length + elizaPlugins.length).toString().padEnd(53)}║`);
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║  Output:                                                     ║");
  console.log("║    data/goatPlugins.json                                     ║");
  console.log("║    data/elizaPlugins.json                                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
  console.error("\nPlugin sync failed:", err);
  process.exit(1);
});

