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

// ──────────────────────────────────────────────────────────────────────────
// x-orchet-* extension conventions (documented for agent authors)
// ──────────────────────────────────────────────────────────────────────────

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
  "x-orchet-requires-confirmation"?:
    | "structured-cart"
    | "structured-itinerary"
    | "structured-booking"
    | "structured-reservation"
    | "structured-trip"
    | false;
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

// ──────────────────────────────────────────────────────────────────────────
// Minimal OpenAPI types we need (avoids pulling in a full openapi-types dep)
// ──────────────────────────────────────────────────────────────────────────

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, OpenApiPathItem>;
  components?: { schemas?: Record<string, unknown> };
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
    content?: Record<string, { schema?: unknown }>;
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

// ──────────────────────────────────────────────────────────────────────────
// Claude tool shape (portable — matches Anthropic Messages API)
// ──────────────────────────────────────────────────────────────────────────

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
  requires_confirmation:
    | "structured-cart"
    | "structured-itinerary"
    | "structured-booking"
    | "structured-reservation"
    | "structured-trip"
    | false;
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
export function openApiToClaudeTools(
  agentId: string,
  doc: OpenApiDocument,
): BridgeResult {
  const tools: ClaudeTool[] = [];
  const routing: Record<string, ToolRoutingEntry> = {};
  const componentSchemas =
    (doc.components?.schemas as Record<string, unknown> | undefined) ?? {};

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    const methods: Array<[ToolRoutingEntry["http_method"], OpenApiOperation | undefined]> = [
      ["GET", pathItem.get],
      ["POST", pathItem.post],
      ["PUT", pathItem.put],
      ["PATCH", pathItem.patch],
      ["DELETE", pathItem.delete],
    ];

    for (const [method, op] of methods) {
      if (!op || op["x-orchet-tool"] !== true) continue;

      const schema = extractInputSchema(op, componentSchemas);
      const tool: ClaudeTool = {
        name: op.operationId,
        description:
          op.description?.trim() ||
          op.summary?.trim() ||
          `Operation ${op.operationId} on ${agentId}`,
        input_schema: schema,
      };

      tools.push(tool);
      routing[op.operationId] = {
        agent_id: agentId,
        operation_id: op.operationId,
        http_method: method,
        path,
        cost_tier: op["x-orchet-cost-tier"] ?? "free",
        requires_confirmation:
          op["x-orchet-requires-confirmation"] ?? false,
        pii_required: op["x-orchet-pii-required"] ?? [],
        intent_tags: op["x-orchet-intent-tags"] ?? [],
        cancels: op["x-orchet-cancels"],
        cancel_for: op["x-orchet-cancel-for"],
        compensation_kind:
          op["x-orchet-compensation-kind"] ??
          (op["x-orchet-cancel-for"]
            ? "best-effort"
            : undefined),
        reversibility: op["x-orchet-reversibility"],
        compensating_tool:
          op["x-orchet-compensating-tool"] ?? op["x-orchet-cancels"],
        compensating_inputs_template: op["x-orchet-compensating-inputs-template"],
        compensating_window_seconds: op["x-orchet-compensating-window-seconds"],
      };
    }
  }

  // Validate cancellation protocol — every money tool must declare a cancel,
  // every declared cancel must point back, within the same agent's doc.
  validateCancellationProtocol(agentId, routing);
  validateRollbackProtocol(agentId, routing);

  return { tools, routing };
}

/**
 * Registry-load-time check: a money-tier tool without a cancel counterpart
 * is a contract violation. Compound bookings would deadlock on rollback
 * if any leg's commit tool couldn't be reversed.
 *
 * Rules:
 *   1. cost_tier === "money"  ⇒  `cancels` is set.
 *   2. If `cancels` is set, that operationId must exist in this same doc
 *      (agents may not delegate their cancel to another agent).
 *   3. The referenced cancel tool must declare `cancel_for` pointing back
 *      to the money tool (bidirectional link).
 *   4. Cancel tools must NOT require confirmation — the Saga never asks
 *      the user a second time.
 */
