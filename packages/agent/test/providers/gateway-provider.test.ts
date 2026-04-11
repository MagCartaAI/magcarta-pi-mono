import { describe, expect, it } from "vitest";
import type { ConnectorEnvelope } from "../../src/connector/types.js";
import { type FetchLike, GatewayProvider, GatewayProviderError } from "../../src/providers/gateway-provider.js";

function makeEnvelope(): ConnectorEnvelope {
	return {
		schema_version: "0.6.0",
		attempt_id: "11111111-1111-1111-1111-111111111111",
		tenant_id: "test-tenant",
		agent_id: "test-agent",
		agent_did: "did:web:test.local:agents:test-agent",
		connector_id: "http.demo",
		connector_type: "http",
		connector_mode: "approval",
		action_id: "connector::http::fetch",
		action_timestamp: "2026-04-13T10:00:00Z",
		request: {
			url: "https://api.example.com",
			method: "GET",
		},
	};
}

function makeValidDecisionBody() {
	return {
		schema_version: "0.6.0",
		attempt_id: "11111111-1111-1111-1111-111111111111",
		outcome: "ALLOW",
		action_id: "connector::http::fetch",
		connector_id: "http.demo",
		connector_mode: "approval",
		tenant_id: "test-tenant",
		agent_id: "test-agent",
		classification_chain: {
			contributions: [
				{
					layer: "manifest",
					classifications: [],
					evaluated_at: "2026-04-13T10:00:00Z",
					latency_ms: 0,
					status: "success",
				},
			],
			merged_classification: "public",
			merge_reason: "test",
		},
		policy_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		determining_policies: ["permit-connector-http-fetch"],
		evaluated_at: "2026-04-13T10:00:00Z",
		signer: "test-signer",
		signature: "ed25519:abc",
	};
}

function fetchOk(body: unknown): FetchLike {
	return async () => ({
		ok: true,
		status: 200,
		json: async () => body,
	});
}

function fetchErr(status: number, body: unknown): FetchLike {
	return async () => ({
		ok: false,
		status,
		json: async () => body,
	});
}

describe("GatewayProvider.authorize — happy path", () => {
	it("sends envelope + bearer token and returns decision on 200", async () => {
		let capturedUrl = "";
		let capturedInit: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
		const fetchImpl: FetchLike = async (url, init) => {
			capturedUrl = url;
			capturedInit = init;
			return { ok: true, status: 200, json: async () => makeValidDecisionBody() };
		};

		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080/",
			token_provider: () => "test-jwt",
			fetch: fetchImpl,
		});
		const decision = await provider.authorize(makeEnvelope());

		expect(decision.outcome).toBe("ALLOW");
		expect(capturedUrl).toBe("http://gateway.test:8080/api/connector/authorize");
		expect(capturedInit?.method).toBe("POST");
		expect(capturedInit?.headers?.Authorization).toBe("Bearer test-jwt");
		expect(capturedInit?.headers?.["Content-Type"]).toBe("application/json");
	});
});

describe("GatewayProvider.authorize — error mapping", () => {
	it("throws GatewayProviderError on non-OK response", async () => {
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test-jwt",
			fetch: fetchErr(403, { error: { code: "POLICY_DENY", message: "denied" } }),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toBeInstanceOf(GatewayProviderError);
	});

	it("throws GatewayProviderError when the token provider fails", async () => {
		const tokenErr = new Error("token fetch timed out");
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => {
				throw tokenErr;
			},
			fetch: fetchOk(makeValidDecisionBody()),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			name: "GatewayProviderError",
			code: "TOKEN_PROVIDER_FAILED",
			cause: tokenErr,
		});
	});

	it("throws GatewayProviderError when the fetch transport fails", async () => {
		const transportErr = new TypeError("network down");
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test-jwt",
			fetch: async () => {
				throw transportErr;
			},
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			name: "GatewayProviderError",
			code: "TRANSPORT_ERROR",
			cause: transportErr,
		});
	});

	it("throws GatewayProviderError when response.json() fails on a 2xx reply", async () => {
		const parseErr = new SyntaxError("unexpected token");
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test-jwt",
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => {
					throw parseErr;
				},
			}),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			name: "GatewayProviderError",
			code: "MALFORMED_RESPONSE_BODY",
			status: 200,
			cause: parseErr,
		});
	});

	it("throws GatewayProviderError when response.json() fails on a non-2xx reply", async () => {
		const parseErr = new SyntaxError("unexpected token");
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test-jwt",
			fetch: async () => ({
				ok: false,
				status: 502,
				json: async () => {
					throw parseErr;
				},
			}),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			name: "GatewayProviderError",
			code: "MALFORMED_RESPONSE_BODY",
			status: 502,
			cause: parseErr,
		});
	});
});

