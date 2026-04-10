import { describe, expect, it } from "vitest";
import { ConnectorEnvelopeBuilder } from "../../src/connector/envelope-builder.js";
import { ToolRegistry } from "../../src/connector/tool-registry.js";

function setupRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	registry.register({
		name: "search_web",
		connector_id: "http.exa",
		connector_type: "http",
		default_action: "connector::http::fetch",
		default_mode: "approval",
	});
	registry.register({
		name: "query_db",
		connector_id: "db.hr",
		connector_type: "db",
		default_action: "connector::db::query",
		default_mode: "proxy",
	});
	return registry;
}

describe("ConnectorEnvelopeBuilder — HTTP thin slice (WE2-007)", () => {
	it("happy: builds HTTP envelope from a registered tool call", () => {
		const registry = setupRegistry();
		const builder = new ConnectorEnvelopeBuilder(registry);

		const envelope = builder.build({
			tool_name: "search_web",
			params: { url: "https://api.example.com/search?q=test", method: "GET" },
			tenant_id: "acme",
			agent_id: "agent-123",
			agent_did: "did:web:test:agents:agent-123",
		});

		expect(envelope.connector_type).toBe("http");
		expect(envelope.action_id).toBe("connector::http::fetch");
		expect(envelope.connector_id).toBe("http.exa");
		expect(envelope.connector_mode).toBe("approval");
		expect(envelope.tenant_id).toBe("acme");
		expect(envelope.agent_id).toBe("agent-123");
		expect(envelope.agent_did).toBe("did:web:test:agents:agent-123");
		expect(envelope.schema_version).toBe("0.6.0");
		expect(envelope.attempt_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(envelope.request.url).toBe("https://api.example.com/search?q=test");
		expect(envelope.request.method).toBe("GET");
	});

	it("happy: lowercase HTTP methods are uppercased", () => {
		const registry = setupRegistry();
		const builder = new ConnectorEnvelopeBuilder(registry);
		const envelope = builder.build({
			tool_name: "search_web",
			params: { url: "https://api.example.com", method: "get" },
			tenant_id: "t",
			agent_id: "a",
			agent_did: "did:web:t:agents:a",
		});
		expect(envelope.request.method).toBe("GET");
	});

	it("unhappy: unregistered tool throws", () => {
		const builder = new ConnectorEnvelopeBuilder(setupRegistry());
		expect(() =>
			builder.build({
				tool_name: "unknown_tool",
				params: { url: "https://example.com" },
				tenant_id: "t",
				agent_id: "a",
				agent_did: "did:web:t:agents:a",
			}),
		).toThrow(/no ToolRegistry binding/);
	});

	it("unhappy: non-HTTP connector tool throws in Phase 1", () => {
		const builder = new ConnectorEnvelopeBuilder(setupRegistry());
		expect(() =>
			builder.build({
				tool_name: "query_db",
				params: { url: "https://example.com" },
				tenant_id: "t",
				agent_id: "a",
				agent_did: "did:web:t:agents:a",
			}),
		).toThrow(/Phase 1 supports only HTTP/);
	});

	it("unhappy: HTTP tool without params.url throws", () => {
		const builder = new ConnectorEnvelopeBuilder(setupRegistry());
		expect(() =>
			builder.build({
				tool_name: "search_web",
				params: { method: "GET" },
				tenant_id: "t",
				agent_id: "a",
				agent_did: "did:web:t:agents:a",
			}),
		).toThrow(/params\.url/);
	});

	it("unhappy: unsupported HTTP method throws", () => {
		const builder = new ConnectorEnvelopeBuilder(setupRegistry());
		expect(() =>
			builder.build({
				tool_name: "search_web",
				params: { url: "https://example.com", method: "CONNECT" },
				tenant_id: "t",
				agent_id: "a",
				agent_did: "did:web:t:agents:a",
			}),
		).toThrow(/unsupported HTTP method/);
	});

	it("corner: attempt_ids are unique across builds", () => {
		const builder = new ConnectorEnvelopeBuilder(setupRegistry());
		const make = () =>
			builder.build({
				tool_name: "search_web",
				params: { url: "https://example.com" },
				tenant_id: "t",
				agent_id: "a",
				agent_did: "did:web:t:agents:a",
			});
		const e1 = make();
		const e2 = make();
		expect(e1.attempt_id).not.toBe(e2.attempt_id);
	});
});

describe("ToolRegistry", () => {
	it("happy: register + lookup round-trip", () => {
		const registry = new ToolRegistry();
		registry.register({
			name: "alpha",
			connector_id: "http.alpha",
			connector_type: "http",
			default_action: "connector::http::fetch",
			default_mode: "approval",
		});
		expect(registry.has("alpha")).toBe(true);
		expect(registry.lookup("alpha")?.connector_id).toBe("http.alpha");
	});

	it("corner: lookup returns undefined for unknown tool", () => {
		const registry = new ToolRegistry();
		expect(registry.lookup("nope")).toBeUndefined();
	});

	it("happy: list returns all bindings", () => {
		const registry = setupRegistry();
		expect(registry.list()).toHaveLength(2);
	});
});
