import { expect, it } from "vitest";
import { ConnectorEnvelopeBuilder } from "../../src/connector/envelope-builder.js";
import { type ConnectorToolBinding, ToolRegistry } from "../../src/connector/tool-registry.js";

const identity = { tenant_id: "tenant", agent_id: "agent", agent_did: "did:web:test:agents:agent" };
const credential = { backend_id: "env", path: "UPSTREAM_KEY" } as const;
const handle = "550e8400-e29b-41d4-a716-446655440000";
const destination = { key: "report.csv", content_type: "text/csv" };

function build(binding: Partial<ConnectorToolBinding>, params: Record<string, unknown>) {
	const registry = new ToolRegistry();
	registry.register({
		name: "tool",
		connector_id: "connector",
		connector_type: "db",
		default_action: "connector::db::query",
		default_mode: "proxy",
		...binding,
	});
	return new ConnectorEnvelopeBuilder(registry).build({ tool_name: "tool", params, ...identity });
}

it("mints each connector request without losing payload, identity, defaults, or credentials", () => {
	const rows: Array<{
		binding: Partial<ConnectorToolBinding>;
		params: Record<string, unknown>;
		request: Record<string, unknown>;
	}> = [
		{
			binding: {},
			params: { connection_ref: "db", sql_text: "select 1" },
			request: { connection_ref: "db", sql_text: "select 1", result_format: "auto", read_replica_ok: false },
		},
		{
			binding: { default_action: "connector::db::mutate" },
			params: {
				connection_ref: "db",
				sql_text: "update t set x=$1",
				parameters: [1, null],
				row_limit: 2,
				result_format: "inline",
				read_replica_ok: true,
			},
			request: {
				connection_ref: "db",
				sql_text: "update t set x=$1",
				parameters: [1, null],
				row_limit: 2,
				result_format: "inline",
				read_replica_ok: true,
			},
		},
		{
			binding: { connector_type: "file", default_action: "connector::file::read" },
			params: { connection_ref: "files", operation: "list" },
			request: { connection_ref: "files", operation: "list", key: "", result_format: "auto" },
		},
		{
			binding: { connector_type: "file", default_action: "connector::file::read" },
			params: {
				connection_ref: "files",
				operation: "get",
				key: "report",
				range: { start_byte: 0, end_byte: 2 },
				result_format: "opaque_handle",
			},
			request: {
				connection_ref: "files",
				operation: "get",
				key: "report",
				range: { start_byte: 0, end_byte: 2 },
				result_format: "opaque_handle",
			},
		},
		{
			binding: { connector_type: "file", default_action: "connector::file::read" },
			params: { connection_ref: "files", operation: "head", key: "report" },
			request: { connection_ref: "files", operation: "head", key: "report", result_format: "auto" },
		},
		{
			binding: { connector_type: "file", default_action: "connector::file::write" },
			params: { connection_ref: "files", destination, inline_content: "YQ==" },
			request: { connection_ref: "files", destination, inline_content: "YQ==" },
		},
		{
			binding: { connector_type: "file", default_action: "connector::file::write" },
			params: {
				connection_ref: "files",
				destination: { ...destination, storage_class: "STANDARD", metadata: { source: "db" } },
				from_handle: handle,
			},
			request: {
				connection_ref: "files",
				destination: { ...destination, storage_class: "STANDARD", metadata: { source: "db" } },
				from_handle: handle,
			},
		},
		{
			binding: { connector_type: "file", default_action: "connector::file::delete" },
			params: { connection_ref: "files", key: "report" },
			request: { connection_ref: "files", key: "report" },
		},
		{
			binding: {
				connector_type: "browser",
				default_action: "connector::browser::navigate",
				credential_ref: credential,
			},
			params: { url: "https://example.com" },
			request: { url: "https://example.com" },
		},
		{
			binding: { connector_type: "http", default_action: "connector::http::fetch", credential_ref: credential },
			params: { url: "https://example.com" },
			request: { url: "https://example.com", method: "GET" },
		},
	];
	const attempts = new Set<string>();
	for (const row of rows) {
		const envelope = build(row.binding, row.params);
		expect(envelope.request).toEqual(row.request);
		expect(envelope).toMatchObject({
			...identity,
			schema_version: "0.6.0",
			connector_id: "connector",
			connector_type: row.binding.connector_type ?? "db",
			action_id: row.binding.default_action ?? "connector::db::query",
			connector_mode: "proxy",
		});
		expect(envelope.attempt_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
		expect(Number.isNaN(Date.parse(envelope.action_timestamp))).toBe(false);
		expect(attempts.has(envelope.attempt_id)).toBe(false);
		attempts.add(envelope.attempt_id);
		expect(envelope.credential_ref).toEqual(row.binding.credential_ref);
		if (envelope.connector_type === "db" || envelope.connector_type === "file") {
			expect(build({ ...row.binding, credential_ref: credential }, row.params).credential_ref).toBeUndefined();
		}
	}
	const listing = { connector_type: "file", default_action: "connector::file::read" } as const;
	expect(build(listing, { connection_ref: "files", operation: "list", key: "" }).request).toMatchObject({ key: "" });
});

it("rejects malformed requests and inconsistent bindings before producing an envelope", () => {
	const db = { connection_ref: "db", sql_text: "select 1" };
	const read = { connection_ref: "files", operation: "get", key: "report" };
	const write = { connection_ref: "files", destination, inline_content: "YQ==" };
	const fileRead = { connector_type: "file", default_action: "connector::file::read" } as const;
	const fileWrite = { connector_type: "file", default_action: "connector::file::write" } as const;
	const rows: Array<[Partial<ConnectorToolBinding>, Record<string, unknown>, RegExp]> = [
		[{}, { ...db, connection_ref: undefined }, /connection_ref/],
		[{}, { ...db, connection_ref: "" }, /connection_ref/],
		[{}, { ...db, connection_ref: 4 }, /connection_ref/],
		[{}, { ...db, sql_text: 4 }, /sql_text/],
		[{}, { ...db, parameters: {} }, /parameters/],
		[{}, { ...db, row_limit: 0 }, /row_limit/],
		[{}, { ...db, row_limit: 1.5 }, /row_limit/],
		[{}, { ...db, result_format: null }, /result_format/],
		[{}, { ...db, read_replica_ok: "false" }, /read_replica_ok/],
		[fileRead, { ...read, operation: "delete" }, /operation/],
		[fileRead, { ...read, key: "" }, /key/],
		[fileRead, { ...read, operation: "head", key: undefined }, /key/],
		[fileRead, { ...read, operation: "list", key: 3 }, /key/],
		[fileRead, { ...read, range: { start_byte: -1, end_byte: 2 } }, /range/],
		[fileRead, { ...read, range: { start_byte: 3, end_byte: 2 } }, /range/],
		[fileRead, { ...read, range: { start_byte: 0, end_byte: 1.5 } }, /range/],
		[fileRead, { ...read, range: null }, /range/],
		[fileWrite, { ...write, from_handle: handle }, /Exactly one|XOR/],
		[fileWrite, { connection_ref: "files", destination }, /Exactly one|XOR/],
		[fileWrite, { connection_ref: "files", destination, from_handle: "bad" }, /from_handle/],
		[fileWrite, { ...write, inline_content: 7 }, /inline_content/],
		[fileWrite, { ...write, destination: { ...destination, content_type: "" } }, /content_type/],
		[fileWrite, { ...write, destination: { ...destination, metadata: { source: 1 } } }, /metadata/],
		[fileWrite, { ...write, destination: { ...destination, storage_class: 1 } }, /storage_class/],
		[
			{ connector_type: "file", default_action: "connector::file::delete" },
			{ connection_ref: "files", key: "" },
			/key/,
		],
		[
			{ connector_type: "browser", default_action: "connector::browser::navigate", credential_ref: credential },
			{ url: "invalid" },
			/url/,
		],
		[
			{ connector_type: "browser", default_action: "connector::browser::navigate" },
			{ url: "https://example.com" },
			/MALFORMED_ENVELOPE.*credential_ref/,
		],
		[
			{ connector_type: "http", default_action: "connector::http::fetch" },
			{ url: "https://example.com" },
			/MALFORMED_ENVELOPE.*credential_ref/,
		],
		[
			{ connector_type: "http", default_action: "connector::http::fetch", default_mode: "approval" },
			{ url: "invalid" },
			/url/,
		],
		[{ default_action: "connector::http::fetch" }, db, /action/],
		[{ ...fileRead, default_action: "connector::db::query" }, read, /action/],
		[
			{ connector_type: "browser", default_action: "connector::db::query", credential_ref: credential },
			{ url: "https://example.com" },
			/action/,
		],
		[{ connector_type: "llm", default_action: "connector::llm::invoke" }, {}, /llm|LLM/],
	];
	for (const [binding, params, error] of rows) {
		expect(() => build(binding, params), JSON.stringify({ binding, params })).toThrow(error);
	}
});