describe("GatewayProvider.authorize — contract validation (review F5)", () => {
	it("rejects response with wrong schema_version", async () => {
		const bad = { ...makeValidDecisionBody(), schema_version: "0.5.0" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("rejects response with non-UUID attempt_id", async () => {
		const bad = { ...makeValidDecisionBody(), attempt_id: "not-a-uuid" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("rejects response with unknown action_id", async () => {
		const bad = { ...makeValidDecisionBody(), action_id: "connector::http::nuke" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("rejects response with bad policy_hash format", async () => {
		const bad = { ...makeValidDecisionBody(), policy_hash: "md5:abc" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("rejects response with unknown merged_classification", async () => {
		const bad = makeValidDecisionBody();
		bad.classification_chain = {
			...bad.classification_chain,
			merged_classification: "super-secret" as "public",
		};
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("rejects ALLOW response that carries a reason field (cleanup invariant)", async () => {
		const bad = { ...makeValidDecisionBody(), reason: "should not be here" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("rejects DENY response without deny_category", async () => {
		const bad = { ...makeValidDecisionBody(), outcome: "DENY", reason: "denied" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("accepts valid DENY response with reason + deny_category", async () => {
		const good = {
			...makeValidDecisionBody(),
			outcome: "DENY",
			reason: "Cedar policy denied",
			deny_category: "policy",
		};
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(good),
		});
		const decision = await provider.authorize(makeEnvelope());
		expect(decision.outcome).toBe("DENY");
		expect(decision.reason).toBe("Cedar policy denied");
		expect(decision.deny_category).toBe("policy");
	});

	// --- Review finding F2 (follow-up): datetime validation ---

	it("rejects response with non-datetime evaluated_at (review F2 follow-up)", async () => {
		const bad = { ...makeValidDecisionBody(), evaluated_at: "yesterday" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("rejects response with datetime missing timezone designator", async () => {
		const bad = { ...makeValidDecisionBody(), evaluated_at: "2026-04-13T10:00:00" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("rejects response with non-datetime contribution evaluated_at", async () => {
		const bad = makeValidDecisionBody();
		bad.classification_chain.contributions[0]!.evaluated_at = "last week";
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(/not a valid AuthorizationDecision/);
	});

	it("accepts datetime with offset timezone", async () => {
		const good = {
			...makeValidDecisionBody(),
			evaluated_at: "2026-04-13T10:00:00.123456-05:30",
		};
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(good),
		});
		const decision = await provider.authorize(makeEnvelope());
		expect(decision.evaluated_at).toBe("2026-04-13T10:00:00.123456-05:30");
	});
});

describe("GatewayProvider.authorize — request/response correlation check", () => {
	it("rejects decision whose attempt_id does not match the envelope", async () => {
		const bad = {
			...makeValidDecisionBody(),
			attempt_id: "22222222-2222-2222-2222-222222222222",
		};
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			code: "MISMATCHED_DECISION",
			message: expect.stringMatching(/attempt_id/),
		});
	});

	it("rejects decision whose connector_id does not match the envelope", async () => {
		const bad = { ...makeValidDecisionBody(), connector_id: "http.other" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			code: "MISMATCHED_DECISION",
			message: expect.stringMatching(/connector_id/),
		});
	});

	it("rejects decision whose tenant_id does not match the envelope", async () => {
		const bad = { ...makeValidDecisionBody(), tenant_id: "other-tenant" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			code: "MISMATCHED_DECISION",
			message: expect.stringMatching(/tenant_id/),
		});
	});

	it("rejects decision whose agent_id does not match the envelope", async () => {
		const bad = { ...makeValidDecisionBody(), agent_id: "other-agent" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			code: "MISMATCHED_DECISION",
			message: expect.stringMatching(/agent_id/),
		});
	});

	it("rejects decision whose connector_mode does not match the envelope", async () => {
		const bad = { ...makeValidDecisionBody(), connector_mode: "proxy" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			code: "MISMATCHED_DECISION",
			message: expect.stringMatching(/connector_mode/),
		});
	});

	it("rejects decision whose action_id does not match the envelope", async () => {
		const bad = { ...makeValidDecisionBody(), action_id: "connector::http::submit" };
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toMatchObject({
			code: "MISMATCHED_DECISION",
			message: expect.stringMatching(/action_id/),
		});
	});

	it("includes expected and actual values in mismatch error message", async () => {
		const bad = {
			...makeValidDecisionBody(),
			attempt_id: "22222222-2222-2222-2222-222222222222",
		};
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		await expect(provider.authorize(makeEnvelope())).rejects.toThrow(
			/expected "11111111-1111-1111-1111-111111111111", got "22222222-2222-2222-2222-222222222222"/,
		);
	});

	it("reports all mismatched fields in a single error when multiple diverge", async () => {
		const bad = {
			...makeValidDecisionBody(),
			attempt_id: "22222222-2222-2222-2222-222222222222",
			connector_id: "http.other",
			tenant_id: "other-tenant",
		};
		const provider = new GatewayProvider({
			gateway_url: "http://gateway.test:8080",
			token_provider: () => "test",
			fetch: fetchOk(bad),
		});
		const error = await provider.authorize(makeEnvelope()).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GatewayProviderError);
		const message = (error as GatewayProviderError).message;
		expect(message).toMatch(/attempt_id/);
		expect(message).toMatch(/connector_id/);
		expect(message).toMatch(/tenant_id/);
	});
});
