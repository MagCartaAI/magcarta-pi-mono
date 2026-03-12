import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../../src/agent-loop.js";
import {
	type ActionEnvelope,
	type AdrEvent,
	DefaultActionEnvelopeBuilder,
	type GatewayDecision,
	type GovernanceContext,
	type GovernanceProvider,
} from "../../src/governance.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../../src/types.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock-model",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock-model",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function createGovernanceContext(): GovernanceContext {
	return {
		agent_did: "did:web:test.magcarta.dev:agents:a1",
		session_id: "sess-test-001",
		taint_context_id: "ctx-test-001",
		policy_epoch: "epoch-1",
	};
}

const echoParams = Type.Object({ text: Type.String() });

function createEchoTool(): AgentTool<typeof echoParams> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echoes input",
		parameters: echoParams,
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `echo: ${params.text}` }],
			details: {},
		}),
	};
}

function createMockGovernance(
	decide: "ALLOW" | "DENY",
	reason?: string,
): {
	provider: GovernanceProvider;
	recorded: AdrEvent[];
} {
	const recorded: AdrEvent[] = [];
	return {
		provider: {
			async evaluateAction(): Promise<GatewayDecision> {
				return {
					decision: decide,
					policy_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					reason,
					determining_policies: ["test-policy"],
				};
			},
			async recordDecision(event: AdrEvent) {
				recorded.push(event);
			},
		},
		recorded,
	};
}

function createToolCallStreamFn(toolName: string, args: Record<string, unknown>) {
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const msg = createAssistantMessage([
				{
					type: "toolCall",
					id: "tc-1",
					name: toolName,
					arguments: args,
				},
			]);
			stream.push({ type: "done", reason: "stop", message: msg });
		});
		return stream;
	};
}

function createTextStreamFn(text: string) {
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const msg = createAssistantMessage([{ type: "text", text }]);
			stream.push({ type: "done", reason: "stop", message: msg });
		});
		return stream;
	};
}

