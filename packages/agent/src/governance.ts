/**
 * MagCarta governance types for agent runtime (C07).
 *
 * This module carries two generations of types side-by-side during the E2
 * migration:
 *
 * - **Legacy (pre-E2, still used by agent-loop.ts):** `GovernanceProvider`,
 *   `ActionEnvelope`, `GatewayDecision`, `ActionEnvelopeBuilder`,
 *   `DefaultActionEnvelopeBuilder`. These power the existing tool-governance
 *   path and continue to work until Phase 9 (WE2-037) rewires the agent
 *   loop to the new interfaces.
 *
 * - **E2 (new, added in WE2-007):** `GovernanceAuthorizer`, `ConnectorExecutor`,
 *   `MagCartaProvider`. These are the split interface per E2-Q9a — decisions
 *   vs. work — that the Phase 1 thin slice uses.
 *
 * Phase 9 removes the legacy types after agent-loop.ts migrates. For now,
 * both generations coexist cleanly because they use different names.
 */

import type {
	AuthorizationDecision,
	ClassificationChain,
	ConnectorEnvelope,
	HttpConnectorEnvelope,
} from "./connector/types.js";

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

// ============================================================================
// E2 governance interfaces (WE2-007, E2-Q9a split)
// ============================================================================

/**
 * Metadata passed to GovernanceAuthorizer.classify() when submitting bytes
 * for post-execution classification (approval-only mode).
 */
export interface ClassificationMetadata {
	readonly content_type: string;
	readonly size_bytes: number;
	readonly source_tool?: string;
}

export interface ClassificationResult {
	readonly classification_chain: ClassificationChain;
}

/**
 * Decision surface — used by every runtime regardless of mode.
 * Phase 1 implements only `authorize()`; `classify()` and `recordDecision()`
 * are stubbed until Phase 3+.
 */
export interface GovernanceAuthorizer {
	authorize(envelope: ConnectorEnvelope): Promise<AuthorizationDecision>;
	classify(attemptId: string, content: Uint8Array, metadata: ClassificationMetadata): Promise<ClassificationResult>;
	recordDecision(event: ConnectorAdrEvent): Promise<void>;
}

/**
 * Execution surface — only used in proxy mode. Runtimes that never use
 * proxy mode do not need to implement this interface. Phase 1 defines
 * the shape; Phase 9 (WE2-036) adds real implementations in GatewayProvider.
 */
export interface ConnectorExecutor {
	executeHttp(envelope: HttpConnectorEnvelope): Promise<unknown>;
	executeDb(envelope: ConnectorEnvelope): Promise<unknown>;
	executeFileRead(envelope: ConnectorEnvelope): Promise<unknown>;
	executeFileWrite(envelope: ConnectorEnvelope): Promise<unknown>;
	executeFileDelete(envelope: ConnectorEnvelope): Promise<unknown>;
	executeLlm(envelope: ConnectorEnvelope): Promise<unknown>;
	executeBrowser(envelope: ConnectorEnvelope): Promise<never>;
}

export interface MagCartaProvider extends GovernanceAuthorizer, ConnectorExecutor {}

/**
 * Event passed to GovernanceAuthorizer.recordDecision() for ADR emission.
 * Phase 1 ships the shape; Phase 3 wires real persistence.
 */
export interface ConnectorAdrEvent {
	readonly event_type:
		| "connector.authorize"
		| "connector.classify"
		| "connector.execute"
		| "connector.deny"
		| "connector.credential_rejected"
		| "connector.classification_blocked"
		| "connector.handle_expired";
	readonly occurred_at: string;
	readonly attempt_id: string;
	readonly action_id: string;
	readonly connector_id: string;
}

// ============================================================================
// Legacy E1 envelope builder (unchanged; Phase 9 retires this class)
// ============================================================================

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