function validateCancellationProtocol(
  agentId: string,
  routing: Record<string, ToolRoutingEntry>,
): void {
  for (const entry of Object.values(routing)) {
    if (entry.cost_tier !== "money") continue;
    if (!entry.cancels) {
      throw new Error(
        `[${agentId}] Operation "${entry.operation_id}" is cost-tier "money" ` +
          `but does not declare \`x-orchet-cancels\`. Every money tool must ship ` +
          `a cancel counterpart so the Saga can roll it back on compound-booking failure.`,
      );
    }
    const cancelTool = routing[entry.cancels];
    if (!cancelTool) {
      throw new Error(
        `[${agentId}] Operation "${entry.operation_id}" declares ` +
          `\`x-orchet-cancels: ${entry.cancels}\`, but that operationId is not ` +
          `exposed as a tool in this agent's OpenAPI. Add \`x-orchet-tool: true\` ` +
          `to the cancel operation (cancels live on the same agent as the money tool).`,
      );
    }
    if (cancelTool.cancel_for !== entry.operation_id) {
      throw new Error(
        `[${agentId}] Cancel link is not bidirectional: ` +
          `"${entry.operation_id}" points at "${entry.cancels}", but ` +
          `"${entry.cancels}".x-orchet-cancel-for === ` +
          `"${cancelTool.cancel_for ?? "(unset)"}". ` +
          `Both operations must reference each other.`,
      );
    }
    if (cancelTool.requires_confirmation !== false) {
      throw new Error(
        `[${agentId}] Cancel tool "${cancelTool.operation_id}" sets ` +
          `\`x-orchet-requires-confirmation: ${cancelTool.requires_confirmation}\`. ` +
          `Cancel tools must set \`false\` — the Saga runs rollback without ` +
          `re-prompting the user (re-prompt would deadlock compound bookings ` +
          `where an earlier leg has already committed).`,
      );
    }
  }
}

/**
 * Registry-load-time check for the durable-mission rollback contract. This is
 * deliberately lighter than the money-tool cancellation protocol because the
 * rollback fields are optional and backward-compatible. Once an operation
 * declares `reversibility: compensating`, though, the referenced compensating
 * operation must exist in the same OpenAPI document.
 */
function validateRollbackProtocol(
  agentId: string,
  routing: Record<string, ToolRoutingEntry>,
): void {
  for (const entry of Object.values(routing)) {
    if (entry.reversibility !== "compensating") continue;
    if (!entry.compensating_tool) {
      throw new Error(
        `[${agentId}] Operation "${entry.operation_id}" declares ` +
          `\`x-orchet-reversibility: compensating\` but does not declare ` +
          `\`x-orchet-compensating-tool\` or \`x-orchet-cancels\`.`,
      );
    }
    const compensatingTool = routing[entry.compensating_tool];
    if (!compensatingTool) {
      throw new Error(
        `[${agentId}] Operation "${entry.operation_id}" declares ` +
          `\`x-orchet-compensating-tool: ${entry.compensating_tool}\`, but that ` +
          `operationId is not exposed as a tool in this agent's OpenAPI.`,
      );
    }
    if (compensatingTool.requires_confirmation !== false) {
      throw new Error(
        `[${agentId}] Compensating tool "${compensatingTool.operation_id}" sets ` +
          `\`x-orchet-requires-confirmation: ${compensatingTool.requires_confirmation}\`. ` +
          `Rollback compensation must not require a second human confirmation.`,
      );
    }
  }
}

/**
 * Merge multiple agents' bridge results into a single tool list + routing
 * map. Tool name collisions are an error — agents must namespace their
 * operationIds (e.g. `flight_search_flights`) if they risk overlap.
 */
