/**
 * Gateway LLM invoke — the single owner of `LlmConnectorEnvelope` minting
 * and the `/api/connector/llm/invoke` client surface (WE2 Phase 8).
 *
 * `GatewayProvider.executeLlm` delegates here so the envelope construction,
 * SSE token parsing, buffered `chat.completion` projection, and the client
 * error taxonomy live in one place. The provider supplies its
 * `connectorContext` (identity fields), token provider, and fetch double;
 * this module never sees an upstream API key.
 */

import type {
	ConnectorContext,
	ConnectorLlmResult,
	LlmConnectorEnvelope,
	LlmInvokeRequest,
	LlmWireMessage,
} from "../connector/types.js";
import type { FetchLike, GatewayResponse } from "./gateway-provider.js";

// --- Connector error taxonomy (mirrors sdk-python magcarta.errors) ---

/** Cedar policy evaluated to DENY (HTTP 403, `category:"policy"`). */
export class GovernanceDenied extends Error {
	constructor(
		public readonly action: string,
		public readonly reason: string,
		public readonly diagnostics: Record<string, unknown> = {},
	) {
		super(`GovernanceDenied: ${action} — ${reason}`);
		this.name = "GovernanceDenied";
	}
}

/** Classification fail-closed block — the response is never delivered. */
export class ClassificationBlocked extends Error {
	constructor(
		public readonly reason: string,
		public readonly code: string,
	) {
		super(`ClassificationBlocked: ${code} — ${reason}`);
		this.name = "ClassificationBlocked";
	}
}

/** Envelope `agent_did` did not match the authenticated JWT subject. */
export class SubjectBindingViolation extends Error {
	constructor(
		public readonly reason: string,
		public readonly code: string,
	) {
		super(`SubjectBindingViolation: ${code} — ${reason}`);
		this.name = "SubjectBindingViolation";
	}
}

/** Cedar context pinned one connector mode; the envelope declared the other. */
export class ModeMismatch extends Error {
	constructor(
		public readonly reason: string,
		public readonly code: string,
	) {
		super(`ModeMismatch: ${code} — ${reason}`);
		this.name = "ModeMismatch";
	}
}

/** A 4xx connector rejection that carries a category but isn't a policy denial. */
export class ConnectorRejected extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly category: string,
		public readonly statusCode: number,
	) {
		super(`ConnectorRejected[${category}]: ${code} — ${message}`);
		this.name = "ConnectorRejected";
	}
}

/** Gateway unreachable, 5xx, or an unparseable response — infrastructure, not a verdict. */
export class GatewayUnavailable extends Error {
	constructor(
		public readonly url: string,
		cause?: Error,
	) {
		super(`GatewayUnavailable: cannot reach ${url}`, cause ? { cause } : undefined);
		this.name = "GatewayUnavailable";
	}
}

export interface LlmInvokeDeps {
	readonly gatewayUrl: string;
	readonly connectorContext: ConnectorContext | undefined;
	readonly tokenProvider: () => Promise<string> | string;
	readonly fetchImpl: FetchLike;
	/** Maps a pre-dispatch client failure onto the provider's error class. */
	readonly clientError: (code: string, message: string) => Error;
}

/**
 * Mint the envelope, POST `/api/connector/llm/invoke`, and return either the
 * buffered `ConnectorLlmResult` (`request.stream === false`) or an
 * `AsyncGenerator<string>` of token chunks (`request.stream === true`).
 */
