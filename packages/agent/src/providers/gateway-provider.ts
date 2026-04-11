/**
 * GatewayProvider — default MagCarta governance provider that talks to the
 * gateway service via HTTP (WE2-007).
 *
 * Phase 1 thin slice implements only `authorize()`. The remaining methods on
 * the `MagCartaProvider` combined interface throw `NotImplementedError`:
 *
 * - `classify()` — wired in Phase 3 (WE2-014)
 * - `recordDecision()` — wired in Phase 3 (WE2-014)
 * - `executeHttp()` and the other `ConnectorExecutor` methods — wired in
 *   Phase 9 (WE2-036)
 *
 * The provider is stateless aside from a pluggable fetch function and an
 * auth token provider callback. Tests inject both as doubles.
 */

import {
	type AuthorizationDecision,
	type ConnectorEnvelope,
	type HttpConnectorEnvelope,
	NotImplementedError,
} from "../connector/types.js";
import type {
	ClassificationMetadata,
	ClassificationResult,
	ConnectorAdrEvent,
	MagCartaProvider,
} from "../governance.js";

export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	},
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

export interface GatewayProviderConfig {
	readonly gateway_url: string;
	readonly token_provider: () => Promise<string> | string;
	readonly fetch?: FetchLike;
}

/**
 * HTTP-backed MagCarta governance provider. Phase 1 implements only
 * `authorize()`; the remaining methods on `MagCartaProvider` throw
 * `NotImplementedError` until Phase 3 (classify + recordDecision) and
 * Phase 9 (execute*).
 */
export class GatewayProvider implements MagCartaProvider {
	private readonly gatewayUrl: string;
	private readonly tokenProvider: () => Promise<string> | string;
	private readonly fetchImpl: FetchLike;

	constructor(config: GatewayProviderConfig) {
		this.gatewayUrl = config.gateway_url.replace(/\/+$/, "");
		this.tokenProvider = config.token_provider;
		this.fetchImpl = config.fetch ?? (defaultFetch as FetchLike);
	}

	// --- GovernanceAuthorizer --------------------------------------------------

	async authorize(envelope: ConnectorEnvelope): Promise<AuthorizationDecision> {
		const token = await this.tokenProvider();
		const url = `${this.gatewayUrl}/api/connector/authorize`;
		const response = await this.fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(envelope),
		});

		const body = (await response.json()) as unknown;

		if (!response.ok) {
			const errorBody = isObjectWithError(body) ? body.error : undefined;
			const code = errorBody && typeof errorBody.code === "string" ? errorBody.code : `HTTP_${response.status}`;
			const message =
				errorBody && typeof errorBody.message === "string"
					? errorBody.message
					: `Gateway returned ${response.status}`;
			throw new GatewayProviderError(code, message, response.status);
		}

		if (!isAuthorizationDecision(body)) {
			throw new GatewayProviderError(
				"MALFORMED_RESPONSE",
				"Gateway response is not a valid AuthorizationDecision",
				response.status,
			);
		}
		return body;
	}

	async classify(
		_attemptId: string,
		_content: Uint8Array,
		_metadata: ClassificationMetadata,
	): Promise<ClassificationResult> {
		throw new NotImplementedError("GatewayProvider.classify", "Phase 1");
	}

	async recordDecision(_event: ConnectorAdrEvent): Promise<void> {
		throw new NotImplementedError("GatewayProvider.recordDecision", "Phase 1");
	}

	// --- ConnectorExecutor (all stubs in Phase 1) ------------------------------

	async executeHttp(_envelope: HttpConnectorEnvelope): Promise<unknown> {
		throw new NotImplementedError("GatewayProvider.executeHttp", "Phase 1");
	}

	async executeDb(_envelope: ConnectorEnvelope): Promise<unknown> {
		throw new NotImplementedError("GatewayProvider.executeDb", "Phase 1");
	}

	async executeFileRead(_envelope: ConnectorEnvelope): Promise<unknown> {
		throw new NotImplementedError("GatewayProvider.executeFileRead", "Phase 1");
	}

	async executeFileWrite(_envelope: ConnectorEnvelope): Promise<unknown> {
		throw new NotImplementedError("GatewayProvider.executeFileWrite", "Phase 1");
	}

	async executeFileDelete(_envelope: ConnectorEnvelope): Promise<unknown> {
		throw new NotImplementedError("GatewayProvider.executeFileDelete", "Phase 1");
	}

	async executeLlm(_envelope: ConnectorEnvelope): Promise<unknown> {
		throw new NotImplementedError("GatewayProvider.executeLlm", "Phase 1");
	}

	async executeBrowser(_envelope: ConnectorEnvelope): Promise<never> {
		throw new NotImplementedError(
			"GatewayProvider.executeBrowser",
			"browser connector is out of scope for E2 (E2-Q2)",
		);
	}
}

/**
 * Error thrown by GatewayProvider when the gateway returns a non-OK response
 * or the response body fails to parse as an AuthorizationDecision. Higher-level
 * callers (agent-loop, SDK) map this onto the richer error taxonomy.
 */
export class GatewayProviderError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "GatewayProviderError";
	}
}

