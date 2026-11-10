/**
 * Connector proxy-mode LLM dispatch for the agent loop (WE2 Phase 8).
 *
 * When `AgentLoopConfig.connectorProvider` and `connectorContext` are present
 * and the mode is `"proxy"`, `agent-loop.ts` routes the turn through
 * `dispatchViaConnector` instead of `getApiKey` + `streamFunction`. This
 * module owns the conversation flattening into `LlmInvokeRequest` and the
 * `AssistantMessage` lifecycle synthesis from the gateway result — the loop
 * file stays focused on turn orchestration.
 */

import type { AssistantMessage, EventStream, Message, TextContent, ToolCall } from "@mariozechner/pi-ai";
import type { ConnectorLlmResult, LlmInvokeRequest, LlmWireMessage } from "./connector/types.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "./types.js";

/**
 * Flatten one `convertToLlm` message into a wire message for the invoke
 * request, or `null` when the message cannot appear on the wire. String
 * content passes through unchanged; array content concatenates
 * `TextContent.text` blocks and drops non-text blocks
 * (thinking/toolCall/image) — the text-only journey.
 *
 * The contract message schema carries `tool_calls` on assistant turns and a
 * `tool` role + `tool_call_id` on results, so the full OpenAI tool round-trip
 * maps cleanly: assistant `toolCall` blocks become `tool_calls` (content is
 * "" when the turn is calls-only), and `toolResult` becomes a `tool`-role
 * message answering that call by id.
 */
function flattenLlmMessage(message: Message): LlmWireMessage {
	if (message.role === "toolResult") {
		const text = message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("");
		return {
			role: "tool",
			content: text,
			tool_call_id: message.toolCallId,
			name: message.toolName,
		};
	}
	if (typeof message.content === "string") {
		return { role: message.role, content: message.content };
	}
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
	const toolCalls =
		message.role === "assistant"
			? message.content
					.filter((block): block is ToolCall => block.type === "toolCall")
					.map((block) => ({
						id: block.id,
						type: "function" as const,
						function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
					}))
			: [];
	return {
		role: message.role,
		content: text,
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
	};
}

function emptyConnectorUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function connectorAssistantMessage(
	text: string,
	config: AgentLoopConfig,
	stopReason: AssistantMessage["stopReason"],
	usage?: ConnectorLlmResult["usage"],
): AssistantMessage {
	const tokenUsage = emptyConnectorUsage();
	if (usage) {
		tokenUsage.input = usage.prompt_tokens;
		tokenUsage.output = usage.completion_tokens;
		tokenUsage.totalTokens = usage.total_tokens;
	}
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: config.model.api ?? "openai-completions",
		provider: config.model.provider,
		model: config.model.id,
		usage: tokenUsage,
		stopReason,
		timestamp: Date.now(),
	};
}

function isTokenStream(result: ConnectorLlmResult | AsyncGenerator<string>): result is AsyncGenerator<string> {
	return typeof (result as AsyncGenerator<string>)[Symbol.asyncIterator] === "function";
}

/**
 * Run one proxy-mode LLM turn through `connectorProvider.executeLlm`. The
 * gateway result synthesizes the same `AssistantMessage` lifecycle the
 * legacy `streamFunction` path produces: `message_start` → one
 * `message_update` (`text_delta`) per token → `message_end`. The
 * gateway-returned text lands on `context.messages`. On abort the stream
 * iterator is closed and the terminal message carries
 * `stopReason:"aborted"` with the text received before Stop — no later
 * token events fire.
 */
