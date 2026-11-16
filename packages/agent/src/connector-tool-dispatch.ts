import {
	type AssistantMessage,
	type EventStream,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import { ConnectorEnvelopeBuilder } from "./connector/envelope-builder.js";
import type { ClassificationChain, ConnectorActionId, ConnectorEnvelope } from "./connector/types.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "./types.js";

async function dispatchToolCall(
	tool: AgentTool,
	toolCallId: string,
	params: Record<string, unknown>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown>,
): Promise<AgentToolResult<unknown>> {
	const binding = config.toolRegistry?.lookup(tool.name);
	if (!binding || binding.default_mode === "approval") return tool.execute(toolCallId, params, signal, onUpdate);
	if (!config.connectorProvider) throw new Error(`Proxy tool ${tool.name} requires connectorProvider`);
	if (!config.connectorContext) throw new Error(`Proxy tool ${tool.name} requires connectorContext`);
	const { tenant_id, agent_id, agent_did } = config.connectorContext;
	const envelope = new ConnectorEnvelopeBuilder(config.toolRegistry!).build({
		tool_name: tool.name,
		params,
		tenant_id,
		agent_id,
		agent_did,
	});
	const provider = config.connectorProvider;
	let result: unknown;
	switch (envelope.connector_type) {
		case "http":
			result = await provider.executeHttp(envelope);
			break;
		case "db":
			result = await provider.executeDb(envelope);
			break;
		case "file":
			switch (envelope.action_id) {
				case "connector::file::read":
					result = await provider.executeFileRead(envelope);
					break;
				case "connector::file::write":
					result = await provider.executeFileWrite(envelope);
					break;
				case "connector::file::delete":
					result = await provider.executeFileDelete(envelope);
					break;
			}
			break;
		case "browser":
			return provider.executeBrowser(envelope);
		case "llm":
			throw new Error("LLM envelopes cannot be dispatched as tool calls");
	}
	validateExecutionResult(envelope, result);
	const safe = sanitizeExecutionResult(envelope, result);
	return { content: [{ type: "text", text: JSON.stringify(safe) }], details: safe };
}

// Response headers that can carry a reusable credential; never reach the model.
const SENSITIVE_HEADERS = new Set([
	"set-cookie",
	"cookie",
	"authorization",
	"www-authenticate",
	"proxy-authorization",
	"proxy-authenticate",
	"x-api-key",
	"x-auth-token",
	"authentication-info",
]);

/**
 * Strip credential-bearing headers from an http result so neither `content`
 * nor `details` exposes them. Non-http results pass through unchanged.
 */
function sanitizeExecutionResult(envelope: ConnectorEnvelope, result: ExecutionResult): ExecutionResult {
	if (envelope.connector_type !== "http" || !isObject(result) || !isObject(result.headers)) return result;
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(result.headers)) {
		if (!SENSITIVE_HEADERS.has(name.toLowerCase()) && typeof value === "string") headers[name] = value;
	}
	return { ...result, headers } as ExecutionResult;
}

interface BaseExecutionResult {
	readonly attempt_id: string;
	readonly classification_chain: ClassificationChain;
	readonly latency_ms: number;
}

interface OpaqueResultHandle {
	readonly handle_id: string;
	readonly tenant_id: string;
	readonly issued_at: string;
	readonly expires_at: string;
	readonly size_bytes: number;
	readonly content_type: string;
	readonly classification_chain: ClassificationChain;
	readonly source_action_id: ConnectorActionId;
	readonly source_connector_id: string;
	readonly source_attempt_id: string;
}

interface FileListingEntry {
	readonly key: string;
	readonly size_bytes: number;
	readonly content_type?: string;
	readonly last_modified?: string;
}

