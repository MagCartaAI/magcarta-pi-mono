// Tool envelopes are minted here; LLM requests retain their provider-owned minter.

import type { ToolRegistry } from "./tool-registry.js";
import type {
	ConnectorEnvelope,
	DbConnectorRequest,
	FileReadConnectorRequest,
	FileWriteConnectorRequest,
	HttpConnectorRequest,
} from "./types.js";

export interface BuildEnvelopeInput {
	readonly tool_name: string;
	readonly params: Record<string, unknown>;
	readonly tenant_id: string;
	readonly agent_id: string;
	readonly agent_did: string;
}

export class ConnectorEnvelopeBuilder {
	constructor(private readonly registry: ToolRegistry) {}

	build(input: BuildEnvelopeInput): ConnectorEnvelope {
		const binding = this.registry.lookup(input.tool_name);
		if (!binding) {
			throw new Error(
				`ConnectorEnvelopeBuilder: no ToolRegistry binding for tool "${input.tool_name}". ` +
					"Register the tool before invoking it via the governance layer.",
			);
		}

		const base = {
			schema_version: "0.6.0" as const,
			attempt_id: generateAttemptId(),
			tenant_id: input.tenant_id,
			agent_id: input.agent_id,
			agent_did: input.agent_did,
			connector_id: binding.connector_id,
			connector_mode: binding.default_mode,
			action_timestamp: new Date().toISOString(),
		};
		const action = binding.default_action;
		const params = input.params;
		switch (binding.connector_type) {
			case "http":
			case "browser": {
				const credential = binding.default_mode === "proxy" ? binding.credential_ref : undefined;
				if (binding.default_mode === "proxy" && credential === undefined) {
					throw new Error("MALFORMED_ENVELOPE: credential_ref is required for proxy http/browser connectors");
				}
				const envelope = { ...base, ...(credential !== undefined ? { credential_ref: credential } : {}) };
				if (binding.connector_type === "http") {
					return {
						...envelope,
						connector_type: "http",
						action_id: this.narrowHttpAction(action),
						request: this.extractHttpRequest(params),
					};
				}
				if (action !== "connector::browser::navigate") break;
				return {
					...envelope,
					connector_type: "browser",
					action_id: action,
					request: { url: extractUrl(params.url) },
				};
			}
			case "db":
				if (action !== "connector::db::query" && action !== "connector::db::mutate") break;
				return { ...base, connector_type: "db", action_id: action, request: extractDbRequest(params) };
			case "file":
				switch (action) {
					case "connector::file::read":
						return {
							...base,
							connector_type: "file",
							action_id: action,
							request: extractFileReadRequest(params),
						};
					case "connector::file::write":
						return {
							...base,
							connector_type: "file",
							action_id: action,
							request: extractFileWriteRequest(params),
						};
					case "connector::file::delete":
						return {
							...base,
							connector_type: "file",
							action_id: action,
							request: {
								connection_ref: extractString(params.connection_ref, "connection_ref"),
								key: extractString(params.key, "key"),
							},
						};
				}
				break;
			case "llm":
				throw new Error("ConnectorEnvelopeBuilder: llm envelopes are minted by executeLlm, not tool calls");
		}
		throw new Error(
			`ConnectorEnvelopeBuilder: action ${action} is inconsistent with connector_type=${binding.connector_type}`,
		);
	}

	private narrowHttpAction(action: string): "connector::http::fetch" | "connector::http::submit" {
		if (action === "connector::http::fetch" || action === "connector::http::submit") {
			return action;
		}
		throw new Error(
			`ConnectorEnvelopeBuilder: action ${action} is not an HTTP action; ` +
				"tool binding is inconsistent with its connector_type.",
		);
	}

