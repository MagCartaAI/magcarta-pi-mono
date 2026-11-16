import { expect, it, vi } from "vitest";
import type { ConnectorEnvelope, HttpConnectorEnvelope } from "../../src/connector/types.js";
import {
	ClassificationBlocked,
	ConnectorRejected,
	type FetchLike,
	GatewayProvider,
	GatewayProviderError,
	GatewayUnavailable,
	GovernanceDenied,
	ModeMismatch,
	SubjectBindingViolation,
} from "../../src/providers/gateway-provider.js";

const baseEnvelope = {
	schema_version: "0.6.0",
	attempt_id: "11111111-1111-4111-8111-111111111111",
	tenant_id: "tenant",
	agent_id: "agent",
	agent_did: "did:web:test:agents:agent",
	connector_id: "connector.test",
	connector_mode: "proxy",
	action_timestamp: "2026-01-01T00:00:00Z",
} as const;

const executorCases = [
	{
		method: "executeHttp",
		route: "http/execute",
		connector_type: "http",
		action_id: "connector::http::fetch",
		request: { url: "https://example.test", method: "GET" },
	},
	{
		method: "executeDb",
		route: "db/execute",
		connector_type: "db",
		action_id: "connector::db::query",
		request: { connection_ref: "db", sql_text: "select 1" },
	},
	{
		method: "executeFileRead",
		route: "file/read",
		connector_type: "file",
		action_id: "connector::file::read",
		request: { connection_ref: "bucket", key: "key", operation: "get" },
	},
	{
		method: "executeFileWrite",
		route: "file/write",
		connector_type: "file",
		action_id: "connector::file::write",
		request: {
			connection_ref: "bucket",
			destination: { key: "key", content_type: "text/plain" },
			inline_content: "eA==",
		},
	},
	{
		method: "executeFileDelete",
		route: "file/delete",
		connector_type: "file",
		action_id: "connector::file::delete",
		request: { connection_ref: "bucket", key: "key" },
	},
	{
		method: "executeBrowser",
		route: "browser/navigate",
		connector_type: "browser",
		action_id: "connector::browser::navigate",
		request: { url: "https://example.test" },
	},
] as const;

it("posts pre-minted envelopes without context and preserves the connector error contract", async () => {
	for (const row of executorCases) {
		const envelope = Object.freeze({
			...baseEnvelope,
			connector_type: row.connector_type,
			action_id: row.action_id,
			request: Object.freeze(row.request),
			...(row.connector_type === "http" || row.connector_type === "browser"
				? { credential_ref: { backend_id: "env", path: "KEY" } }
				: {}),
		}) as ConnectorEnvelope;
		const serializedEnvelope = JSON.stringify(envelope);
		for (const outcome of [
			"success",
			"policy",
			"classification",
			"subject_binding",
			"mode_mismatch",
			"credential_missing",
			"server",
			"token",
			"transport",
			"malformed",
		] as const) {
			const result = { untouched: ["payload", { nested: true }] };
			const tokenProvider = vi.fn(() => {
				if (outcome === "token") throw new Error("token unavailable");
				return "gateway-token";
			});
			const fetchGateway = vi.fn<FetchLike>(async () => {
				if (outcome === "transport") throw new Error("connection refused");
				const status = outcome === "success" || outcome === "malformed" ? 200 : outcome === "server" ? 503 : 403;
				return {
					ok: status === 200,
					status,
					json: async () => {
						if (outcome === "malformed") throw new SyntaxError("not JSON");
						return outcome === "success"
							? result
							: { error: { code: "GATEWAY_CODE", message: "gateway reason", category: outcome } };
					},
				};
			});
			const provider = new GatewayProvider({
				gateway_url: "https://gateway.test/",
				token_provider: tokenProvider,
				fetch: fetchGateway,
			});
			const execution =
				row.method === "executeHttp"
					? provider.executeHttp(envelope as HttpConnectorEnvelope)
					: provider[row.method](envelope);
			const label = `${row.method}: ${outcome}`;
			if (outcome === "success" && row.method !== "executeBrowser") {
				await expect(execution, label).resolves.toBe(result);
			} else {
				const error = await execution.catch((failure: unknown) => failure);
				const errorClass =
					outcome === "policy"
						? GovernanceDenied
						: outcome === "classification"
							? ClassificationBlocked
							: outcome === "subject_binding"
								? SubjectBindingViolation
								: outcome === "mode_mismatch"
									? ModeMismatch
									: outcome === "credential_missing"
										? ConnectorRejected
										: outcome === "token" || outcome === "transport"
											? GatewayProviderError
											: GatewayUnavailable;
				expect(error, label).toBeInstanceOf(errorClass);
				if (outcome === "policy")
					expect(error, label).toMatchObject({ action: row.action_id, diagnostics: { code: "GATEWAY_CODE" } });
				if (outcome === "token" || outcome === "transport")
					expect(error, label).toMatchObject({
						code: outcome === "token" ? "TOKEN_PROVIDER_FAILED" : "TRANSPORT_ERROR",
					});
				if (["classification", "subject_binding", "mode_mismatch", "credential_missing"].includes(outcome))
					expect(error, label).toMatchObject({ code: "GATEWAY_CODE" });
				if (outcome === "malformed") {
					expect((error as Error).message, label).toContain(row.action_id);
					expect((error as Error).message, label).toContain(`/api/connector/${row.route}`);
				}
			}
			expect(tokenProvider, label).toHaveBeenCalledTimes(1);
			if (outcome === "token") expect(fetchGateway, label).not.toHaveBeenCalled();
			else
				expect(fetchGateway, label).toHaveBeenCalledExactlyOnceWith(
					`https://gateway.test/api/connector/${row.route}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json", Authorization: "Bearer gateway-token" },
						body: serializedEnvelope,
					},
				);
			expect(JSON.stringify(envelope), label).toBe(serializedEnvelope);
		}
	}
});
