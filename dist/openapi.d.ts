/**
 * OpenAPI ↔ Claude tool bridge.
 *
 * The shell's orchestrator exposes Claude a union of tools drawn from every
 * registered agent. Each agent ships an OpenAPI 3.1 spec; the `x-orchet-*`
 * extensions below mark which operations become LLM tools and how they are
 * gated.
 *
 * This module is the single source of truth for converting an OpenAPI
 * operation to a Claude tool definition. It is intentionally small and has
 * no Anthropic SDK dependency — it returns plain shapes the orchestrator can
 * feed into `anthropic.messages.create({ tools })` (Claude) or the equivalent
 * OpenAI structured-tool shape (fallback).
 */
import type { CostTier } from "./types.js";
/**
 * Put these on an OpenAPI operation to expose it as an orchestrator tool.
 *
 * ```yaml
 * paths:
 *   /confirm:
 *     post:
 *       operationId: flight_book_offer
 *       x-orchet-tool: true
 *       x-orchet-cost-tier: money
 *       x-orchet-requires-confirmation: structured-itinerary
 *       x-orchet-pii-required: [name, email, payment_method_id]
 *       x-orchet-cancels: flight_cancel_booking
 *       x-orchet-compensation-kind: best-effort
 *       x-orchet-reversibility: compensating
 *       x-orchet-compensating-tool: flight_cancel_booking
 *       x-orchet-compensating-inputs-template:
 *         booking_id: "{{outputs.booking_id}}"
 *   /cancel:
 *     post:
 *       operationId: flight_cancel_booking
 *       x-orchet-tool: true
 *       x-orchet-cost-tier: free        # cancellation itself never charges
 *       x-orchet-cancel-for: flight_book_offer
 *       x-orchet-requires-confirmation: false
 * ```
 *
 * Contract — cancellation protocol (see RFC 0001):
 * - Any operation with `x-orchet-cost-tier: money` MUST declare `x-orchet-cancels`
 *   pointing to a peer operation on the same agent whose `x-orchet-cancel-for`
 *   matches it (bidirectional link, validated at registry load).
 * - The cancel counterpart MUST set `x-orchet-requires-confirmation: false`
 *   — rollback fires WITHOUT re-prompting the user; a stuck money tool that
 *   depended on a second human ack would be a Saga deadlock.
 * - `x-orchet-compensation-kind` classifies what the cancel guarantees:
 *   • `perfect`     — vendor fully reverses (e.g. reservation hold release)
 *   • `best-effort` — subject to vendor policy; may be partial refund
 *   • `manual`      — cancel tool exists but expects human follow-up
 *   Orchestrator uses this to decide whether to surface
 *   `rollback_incomplete` warnings to the user proactively.
 */
