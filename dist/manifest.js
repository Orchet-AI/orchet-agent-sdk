/**
 * Agent manifest types.
 *
 * Every specialist agent serves a manifest at `/.well-known/agent.json` that
 * conforms to {@link AgentManifest}. Orchet polls manifests at boot to build
 * its registry and re-validates on every deploy webhook.
 */
import { z } from "zod";
// ──────────────────────────────────────────────────────────────────────────
// Zod schemas (runtime validation at registry load)
// ──────────────────────────────────────────────────────────────────────────
export const AgentSLASchema = z.object({
    p50_latency_ms: z.number().int().positive(),
    p95_latency_ms: z.number().int().positive(),
    availability_target: z.number().min(0).max(1),
});
export const AgentUIManifestSchema = z.object({
    /** URL of the Module Federation remote entry (web shell). */
    remote_url: z.string().url().optional(),
    /** Published npm package name for React Native components. */
    native_package: z.string().optional(),
    /** Component names the shell is allowed to render. */
    components: z.array(z.string()).default([]),
});
/**
 * Self-declared contract version and capability flags. Orchet reads this
 * at `/.well-known/agent.json` load and fast-fails if the agent is missing
 * a capability the registry needs.
 *
 * Why a separate block rather than top-level fields: capabilities will grow
 * (compound bookings today, streaming tool results later, …) and nesting
 * them keeps the top of the manifest stable.
 */
/**
 * Connection block — introduced in SDK v0.4 to support the Orchet Store.
 *
 * Every agent that holds user-scoped state (a cart, an order history, a
 * saved payment method, a loyalty account) declares how an Orchet user
 * "connects" their identity to the agent. Orchet reads this block when
 * rendering the Orchet Store card ("Connect Food Agent") and the router
 * reads it to know whether to attach a user-scoped bearer
 * token on each tool dispatch.
 *
 * Three models are allowed today:
 *
 *   "oauth2"    — the agent is an OAuth 2.1 Authorization Server. Orchet
 *                 kicks off the Authorization Code + PKCE flow, stores
 *                 the returned access/refresh tokens per user, and
 *                 attaches `Authorization: Bearer <access>` on every
   *                 tool call. This is the model every Orchet-built agent
 *                 uses and the one third-party SaaS typically slots into.
 *
 *   "orchet_user_jwt" — the agent delegates identity to Orchet. Orchet issues a
 *                 signed OIDC token per request; the agent trusts Orchet's
 *                 JWKS. Cheap for Orchet-native agents; doesn't work for
 *                 third-party SaaS with pre-existing user bases.
 *
 *   "none"      — agent exposes only anonymous tools (e.g., a public
 *                 weather lookup). No per-user state, no bearer, no
 *                 Connect button in the Orchet Store.
 *
 * An agent with `requires_payment: true` or any money-tier tool MUST NOT
 * declare `"none"`. Orchet will refuse to load such a manifest.
 *
 * Why a block, not top-level fields: future additions (API-key-per-user,
 * MTLS, passkey-bound bearer) extend this block without churning the top
 * of the manifest. Keep additions backward-compatible or bump SDK major.
 */