	private extractHttpRequest(params: Record<string, unknown>): HttpConnectorRequest {
		const url = extractUrl(params.url);
		const method = typeof params.method === "string" ? params.method : "GET";
		if (!url) {
			throw new Error("ConnectorEnvelopeBuilder: HTTP tool call must include params.url (string)");
		}

		const upperMethod = method.toUpperCase();
		if (
			upperMethod !== "GET" &&
			upperMethod !== "HEAD" &&
			upperMethod !== "POST" &&
			upperMethod !== "PUT" &&
			upperMethod !== "PATCH" &&
			upperMethod !== "DELETE"
		) {
			throw new Error(`ConnectorEnvelopeBuilder: unsupported HTTP method ${method}`);
		}

		const headers = extractStringRecord(params.headers, "params.headers");
		const queryParams = extractStringRecord(params.query_params, "params.query_params");
		const body = extractBody(params.body);

		const request: HttpConnectorRequest = {
			url,
			method: upperMethod,
			...(headers !== undefined ? { headers } : {}),
			...(body !== undefined ? { body } : {}),
			...(queryParams !== undefined ? { query_params: queryParams } : {}),
		};
		return request;
	}
}

function extractString(value: unknown, field: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new Error(
			`ConnectorEnvelopeBuilder: params.${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
		);
	}
	return value;
}

function extractUrl(value: unknown): string {
	const url = extractString(value, "url");
	try {
		new URL(url);
	} catch {
		throw new Error("ConnectorEnvelopeBuilder: params.url must be a valid URL");
	}
	return url;
}

function extractObject(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`ConnectorEnvelopeBuilder: params.${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function extractResultFormat(value: unknown): "inline" | "opaque_handle" | "auto" {
	if (value === undefined) return "auto";
	if (value !== "inline" && value !== "opaque_handle" && value !== "auto") {
		throw new Error("ConnectorEnvelopeBuilder: params.result_format must be inline, opaque_handle, or auto");
	}
	return value;
}

function extractInteger(value: unknown, field: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
		throw new Error(`ConnectorEnvelopeBuilder: params.${field} must be an integer >= ${minimum}`);
	}
	return value;
}

function extractDbRequest(params: Record<string, unknown>): DbConnectorRequest {
	const connectionRef = extractString(params.connection_ref, "connection_ref");
	const sqlText = extractString(params.sql_text, "sql_text");
	if (params.parameters !== undefined && !Array.isArray(params.parameters)) {
		throw new Error("ConnectorEnvelopeBuilder: params.parameters must be an array");
	}
	if (params.read_replica_ok !== undefined && typeof params.read_replica_ok !== "boolean") {
		throw new Error("ConnectorEnvelopeBuilder: params.read_replica_ok must be a boolean");
	}
	return {
		connection_ref: connectionRef,
		sql_text: sqlText,
		...(params.parameters !== undefined ? { parameters: params.parameters } : {}),
		...(params.row_limit !== undefined ? { row_limit: extractInteger(params.row_limit, "row_limit", 1) } : {}),
		result_format: extractResultFormat(params.result_format),
		read_replica_ok: params.read_replica_ok ?? false,
	};
}

function extractFileReadRequest(params: Record<string, unknown>): FileReadConnectorRequest {
	const connectionRef = extractString(params.connection_ref, "connection_ref");
	const operation = params.operation;
	if (operation !== "get" && operation !== "head" && operation !== "list") {
		throw new Error("ConnectorEnvelopeBuilder: params.operation must be get, head, or list");
	}
	const key = extractString(params.key === undefined ? "" : params.key, "key", operation === "list");
	let range: FileReadConnectorRequest["range"];
	if (params.range !== undefined) {
		const inputRange = extractObject(params.range, "range");
		const startByte = extractInteger(inputRange.start_byte, "range.start_byte", 0);
		const endByte = extractInteger(inputRange.end_byte, "range.end_byte", 0);
		if (startByte > endByte) {
			throw new Error("ConnectorEnvelopeBuilder: params.range.start_byte must not exceed range.end_byte");
		}
		range = { start_byte: startByte, end_byte: endByte };
	}
	return {
		connection_ref: connectionRef,
		key,
		operation,
		...(range !== undefined ? { range } : {}),
		result_format: extractResultFormat(params.result_format),
	};
}

function extractFileWriteRequest(params: Record<string, unknown>): FileWriteConnectorRequest {
	const connectionRef = extractString(params.connection_ref, "connection_ref");
	const destination = extractObject(params.destination, "destination");
	const key = extractString(destination.key, "destination.key");
	const contentType = extractString(destination.content_type, "destination.content_type");
	const storageClass =
		destination.storage_class === undefined
			? undefined
			: extractString(destination.storage_class, "destination.storage_class", true);
	const metadata = extractStringRecord(destination.metadata, "params.destination.metadata");
	if ((params.from_handle !== undefined) === (params.inline_content !== undefined)) {
		throw new Error("ConnectorEnvelopeBuilder: Exactly one of from_handle or inline_content must be provided (XOR)");
	}
	const fromHandle = params.from_handle === undefined ? undefined : extractString(params.from_handle, "from_handle");
	if (
		fromHandle !== undefined &&
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fromHandle)
	) {
		throw new Error("ConnectorEnvelopeBuilder: params.from_handle must be a UUID");
	}
	const inlineContent =
		params.inline_content === undefined ? undefined : extractString(params.inline_content, "inline_content", true);
	return {
		connection_ref: connectionRef,
		destination: {
			key,
			content_type: contentType,
			...(storageClass !== undefined ? { storage_class: storageClass } : {}),
			...(metadata !== undefined ? { metadata } : {}),
		},
		...(fromHandle !== undefined ? { from_handle: fromHandle } : {}),
		...(inlineContent !== undefined ? { inline_content: inlineContent } : {}),
	};
}

/**
 * Validate that a value intended for HttpConnectorRequest.body matches the
 * type contract (string). Returns undefined when the caller did not provide
 * a body, throws when the caller provided something of the wrong shape —
 * silently dropping payload data would let the envelope misrepresent the
 * agent's actual request, which the governance layer must not do.
 */
function extractBody(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(
			"ConnectorEnvelopeBuilder: params.body must be a string when present " +
				"(serialize structured bodies before passing them to the tool call)",
		);
	}
	return value;
}

