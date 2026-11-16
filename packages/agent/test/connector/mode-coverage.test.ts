import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
import { agentLoop } from "../../src/agent-loop.js";
import type { ConnectorContext, ConnectorEnvelope, ConnectorMode } from "../../src/connector/types.js";
import * as connectorDispatch from "../../src/connector-dispatch.js";
import { type FetchLike, GatewayProvider, GovernanceDenied } from "../../src/providers/gateway-provider.js";
import type { AgentLoopConfig, StreamFn } from "../../src/types.js";

const connectorContext: ConnectorContext = {
	tenant_id: "test-tenant",
	agent_id: "test-agent",
	agent_did: "did:web:test:agents:test-agent",
	connector_id: "llm.test",
	connector_mode: "proxy",
	credential_ref: { backend_id: "env", path: "UPSTREAM_API_KEY" },
};
const model: Model<"openai-completions"> = {
	id: "test/model",
	name: "test",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://upstream.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

interface ModeCase {
	name: string;
	operation: "loop" | "browser";
	hasProvider: boolean;
	mode?: ConnectorMode;
	keySource: "resolved" | "undefined" | "empty" | "config";
	dispatch: "connector" | "local" | "denied";
}

const modeCases: ModeCase[] = [
	{
		name: "proxy with provider",
		operation: "loop",
		hasProvider: true,
		mode: "proxy",
		keySource: "resolved",
		dispatch: "connector",
	},
	{
		name: "proxy without provider",
		operation: "loop",
		hasProvider: false,
		mode: "proxy",
		keySource: "resolved",
		dispatch: "local",
	},
	{
		name: "approval with provider",
		operation: "loop",
		hasProvider: true,
		mode: "approval",
		keySource: "resolved",
		dispatch: "local",
	},
	{ name: "provider without context", operation: "loop", hasProvider: true, keySource: "resolved", dispatch: "local" },
	{
		name: "approval without provider",
		operation: "loop",
		hasProvider: false,
		mode: "approval",
		keySource: "config",
		dispatch: "local",
	},
	{ name: "no provider or context", operation: "loop", hasProvider: false, keySource: "config", dispatch: "local" },
	{
		name: "undefined resolved key",
		operation: "loop",
		hasProvider: true,
		mode: "approval",
		keySource: "undefined",
		dispatch: "local",
	},
	{
		name: "empty resolved key",
		operation: "loop",
		hasProvider: true,
		mode: "approval",
		keySource: "empty",
		dispatch: "local",
	},
	{
		name: "browser proxy",
		operation: "browser",
		hasProvider: true,
		mode: "proxy",
		keySource: "config",
		dispatch: "denied",
	},
	{
		name: "browser approval",
		operation: "browser",
		hasProvider: true,
		mode: "approval",
		keySource: "config",
		dispatch: "denied",
	},
];

it("keeps connector execution exclusive to proxy mode and browser execution disabled", async () => {
	const dispatchViaConnector = vi.spyOn(connectorDispatch, "dispatchViaConnector");
	try {
		for (const row of modeCases) {
			dispatchViaConnector.mockClear();
			const context = row.mode ? { ...connectorContext, connector_mode: row.mode } : undefined;
			const envelopes: ConnectorEnvelope[] = [];
			const fetchGateway = vi.fn<FetchLike>(async (_url, init) => {
				envelopes.push(JSON.parse(init?.body ?? "null"));
				if (row.operation === "browser") {
					return new Response(JSON.stringify({ error: { category: "policy" } }), { status: 403 });
				}
				return new Response('data: {"choices":[{"delta":{"content":"gateway answer"}}]}\n\ndata: [DONE]\n\n');
			});
			const tokenProvider = vi.fn(() => "gateway-token");
			const provider = new GatewayProvider({
				gateway_url: "https://gateway.test",
				token_provider: tokenProvider,
				connectorContext: context,
				fetch: fetchGateway,
			});
			const executeLlm = vi.spyOn(provider, "executeLlm");
			const getApiKey = vi.fn(async () =>
				row.keySource === "resolved" ? "resolved-key" : row.keySource === "empty" ? "" : undefined,
			);
			const streamFunction = vi.fn<StreamFn>(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "local answer" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				};
				const response = createAssistantMessageEventStream();
				response.push({ type: "done", reason: "stop", message });
				response.end(message);
				return response;
			});
			if (row.operation === "browser") {
				const envelope = {
					...connectorContext,
					connector_mode: row.mode!,
					schema_version: "0.6.0",
					attempt_id: "11111111-1111-4111-8111-111111111111",
					action_timestamp: "2026-01-01T00:00:00Z",
					connector_type: "browser",
					action_id: "connector::browser::navigate",
					request: { url: "https://example.test" },
				} as unknown as ConnectorEnvelope;
				await expect(provider.executeBrowser(envelope), row.name).rejects.toBeInstanceOf(GovernanceDenied);
			} else {
				const config: AgentLoopConfig = {
					model,
					connectorProvider: row.hasProvider ? provider : undefined,
					connectorContext: context,
					apiKey: "configured-key",
					getApiKey: row.keySource === "config" ? undefined : getApiKey,
					convertToLlm: (messages) => [...messages] as Message[],
				};
				const stream = agentLoop(
					[{ role: "user", content: "hello", timestamp: 1 }],
					{ systemPrompt: "Be concise.", messages: [] },
					config,
					undefined,
					streamFunction,
				);
				expect((await stream.result()).at(-1), row.name).toMatchObject({
					role: "assistant",
					content: [{ type: "text", text: row.dispatch === "connector" ? "gateway answer" : "local answer" }],
					stopReason: "stop",
				});
			}
			if (row.dispatch === "connector") {
				expect(dispatchViaConnector, row.name).toHaveBeenCalledTimes(1);
				expect(executeLlm, row.name).toHaveBeenCalledTimes(1);
				expect(fetchGateway, row.name).toHaveBeenCalledExactlyOnceWith(
					"https://gateway.test/api/connector/llm/invoke",
					expect.objectContaining({
						method: "POST",
						headers: expect.objectContaining({ Authorization: "Bearer gateway-token" }),
					}),
				);
				expect(tokenProvider, row.name).toHaveBeenCalledTimes(1);
				expect(envelopes, row.name).toHaveLength(1);
				expect(envelopes[0], row.name).toMatchObject({
					...connectorContext,
					connector_mode: "proxy",
					connector_type: "llm",
					action_id: "connector::llm::invoke",
					request: {
						model: model.id,
						stream: true,
						messages: [
							{ role: "system", content: "Be concise." },
							{ role: "user", content: "hello" },
						],
					},
				});
			} else if (row.operation === "browser") {
				expect(dispatchViaConnector, row.name).not.toHaveBeenCalled();
				expect(executeLlm, row.name).not.toHaveBeenCalled();
				expect(fetchGateway, row.name).toHaveBeenCalledExactlyOnceWith(
					"https://gateway.test/api/connector/browser/navigate",
					expect.objectContaining({ method: "POST", body: JSON.stringify(envelopes[0]) }),
				);
				expect(tokenProvider, row.name).toHaveBeenCalledTimes(1);
				expect(envelopes, row.name).toHaveLength(1);
			} else {
				expect(dispatchViaConnector, row.name).not.toHaveBeenCalled();
				expect(executeLlm, row.name).not.toHaveBeenCalled();
				expect(fetchGateway, row.name).not.toHaveBeenCalled();
				expect(tokenProvider, row.name).not.toHaveBeenCalled();
				expect(envelopes, row.name).toEqual([]);
			}
			if (row.dispatch === "local") {
				expect(streamFunction, row.name).toHaveBeenCalledExactlyOnceWith(
					model,
					expect.objectContaining({
						systemPrompt: "Be concise.",
						messages: [{ role: "user", content: "hello", timestamp: 1 }],
					}),
					expect.objectContaining({ apiKey: row.keySource === "resolved" ? "resolved-key" : "configured-key" }),
				);
				if (row.keySource === "config") expect(getApiKey, row.name).not.toHaveBeenCalled();
				else expect(getApiKey, row.name).toHaveBeenCalledExactlyOnceWith(model.provider);
			} else {
				expect(streamFunction, row.name).not.toHaveBeenCalled();
				expect(getApiKey, row.name).not.toHaveBeenCalled();
			}
		}
	} finally {
		dispatchViaConnector.mockRestore();
	}
});