export const AgentConnectSchema = z.discriminatedUnion("model", [
    z.object({
        model: z.literal("oauth2"),
        /**
         * The agent's OAuth authorize endpoint. Users are redirected here
         * with client_id, redirect_uri, scope, state, code_challenge,
         * code_challenge_method=S256.
         */
        authorize_url: z.string().url(),
        /**
         * The agent's OAuth token endpoint. Receives the authorization code
         * and returns access_token, refresh_token, expires_in, token_type=Bearer.
         */
        token_url: z.string().url(),
        /**
         * Optional revocation endpoint (RFC 7009). Super Agent calls this on
         * explicit disconnect to tell the agent to invalidate the token
         * server-side. If not provided, we just delete our copy.
         */
        revocation_url: z.string().url().optional(),
        /**
         * The scopes the agent supports. Minimum set the agent requires for
         * ANY tool call should be listed with `required: true` — the
         * consent UI surfaces that. Additional fine-grained scopes can be
         * declared optional and the consent UI will let the user toggle.
         */
        scopes: z
            .array(z.object({
            name: z.string().min(1),
            description: z.string().min(4),
            required: z.boolean().default(false),
        }))
            .min(1),
        /**
         * Env var name Orchet looks up for this agent's OAuth
         * client_id and client_secret. Conventions accepted:
         *   - ORCHET_<AGENT_ID_SHOUT>_CLIENT_ID / ORCHET_<AGENT_ID_SHOUT>_CLIENT_SECRET   (preferred)
         *   - LUMO_<AGENT_ID_SHOUT>_CLIENT_ID   / LUMO_<AGENT_ID_SHOUT>_CLIENT_SECRET     (legacy, supported until coordinated prod env-var rename)
         * Declared here so the orchestrator fails fast with a clear error
         * instead of a mysterious 401 at token-exchange time.
         */
        client_id_env: z.string().regex(/^(ORCHET|LUMO)_[A-Z0-9_]+_CLIENT_ID$/),
        client_secret_env: z
            .string()
            .regex(/^(ORCHET|LUMO)_[A-Z0-9_]+_CLIENT_SECRET$/)
            .optional(),
        /**
         * Whether this client is confidential (secret required) or public
         * (PKCE only). Public is the right default for user-facing apps where
         * the "secret" would just be bundled in the browser. Confidential is
         * right for server-to-server where we can keep the secret out of
         * client code. Orchet's runtime is always server-side, so
         * confidential is preferred — but agents that haven't wired secrets
         * can still register as public.
         */
        client_type: z.enum(["public", "confidential"]).default("confidential"),
    }),
    z.object({
        model: z.literal("orchet_user_jwt"),
        /**
         * Audience claim the agent expects on the OIDC ID token. Typically
         * the agent's base URL or agent_id.
         */
        audience: z.string().min(3),
    }),
    z.object({
        model: z.literal("none"),
    }),
]);
/**
 * Payment-architecture declaration — introduced in SDK v0.6 to support
 * Orchet's unified-checkout vision (one payment per trip, even when
 * the trip spans multiple agents).
 *
 * Three modes are allowed today:
 *
 *   "agent_owned"      — agent collects payment via its own PG portal.
 *                        Used when the upstream booking API atomically
 *                        requires payment_id at booking-creation time
 *                        (a first-party rentals service's /v1/bookings/{hash} requires
 *                        razorPayPaymentId on the same call). Orchet
 *                        sequences these legs one at a time — the user
 *                        clicks "Pay leg 1 of 2" → confirmation → "Pay
 *                        leg 2 of 2" in the chat thread.
 *
 *   "orchet_unified"   — agent only QUOTES + FINALIZES; Orchet collects
 *                        ONE payment for the trip's total via its own
 *                        PG account and disburses to each agent after
 *                        capture. The agent exposes `*_quote_*` tools
 *                        that return a QuoteToken (HMAC-signed amount +
 *                        finalize_url + finalize_payload). This is the
 *                        target architecture — best UX for multi-leg
 *                        trips (Flight + Car + Hotel = one swipe).
 *
 *   "hybrid"           — agent supports BOTH. Exposes legacy single-leg
 *                        booking tools (agent_owned) AND quote tools
 *                        (orchet_unified). Orchet's dispatcher picks
 *                        orchet_unified for multi-leg bundles and
 *                        agent_owned for solo bookings (less ceremony).
 *
 * If unset, defaults to "agent_owned" — safest assumption for any new
 * agent and matches the behavior of every pre-v0.6 agent in the
 * Orchet Store. Switching to orchet_unified requires the agent to ALSO
 * expose at least one tool whose name matches /_quote_|quote_booking/
 * (validated at openapi-load time).
 */
