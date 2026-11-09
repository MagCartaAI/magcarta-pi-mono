import { mkdir, writeFile } from "node:fs/promises";
import { type AssistantMessage, EventStream, type AssistantMessageEvent, type Message, type Model } from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
import { agentLoop } from "../../src/agent-loop.js";
import type { ConnectorContext, LlmConnectorEnvelope, LlmInvokeRequest } from "../../src/connector/types.js";
import { DefaultActionEnvelopeBuilder } from "../../src/governance.js";
import { ClassificationBlocked, GatewayProvider, GovernanceDenied, ModeMismatch, SubjectBindingViolation } from "../../src/providers/gateway-provider.js";
import type { AgentContext, AgentEvent, AgentLoopConfig } from "../../src/types.js";

// Failures: direct dispatch leaks a key; flattening loses history; malformed envelopes dispatch;
// SSE denial becomes success; Stop emits later tokens; legacy authorization disappears.
const connectorContext: ConnectorContext = {
	tenant_id: "demo-tenant", agent_id: "assistant", agent_did: "did:web:test:agents:assistant",
	connector_id: "llm.demo", connector_mode: "proxy", credential_ref: { backend_id: "env", path: "OPENROUTER_API_KEY" },
};
const model: Model<"openai-completions"> = {
	id: "demo/model", name: "demo", api: "openai-completions", provider: "openrouter", baseUrl: "https://example.invalid",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 2048,
};