/**
 * Validate that a value intended for HttpConnectorRequest.headers or
 * .query_params is a plain object with string values, matching the
 * `Readonly<Record<string, string>>` type contract. Throws when the shape
 * is wrong rather than silently dropping — same reasoning as extractBody.
 */
function extractStringRecord(value: unknown, fieldName: string): Record<string, string> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`ConnectorEnvelopeBuilder: ${fieldName} must be an object with string values when present`);
	}
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			throw new Error(`ConnectorEnvelopeBuilder: ${fieldName}.${key} must be a string; got ${typeof entry}`);
		}
		out[key] = entry;
	}
	return out;
}

/**
 * Generate a v4-style attempt ID. Three-tier entropy strategy:
 *
 *   1. `crypto.randomUUID()` — cryptographically secure, native v4 format.
 *      Available in Node 19+ on `globalThis.crypto`, all modern browsers,
 *      Deno, Bun, workers.
 *   2. `crypto.getRandomValues()` — cryptographically secure CSPRNG,
 *      manually formatted into RFC 4122 v4 layout. Available in Node 15+,
 *      all browsers (Web Crypto has shipped for over a decade), and every
 *      other modern runtime. This is the *normal* fallback — in practice
 *      `randomUUID` and `getRandomValues` are always paired.
 *   3. `Math.random()` — NOT cryptographically secure. Last-resort fallback
 *      so the package keeps working in exotic stripped-down environments
 *      (e.g. some browser-smoke-check shims). attempt_id is the correlation
 *      key for ADR audit entries, Cedar eval context, and request/response
 *      identity cross-checks, so a predictable PRNG opens predictability
 *      and ADR-spoofing risk. Any environment that lands on this branch
 *      must be treated as degraded.
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
		// Cryptographically weak last-resort fallback — see docstring.
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