function isObjectWithError(
	value: unknown,
): value is { error: { code?: unknown; message?: unknown; category?: unknown } } {
	return (
		typeof value === "object" &&
		value !== null &&
		"error" in value &&
		typeof (value as { error: unknown }).error === "object"
	);
}

// Review finding F5: comprehensive contract validation on the client side.
// The pi-mono GatewayProvider now rejects any gateway response that does not
// match the contract shape exactly — same invariants enforced by the
// server-side Zod refinement and the Python SDK's AuthorizationDecision.from_dict.

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const POLICY_HASH_RE = /^sha256:[0-9a-f]{64}$/;
// RFC 3339 datetime with required timezone. Mirrors Zod's
// `z.string().datetime()` server-side enforcement and the Python SDK's
// `_ISO_DATETIME_RE`. Review finding F2 (follow-up).
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoDateTime(value: unknown): value is string {
	return typeof value === "string" && ISO_DATETIME_RE.test(value);
}
const CONNECTOR_ACTIONS = new Set<string>([
	"connector::http::fetch",
	"connector::http::submit",
	"connector::db::query",
	"connector::db::mutate",
	"connector::file::read",
	"connector::file::write",
	"connector::file::delete",
	"connector::llm::invoke",
	"connector::browser::navigate",
]);
const CONNECTOR_MODES = new Set<string>(["approval", "proxy"]);
const CLASSIFICATIONS = new Set<string>(["public", "internal", "confidential", "pii", "phi", "pci", "restricted"]);
const CLASSIFICATION_LAYERS = new Set<string>(["manifest", "policy", "scanner", "external_provider"]);
const CLASSIFICATION_STATUSES = new Set<string>(["success", "timeout", "error", "skipped"]);
const DENY_CATEGORIES = new Set<string>([
	"policy",
	"classification",
	"credential_missing",
	"credential_rejected",
	"mode_mismatch",
	"target_unavailable",
	"malformed_envelope",
]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isClassificationContribution(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const c = value as Record<string, unknown>;
	if (typeof c.layer !== "string" || !CLASSIFICATION_LAYERS.has(c.layer)) return false;
	if (typeof c.status !== "string" || !CLASSIFICATION_STATUSES.has(c.status)) return false;
	if (!Array.isArray(c.classifications)) return false;
	for (const entry of c.classifications) {
		if (typeof entry !== "string" || !CLASSIFICATIONS.has(entry)) return false;
	}
	if (!isIsoDateTime(c.evaluated_at)) return false;
	if (typeof c.latency_ms !== "number" || !Number.isFinite(c.latency_ms)) return false;
	return true;
}

function isClassificationChain(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const chain = value as Record<string, unknown>;
	if (!Array.isArray(chain.contributions)) return false;
	for (const c of chain.contributions) {
		if (!isClassificationContribution(c)) return false;
	}
	if (typeof chain.merged_classification !== "string" || !CLASSIFICATIONS.has(chain.merged_classification)) {
		return false;
	}
	if (!isNonEmptyString(chain.merge_reason)) return false;
	return true;
}

function isAuthorizationDecision(value: unknown): value is AuthorizationDecision {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;

	if (obj.schema_version !== "0.6.0") return false;
	if (typeof obj.attempt_id !== "string" || !UUID_RE.test(obj.attempt_id)) return false;
	if (obj.outcome !== "ALLOW" && obj.outcome !== "DENY") return false;
	if (typeof obj.action_id !== "string" || !CONNECTOR_ACTIONS.has(obj.action_id)) return false;
	if (!isNonEmptyString(obj.connector_id)) return false;
	if (typeof obj.connector_mode !== "string" || !CONNECTOR_MODES.has(obj.connector_mode)) return false;
	if (!isNonEmptyString(obj.tenant_id)) return false;
	if (!isNonEmptyString(obj.agent_id)) return false;
	if (!isClassificationChain(obj.classification_chain)) return false;
	if (typeof obj.policy_hash !== "string" || !POLICY_HASH_RE.test(obj.policy_hash)) return false;
	// Review finding F2 (follow-up): evaluated_at must be a real RFC 3339
	// datetime, not just any non-empty string.
	if (!isIsoDateTime(obj.evaluated_at)) return false;
	if (!isNonEmptyString(obj.signer)) return false;
	if (!isNonEmptyString(obj.signature)) return false;

	// DENY/ALLOW cleanup invariant — mirrors server-side Zod refinement
	if (obj.outcome === "DENY") {
		if (!isNonEmptyString(obj.reason)) return false;
		if (typeof obj.deny_category !== "string" || !DENY_CATEGORIES.has(obj.deny_category)) return false;
	} else {
		if (obj.reason !== undefined && obj.reason !== null) return false;
		if (obj.deny_category !== undefined && obj.deny_category !== null) return false;
	}

	return true;
}

/**
 * Lightweight wrapper around the global `fetch` to normalize the return
 * shape. Avoids a hard dependency on undici/node-fetch since the package is
 * intended to run in both Node and browser contexts.
 */
const defaultFetch: FetchLike = async (input, init) => {
	const response = await globalThis.fetch(input, init as RequestInit);
	return {
		ok: response.ok,
		status: response.status,
		json: () => response.json() as Promise<unknown>,
	};
};