export async function dispatchViaConnector(
	context: AgentContext,
	config: AgentLoopConfig,
	llmMessages: Message[],
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<AssistantMessage> {
	const provider = config.connectorProvider;
	if (!provider) {
		throw new Error("dispatchViaConnector requires config.connectorProvider");
	}
	const request: LlmInvokeRequest = {
		model: config.model.id,
		systemPrompt: context.systemPrompt,
		messages: llmMessages.map(flattenLlmMessage),
		stream: true,
		...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
		...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
	};
	let result: ConnectorLlmResult | AsyncGenerator<string>;
	try {
		result = await provider.executeLlm(request, signal);
	} catch (err) {
		// A Stop that lands while the invoke is still in flight (e.g. fetch
		// aborted by signal) yields the aborted terminal, not an error turn —
		// the same contract as a mid-stream cancel.
		if (signal?.aborted) {
			const abortedMessage = connectorAssistantMessage("", config, "aborted");
			context.messages.push(abortedMessage);
			stream.push({ type: "message_start", message: { ...abortedMessage } });
			stream.push({ type: "message_end", message: abortedMessage });
			return abortedMessage;
		}
		throw err;
	}

	if (!isTokenStream(result)) {
		const finalMessage = connectorAssistantMessage(result.text, config, "stop", result.usage);
		context.messages.push(finalMessage);
		stream.push({ type: "message_start", message: { ...finalMessage } });
		stream.push({ type: "message_end", message: finalMessage });
		return finalMessage;
	}

	const iterator = result[Symbol.asyncIterator]();
	// The gateway stream exposes the terminal OpenAI finish_reason on the
	// generator once iteration completes; read it to map truncation.
	const tokenStream = result as { finishReason?: string };
	let partialMessage: AssistantMessage | null = null;
	let accumulated = "";
	let aborted = false;
	try {
		for (;;) {
			if (signal?.aborted) {
				aborted = true;
				break;
			}
			let step: IteratorResult<string>;
			try {
				step = await iterator.next();
			} catch (err) {
				// An iterator rejection caused by Stop (abort mid-read) is a
				// cancellation, not a stream failure — surface the aborted
				// terminal rather than letting an error propagate.
				if (signal?.aborted) {
					aborted = true;
					break;
				}
				// A stream failure after message_start must still close the
				// assistant message: emit message_end with the text received so
				// far, then propagate — otherwise the unmatched start leaves a
				// stale partial a retry would append to.
				if (partialMessage) {
					const failedMessage = connectorAssistantMessage(accumulated, config, "error");
					failedMessage.errorMessage = err instanceof Error ? err.message : String(err);
					context.messages[context.messages.length - 1] = failedMessage;
					stream.push({ type: "message_end", message: failedMessage });
				}
				throw err;
			}
			// A Stop that lands while next() is in flight must not count the
			// token the iterator was already resolving — check again after await.
			if (signal?.aborted) {
				aborted = true;
				break;
			}
			const { value, done } = step;
			if (done) break;
			accumulated += value;
			if (!partialMessage) {
				partialMessage = connectorAssistantMessage(accumulated, config, "stop");
				context.messages.push(partialMessage);
				stream.push({ type: "message_start", message: { ...partialMessage } });
			} else {
				partialMessage = connectorAssistantMessage(accumulated, config, "stop");
			}
			context.messages[context.messages.length - 1] = partialMessage;
			const deltaEvent = {
				type: "text_delta" as const,
				contentIndex: 0,
				delta: value,
				partial: partialMessage,
			};
			stream.push({ type: "message_update", assistantMessageEvent: deltaEvent, message: { ...partialMessage } });
		}
	} finally {
		if (aborted || signal?.aborted) {
			aborted = true;
			await iterator.return?.(undefined);
		}
	}

	// A finish_reason of "length" means the completion was cut off by
	// max_tokens — surface it as the "length" stop reason, not a clean stop.
	const stopReason: AssistantMessage["stopReason"] = aborted
		? "aborted"
		: tokenStream.finishReason === "length"
			? "length"
			: "stop";
	const finalMessage = connectorAssistantMessage(accumulated, config, stopReason);
	if (partialMessage) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		stream.push({ type: "message_start", message: { ...finalMessage } });
	}
	stream.push({ type: "message_end", message: finalMessage });
	return finalMessage;
}