export async function executeLlmInvoke(
	deps: LlmInvokeDeps,
	request: LlmInvokeRequest,
	signal?: AbortSignal,
): Promise<ConnectorLlmResult | AsyncGenerator<string>> {
	const envelope = mintLlmEnvelope(deps, request);
	let token: string;
	try {
		token = await deps.tokenProvider();
	} catch (err) {
		throw deps.clientError(
			"TOKEN_PROVIDER_FAILED",
			`Token provider threw before executeLlm could call gateway: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const url = `${deps.gatewayUrl}/api/connector/llm/invoke`;
	let response: GatewayResponse;
	try {
		response = await deps.fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(envelope),
			...(signal !== undefined ? { signal } : {}),
		});
	} catch (err) {
		throw deps.clientError(
			"TRANSPORT_ERROR",
			`Gateway request failed before a response was received: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!response.ok) {
		await raiseConnectorError(response, deps.gatewayUrl, envelope.action_id);
	}
	if (request.stream) {
		return streamLlmTokens(response, deps.gatewayUrl);
	}
	return readLlmResult(response, deps.gatewayUrl);
}

/**
 * Build the wire envelope for one invoke. Fails closed — a proxy-mode
 * envelope without `credential_ref`, or any invoke without a provider
 * `connectorContext`, raises `MALFORMED_ENVELOPE` before fetch so the
 * gateway never sees a malformed artifact. `request.systemPrompt` folds
 * into `messages[0]` as `{ role:"system" }` because the contract request
 * is strict with no `systemPrompt` sibling.
 */
function mintLlmEnvelope(deps: LlmInvokeDeps, request: LlmInvokeRequest): LlmConnectorEnvelope {
	const context = deps.connectorContext;
	if (!context) {
		throw deps.clientError(
			"MALFORMED_ENVELOPE",
			"executeLlm requires GatewayProviderConfig.connectorContext to mint an LlmConnectorEnvelope",
		);
	}
	if (context.connector_mode === "proxy" && context.credential_ref === undefined) {
		throw deps.clientError("MALFORMED_ENVELOPE", "credential_ref is required when connector_mode is 'proxy'");
	}
	const messages: LlmWireMessage[] = [];
	// Truthy guard mirrors the OpenAI provider — an empty system prompt never
	// produces a leading empty system message on the wire.
	if (request.systemPrompt) {
		messages.push({ role: "system", content: request.systemPrompt });
	}
	for (const message of request.messages) {
		messages.push(message);
	}
	return {
		schema_version: "0.6.0",
		attempt_id: generateAttemptId(),
		tenant_id: context.tenant_id,
		agent_id: context.agent_id,
		agent_did: context.agent_did,
		connector_id: context.connector_id,
		connector_type: "llm",
		connector_mode: context.connector_mode,
		action_id: "connector::llm::invoke",
		action_timestamp: new Date().toISOString(),
		...(context.credential_ref !== undefined ? { credential_ref: context.credential_ref } : {}),
		request: {
			model: request.model,
			messages,
			stream: request.stream,
		},
	};
}

/**
 * Project a buffered post-scan `chat.completion` body onto the flat
 * `ConnectorLlmResult` shape. Classification metadata is gateway-internal —
 * it never appears on this client surface.
 */
async function readLlmResult(response: GatewayResponse, gatewayUrl: string): Promise<ConnectorLlmResult> {
	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		throw new GatewayUnavailable(gatewayUrl, err instanceof Error ? err : new Error(String(err)));
	}
	try {
		const completion = body as {
			choices: Array<{ message: { content: string } }>;
			model: string;
			usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
			blocked?: boolean;
		};
		const text = completion.choices[0].message.content;
		const model = completion.model;
		if (typeof text !== "string" || typeof model !== "string") {
			throw new TypeError("Invalid chat completion text or model");
		}
		return {
			text,
			model,
			...(completion.usage !== undefined ? { usage: completion.usage } : {}),
			...(completion.blocked !== undefined ? { blocked: completion.blocked } : {}),
		};
	} catch (err) {
		throw new GatewayUnavailable(gatewayUrl, err instanceof Error ? err : new Error(String(err)));
	}
}

/**
 * Parse the SSE token stream into an `AsyncGenerator<string>`. Each
 * `data:` frame is a `chat.completion.chunk`; `delta.content` strings are
 * yielded verbatim. `data: [DONE]` terminates the iterator. A mid-stream
 * `data: {"error":"…"}` string frame raises `ClassificationBlocked` from
 * inside the iterator — the governance block surface, not a transport
 * failure. A stream that ends without `[DONE]` raises `GatewayUnavailable`.
 */
