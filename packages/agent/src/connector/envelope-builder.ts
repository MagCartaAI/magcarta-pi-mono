/**
 * ConnectorEnvelopeBuilder — constructs ConnectorEnvelope instances from
 * agent tool calls (WE2-007).
 *
 * Phase 1 thin slice handles HTTP only. Phase 2 (WE2-009) broadens to
 * DB/File/LLM/Browser; the build() method signature stays stable because
 * the discriminated union narrows on connector_type downstream.
 */

import type { ToolRegistry } from "./tool-registry.js";
import type { ConnectorEnvelope, HttpConnectorRequest } from "./types.js";

export interface BuildEnvelopeInput {
	readonly tool_name: string;
	readonly params: Record<string, unknown>;
	readonly tenant_id: string;
	readonly agent_id: string;
	readonly agent_did: string;
	readonly session_id?: string;
}

export class ConnectorEnvelopeBuilder {
	constructor(private readonly registry: ToolRegistry) {}

	/**
	 * Build a ConnectorEnvelope for a given tool invocation. In Phase 1, only
	 * HTTP connector tools are supported — looking up a non-HTTP tool throws.
	 * Phase 2 adds DB/File/LLM/Browser paths.
	 */
	build(input: BuildEnvelopeInput): ConnectorEnvelope {
		const binding = this.registry.lookup(input.tool_name);
		if (!binding) {
			throw new Error(
				`ConnectorEnvelopeBuilder: no ToolRegistry binding for tool "${input.tool_name}". ` +
					"Register the tool before invoking it via the governance layer.",
			);
		}

		if (binding.connector_type !== "http") {
			throw new Error(
				`ConnectorEnvelopeBuilder: Phase 1 supports only HTTP connectors; tool ` +
					`"${input.tool_name}" is bound to connector_type=${binding.connector_type}. ` +
					"Wait for Phase 2 (WE2-009) to broaden the envelope builder.",
			);
		}

		const request = this.extractHttpRequest(input.params);
		const attemptId = generateAttemptId();
		const now = new Date().toISOString();

		return {
			schema_version: "0.6.0",
			attempt_id: attemptId,
			tenant_id: input.tenant_id,
			agent_id: input.agent_id,
			agent_did: input.agent_did,
			connector_id: binding.connector_id,
			connector_type: "http",
			connector_mode: binding.default_mode,
			action_id: this.narrowHttpAction(binding.default_action),
			action_timestamp: now,
			request,
		};
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
		const url = typeof params.url === "string" ? params.url : undefined;
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

		const request: HttpConnectorRequest = {
			url,
			method: upperMethod,
		};
		return request;
	}
}

/**
 * Generate a v4-style attempt ID. Uses crypto.randomUUID where available
 * (Node 22+, all modern runtimes) and falls back to a manual RFC 4122
 * format otherwise so the package stays environment-agnostic for
 * browser-smoke-check targets.
 */
function generateAttemptId(): string {
	const maybeCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (maybeCrypto?.randomUUID) {
		return maybeCrypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		bytes[i] = Math.floor(Math.random() * 256);
	}
	const b6 = bytes[6] ?? 0;
	const b8 = bytes[8] ?? 0;
	bytes[6] = (b6 & 0x0f) | 0x40;
	bytes[8] = (b8 & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` + `${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
