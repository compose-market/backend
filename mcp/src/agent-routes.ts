/**
 * Agent API Routes
 * 
 * REST API endpoints for interacting with LangChain agents.
 * All execution endpoints are x402 payable.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
    registerAgent,
    getRegisteredAgent,
    getAgentInstance,
    listRegisteredAgents,
    markAgentExecuted,
} from "./agent-registry.js";
import { executeAgent, streamAgent, uploadKnowledge, listKnowledge } from "./frameworks/langchain.js";
import { handleX402Payment, extractPaymentInfo, DEFAULT_PRICES } from "./payment.js";

const router = Router();

// =============================================================================
// Middleware
// =============================================================================

function asyncHandler(
    fn: (req: Request, res: Response) => Promise<void>
) {
    return (req: Request, res: Response) => {
        fn(req, res).catch((err) => {
            console.error(`[agent-routes] Error:`, err);
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        });
    };
}

// =============================================================================
// Schemas
// =============================================================================

const RegisterAgentSchema = z.object({
    agentId: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
    dnaHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) as z.ZodType<`0x${string}`>,
    name: z.string().min(1),
    description: z.string(),
    agentCardUri: z.string().startsWith("ipfs://"),
    creator: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    model: z.string().default("gpt-4o-mini"),
    plugins: z.array(z.string()).default(["coingecko"]),
    systemPrompt: z.string().optional(),
});

const ChatSchema = z.object({
    message: z.string().min(1, "message is required"),
    threadId: z.string().optional(),
});

// =============================================================================
// Agent Registration
// =============================================================================

/**
 * POST /agent/register
 * Register a new agent (called after on-chain mint)
 */
router.post(
    "/register",
    asyncHandler(async (req: Request, res: Response) => {
        const parseResult = RegisterAgentSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
            });
            return;
        }

        const params = parseResult.data;

        try {
            const agent = await registerAgent({
                agentId: params.agentId,
                dnaHash: params.dnaHash,
                name: params.name,
                description: params.description,
                agentCardUri: params.agentCardUri,
                creator: params.creator,
                model: params.model,
                plugins: params.plugins,
                systemPrompt: params.systemPrompt,
            });

            res.status(201).json({
                success: true,
                agent: {
                    agentId: agent.agentId.toString(),
                    name: agent.name,
                    walletAddress: agent.walletAddress,
                    apiUrl: `/agent/${agent.agentId}/chat`,
                },
            });
        } catch (err) {
            res.status(409).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    })
);

/**
 * GET /agent/list
 * List all registered agents
 */
router.get("/list", (_req: Request, res: Response) => {
    const agents = listRegisteredAgents();
    res.json({
        count: agents.length,
        agents: agents.map((a) => ({
            agentId: a.agentId.toString(),
            name: a.name,
            description: a.description,
            walletAddress: a.walletAddress,
            model: a.model,
            plugins: a.plugins,
            createdAt: a.createdAt.toISOString(),
            lastExecutedAt: a.lastExecutedAt?.toISOString(),
        })),
    });
});

// =============================================================================
// Agent Metadata
// =============================================================================

/**
 * GET /agent/:id
 * Get agent metadata
 */
router.get(
    "/:id",
    asyncHandler(async (req: Request, res: Response) => {
        const agentId = BigInt(req.params.id);
        const agent = getRegisteredAgent(agentId);

        if (!agent) {
            res.status(404).json({ error: `Agent ${agentId} not found` });
            return;
        }

        res.json({
            agentId: agent.agentId.toString(),
            name: agent.name,
            description: agent.description,
            agentCardUri: agent.agentCardUri,
            creator: agent.creator,
            walletAddress: agent.walletAddress,
            model: agent.model,
            plugins: agent.plugins,
            createdAt: agent.createdAt.toISOString(),
            lastExecutedAt: agent.lastExecutedAt?.toISOString(),
            endpoints: {
                chat: `/agent/${agent.agentId}/chat`,
                stream: `/agent/${agent.agentId}/stream`,
            },
        });
    })
);

// =============================================================================
// Knowledge Management
// =============================================================================

const KnowledgeUploadSchema = z.object({
    key: z.string().min(1, "key is required"),
    content: z.string().min(1, "content is required"),
    metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /agent/:id/knowledge
 * Upload knowledge to an agent's knowledge base
 */
router.post(
    "/:id/knowledge",
    asyncHandler(async (req: Request, res: Response) => {
        const agentId = BigInt(req.params.id);
        const agent = getRegisteredAgent(agentId);

        if (!agent) {
            res.status(404).json({ error: `Agent ${agentId} not found` });
            return;
        }

        const parseResult = KnowledgeUploadSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
            });
            return;
        }

        const { key, content, metadata } = parseResult.data;
        const instance = await getAgentInstance(agentId);

        if (!instance) {
            res.status(500).json({ error: "Agent instance not initialized" });
            return;
        }

        const success = await uploadKnowledge(instance.id, key, content, metadata);

        res.json({
            success,
            agentId: agentId.toString(),
            key,
            contentLength: content.length,
        });
    })
);