type ExecutionResult = BaseExecutionResult &
	(
		| { readonly status_code: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
		| {
				readonly result_format: "inline";
				readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
				readonly row_count: number;
		  }
		| { readonly result_format: "opaque_handle"; readonly handle: OpaqueResultHandle; readonly row_count: number }
		| {
				readonly result_format: "inline";
				readonly content: string;
				readonly content_type: string;
				readonly size_bytes: number;
		  }
		| { readonly result_format: "opaque_handle"; readonly handle: OpaqueResultHandle; readonly content_type: string }
		| {
				readonly result_format: "listing";
				readonly entries: ReadonlyArray<FileListingEntry>;
				readonly next_continuation_token?: string;
		  }
		| {
				readonly result_format: "metadata";
				readonly content_type: string;
				readonly size_bytes: number;
				readonly last_modified?: string;
		  }
		| {
				readonly bucket: string;
				readonly key: string;
				readonly bytes_written: number;
				readonly etag?: string;
				readonly handle_redeemed?: string;
		  }
		| { readonly bucket: string; readonly key: string; readonly deleted: boolean }
	);

type FieldCheck = (value: unknown) => boolean;
const isString: FieldCheck = (value) => typeof value === "string";
const isNonEmptyString: FieldCheck = (value) => typeof value === "string" && value.length > 0;
const isNonnegativeNumber: FieldCheck = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isNonnegativeInteger: FieldCheck = (value) => isNonnegativeNumber(value) && Number.isInteger(value);
const isUuid: FieldCheck = (value) =>
	typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const isClassification: FieldCheck = (value) =>
	typeof value === "string" &&
	["public", "internal", "confidential", "pii", "phi", "pci", "restricted"].includes(value);
const isConnectorAction: FieldCheck = (value) =>
	typeof value === "string" &&
	[
		"connector::http::fetch",
		"connector::http::submit",
		"connector::db::query",
		"connector::db::mutate",
		"connector::file::read",
		"connector::file::write",
		"connector::file::delete",
		"connector::llm::invoke",
		"connector::browser::navigate",
	].includes(value);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateTime(value: unknown): boolean {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/.test(value))
		return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value.slice(0, 10);
}

function matchesObject(
	value: unknown,
	required: Record<string, FieldCheck>,
	optional: Record<string, FieldCheck> = {},
	strict = true,
): boolean {
	if (!isObject(value)) return false;
	return (
		Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key])) &&
		Object.entries(optional).every(([key, check]) => value[key] === undefined || check(value[key])) &&
		(!strict || Object.keys(value).every((key) => Object.hasOwn(required, key) || Object.hasOwn(optional, key)))
	);
}

function isClassificationChain(value: unknown): boolean {
	return matchesObject(
		value,
		{
			contributions: (entries) =>
				Array.isArray(entries) &&
				entries.every((entry) =>
					matchesObject(
						entry,
						{
							layer: (layer) =>
								typeof layer === "string" &&
								["manifest", "policy", "scanner", "external_provider"].includes(layer),
							classifications: (labels) => Array.isArray(labels) && labels.every(isClassification),
							evaluated_at: isDateTime,
							latency_ms: isNonnegativeNumber,
							status: (status) =>
								typeof status === "string" && ["success", "timeout", "error", "skipped"].includes(status),
						},
						{
							provider_id: isString,
							confidence: (confidence) => isNonnegativeNumber(confidence) && (confidence as number) <= 1,
							error_message: isString,
						},
						false,
					),
				),
			merged_classification: isClassification,
			merge_reason: isNonEmptyString,
		},
		{},
		false,
	);
}

function isOpaqueHandle(value: unknown): boolean {
	return matchesObject(value, {
		handle_id: isUuid,
		tenant_id: isNonEmptyString,
		issued_at: isDateTime,
		expires_at: isDateTime,
		size_bytes: (size) => isNonnegativeInteger(size) && (size as number) > 0,
		content_type: isNonEmptyString,
		classification_chain: isClassificationChain,
		source_action_id: isConnectorAction,
		source_connector_id: isNonEmptyString,
		source_attempt_id: isUuid,
	});
}