it("routes connector turns through one governed dispatch with typed failures and cancellation", async () => {
	const gates: string[] = [];
	const requests: LlmConnectorEnvelope[] = [];
	let responseMode = "stream";
	const fetchGateway = vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
		expect(url).toBe("https://gateway.test/api/connector/llm/invoke");
		expect(init?.headers?.Authorization).toBe("Bearer gateway-jwt");
		requests.push(JSON.parse(init!.body!));
		if (["policy", "classification", "subject_binding", "mode_mismatch"].includes(responseMode)) {
			return new Response(JSON.stringify({ error: { code: responseMode === "classification" ? "CLASSIFICATION_BLOCKED" : "DENIED", message: "denied", category: responseMode } }), { status: 403 });
		}
		if (responseMode === "buffered") return new Response(JSON.stringify({ model: "demo/model", choices: [{ message: { content: "buffered answer" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
		const end = responseMode === "blocked" ? 'data: {"error":"Content blocked by governance: pii"}\n\n' : 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n';
		return new Response('data: {"choices":[{"delta":{"content":"gateway "}}]}\r\n\r\n' + end);
	});
	const provider = new GatewayProvider({ gateway_url: "https://gateway.test", token_provider: () => "gateway-jwt", connectorContext, fetch: fetchGateway });
	const directDispatch = vi.fn(() => { throw new Error("Direct dispatch is forbidden"); });
	const getApiKey = vi.fn(() => { throw new Error("Caller must not resolve an upstream key"); });
	const executeLlm = vi.spyOn(provider, "executeLlm");
	const config: AgentLoopConfig = { model, connectorProvider: provider, connectorContext, getApiKey, convertToLlm: (messages) => messages as Message[] };
	const context: AgentContext = { systemPrompt: "Always answer kindly.", messages: [] };
	let outcome = "FAIL";
	try {
		for (const prompt of ["initial", "follow-up"]) {
			const stream = agentLoop([{ role: "user", content: prompt, timestamp: 1 }], context, config, undefined, directDispatch);
			const events: AgentEvent[] = [];
			for await (const event of stream) events.push(event);
			const messages = await stream.result();
			context.messages.push(...messages);
			expect(messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "gateway answer" }], stopReason: "stop" });
			expect(events.filter((event) => event.type === "message_update")).toHaveLength(2);
		}
		expect(executeLlm).toHaveBeenCalledTimes(2);
		expect(directDispatch).not.toHaveBeenCalled();
		expect(getApiKey).not.toHaveBeenCalled();
		for (const envelope of requests) {
			expect(envelope).toMatchObject({ ...connectorContext, schema_version: "0.6.0", connector_type: "llm", action_id: "connector::llm::invoke" });
			expect(envelope.attempt_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(Number.isFinite(Date.parse(envelope.action_timestamp))).toBe(true);
			expect(envelope.request.messages[0]).toEqual({ role: "system", content: context.systemPrompt });
			expect(envelope.request.messages.every((message) => typeof message.content === "string")).toBe(true);
			expect(envelope.request).not.toHaveProperty("systemPrompt");
		}
		expect(requests[0].attempt_id).not.toBe(requests[1].attempt_id);
		expect(requests[1].request.messages).toContainEqual({ role: "assistant", content: "gateway answer" });
		gates.push("initial and follow-up preserve system prompt and string history with one dispatch per turn");
		const invoke: LlmInvokeRequest = { model: model.id, messages: [{ role: "user", content: "hello" }], stream: false };
		responseMode = "buffered";
		expect(await provider.executeLlm(invoke)).toEqual({ text: "buffered answer", model: model.id, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
		for (const [category, errorType] of [["classification", ClassificationBlocked], ["policy", GovernanceDenied], ["subject_binding", SubjectBindingViolation], ["mode_mismatch", ModeMismatch]] as const) {
			responseMode = category;
			await expect(provider.executeLlm(invoke)).rejects.toBeInstanceOf(errorType);
		}
		responseMode = "blocked";
		const blockedStream = await provider.executeLlm({ ...invoke, stream: true }) as AsyncGenerator<string>;
		expect(await blockedStream.next()).toMatchObject({ value: "gateway ", done: false });
		await expect(blockedStream.next()).rejects.toBeInstanceOf(ClassificationBlocked);
		const requestCount = requests.length;
		const malformed = new GatewayProvider({ gateway_url: "https://gateway.test", token_provider: () => "gateway-jwt", connectorContext: { ...connectorContext, credential_ref: undefined }, fetch: fetchGateway });
		await expect(malformed.executeLlm(invoke)).rejects.toMatchObject({ code: "MALFORMED_ENVELOPE" });
		expect(requests).toHaveLength(requestCount);
		gates.push("buffered result and HTTP and SSE taxonomy; malformed envelope never dispatches");
		const controller = new AbortController();
		let iteratorClosed = false;
		executeLlm.mockImplementationOnce(async (_request, signal) => (async function* () {
			try {
				yield "before stop";
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				yield "after stop";
			} finally { iteratorClosed = true; }
		})());
		const cancelled = agentLoop([{ role: "user", content: "cancel", timestamp: 1 }], context, config, controller.signal, directDispatch);
		const cancelEvents: AgentEvent[] = [];
		for await (const event of cancelled) {
			cancelEvents.push(event);
			if (event.type === "message_update") controller.abort();
		}
		expect((await cancelled.result()).at(-1)).toMatchObject({ stopReason: "aborted", content: [{ type: "text", text: "before stop" }] });
		expect(cancelEvents.filter((event) => event.type === "message_update")).toHaveLength(1);
		expect(iteratorClosed).toBe(true);
		expect(executeLlm.mock.calls.at(-1)?.[1]).toBe(controller.signal);
		gates.push("Stop closes iterator and yields aborted without later token events");
		const legacyMessage: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "legacy" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 };
		const evaluateAction = vi.fn(async () => ({ decision: "ALLOW" as const, policy_hash: "test" }));
		const legacy = agentLoop([{ role: "user", content: "legacy", timestamp: 1 }], context, { ...config, connectorContext: undefined, getApiKey: undefined, governance: { evaluateAction, recordDecision: async () => {} }, governanceContext: { agent_did: connectorContext.agent_did, session_id: "session", taint_context_id: "taint", policy_epoch: "epoch" }, envelopeBuilder: new DefaultActionEnvelopeBuilder({}) }, undefined, () => {
			const events = new EventStream<AssistantMessageEvent, AssistantMessage>((event) => event.type === "done", () => legacyMessage);
			queueMicrotask(() => events.push({ type: "done", reason: "stop", message: legacyMessage }));
			return events;
		});
		for await (const _event of legacy) { /* Drain the public event stream. */ }
		expect(evaluateAction).toHaveBeenCalledOnce();
		expect((await legacy.result()).at(-1)).toEqual(legacyMessage);
		gates.push("missing connector context retains legacy authorization");
		outcome = "PASS";
	} finally {
		await mkdir("tests/e2e/artifacts", { recursive: true });
		await writeFile("tests/e2e/artifacts/connector-llm.json", JSON.stringify({ outcome, gates, mocks: ["gateway HTTP response", "cancellable connector provider"] }, null, 2) + "\n");
	}
});
