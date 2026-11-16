// Wire shapes mirror the contracts inline to preserve the standalone publish boundary.

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

// --- Credential reference (proxy-mode secret addressing) ---

/**
 * A reference to a secret stored in a secrets backend — never the raw secret.
 * Mirrors the contracts `CredentialRefSchema`; required on proxy-mode
 * envelopes so the gateway can resolve the upstream credential at call time.
 */
export interface CredentialRef {
	readonly backend_id: "env" | "aws_ssm" | "vault" | "custom";
	readonly path: string;
	readonly version?: string;
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
	readonly credential_ref?: CredentialRef;
}

export interface HttpConnectorEnvelope extends BaseConnectorEnvelope {
	readonly connector_type: "http";
	readonly action_id: "connector::http::fetch" | "connector::http::submit";
	readonly request: HttpConnectorRequest;
}

export interface DbConnectorRequest {
	readonly connection_ref: string;
	readonly sql_text: string;
	readonly parameters?: unknown[];
	readonly row_limit?: number;
	readonly result_format?: "inline" | "opaque_handle" | "auto";
	readonly read_replica_ok?: boolean;
}

export interface DbConnectorEnvelope extends BaseConnectorEnvelope {
	readonly connector_type: "db";
	readonly action_id: "connector::db::query" | "connector::db::mutate";
	readonly request: DbConnectorRequest;
}

export interface FileReadConnectorRequest {
	readonly connection_ref: string;
	readonly key: string;
	readonly operation: "get" | "head" | "list";
	readonly range?: { readonly start_byte: number; readonly end_byte: number };
	readonly result_format?: "inline" | "opaque_handle" | "auto";
}

export interface FileReadConnectorEnvelope extends BaseConnectorEnvelope {
	readonly connector_type: "file";
	readonly action_id: "connector::file::read";
	readonly request: FileReadConnectorRequest;
}

export interface FileWriteConnectorRequest {
	readonly connection_ref: string;
	readonly destination: {
		readonly key: string;
		readonly content_type: string;
		readonly storage_class?: string;
		readonly metadata?: Readonly<Record<string, string>>;
	};
	readonly from_handle?: string;
	readonly inline_content?: string;
}

export interface FileWriteConnectorEnvelope extends BaseConnectorEnvelope {
	readonly connector_type: "file";
	readonly action_id: "connector::file::write";
	readonly request: FileWriteConnectorRequest;
}

export interface FileDeleteConnectorRequest {
	readonly connection_ref: string;
	readonly key: string;
}

export interface FileDeleteConnectorEnvelope extends BaseConnectorEnvelope {
	readonly connector_type: "file";
	readonly action_id: "connector::file::delete";
	readonly request: FileDeleteConnectorRequest;
}

export interface BrowserConnectorRequest {
	readonly url: string;
}

export interface BrowserConnectorEnvelope extends BaseConnectorEnvelope {
	readonly connector_type: "browser";
	readonly action_id: "connector::browser::navigate";
	readonly request: BrowserConnectorRequest;
}

// --- LLM connector shapes ---

/**
 * One wire message on the LLM invoke request. `content` is always a plain
 * string on the wire — the agent loop flattens pi-ai content blocks into
 * text before the request is built. Mirrors the contract's strict message
 * object (`role` enum, `content` string, optional `name`/`tool_call_id`).
 */
export interface LlmWireMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: string;
	readonly name?: string;
	readonly tool_call_id?: string;
	/** Assistant turns that call tools carry the OpenAI-compatible tool_calls
	 * array the gateway forwards untouched to the upstream provider. */
	readonly tool_calls?: ReadonlyArray<unknown>;
}

/**
 * Loop→provider hand-off payload for one LLM turn. This is NOT the wire
 * envelope — the provider mints the `LlmConnectorEnvelope` from it. The
 * `systemPrompt` travels its own field here and the provider folds it into
 * `messages[0]` because the contract request is strict with no sibling.
 */
export interface LlmInvokeRequest {
	readonly model: string;
	readonly systemPrompt?: string;
	readonly messages: ReadonlyArray<LlmWireMessage>;
	readonly stream: boolean;
	readonly max_tokens?: number;
	readonly temperature?: number;
}

/**
 * The invoke body embedded in an `LlmConnectorEnvelope.request`. Mirrors the
 * contracts `LlmConnectorEnvelopeSchema.request` — strict, no `systemPrompt`.
 */
export interface LlmConnectorRequest {
	readonly model: string;
	readonly messages: ReadonlyArray<LlmWireMessage>;
	readonly stream: boolean;
	readonly max_tokens?: number;
	readonly temperature?: number;
	readonly tools?: ReadonlyArray<unknown>;
	readonly response_format?: unknown;
}

export interface LlmConnectorEnvelope extends BaseConnectorEnvelope {
	readonly connector_type: "llm";
	readonly action_id: "connector::llm::invoke";
	readonly request: LlmConnectorRequest;
}

/**
 * Client-visible non-streaming invoke result — the post-scan upstream
 * `chat.completion` projected onto a flat shape. Streaming calls return an
 * `AsyncGenerator<string>` of token chunks instead of this object.
 */
export interface ConnectorLlmResult {
	readonly text: string;
	readonly model: string;
	readonly usage?: {
		readonly prompt_tokens: number;
		readonly completion_tokens: number;
		readonly total_tokens: number;
	};
	readonly blocked?: boolean;
}

/**
 * Identity the provider needs to mint a `LlmConnectorEnvelope`. Carried on
 * `AgentLoopConfig.connectorContext` and on `GatewayProviderConfig` — the
 * same record drives both the loop's dispatch decision and the provider's
 * envelope fields.
 */
export interface ConnectorContext {
	readonly tenant_id: string;
	readonly agent_id: string;
	readonly agent_did: string;
	readonly connector_id: string;
	readonly connector_mode: ConnectorMode;
	readonly credential_ref?: CredentialRef;
}

// File variants share connector_type and narrow further on action_id.
export type ConnectorEnvelope =
	| HttpConnectorEnvelope
	| DbConnectorEnvelope
	| FileReadConnectorEnvelope
	| FileWriteConnectorEnvelope
	| FileDeleteConnectorEnvelope
	| LlmConnectorEnvelope
	| BrowserConnectorEnvelope;

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