async function* streamLlmTokens(response: GatewayResponse, gatewayUrl: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let pending = "";
	let dataLines: string[] = [];
	let sawDone = false;

	function* handleFrame(data: string): Generator<string> {
		if (data === "[DONE]") {
			sawDone = true;
			return;
		}
		let frame: { error?: unknown; choices?: Array<{ delta?: { content?: unknown } }> };
		try {
			frame = JSON.parse(data);
		} catch (err) {
			throw new GatewayUnavailable(
				gatewayUrl,
				err instanceof Error ? err : new Error(`Unparseable SSE frame: ${data}`),
			);
		}
		if (typeof frame.error === "string") {
			throw new ClassificationBlocked(frame.error, "CLASSIFICATION_BLOCKED");
		}
		const choices = frame.choices;
		if (Array.isArray(choices) && choices.length > 0) {
			const token = choices[0]?.delta?.content;
			if (token !== undefined && token !== null) {
				if (typeof token !== "string") {
					throw new GatewayUnavailable(gatewayUrl, new TypeError("Invalid chat completion token"));
				}
				yield token;
			}
		}
	}

	if (response.body) {
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				pending += decoder.decode(value, { stream: true });
				for (;;) {
					const newlineIndex = pending.indexOf("\n");
					if (newlineIndex < 0) break;
					const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
					pending = pending.slice(newlineIndex + 1);
					if (line.startsWith("data:")) {
						dataLines.push(line.slice(5).replace(/^ /, ""));
					} else if (line === "" && dataLines.length > 0) {
						const data = dataLines.join("\n");
						dataLines = [];
						yield* handleFrame(data);
						if (sawDone) return;
					}
				}
			}
		} finally {
			reader.releaseLock();
			await reader.cancel().catch(() => {});
		}
	} else if (response.text) {
		pending = await response.text();
		for (const line of pending.split("\n")) {
			const trimmed = line.replace(/\r$/, "");
			if (trimmed.startsWith("data:")) {
				dataLines.push(trimmed.slice(5).replace(/^ /, ""));
			} else if (trimmed === "" && dataLines.length > 0) {
				const data = dataLines.join("\n");
				dataLines = [];
				yield* handleFrame(data);
				if (sawDone) return;
			}
		}
	}
	if (!sawDone) {
		throw new GatewayUnavailable(gatewayUrl, new Error("LLM stream ended before [DONE]"));
	}
}

/**
 * Translate a non-OK invoke response body `{ error: { code, message, category } }`
 * onto the connector exception taxonomy. Ordering mirrors
 * `sdk-python/connector/error_translator.py`: `subject_binding` first (identity
 * integrity, not a policy verdict), then the 4xx category branches, then a
 * generic `GatewayUnavailable` for everything else. Always throws.
 */
async function raiseConnectorError(response: GatewayResponse, gatewayUrl: string, actionId: string): Promise<never> {
	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		throw new GatewayUnavailable(
			gatewayUrl,
			err instanceof Error ? err : new Error(`Gateway returned ${response.status} with an unparseable body`),
		);
	}
	const rawError = isObjectWithError(body) ? body.error : {};
	const error = rawError as { code?: unknown; message?: unknown; category?: unknown };
	const code = typeof error.code === "string" ? error.code : `HTTP_${response.status}`;
	const message = typeof error.message === "string" ? error.message : `Gateway returned ${response.status}`;
	const category = typeof error.category === "string" ? error.category : undefined;
	const status = response.status;

	if (category === "subject_binding") {
		throw new SubjectBindingViolation(message, code);
	}
	if (status === 403 && category === "policy") {
		throw new GovernanceDenied(actionId, message, { code });
	}
	if (category === "classification") {
		throw new ClassificationBlocked(message, code);
	}
	if (category === "mode_mismatch") {
		throw new ModeMismatch(message, code);
	}
	if (status >= 400 && status < 500 && category !== undefined) {
		throw new ConnectorRejected(code, message, category, status);
	}
	throw new GatewayUnavailable(gatewayUrl, new Error(`Gateway returned ${status} ${code}: ${message}`));
}

function isObjectWithError(
	value: unknown,
): value is { error: { code?: unknown; message?: unknown; category?: unknown } } {
	if (typeof value !== "object" || value === null || !("error" in value)) {
		return false;
	}
	const { error } = value as { error: unknown };
	return typeof error === "object" && error !== null;
}

/**
 * Attempt-id generator — same three-tier entropy strategy as
 * `connector/envelope-builder.ts` (crypto.randomUUID → getRandomValues →
 * Math.random last resort). Each invoke mints a fresh id for ADR
 * correlation and request/response identity cross-checks.
 */
function generateAttemptId(): string {
	const maybeCrypto = (
		globalThis as {
			crypto?: {
				randomUUID?: () => string;
				getRandomValues?: (array: Uint8Array) => Uint8Array;
			};
		}
	).crypto;
	if (maybeCrypto?.randomUUID) {
		return maybeCrypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (maybeCrypto?.getRandomValues) {
		maybeCrypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	const b6 = bytes[6] ?? 0;
	const b8 = bytes[8] ?? 0;
	bytes[6] = (b6 & 0x0f) | 0x40;
	bytes[8] = (b8 & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` + `${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