describe("Governance hooks (C07)", () => {
	describe("tool execution governance", () => {
		it("ALLOW: tool executes when governance approves", async () => {
			const { provider, recorded } = createMockGovernance("ALLOW");
			const tool = createEchoTool();
			const context: AgentContext = { systemPrompt: "test", messages: [], tools: [tool] };
			const builder = new DefaultActionEnvelopeBuilder({
				echo: { tool_type: "http", default_classification: "internal" },
			});

			let callCount = 0;
			const streamFn = () => {
				callCount++;
				if (callCount === 1) return createToolCallStreamFn("echo", { text: "hello" })();
				return createTextStreamFn("Done")();
			};

			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				governance: provider,
				governanceContext: createGovernanceContext(),
				envelopeBuilder: builder,
			};

			const events: AgentEvent[] = [];
			const stream = agentLoop([createUserMessage("hi")], context, config, undefined, streamFn);
			for await (const event of stream) events.push(event);

			const toolEnd = events.find((e) => e.type === "tool_execution_end") as Extract<
				AgentEvent,
				{ type: "tool_execution_end" }
			>;
			expect(toolEnd).toBeDefined();
			expect(toolEnd.isError).toBe(false);

			expect(recorded.length).toBeGreaterThanOrEqual(1);
			expect(recorded[0].decision.decision).toBe("ALLOW");
		});

		it("DENY: tool is skipped with error result", async () => {
			const recorded: AdrEvent[] = [];
			const toolDenyProvider: GovernanceProvider = {
				async evaluateAction(envelope: ActionEnvelope): Promise<GatewayDecision> {
					if (envelope.tool_type === "llm") {
						return {
							decision: "ALLOW",
							policy_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						};
					}
					return {
						decision: "DENY",
						policy_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						reason: "Policy forbids echo tool",
					};
				},
				async recordDecision(event: AdrEvent) {
					recorded.push(event);
				},
			};

			const tool = createEchoTool();
			const context: AgentContext = { systemPrompt: "test", messages: [], tools: [tool] };
			const builder = new DefaultActionEnvelopeBuilder({
				echo: { tool_type: "http", default_classification: "internal" },
			});

			let callCount = 0;
			const streamFn = () => {
				callCount++;
				if (callCount === 1) return createToolCallStreamFn("echo", { text: "hello" })();
				return createTextStreamFn("I see the tool was denied.")();
			};

			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				governance: toolDenyProvider,
				governanceContext: createGovernanceContext(),
				envelopeBuilder: builder,
			};

			const events: AgentEvent[] = [];
			const stream = agentLoop([createUserMessage("hi")], context, config, undefined, streamFn);
			for await (const event of stream) events.push(event);

			const govDecisions = events.filter((e) => e.type === "governance_decision") as Array<
				Extract<AgentEvent, { type: "governance_decision" }>
			>;
			const toolDecision = govDecisions.find((d) => d.toolCallId);
			expect(toolDecision).toBeDefined();
			expect(toolDecision!.decision.decision).toBe("DENY");

			const toolDenied = recorded.find((r) => r.action_type === "api_call");
			expect(toolDenied).toBeDefined();
			expect(toolDenied!.decision.decision).toBe("DENY");
		});
	});

	describe("LLM call governance", () => {
		it("DENY: LLM call is blocked with error message", async () => {
			const { provider, recorded } = createMockGovernance("DENY", "LLM calls not allowed");
			const context: AgentContext = { systemPrompt: "test", messages: [], tools: [] };
			const builder = new DefaultActionEnvelopeBuilder({});

			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				governance: provider,
				governanceContext: createGovernanceContext(),
				envelopeBuilder: builder,
			};

			const events: AgentEvent[] = [];
			const stream = agentLoop(
				[createUserMessage("hi")],
				context,
				config,
				undefined,
				createTextStreamFn("should not see this"),
			);
			for await (const event of stream) events.push(event);

			const messages = await stream.result();
			const lastAssistant = messages.find((m) => m.role === "assistant") as AssistantMessage;
			expect(lastAssistant).toBeDefined();
			expect(lastAssistant.stopReason).toBe("error");

			const govDecisions = events.filter((e) => e.type === "governance_decision");
			expect(govDecisions.length).toBeGreaterThanOrEqual(1);

			expect(recorded.length).toBeGreaterThanOrEqual(1);
			expect(recorded[0].action_type).toBe("model_call");
		});
	});

	describe("passthrough (no governance)", () => {
		it("runs identically to upstream when no governance configured", async () => {
			const tool = createEchoTool();
			const context: AgentContext = { systemPrompt: "test", messages: [], tools: [tool] };

			let callCount = 0;
			const streamFn = () => {
				callCount++;
				if (callCount === 1) return createToolCallStreamFn("echo", { text: "hello" })();
				return createTextStreamFn("Done")();
			};

			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
			};

			const events: AgentEvent[] = [];
			const stream = agentLoop([createUserMessage("hi")], context, config, undefined, streamFn);
			for await (const event of stream) events.push(event);

			const govEvents = events.filter((e) => e.type === "governance_evaluate" || e.type === "governance_decision");
			expect(govEvents).toHaveLength(0);

			const toolEnd = events.find((e) => e.type === "tool_execution_end") as Extract<
				AgentEvent,
				{ type: "tool_execution_end" }
			>;
			expect(toolEnd).toBeDefined();
			expect(toolEnd.isError).toBe(false);
		});
	});

	describe("envelope correctness", () => {
		it("builds valid v0.2.0 envelopes with SHA-256 params_hash", async () => {
			const builder = new DefaultActionEnvelopeBuilder({
				echo: { tool_type: "http", default_classification: "internal" },
			});
			const ctx = createGovernanceContext();

			const envelope = await builder.fromToolCall("echo", { text: "hello" }, ctx);
			expect(envelope.schema_version).toBe("0.2.0");
			expect(envelope.tool_type).toBe("http");
			expect(envelope.params_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(envelope.data_classification).toBe("internal");
			expect(envelope.context_taint).toBe("UNTAINTED");
			expect(envelope.taint_context_id).toBe(ctx.taint_context_id);
		});

		it("builds LLM envelope with tool_type 'llm'", async () => {
			const builder = new DefaultActionEnvelopeBuilder({});
			const ctx = createGovernanceContext();

			const envelope = await builder.fromLLMCall({ provider: "openai", id: "gpt-4" }, ctx);
			expect(envelope.tool_type).toBe("llm");
			expect(envelope.operation).toBe("inference");
			expect(envelope.target).toBe("openai/gpt-4");
		});

		it("deterministic params_hash for same args", async () => {
			const builder = new DefaultActionEnvelopeBuilder({
				foo: { tool_type: "db", default_classification: "confidential" },
			});
			const ctx = createGovernanceContext();

			const e1 = await builder.fromToolCall("foo", { a: 1, b: "x" }, ctx);
			const e2 = await builder.fromToolCall("foo", { b: "x", a: 1 }, ctx);
			expect(e1.params_hash).toBe(e2.params_hash);
		});
	});

	describe("unknown tool fail-closed", () => {
		it("unknown tools get restricted classification and TAINTED context", async () => {
			const builder = new DefaultActionEnvelopeBuilder({});
			const ctx = createGovernanceContext();

			const envelope = await builder.fromToolCall("unknown_tool", { x: 1 }, ctx);
			expect(envelope.data_classification).toBe("restricted");
			expect(envelope.context_taint).toBe("TAINTED");
		});
	});

	describe("event sequence", () => {
		it("governance_evaluate precedes governance_decision for tool calls", async () => {
			const { provider } = createMockGovernance("ALLOW");
			const tool = createEchoTool();
			const context: AgentContext = { systemPrompt: "test", messages: [], tools: [tool] };
			const builder = new DefaultActionEnvelopeBuilder({
				echo: { tool_type: "http", default_classification: "internal" },
			});

			let callCount = 0;
			const streamFn = () => {
				callCount++;
				if (callCount === 1) return createToolCallStreamFn("echo", { text: "hi" })();
				return createTextStreamFn("done")();
			};

			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				governance: provider,
				governanceContext: createGovernanceContext(),
				envelopeBuilder: builder,
			};

			const events: AgentEvent[] = [];
			const stream = agentLoop([createUserMessage("hi")], context, config, undefined, streamFn);
			for await (const event of stream) events.push(event);

			const govEvents = events.filter((e) => e.type === "governance_evaluate" || e.type === "governance_decision");
			expect(govEvents.length).toBeGreaterThanOrEqual(2);

			for (let i = 0; i < govEvents.length - 1; i += 2) {
				expect(govEvents[i].type).toBe("governance_evaluate");
				expect(govEvents[i + 1].type).toBe("governance_decision");
			}
		});
	});
});