/**
 * GET /agent/:id/knowledge
 * List all knowledge items for an agent
 */
router.get(
    "/:id/knowledge",
    asyncHandler(async (req: Request, res: Response) => {
        const agentId = BigInt(req.params.id);
        const agent = getRegisteredAgent(agentId);

        if (!agent) {
            res.status(404).json({ error: `Agent ${agentId} not found` });
            return;
        }

        const instance = await getAgentInstance(agentId);
        if (!instance) {
            res.status(500).json({ error: "Agent instance not initialized" });
            return;
        }

        const keys = await listKnowledge(instance.id);

        res.json({
            agentId: agentId.toString(),
            count: keys.length,
            keys,
        });
    })
);

// =============================================================================
// Agent Execution (x402 Payable)
// =============================================================================

/**
 * POST /agent/:id/chat
 * Chat with an agent (x402 payable)
 */
router.post(
    "/:id/chat",
    asyncHandler(async (req: Request, res: Response) => {
        const agentId = BigInt(req.params.id);

        // x402 Payment Verification - ALWAYS required, no session bypass
        // Server must NEVER trust client headers for payment - always verify on-chain
        const { paymentData } = extractPaymentInfo(
            req.headers as Record<string, string | string[] | undefined>
        );

        const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
        const paymentResult = await handleX402Payment(
            paymentData,
            resourceUrl,
            "POST",
            DEFAULT_PRICES.AGENT_CHAT
        );

        if (paymentResult.status !== 200) {
            // Payment failed or not provided - return 402 Payment Required
            Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });
            res.status(paymentResult.status).json(paymentResult.responseBody);
            return;
        }
        console.log(`[x402] Payment verified for agent ${agentId}`);

        // Validate agent exists
        const agent = getRegisteredAgent(agentId);
        if (!agent) {
            res.status(404).json({ error: `Agent ${agentId} not found` });
            return;
        }

        const instance = getAgentInstance(agentId);
        if (!instance) {
            res.status(500).json({ error: `Agent ${agentId} runtime not available` });
            return;
        }

        // Parse request
        const parseResult = ChatSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
                hint: "Body should be: { message: string, threadId?: string }",
            });
            return;
        }

        const { message, threadId } = parseResult.data;

        // Execute agent
        console.log(`[agent] Executing ${agent.name} (${agentId}): "${message.slice(0, 50)}..."`);
        const result = await executeAgent(instance.id, message, threadId);
        markAgentExecuted(agentId);

        res.json({
            agentId: agent.agentId.toString(),
            name: agent.name,
            ...result,
        });
    })
);

/**
 * POST /agent/:id/stream
 * Stream chat with an agent (x402 payable, SSE)
 */
router.post(
    "/:id/stream",
    asyncHandler(async (req: Request, res: Response) => {
        const agentId = BigInt(req.params.id);

        // x402 Payment Verification - ALWAYS required, no session bypass
        const { paymentData } = extractPaymentInfo(
            req.headers as Record<string, string | string[] | undefined>
        );

        const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
        const paymentResult = await handleX402Payment(
            paymentData,
            resourceUrl,
            "POST",
            DEFAULT_PRICES.AGENT_CHAT
        );

        if (paymentResult.status !== 200) {
            Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });
            res.status(paymentResult.status).json(paymentResult.responseBody);
            return;
        }

        // Validate agent
        const agent = getRegisteredAgent(agentId);
        if (!agent) {
            res.status(404).json({ error: `Agent ${agentId} not found` });
            return;
        }

        const instance = getAgentInstance(agentId);
        if (!instance) {
            res.status(500).json({ error: `Agent ${agentId} runtime not available` });
            return;
        }

        const parseResult = ChatSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
            });
            return;
        }

        const { message, threadId } = parseResult.data;

        // Set up SSE
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        console.log(`[agent] Streaming ${agent.name} (${agentId}): "${message.slice(0, 50)}..."`);

        try {
            for await (const event of streamAgent(instance.id, message, threadId)) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        } catch (err) {
            res.write(`data: ${JSON.stringify({ type: "error", content: String(err) })}\n\n`);
        }

        markAgentExecuted(agentId);
        res.end();
    })
);

export default router;
