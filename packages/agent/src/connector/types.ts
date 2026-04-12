/**
 * MagCarta C09 Tool Access Plane types — Phase 1 thin slice (WE2-007).
 *
 * These types mirror `@magcarta/contracts` schemas by structure but are defined
 * inline in this package. pi-mono publishes as a standalone package and does
 * not depend on @magcarta/contracts directly; keeping the shapes local preserves
 * the publish boundary while still matching the contract. Any divergence must
 * be reconciled here when contracts change.
 *
 * Phase 2+ broadens the envelope union to DB/File/LLM/Browser; Phase 1 ships
 * the HTTP discriminant only to validate the end-to-end architecture.
 */

// --- Enumerations ---

export type ConnectorType = "http" | "db" | "file" | "llm" | "browser";

export type ConnectorActionId =
	| "connector::http::fetch"
	| "connector::http::submit"
	| "connector::db::query"
	| "connector::db::mutate"
	| "connector::file::read"
	| "connector::file::write"
	| "connector::file::delete"
	| "connector::llm::invoke"
	| "connector::browser::navigate";

export type ConnectorMode = "approval" | "proxy";

export type Classification = "public" | "internal" | "confidential" | "pii" | "phi" | "pci" | "restricted";

export type ClassificationLayer = "manifest" | "policy" | "scanner" | "external_provider";

export type ClassificationStatus = "success" | "timeout" | "error" | "skipped";

export type AuthorizationOutcome = "ALLOW" | "DENY";

export type DenyCategory =
	| "policy"
	| "classification"
	| "credential_missing"
	| "credential_rejected"
	| "mode_mismatch"
	| "target_unavailable"
	| "malformed_envelope";

// --- Classification chain ---

export interface ClassificationContribution {
	readonly layer: ClassificationLayer;
	readonly classifications: ReadonlyArray<Classification>;
	readonly evaluated_at: string;
	readonly latency_ms: number;
	readonly status: ClassificationStatus;
	readonly provider_id?: string;
	readonly confidence?: number;
	readonly error_message?: string;
}

export interface ClassificationChain {
	readonly contributions: ReadonlyArray<ClassificationContribution>;
	readonly merged_classification: Classification;
	readonly merge_reason: string;
}

// --- HTTP request shape (Phase 1 thin slice only) ---

export interface HttpConnectorRequest {
	readonly url: string;
	readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly query_params?: Readonly<Record<string, string>>;
}

// --- Base envelope fields shared by every connector ---

export interface BaseConnectorEnvelope {
	readonly schema_version: "0.6.0";
	readonly attempt_id: string;
	readonly tenant_id: string;
	readonly agent_id: string;
	readonly agent_did: string;
	readonly connector_id: string;
	readonly connector_type: ConnectorType;
	readonly connector_mode: ConnectorMode;
	readonly action_id: ConnectorActionId;
	readonly action_timestamp: string;
	readonly classification_hints?: ReadonlyArray<Classification>;
}

export interface HttpConnectorEnvelope extends BaseConnectorEnvelope {
	readonly connector_type: "http";
	readonly action_id: "connector::http::fetch" | "connector::http::submit";
	readonly request: HttpConnectorRequest;
}

/**
 * The Phase 1 thin-slice ConnectorEnvelope union. Currently only HTTP is wired;
 * Phase 2 (WE2-009) broadens to DB/File/LLM/Browser variants.
 */
export type ConnectorEnvelope = HttpConnectorEnvelope;

// --- Authorization decision ---

export interface AuthorizationDecision {
	readonly schema_version: "0.6.0";
	readonly attempt_id: string;
	readonly outcome: AuthorizationOutcome;
	readonly action_id: ConnectorActionId;
	readonly connector_id: string;
	readonly connector_mode: ConnectorMode;
	readonly tenant_id: string;
	readonly agent_id: string;
	readonly classification_chain: ClassificationChain;
	readonly policy_hash: string;
	readonly determining_policies?: ReadonlyArray<string>;
	readonly checkpoint_required?: boolean;
	readonly reason?: string;
	readonly deny_category?: DenyCategory;
	readonly evaluated_at: string;
	readonly signer: string;
	readonly signature: string;
}

// --- Error surface ---

/**
 * Thrown by any ConnectorExecutor method that isn't implemented in the
 * current phase. Used extensively in Phase 1 where only `authorize()` is
 * wired; the remaining methods exist to satisfy the interface but throw.
 */
export class NotImplementedError extends Error {
	constructor(method: string, phase: string = "Phase 1") {
		super(`${method} is not implemented in ${phase}`);
		this.name = "NotImplementedError";
	}
}