export const AgentPaymentModeSchema = z.enum([
    "agent_owned",
    "orchet_unified",
    "hybrid",
]);
export const AgentCapabilitiesSchema = z.object({
    /**
     * SDK semver the agent was built against. The shell refuses to register
     * an agent whose major ≠ the shell's major (breaking contract drift).
     */
    sdk_version: z.string().regex(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/),
    /**
     * Does this agent participate in compound bookings (trip summaries)?
     * If false, the orchestrator will never route a leg of a TripSummary
     * to this agent — it can only be used for single-leg intents. Any
     * agent with a money tool SHOULD set this to true; the registry will
     * warn if money + compound=false to flag the config as likely wrong.
     */
    supports_compound_bookings: z.boolean().default(false),
    /**
     * Does the agent implement the cancellation protocol for every money
     * tool it exposes? This is validated structurally at OpenAPI load
     * (see openapi.ts validateCancellationProtocol), but we record the
     * self-declaration here so health checks can surface the gap early
     * even before the first tool bridge is built.
     */
    implements_cancellation: z.boolean().default(false),
    /**
     * How this agent collects money. See {@link AgentPaymentModeSchema}.
     * Defaulted to `agent_owned` so pre-v0.6 manifests parse unchanged
     * and the orchestrator's trip-payment dispatcher treats them
     * conservatively (sequential per-leg pay flow).
     */
    payment_mode: AgentPaymentModeSchema.default("agent_owned"),
});
export const AgentManifestSchema = z.object({
    agent_id: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/),
    domain: z.string().min(3),
    display_name: z.string().min(2).max(48),
    one_liner: z.string().min(8).max(140),
    /** Canonical intent labels the agent handles. */
    intents: z.array(z.string().min(2)).min(1),
    /** Short, natural-language examples the orchestrator uses as few-shot hints. */
    example_utterances: z.array(z.string()).default([]),
    openapi_url: z.string().url(),
    mcp_url: z.string().url().optional(),
    ui: AgentUIManifestSchema,
    health_url: z.string().url(),
    sla: AgentSLASchema,
    /** Narrow list of PII fields the agent may be granted. */
    pii_scope: z.array(z.enum([
        "name",
        "email",
        "phone",
        "address",
        "dob",
        "payment_method_id",
        "passport",
        "passport_optional",
        "loyalty_numbers",
        "traveler_profile",
    ])),
    requires_payment: z.boolean().default(false),
    /** ISO region codes where this agent is available to users. */
    supported_regions: z.array(z.string()).default([]),
    /**
     * Contract/capability block. Defaulted so v0.1.x manifests still parse —
     * but registry-level validation (in Orchet) will refuse to register
     * an agent that exposes a money tool without `implements_cancellation`.
     */
    capabilities: AgentCapabilitiesSchema.default({
        sdk_version: "0.1.0",
        supports_compound_bookings: false,
        implements_cancellation: false,
    }),
    /**
     * Connection block — how an Orchet user links their account on THIS agent
     * to their Orchet identity. See {@link AgentConnectSchema}. Defaulted to
     * `none` so pre-v0.4 manifests still parse; the registry validator
     * refuses agents with money tools + model="none".
     */
    connect: AgentConnectSchema.default({ model: "none" }),
    /**
     * Orchet Store catalog fields (v0.4). Surfaced on /marketplace cards.
     * Optional so internal/private agents don't have to fill them in.
     */
    listing: z
        .object({
        /** Square or circular logo, ≥ 128px, hosted by the agent. */
        logo_url: z.string().url().optional(),
        /** Marketing hero image for the detail page, wide aspect. */
        hero_url: z.string().url().optional(),
        /** Plain-English category for filters: "Food", "Travel", "Productivity", etc. */
        category: z.string().min(2).optional(),
        /** Short (≤200 char) paragraphs, 1-5 of them, for the detail page. */
        about_paragraphs: z.array(z.string().min(8).max(400)).max(5).optional(),
        /** Links the detail page surfaces in the sidebar. */
        homepage_url: z.string().url().optional(),
        privacy_policy_url: z.string().url().optional(),
        terms_url: z.string().url().optional(),
        /** Optional pricing note, human-readable: "Free", "Pay-per-use", "Subscription — $9.99/mo". */
        pricing_note: z.string().max(80).optional(),
    })
        .optional(),
    /** Optional metadata for analytics / ops. */
    owner_team: z.string().optional(),
    on_call_escalation: z.string().url().optional(),
});
/**
 * Define and validate an agent manifest at build time. Throws with a readable
 * error if the shape is wrong. Use this in your agent's `app/manifest.ts`.
 */
export function defineManifest(input) {
    const parsed = AgentManifestSchema.safeParse(input);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((i) => `  · ${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("\n");
        throw new Error(`Invalid agent manifest:\n${issues}`);
    }
    return parsed.data;
}
/**
 * Runtime guard used by Orchet when it loads `/.well-known/agent.json` from
 * a remote agent. Never trust manifest data without running it through this.
 */
export function parseManifest(raw) {
    return AgentManifestSchema.parse(raw);
}
//# sourceMappingURL=manifest.js.map