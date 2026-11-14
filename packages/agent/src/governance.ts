/** Connector governance separates authorization from execution. */

import type {
	AuthorizationDecision,
	ClassificationChain,
	ConnectorEnvelope,
	ConnectorLlmResult,
	HttpConnectorEnvelope,
	LlmInvokeRequest,
} from "./connector/types.js";

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
 *
 * `executeLlm` takes the flattened loop→provider request (not a pre-built
 * envelope) and resolves to a buffered `ConnectorLlmResult` when
 * `request.stream` is false, or an `AsyncGenerator<string>` of token chunks
 * when it is true. The provider owns envelope minting.
 */
export interface ConnectorExecutor {
	executeHttp(envelope: HttpConnectorEnvelope): Promise<unknown>;
	executeDb(envelope: ConnectorEnvelope): Promise<unknown>;
	executeFileRead(envelope: ConnectorEnvelope): Promise<unknown>;
	executeFileWrite(envelope: ConnectorEnvelope): Promise<unknown>;
	executeFileDelete(envelope: ConnectorEnvelope): Promise<unknown>;
	executeLlm(request: LlmInvokeRequest, signal?: AbortSignal): Promise<ConnectorLlmResult | AsyncGenerator<string>>;
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