function validateExecutionResult(envelope: ConnectorEnvelope, value: unknown): asserts value is ExecutionResult {
	const baseFields = {
		attempt_id: isUuid,
		classification_chain: isClassificationChain,
		latency_ms: isNonnegativeNumber,
	};
	let fields: Record<string, FieldCheck>;
	let optional: Record<string, FieldCheck> = {};
	const resultFormat = isObject(value) ? value.result_format : undefined;
	switch (envelope.connector_type) {
		case "http":
			fields = {
				status_code: (status) => Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599,
				headers: (headers) => isObject(headers) && Object.values(headers).every(isString),
				body: isString,
			};
			break;
		case "db":
			fields = {
				result_format: (format) => format === "inline" || format === "opaque_handle",
				row_count: isNonnegativeInteger,
				...(resultFormat === "inline"
					? { rows: (rows: unknown) => Array.isArray(rows) && rows.every(isObject) }
					: { handle: isOpaqueHandle }),
			};
			break;
		case "file":
			if (envelope.action_id === "connector::file::write") {
				fields = { bucket: isNonEmptyString, key: isNonEmptyString, bytes_written: isNonnegativeInteger };
				optional = { etag: isString, handle_redeemed: isUuid };
			} else if (envelope.action_id === "connector::file::delete") {
				fields = {
					bucket: isNonEmptyString,
					key: isNonEmptyString,
					deleted: (deleted) => typeof deleted === "boolean",
				};
			} else {
				fields = {
					result_format: (format) =>
						format === "inline" || format === "opaque_handle" || format === "listing" || format === "metadata",
				};
				switch (resultFormat) {
					case "inline":
						fields = {
							...fields,
							content: isString,
							content_type: isNonEmptyString,
							size_bytes: isNonnegativeInteger,
						};
						break;
					case "opaque_handle":
						fields = { ...fields, handle: isOpaqueHandle, content_type: isNonEmptyString };
						break;
					case "listing":
						fields = {
							...fields,
							entries: (entries) =>
								Array.isArray(entries) &&
								entries.every((entry) =>
									matchesObject(
										entry,
										{ key: isNonEmptyString, size_bytes: isNonnegativeInteger },
										{ content_type: isString, last_modified: isDateTime },
									),
								),
						};
						optional = { next_continuation_token: isString };
						break;
					case "metadata":
						fields = { ...fields, content_type: isNonEmptyString, size_bytes: isNonnegativeInteger };
						optional = { last_modified: isDateTime };
						break;
				}
			}
			break;
		default:
			throw new Error(`${envelope.action_id}: unsupported execution result`);
	}
	if (!matchesObject(value, { ...baseFields, ...fields }, optional)) {
		throw new Error(`${envelope.action_id}: invalid gateway execution result schema`);
	}
	// Bind the result to this envelope: a mismatched attempt_id or a handle
	// pointing at another tenant/action is a replay or cross-attempt leak.
	const resultObj = value as { attempt_id?: unknown; handle?: unknown };
	if (resultObj.attempt_id !== envelope.attempt_id) {
		throw new Error(`${envelope.action_id}: result attempt_id does not match the dispatched envelope`);
	}
	if (isObject(resultObj.handle)) {
		const handle = resultObj.handle as { tenant_id?: unknown; source_action_id?: unknown; source_attempt_id?: unknown };
		if (
			handle.tenant_id !== envelope.tenant_id ||
			handle.source_action_id !== envelope.action_id ||
			handle.source_attempt_id !== envelope.attempt_id
		) {
			throw new Error(`${envelope.action_id}: opaque handle identity does not match the dispatched envelope`);
		}
	}
}

/**
 * Execute tool calls from an assistant message.
 */
export async function executeToolCalls(
	tools: AgentContext["tools"],
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	const getSteeringMessages = config.getSteeringMessages;
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const results: ToolResultMessage[] = [];
	let steeringMessages: AgentMessage[] | undefined;

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		const tool = tools?.find((t) => t.name === toolCall.name);

		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let result: AgentToolResult<unknown>;
		let isError = false;

		try {
			if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

			const validatedArgs = validateToolArguments(tool, toolCall);

			result = await dispatchToolCall(tool, toolCall.id, validatedArgs, config, signal, (partialResult) => {
				stream.push({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
					partialResult,
				});
			});
		} catch (e) {
			result = {
				content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
				details: {},
			};
			isError = true;
		}

		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};

		results.push(toolResultMessage);
		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });

		// Check for steering messages - skip remaining tools if user interrupted
		if (getSteeringMessages) {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				const remainingCalls = toolCalls.slice(index + 1);
				for (const skipped of remainingCalls) {
					results.push(skipToolCall(skipped, stream));
				}
				break;
			}
		}
	}

	return { toolResults: results, steeringMessages };
}

function skipToolCall(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}
