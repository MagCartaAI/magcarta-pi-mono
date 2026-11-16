import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import { type ConnectorToolBinding, ToolRegistry } from "../src/connector/tool-registry.js";
import type { ConnectorEnvelope } from "../src/connector/types.js";
import { GatewayProvider } from "../src/providers/gateway-provider.js";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../src/types.js";

// Failures: local execution bypasses proxy governance; malformed payloads become success;
// result wrapping loses handles/bytes; extraction changes events or steering after abort.
const identity = { tenant_id: "tenant", agent_id: "agent", agent_did: "did:web:agent" };
const attemptId = "00000000-0000-4000-8000-000000000001";
const chain = { contributions: [], merged_classification: "public", merge_reason: "No sensitive data" };
const baseResult = { attempt_id: attemptId, classification_chain: chain, latency_ms: 1 };
const handle = {
	handle_id: attemptId,
	tenant_id: "tenant",
	issued_at: "2026-01-01T00:00:00Z",
	expires_at: "2026-01-02T00:00:00Z",
	size_bytes: 8,
	content_type: "application/json",
	classification_chain: chain,
	source_action_id: "connector::db::query",
	source_connector_id: "db.source",
	source_attempt_id: attemptId,
};
const model: Model<"openai-completions"> = {
	id: "test",
	name: "test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://unused.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};
const dbResult = { ...baseResult, result_format: "inline", rows: [{ answer: 42 }], row_count: 1 };
const writeResult = { ...baseResult, bucket: "bucket", key: "key", bytes_written: 8, handle_redeemed: attemptId };
interface Case {
	name: string;
	type: ConnectorToolBinding["connector_type"];
	action: ConnectorToolBinding["default_action"];
	params: Record<string, unknown>;
	result: unknown;
	error?: string;
	mode?: "approval" | "unregistered";
	missing?: "connectorProvider" | "connectorContext";
	deny?: boolean;
	abort?: "continue" | "steer";
}
const cases: Case[] = [
	{
		name: "db inline",
		type: "db",
		action: "connector::db::query",
		params: { connection_ref: "db", sql_text: "SELECT 42" },
		result: dbResult,
	},
	{
		name: "db mutate handle",
		type: "db",
		action: "connector::db::mutate",
		params: { connection_ref: "db", sql_text: "UPDATE rows SET x=1" },
		result: { ...baseResult, result_format: "opaque_handle", handle, row_count: 1 },
	},
	{
		name: "http upstream 404",
		type: "http",
		action: "connector::http::fetch",
		params: { url: "https://upstream.test" },
		result: { ...baseResult, status_code: 404, headers: {}, body: "missing" },
	},
	{
		name: "http submit",
		type: "http",
		action: "connector::http::submit",
		params: { url: "https://upstream.test", method: "POST" },
		result: { ...baseResult, status_code: 201, headers: { location: "/new" }, body: "ok" },
	},
	...[
		{ result_format: "inline", content: "AAEC/w==", content_type: "application/octet-stream", size_bytes: 4 },
		{ result_format: "opaque_handle", handle, content_type: "application/json" },
		{
			result_format: "listing",
			entries: [{ key: "key", size_bytes: 8, last_modified: "2026-01-01T00:00:00Z" }],
			next_continuation_token: "next",
		},
		{ result_format: "metadata", content_type: "text/plain", size_bytes: 8, last_modified: "2026-01-01T00:00:00Z" },
	].map(
		(result): Case => ({
			name: `file read ${result.result_format}`,
			type: "file",
			action: "connector::file::read",
			params: {
				connection_ref: "files",
				key: "key",
				operation:
					result.result_format === "listing" ? "list" : result.result_format === "metadata" ? "head" : "get",
			},
			result: { ...baseResult, ...result },
		}),
	),
	{
		name: "file write",
		type: "file",
		action: "connector::file::write",
		params: {
			connection_ref: "files",
			destination: { key: "key", content_type: "text/plain" },
			from_handle: attemptId,
		},
		result: writeResult,
	},
	{
		name: "file delete missing",
		type: "file",
		action: "connector::file::delete",
		params: { connection_ref: "files", key: "missing" },
		result: { ...baseResult, bucket: "bucket", key: "missing", deleted: false },
	},
	{
		name: "browser deny",
		type: "browser",
		action: "connector::browser::navigate",
		params: { url: "https://upstream.test" },
		result: {},
		deny: true,
		error: "GovernanceDenied",
	},
];
for (const mode of ["approval", "unregistered"] as const) cases.push({ ...cases[0], name: mode, mode });
for (const missing of ["connectorProvider", "connectorContext"] as const)
	cases.push({ ...cases[0], name: missing, missing, error: missing });
cases.push({ ...cases[0], name: "policy denied", deny: true, error: "GovernanceDenied" });
cases.push({ ...cases[0], name: "missing build field", params: { sql_text: "SELECT 42" }, error: "connection_ref" });
cases.push({ ...cases[6], name: "wrong file action result", result: writeResult, error: "connector::file::read" });
for (const result of [
	null,
	[],
	{},
	{ ...dbResult, row_count: -1 },
	{ ...dbResult, rows: [null] },
	{ ...dbResult, extra: true },
	{ ...dbResult, attempt_id: "not-uuid" },
	{ ...dbResult, latency_ms: -1 },
	{
		...dbResult,
		classification_chain: {
			...chain,
			contributions: [
				{ layer: "scanner", classifications: ["public"], status: "success", evaluated_at: "bad", latency_ms: 1 },
			],
		},
	},
	{
		...baseResult,
		result_format: "opaque_handle",
		row_count: 1,
		handle: { ...handle, expires_at: "2026-02-30T00:00:00Z" },
	},
	{ ...baseResult, result_format: "opaque_handle", row_count: 1, handle: { ...handle, size_bytes: 0 } },
	{ ...baseResult, result_format: "opaque_handle", row_count: 1, handle: { ...handle, extra: true } },
])
	cases.push({ ...cases[0], name: `malformed ${cases.length}`, result, error: "connector::db::query" });
for (const abort of ["continue", "steer"] as const) cases.push({ ...cases[0], name: `abort ${abort}`, abort });
// Security: a mismatched attempt_id or foreign handle identity must isError.
cases.push({
	...cases[0],
	name: "mismatched attempt_id",
	result: { ...dbResult, attempt_id: "00000000-0000-4000-8000-0000000000ff" },
	error: "attempt_id",
});
cases.push({
	...cases[1],
	name: "foreign handle",
	result: {
		...baseResult,
		result_format: "opaque_handle",
		row_count: 1,
		handle: { ...handle, tenant_id: "other-tenant" },
	},
	error: "opaque handle identity",
});
// Security: sensitive http headers must be stripped from content + details.
cases.push({
	...cases[3],
	name: "sensitive headers stripped",
	result: {
		...baseResult,
		status_code: 200,
		headers: { "content-type": "text/plain", "Set-Cookie": "session=secret", "X-Api-Key": "key", location: "/x" },
		body: "ok",
	},
});

it("routes tool calls by their registry mode and preserves result contracts and lifecycle", async () => {
	const gates: string[] = [];
	let outcome = "FAIL";
	await mkdir("tests/e2e/artifacts", { recursive: true });
	try {
		for (const row of cases) {
			const registry = new ToolRegistry();
			if (row.mode !== "unregistered")
				registry.register({
					name: "tool",
					connector_id: "tool.connector",
					connector_type: row.type,
					default_action: row.action,
					default_mode: row.mode === "approval" ? "approval" : "proxy",
					credential_ref: { backend_id: "env", path: "TOOL_KEY" },
				});
			const controller = new AbortController();
			const requests: { url: string; envelope: ConnectorEnvelope }[] = [];
			const boundResults: unknown[] = [];
			const fetchGateway = vi.fn(
				async (url: string, init?: { body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
					expect(init?.headers?.Authorization).toBe("Bearer gateway-token");
					expect(init?.signal).toBeUndefined();
					const dispatched = JSON.parse(init!.body!) as ConnectorEnvelope;
					requests.push({ url, envelope: dispatched });
					if (row.abort) controller.abort();
					// A real gateway echoes the dispatched envelope's attempt_id back.
					// Rebind the fixture result so attempt_id / handle identity match.
					const bind = (value: unknown): unknown => {
						if (!value || typeof value !== "object" || Array.isArray(value)) return value;
						const bound = { ...(value as Record<string, unknown>) };
						// Only rebind the legit fixture id; leave malformed values (non-uuid,
						// foreign handle fields) so the malformed rows still reject.
						if (bound.attempt_id === attemptId) bound.attempt_id = dispatched.attempt_id;
						if (bound.handle && typeof bound.handle === "object") {
							const h = bound.handle as Record<string, unknown>;
							if (h.source_attempt_id === attemptId && h.tenant_id === "tenant") {
								bound.handle = {
									...h,
									tenant_id: dispatched.tenant_id,
									source_action_id: dispatched.action_id,
									source_attempt_id: dispatched.attempt_id,
								};
							}
						}
						return bound;
					};
					const body = row.deny
						? { error: { category: "policy", code: "DENIED", message: "forbidden" } }
						: bind(row.result);
					boundResults.push(body);
					return new Response(JSON.stringify(body), { status: row.deny ? 403 : 200 });
				},
			);
			const provider = new GatewayProvider({
				gateway_url: "https://gateway.test",
				token_provider: () => "gateway-token",
				fetch: fetchGateway,
			});
			const localResult = { content: [{ type: "text" as const, text: "local" }], details: { local: true } };
			const execute = vi.fn<AgentTool["execute"]>(async (_id, _params, _signal, update) => {
				update?.(localResult);
				return localResult;
			});
			const tool: AgentTool = {
				name: "tool",
				label: "Tool",
				description: "Tool",
				parameters: Type.Object({}),
				execute,
			};
			let turnCount = 0;
			const streamFn: StreamFn = () => {
				const response = createAssistantMessageEventStream();
				const toolCount = row.abort ? 2 : 1;
				const content: AssistantMessage["content"] =
					turnCount++ === 0
						? Array.from({ length: toolCount }, (_, index) => ({
								type: "toolCall" as const,
								id: `call-${index}`,
								name: "tool",
								arguments: row.params,
							}))
						: [{ type: "text", text: "done" }];
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content,
					stopReason: turnCount === 1 ? "toolUse" : "stop",
					timestamp: 1,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				response.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				return response;
			};
			let steeringDelivered = false;
			const config: AgentLoopConfig = {
				model,
				convertToLlm: (messages) => messages as Message[],
				toolRegistry: registry,
				connectorProvider: row.missing === "connectorProvider" ? undefined : provider,
				connectorContext:
					row.missing === "connectorContext"
						? undefined
						: { ...identity, connector_id: "llm.unused", connector_mode: "approval" },
				getSteeringMessages: async (): Promise<AgentMessage[]> => {
					if (row.abort === "steer" && requests.length === 1 && !steeringDelivered) {
						steeringDelivered = true;
						return [{ role: "user", content: "stop tools", timestamp: 1 }];
					}
					return [];
				},
			};
			const stream = agentLoop(
				[{ role: "user", content: "run", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [tool] },
				config,
				controller.signal,
				streamFn,
			);
			const events: AgentEvent[] = [];
			for await (const event of stream) events.push(event);
			const results = (await stream.result()).filter((message) => message.role === "toolResult");
			expect(results, row.name).toHaveLength(row.abort ? 2 : 1);
			const ends = events.filter((event) => event.type === "tool_execution_end");
			expect(ends).toHaveLength(results.length);
			const lifecycle = events
				.filter((event) => event.type.startsWith("tool_execution_"))
				.map((event) => event.type);
			expect(lifecycle.slice(0, row.mode ? 3 : 2)).toEqual(
				row.mode
					? ["tool_execution_start", "tool_execution_update", "tool_execution_end"]
					: ["tool_execution_start", "tool_execution_end"],
			);
			expect(results[0].isError, row.name).toBe(Boolean(row.error));
			expect(ends[0].isError, row.name).toBe(Boolean(row.error));
			expect(ends[0].result).toEqual({ content: results[0].content, details: results[0].details });
			if (row.error)
				expect(results[0].content).toEqual([{ type: "text", text: expect.stringContaining(row.error) }]);
			else if (row.mode) {
				expect(execute).toHaveBeenCalledExactlyOnceWith(
					"call-0",
					row.params,
					controller.signal,
					expect.any(Function),
				);
				expect(results[0]).toMatchObject(localResult);
			} else if (row.name === "sensitive headers stripped") {
				const details = results[0].details as { headers?: Record<string, string> };
				expect(details.headers).toEqual({ "content-type": "text/plain", location: "/x" });
				expect(results[0].content[0]).toEqual({
					type: "text",
					text: expect.not.stringContaining("secret"),
				});
			} else {
				expect(results[0].content).toEqual([{ type: "text", text: JSON.stringify(boundResults[0]) }]);
				expect(results[0].details).toEqual(boundResults[0]);
			}
			if (!row.mode) expect(execute).not.toHaveBeenCalled();
			if (row.mode || row.missing || row.name === "missing build field") expect(fetchGateway).not.toHaveBeenCalled();
			else {
				expect(requests).toHaveLength(row.abort === "continue" ? 2 : 1);
				const route =
					row.type === "file"
						? `file/${row.action.split("::")[2]}`
						: row.type === "browser"
							? "browser/navigate"
							: `${row.type}/execute`;
				expect(requests[0].url).toBe(`https://gateway.test/api/connector/${route}`);
				expect(requests[0].envelope).toMatchObject({
					...identity,
					connector_id: "tool.connector",
					connector_type: row.type,
					connector_mode: "proxy",
					action_id: row.action,
				});
				expect(requests[0].envelope.attempt_id).toMatch(/^[0-9a-f-]{36}$/);
				if (row.abort === "steer") {
					expect(results[1].isError).toBe(true);
					expect(results[1].content).toEqual([{ type: "text", text: "Skipped due to queued user message." }]);
				}
				if (row.abort === "continue") {
					expect(results[1].isError).toBe(false);
					expect(requests[1].envelope.attempt_id).not.toBe(requests[0].envelope.attempt_id);
				}
			}
			gates.push(row.name);
		}
		for (const file of ["src/agent-loop.ts", "src/connector-tool-dispatch.ts"]) {
			expect(await readFile(file, "utf8")).not.toMatch(/action_type|"model_call"|"api_call"/);
		}
		outcome = "PASS";
	} finally {
		await writeFile(
			"tests/e2e/artifacts/tool-mode.json",
			`${JSON.stringify({ outcome, gates, mocks: ["LLM stream", "gateway fetch"] }, null, 2)}\n`,
		);
	}
});
