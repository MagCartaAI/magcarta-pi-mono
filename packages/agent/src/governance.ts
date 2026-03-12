/**
 * MagCarta governance types for agent runtime (C07).
 *
 * GovernanceProvider: Strategy pattern — injected into the agent loop to
 * intercept tool calls and LLM calls for policy evaluation.
 *
 * ActionEnvelopeBuilder: Adapter pattern — maps pi-agent-core tool/LLM
 * call data into MagCarta ActionEnvelope format.
 */

export type ToolType = "http" | "db" | "browser" | "llm";
export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export type ContextTaint = "TAINTED" | "UNTAINTED";

export interface ActionEnvelope {
	schema_version: "0.2.0";
	tool_type: ToolType;
	operation: string;
	target: string;
	params_hash: string;
	data_classification: DataClassification;
	taint_context_id: string;
	context_taint: ContextTaint;
	metadata?: Record<string, unknown>;
}

export interface GatewayDecision {
	decision: "ALLOW" | "DENY";
	policy_hash: string;
	reason?: string;
	checkpoint_required?: boolean;
	determining_policies?: string[];
}

export interface GovernanceContext {
	agent_did: string;
	session_id: string;
	taint_context_id: string;
	policy_epoch: string;
}

export interface AdrEvent {
	agent_did: string;
	action_type: string;
	envelope: ActionEnvelope;
	decision: GatewayDecision;
	timestamp: string;
}

export interface GovernanceProvider {
	evaluateAction(envelope: ActionEnvelope, context: GovernanceContext): Promise<GatewayDecision>;
	recordDecision(event: AdrEvent): Promise<void>;
}

export interface ToolBinding {
	tool_type: ToolType;
	default_classification: DataClassification;
}

export interface ActionEnvelopeBuilder {
	fromToolCall(toolName: string, args: Record<string, unknown>, context: GovernanceContext): Promise<ActionEnvelope>;
	fromLLMCall(model: { provider: string; id: string }, context: GovernanceContext): Promise<ActionEnvelope>;
}

import { sha256 } from "./crypto/hash.js";

function deterministicSerialize(obj: unknown): string {
	return JSON.stringify(obj, (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.keys(value)
					.sort()
					.reduce<Record<string, unknown>>((acc, k) => {
						acc[k] = value[k];
						return acc;
					}, {})
			: value,
	);
}

export class DefaultActionEnvelopeBuilder implements ActionEnvelopeBuilder {
	private toolMap: Map<string, ToolBinding>;

	constructor(toolBindings: Record<string, ToolBinding>) {
		this.toolMap = new Map(Object.entries(toolBindings));
	}

	async fromToolCall(
		toolName: string,
		args: Record<string, unknown>,
		context: GovernanceContext,
	): Promise<ActionEnvelope> {
		const binding = this.toolMap.get(toolName);

		const tool_type: ToolType = binding?.tool_type ?? "http";
		const data_classification: DataClassification = binding?.default_classification ?? "restricted";
		const context_taint: ContextTaint = binding ? "UNTAINTED" : "TAINTED";

		const paramsHash = await sha256(deterministicSerialize(args));

		return {
			schema_version: "0.2.0",
			tool_type,
			operation: toolName,
			target: toolName,
			params_hash: `sha256:${paramsHash}`,
			data_classification,
			taint_context_id: context.taint_context_id,
			context_taint,
		};
	}

	async fromLLMCall(model: { provider: string; id: string }, context: GovernanceContext): Promise<ActionEnvelope> {
		const modelTarget = `${model.provider}/${model.id}`;
		const paramsHash = await sha256(deterministicSerialize({ model: modelTarget }));

		return {
			schema_version: "0.2.0",
			tool_type: "llm",
			operation: "inference",
			target: modelTarget,
			params_hash: `sha256:${paramsHash}`,
			data_classification: "internal",
			taint_context_id: context.taint_context_id,
			context_taint: "UNTAINTED",
		};
	}
}