export interface OrchetOperationExtensions {
    "x-orchet-tool"?: boolean;
    "x-orchet-cost-tier"?: CostTier;
    /** The shape of the summary the user must have confirmed before this tool fires. */
    "x-orchet-requires-confirmation"?: "structured-cart" | "structured-itinerary" | "structured-booking" | "structured-reservation" | "structured-trip" | false;
    /** PII fields the tool needs in its request body. */
    "x-orchet-pii-required"?: string[];
    /** Tags the orchestrator uses for routing heuristics and analytics. */
    "x-orchet-intent-tags"?: string[];
    /**
     * operationId of the cancel counterpart for this tool. Required for any
     * operation at cost-tier `money`. The Saga invokes this on rollback.
     */
    "x-orchet-cancels"?: string;
    /**
     * Set on a cancel tool to declare which money tool it rolls back. Must
     * point to a peer operation on the same agent whose `x-orchet-cancels`
     * points back to this one.
     */
    "x-orchet-cancel-for"?: string;
    /**
     * Declares the strength of the compensation guarantee. See the module
     * doc comment for semantics. Defaults to `best-effort` on any cancel tool.
     */
    "x-orchet-compensation-kind"?: "perfect" | "best-effort" | "manual";
    /**
     * Declares how durable mission rollback should treat the operation after
     * it succeeds. Absent values are interpreted conservatively by Orchet.
     */
    "x-orchet-reversibility"?: "reversible" | "compensating" | "irreversible";
    /**
     * operationId of the compensating action to call during mission rollback.
     * This is intentionally separate from `x-orchet-cancels` so non-money tools
     * can declare a compensation path too.
     */
    "x-orchet-compensating-tool"?: string;
    /**
     * Template rendered against the original step outputs before invoking the
     * compensating tool. Supports simple `{{outputs.foo.bar}}` substitutions.
     */
    "x-orchet-compensating-inputs-template"?: Record<string, unknown>;
    /** Optional time window after which compensation should not be attempted. */
    "x-orchet-compensating-window-seconds"?: number;
}
export interface OpenApiDocument {
    openapi: string;
    info: {
        title: string;
        version: string;
    };
    paths: Record<string, OpenApiPathItem>;
    components?: {
        schemas?: Record<string, unknown>;
    };
}
export interface OpenApiPathItem {
    get?: OpenApiOperation;
    post?: OpenApiOperation;
    put?: OpenApiOperation;
    patch?: OpenApiOperation;
    delete?: OpenApiOperation;
}
export interface OpenApiOperation extends OrchetOperationExtensions {
    operationId: string;
    summary?: string;
    description?: string;
    requestBody?: {
        required?: boolean;
        content?: Record<string, {
            schema?: unknown;
        }>;
    };
    parameters?: Array<{
        name: string;
        in: "query" | "path" | "header" | "cookie";
        required?: boolean;
        schema?: unknown;
        description?: string;
    }>;
    responses?: Record<string, unknown>;
}
export interface ClaudeTool {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
}
/**
 * The orchestrator keeps this side-table keyed by tool name so that when
 * Claude emits a tool_use block, we know which agent to route to and whether
 * the confirmation gate applies.
 */
export interface ToolRoutingEntry {
    agent_id: string;
    operation_id: string;
    http_method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    cost_tier: CostTier;
    requires_confirmation: "structured-cart" | "structured-itinerary" | "structured-booking" | "structured-reservation" | "structured-trip" | false;
    pii_required: string[];
    intent_tags: string[];
    /**
     * operationId of the cancel counterpart. Set on money-tier tools only.
     * The orchestrator's Saga reads this to find the rollback tool without
     * having to re-parse the OpenAPI doc.
     */
    cancels?: string;
    /**
     * operationId of the money tool this cancel rolls back. Set on cancel
     * tools only. The orchestrator uses this to validate that a rollback
     * invocation matches the original forward tool it's compensating for.
     */
    cancel_for?: string;
    /**
     * Compensation strength — drives whether the orchestrator surfaces
     * partial-rollback warnings proactively. Only meaningful on cancel tools.
     */
    compensation_kind?: "perfect" | "best-effort" | "manual";
    /**
     * Durable mission rollback semantics for this operation. If absent, Orchet
     * Core falls back to its conservative heuristics.
     */
    reversibility?: "reversible" | "compensating" | "irreversible";
    /** operationId of the compensating action for this operation. */
    compensating_tool?: string;
    /** Template rendered against the forward step outputs for compensation. */
    compensating_inputs_template?: Record<string, unknown>;
    /** Optional compensation window in seconds from the forward step finish. */
    compensating_window_seconds?: number;
}
export interface BridgeResult {
    tools: ClaudeTool[];
    routing: Record<string, ToolRoutingEntry>;
}
/**
 * Convert a single agent's OpenAPI document into (a) the Claude tool list
 * and (b) a routing table the orchestrator uses at dispatch time.
 *
 * Only operations with `x-orchet-tool: true` become tools. Operations without
 * the extension are ignored (they may be internal endpoints, webhooks, etc.).
 */
export declare function openApiToClaudeTools(agentId: string, doc: OpenApiDocument): BridgeResult;
/**
 * Merge multiple agents' bridge results into a single tool list + routing
 * map. Tool name collisions are an error — agents must namespace their
 * operationIds (e.g. `flight_search_flights`) if they risk overlap.
 */
export declare function mergeBridges(results: BridgeResult[]): BridgeResult;
//# sourceMappingURL=openapi.d.ts.map