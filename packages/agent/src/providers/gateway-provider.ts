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

function isAuthorizationDecision(value: unknown): value is AuthorizationDecision {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return (
		obj.schema_version === "0.6.0" &&
		typeof obj.attempt_id === "string" &&
		(obj.outcome === "ALLOW" || obj.outcome === "DENY") &&
		typeof obj.action_id === "string" &&
		typeof obj.connector_id === "string" &&
		typeof obj.signature === "string"
	);
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