export function mergeBridges(results: BridgeResult[]): BridgeResult {
  const tools: ClaudeTool[] = [];
  const routing: Record<string, ToolRoutingEntry> = {};
  const seen = new Set<string>();

  for (const r of results) {
    for (const tool of r.tools) {
      if (seen.has(tool.name)) {
        throw new Error(
          `Tool name collision: "${tool.name}" is exposed by multiple agents. ` +
            `Namespace your operationIds.`,
        );
      }
      seen.add(tool.name);
      tools.push(tool);
    }
    Object.assign(routing, r.routing);
  }

  return { tools, routing };
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

function extractInputSchema(
  op: OpenApiOperation,
  componentSchemas: Record<string, unknown>,
): ClaudeTool["input_schema"] {
  // Prefer the JSON body schema if present.
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema && typeof bodySchema === "object") {
    // OpenAPI lets operations point at a named schema via `$ref`. Claude can't
    // dereference `$ref` on its own — if we pass the raw ref object through,
    // the tool input_schema looks empty and Claude fabricates plausible field
    // names (e.g. `origin`/`destination` when the real schema wants Duffel's
    // `slices`/`passengers`). Resolve every `$ref` recursively against
    // `components.schemas` before normalising.
    const resolved = resolveRefs(
      bodySchema as Record<string, unknown>,
      componentSchemas,
      new Set<string>(),
    );
    return normalizeSchema(resolved as Record<string, unknown>);
  }

  // Otherwise, synthesize from query/path parameters.
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of op.parameters ?? []) {
    const paramSchema = p.schema
      ? resolveRefs(p.schema as Record<string, unknown>, componentSchemas, new Set())
      : { type: "string" };
    properties[p.name] = paramSchema;
    if (p.required) required.push(p.name);
  }

  return {
    type: "object",
    properties,
    required: required.length ? required : undefined,
    additionalProperties: false,
  };
}

/**
 * Walk a JSON Schema fragment and replace every `{"$ref": "#/components/schemas/X"}`
 * with a (recursively resolved) copy of the target. Keeps a `seen` set so
 * self-referential schemas don't loop forever — a circular ref collapses to
 * `{}` which Claude will treat as "any", an acceptable degradation.
 *
 * Only handles `#/components/schemas/...` refs. External refs (http URIs,
 * paths into other files) are left untouched; agents that need those should
 * bundle their spec first.
 */
function resolveRefs(
  node: unknown,
  componentSchemas: Record<string, unknown>,
  seen: Set<string>,
): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(item, componentSchemas, seen));
  }

  const obj = node as Record<string, unknown>;
  const ref = obj["$ref"];
  if (typeof ref === "string") {
    const prefix = "#/components/schemas/";
    if (!ref.startsWith(prefix)) return obj;
    if (seen.has(ref)) return {}; // circular — bail gracefully
    const name = ref.slice(prefix.length);
    const target = componentSchemas[name];
    if (target === undefined) return obj; // dangling ref; leave as-is
    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    return resolveRefs(target, componentSchemas, nextSeen);
  }

  // Recurse into every value — cheap and correct for arbitrary JSON Schema
  // shapes (properties, items, allOf/anyOf/oneOf, patternProperties, …).
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = resolveRefs(v, componentSchemas, seen);
  }
  return out;
}

function normalizeSchema(schema: Record<string, unknown>): ClaudeTool["input_schema"] {
  // We assume the agent's JSON schema is already "object" at the root; if not,
  // we wrap it. Claude tool schemas must be object at the top level.
  if (schema.type === "object") {
    return {
      type: "object",
      properties: (schema.properties as Record<string, unknown>) ?? {},
      required: Array.isArray(schema.required) ? (schema.required as string[]) : undefined,
      additionalProperties: schema.additionalProperties === true ? true : false,
    };
  }
  return {
    type: "object",
    properties: { value: schema },
    required: ["value"],
    additionalProperties: false,
  };
}
