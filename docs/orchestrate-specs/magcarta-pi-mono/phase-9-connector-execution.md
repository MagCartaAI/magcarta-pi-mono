# Phase 9 — Connector execution + tool-mode branching

> Spec for the pi-mono agent package. Design content only.

## Objective

Wire the remaining `ConnectorExecutor` methods on `GatewayProvider`, widen
the connector envelope union to all five variants, broaden
`ConnectorEnvelopeBuilder` to mint db/file/browser envelopes, and branch
per-tool execution on connector mode inside the agent loop.

The thin-slice baseline wires only `authorize()` and `executeLlm()`. The five
envelope-taking executor stubs throw `NotImplementedError`, the envelope
builder is HTTP-only, and `executeToolCalls` runs every tool locally with no
connector logic. This phase makes proxy-mode tool calls real: a
registry-bound tool with `default_mode === "proxy"` mints an envelope and
dispatches through the provider; approval-mode and unregistered tools keep
the local path.

### Settled design facts

Verified by direct source reads. Cited, not re-derived.

**`src/providers/gateway-provider.ts`.** `authorize()` and `executeLlm()`
(delegating to `executeLlmInvoke` in `gateway-llm.ts`) are the only wired
methods. `executeHttp`/`executeDb`/`executeFileRead`/`executeFileWrite`/
`executeFileDelete` throw `NotImplementedError` (~:202–219); `classify()`
(~:188) and `recordDecision()` (~:196) throw too and stay out of scope.
`executeBrowser` throws `NotImplementedError` today; it keeps `Promise<never>`
but moves to the real deny-mapping below. The provider is stateless apart
from `gatewayUrl`, `tokenProvider`, `connectorContext`, `fetchImpl`.
`tokenProvider` failure → `GatewayProviderError` `TOKEN_PROVIDER_FAILED`;
transport failure → `TRANSPORT_ERROR`. New executors reuse that
normalization.

**`src/providers/gateway-llm.ts`.** Owns `mintLlmEnvelope`, the error
taxonomy (`GovernanceDenied`, `ClassificationBlocked`,
`SubjectBindingViolation`, `ModeMismatch`, `ConnectorRejected`,
`GatewayUnavailable`), and `raiseConnectorError`. That mapper takes
`(response, gatewayUrl, actionId)` and maps a non-OK
`{ error: { code, message, category } }` in fixed order: `subject_binding` →
`SubjectBindingViolation`; `403`+`policy` → `GovernanceDenied`;
`classification` → `ClassificationBlocked`; `mode_mismatch` → `ModeMismatch`;
other `4xx`+category → `ConnectorRejected`; else `GatewayUnavailable`. The
six envelope-taking methods reuse this exact mapper.

**`src/connector/types.ts`.** `ConnectorEnvelope` is currently
`HttpConnectorEnvelope | LlmConnectorEnvelope`. The package mirrors
`@magcarta/contracts` inline — NO import exists and the publish boundary
forbids one; new wire shapes are mirrored verbatim from
`magcarta-contracts/src/schemas/connector-envelope.ts`.
`BaseConnectorEnvelope` already carries every shared field
(`schema_version:"0.6.0"`, `attempt_id`, `tenant_id`, `agent_id`,
`agent_did`, `connector_id`, `connector_type`, `connector_mode`,
`action_id`, `action_timestamp`, `classification_hints?`, `credential_ref?`);
new envelopes extend it by narrowing `connector_type`/`action_id` and adding
`request`.

**`src/connector/envelope-builder.ts`.** `build(input)` returns
`HttpConnectorEnvelope` and throws on any non-HTTP `connector_type`. It reads
the `ToolRegistry` binding, mints `attempt_id`, stamps `action_timestamp`,
copies identity fields. `extractHttpRequest` sets the fail-loud convention:
missing `params.url`, unsupported method, non-string `body`/`headers`/
`query_params` all throw — never silently drop. New extractors follow it.

**`src/connector/tool-registry.ts`.** `ConnectorToolBinding` =
`{ name, connector_id, connector_type, default_action, default_mode }`.
`register` throws `DuplicateToolRegistrationError` on a duplicate name unless
`{ override: true }`. This phase adds an optional `credential_ref?:
CredentialRef` field so a proxy-bound http or browser tool can carry the
secret the gateway resolves; db and file bindings omit it (see the
credential rule below).

**`src/agent-loop.ts` (~493 lines).** `executeToolCalls` (~:369) resolves
each `AgentTool` by name, validates args, calls `tool.execute(id,
validatedArgs, signal, onUpdate)` — no connector logic. The LLM-turn branch
already exists in `streamAssistantResponse` (~:298): `connectorProvider` set
+ `connectorContext?.connector_mode === "proxy"` routes through
`dispatchViaConnector` — untouched by this phase. The file carries no
`action_type:"model_call"`/`"api_call"` hardcodes (grep-verified) and is
flagged near the ~700-LOC cap, so tool dispatch is extracted to a new
sibling module.

**`src/types.ts`.** `AgentLoopConfig` already carries
`connectorProvider?: ConnectorExecutor` and `connectorContext?:
ConnectorContext`; this phase adds `toolRegistry?: ToolRegistry`.

**Byte-pinned interface (`tests/e2e/governance-api.test.ts`).** The e2e test
asserts the `ConnectorExecutor` declaration in `src/governance.ts` is
byte-identical. Signatures and field order do NOT change:
`executeHttp(HttpConnectorEnvelope)`, `executeDb(ConnectorEnvelope)`,
`executeFileRead/Write/Delete(ConnectorEnvelope)`, `executeLlm(LlmInvokeRequest,
signal?)`, `executeBrowser(ConnectorEnvelope): Promise<never>`. The widened
union is type-compatible with that text as written.

**Execution model — minting asymmetry.** `executeHttp`, `executeDb`,
`executeFileRead`, `executeFileWrite`, `executeFileDelete`, `executeBrowser`
take a PRE-MINTED envelope built by the caller via `ConnectorEnvelopeBuilder`.
The provider only POSTs it, returns `response.json()` on `ok`, calls
`raiseConnectorError` on `!ok`. It does NOT re-mint — re-minting duplicates
the builder and double-stamps `attempt_id`/`action_timestamp`. `executeLlm`
is the asymmetry: it takes a flat `LlmInvokeRequest`, mints internally, and
so needs `connectorContext`. The six envelope-takers do NOT — the envelope
already carries `tenant_id`/`agent_id`/`agent_did`/`connector_id`/
`connector_mode`/`credential_ref`. The spec keeps this asymmetry explicit;
the pinned signatures fix it.

**Gateway execute routes** (verified in
`magcarta-gateway-service/src/routes/connector/`). Each takes the full
envelope as POST body: `POST /api/connector/http/execute`,
`/api/connector/db/execute`, `/api/connector/file/read`,
`/api/connector/file/write`, `/api/connector/file/delete`,
`/api/connector/browser/navigate`. Error bodies use
`{ error: { code, message, category } }` → `raiseConnectorError`. The
navigate route is gateway-Cedar-forbidden
(`forbid-connector-browser-navigate.cedar`): a real call returns 403 `policy`
→ `GovernanceDenied`; a 2xx from that stub route is a gateway bug.

**Credential rule (proxy `credential_ref`).** The contract `.superRefine`
requires `credential_ref` on proxy envelopes ONLY for types that do not
resolve credentials through `connection_ref` — i.e. `http` and `browser`.
`db` and `file` are exempt: the gateway resolves
`{ bucket/host, region, credential_ref }` from `DbConnectionsConfig` /
`FileConnectionsConfig` keyed on `connection_ref`. So a proxy http or
browser envelope NEEDS `credential_ref`; a proxy db or file envelope never
does. The per-tool credential source is `ConnectorToolBinding.credential_ref`
(new optional field): the builder copies `binding.credential_ref` onto the
envelope. A proxy http or browser binding missing `credential_ref` throws a
`MALFORMED_ENVELOPE`-style build error at mint time, before fetch — same
fail-closed convention `mintLlmEnvelope` uses for `connectorContext`.
`connection_ref` (the db/file target alias) is separate and travels inside
`request`, extracted from `params`.

**ADR serialization (de-scope check).** Nothing in `packages/agent/src`
serializes or emits ADR events — `recordDecision` is a `NotImplementedError`
stub and `ConnectorAdrEvent` is type-only. The `connector_mode`-omission rule
lives gateway-side; pi-mono asserts nothing. See the de-scoped requirement.

### Non-goals

- `classify()` and `recordDecision()` — a later phase; they stay
  `NotImplementedError`.
- Any change to the LLM-turn dispatch path (`dispatchViaConnector`,
  `mintLlmEnvelope`, `executeLlmInvoke`).
- The demo repository.
- Any `@magcarta/contracts` import — wire shapes are mirrored inline.
- A local fallback for a proxy-bound tool that is missing its provider or
  context — that fails as an `isError` tool result, never silently local.
- `executeBrowser` ever returning a value — signature stays `Promise<never>`.
- Changing the `ConnectorExecutor` interface declaration text — it is
  byte-pinned by the e2e governance test.

## Impact radius

Files touched are enumerated in the Structure table below. Production edits:
`connector/types.ts`, `connector/envelope-builder.ts`,
`providers/gateway-provider.ts`, `types.ts`, `agent-loop.ts`. New production
file: `connector-tool-dispatch.ts`. Test surface: three new test files plus
the `mode-coverage.test.ts` browser rows.

**d=1 (WILL BREAK) dependents.**
- `test/connector/mode-coverage.test.ts` asserts `executeBrowser` rejects
  `NotImplementedError`. New behavior replaces that with the real
  deny-mapping, so the two `browser` rows are updated to the new expectation.
- `test/connector/envelope-builder.test.ts` accesses HTTP-only request
  fields and asserts the retired non-HTTP rejection — widening `build()`'s
  return to the union breaks those accesses under the root type-check;
  adapted in place.
- `src/providers/gateway-provider.ts` cannot reuse `raiseConnectorError`
  while it stays module-private in `gateway-llm.ts` — the mapper is
  exported (unchanged body) as part of this change.
- `tests/e2e/governance-api.test.ts` pins `ConnectorExecutor` byte-identical —
  signatures stay verbatim; the widened union keeps them compiling.

**Graph check.**
- `GatewayProvider` upstream: LOW — a single importer (`gateway-llm.ts`
  re-export chain plus tests).
- `executeToolCalls` upstream: LOW — internal to `agent-loop.ts`, four
  impacted call sites inside the loop flow.
- Index was built fresh in this worktree mid-design; radius confirmed by
  graph impact plus direct reads of the call sites above.

**Risk: MEDIUM.** The change adds new behavior behind a registry-mode
branch and widens a type union; it does not alter the wired `authorize()` /
`executeLlm()` paths or the pinned interface text. The main risk is the
envelope-builder broadening touching shared mint logic — kept isolated by
per-type extractors.

## Structure

New and modified units with single responsibilities.

| File | Status | Responsibility |
| --- | --- | --- |
| `src/connector/types.ts` | Modified | Mirror the 5 contract request/envelope shapes inline; widen the union |
| `src/connector/tool-registry.ts` | Modified | `ConnectorToolBinding.credential_ref?: CredentialRef` optional field |
| `src/connector/envelope-builder.ts` | Modified | Mint db/file/browser envelopes; fail-loud param extraction per type; copy `binding.credential_ref` |
| `src/providers/gateway-llm.ts` | Modified | Export `raiseConnectorError` (currently module-private) so `gateway-provider.ts` reuses it — signature unchanged |
| `src/providers/gateway-provider.ts` | Modified | POST pre-minted envelopes to execute routes; map errors; `executeBrowser` deny path |
| `src/types.ts` | Modified | `AgentLoopConfig.toolRegistry` optional field |
| `src/agent-loop.ts` | Modified | Delegate tool dispatch to the new module; drop inline connector-free body |
| `src/connector-tool-dispatch.ts` | New | Per-tool proxy/approval branch, envelope build + execute, result→`AgentToolResult` adapter, isError mapping |
| `test/providers/gateway-provider-executors.test.ts` | New | Executor happy/deny/token/transport/malformed-success coverage |
| `test/connector/envelope-builder-broaden.test.ts` | New | Broadened builder coverage |
| `test/connector/envelope-builder.test.ts` | Modified | Adapt to the widened `build()` return (request narrowing, llm-rejection, credential_ref copy) |
| `test/agent-loop-tool-mode.test.ts` | New | Loop branching + result-conversion coverage |
| `test/connector/mode-coverage.test.ts` | Modified | Browser rows → new deny expectation |

The extraction target is `connector-tool-dispatch.ts`, a sibling of
`connector-dispatch.ts` (which owns the LLM-turn path). The split mirrors
the existing convention: `connector-dispatch.ts` owns the LLM turn,
`connector-tool-dispatch.ts` owns per-tool connector routing, and
`agent-loop.ts` keeps turn orchestration.

## Requirements

### Requirement: Widen the connector type union

`src/connector/types.ts` SHALL define inline request and envelope
interfaces for the db, file-read, file-write, file-delete, and browser
connectors, mirroring the `magcarta-contracts` zod schemas field-for-field
(readonly properties, no import). `ConnectorEnvelope` SHALL widen to the
union of all seven variants (http, db, file-read, file-write, file-delete,
llm, browser). No `@magcarta/contracts` import SHALL appear.

Each envelope narrows `connector_type`/`action_id` on `BaseConnectorEnvelope`
and adds `request`. Request shapes to mirror (all `readonly`):

- `DbConnectorRequest` — `{ connection_ref; sql_text; parameters?: unknown[];
  row_limit?: number; result_format?: "inline"|"opaque_handle"|"auto" = "auto";
  read_replica_ok?: boolean = false }`. `row_limit` when present SHALL be a
  positive integer (builder-validated). Envelope `connector_type:"db"`,
  `action_id:"connector::db::query"|"connector::db::mutate"`.
- `FileReadConnectorRequest` — `{ connection_ref; key; operation:
  "get"|"head"|"list"; range?: { start_byte; end_byte }; result_format?:
  ... = "auto" }`. `key` empty ONLY for `list` (builder-enforced); an
  omitted `key` SHALL be treated as the empty string, so `get`/`head` throw
  and `list` maps to a bucket-root listing. `range` when present SHALL be
  `{ start_byte; end_byte }` of nonnegative integers with
  `start_byte <= end_byte` (builder-validated). `connector_type:"file"`,
  `action_id:"connector::file::read"`.
- `FileWriteConnectorRequest` — `{ connection_ref; destination: { key;
  content_type; storage_class?; metadata?: Record<string,string> };
  from_handle?: uuid; inline_content?: string }`. Exactly one of
  `from_handle`/`inline_content` (XOR, builder-enforced); `inline_content`
  is base64 bytes.
  `connector_type:"file"`, `action_id:"connector::file::write"`.
- `FileDeleteConnectorRequest` — `{ connection_ref; key }`.
  `connector_type:"file"`, `action_id:"connector::file::delete"`.
- `BrowserConnectorRequest` — `{ url }`, a string that parses as a URL.
  `connector_type:"browser"`, `action_id:"connector::browser::navigate"`.

#### Scenario: union widening

**WHEN** a value typed `ConnectorEnvelope` is narrowed on `connector_type`
**THEN** all seven variants resolve to their concrete envelope interface
**AND** the `db` variant accepts both `connector::db::query` and
`connector::db::mutate` action ids, the three `file` variants distinguish on
`action_id`, and no variant carries a field outside the mirrored contract
shape.

#### Scenario: publish boundary

**WHEN** the package source is searched
**THEN** no `@magcarta/contracts` import exists
**AND** each new interface is declared `readonly`-fielded inline in
`types.ts`.

### Requirement: Envelope-driven executor methods

`GatewayProvider` SHALL implement `executeHttp`, `executeDb`,
`executeFileRead`, `executeFileWrite`, and `executeFileDelete`. Each method
SHALL take its pre-minted envelope as the POST body and SHALL NOT mint,
re-mint, or mutate the envelope — `attempt_id`, `action_timestamp`, and all
identity fields arrive already set by `ConnectorEnvelopeBuilder`. Each SHALL
resolve the bearer token via `tokenProvider`, POST the serialized envelope
to its route, and call `raiseConnectorError(response, gatewayUrl,
envelope.action_id)` on `!ok`.

On `ok` each method SHALL parse the body as JSON and return the parsed
value unchanged. If `response.json()` rejects (non-JSON or malformed body
on a success status), the method SHALL throw `GatewayUnavailable` — the
same contract `executeLlm` uses for an unparseable success body. No
schema validation is applied at this layer; the dispatch adapter validates
against the result contract (see the result-conversion requirement).

Error normalization SHALL match the LLM path: `tokenProvider` throwing maps
to `GatewayProviderError` code `TOKEN_PROVIDER_FAILED`; a `fetchImpl`
transport throw maps to code `TRANSPORT_ERROR`; a non-OK response maps
through `raiseConnectorError` (`subject_binding` → `SubjectBindingViolation`,
403+`policy` → `GovernanceDenied`, `classification` → `ClassificationBlocked`,
`mode_mismatch` → `ModeMismatch`, other 4xx+category → `ConnectorRejected`,
else `GatewayUnavailable`).

The six envelope-taking methods SHALL NOT read `connectorContext` — the
envelope already carries identity. Only `executeLlm` (which mints) needs it.

Route table:

| Method | Route |
| --- | --- |
| `executeHttp` | `POST /api/connector/http/execute` |
| `executeDb` | `POST /api/connector/db/execute` |
| `executeFileRead` | `POST /api/connector/file/read` |
| `executeFileWrite` | `POST /api/connector/file/write` |
| `executeFileDelete` | `POST /api/connector/file/delete` |

#### Scenario: happy passthrough

**WHEN** `executeDb` is called with a pre-minted `DbConnectorEnvelope` and
the gateway answers 200 with a JSON result body
**THEN** the provider POSTs the serialized envelope to
`/api/connector/db/execute` with `Authorization: Bearer <token>`
**AND** resolves to the parsed `response.json()` unchanged
**AND** does not modify any envelope field.

#### Scenario: policy deny mapping

**WHEN** the gateway answers 403 with `{ error: { code, message,
category: "policy" } }`
**THEN** each executor rejects with `GovernanceDenied`
**AND** the thrown error carries the gateway `code` and `action_id`.

#### Scenario: classification + token + transport

**WHEN** the gateway answers a `classification`-category error, OR
`tokenProvider` throws, OR `fetchImpl` throws before any response
**THEN** the executor rejects with `ClassificationBlocked`,
`GatewayProviderError(TOKEN_PROVIDER_FAILED)`, or
`GatewayProviderError(TRANSPORT_ERROR)` respectively.

#### Scenario: no re-minting

**WHEN** any of the six envelope-taking executors runs
**THEN** it neither calls `generateAttemptId` nor overwrites
`action_timestamp`
**AND** `connectorContext` is not dereferenced on that path.

#### Scenario: malformed success body

**WHEN** the gateway answers 200 but `response.json()` rejects
**THEN** the executor rejects with `GatewayUnavailable`
**AND** the action id and route are named in the error message.

### Requirement: executeBrowser deny mapping

`GatewayProvider.executeBrowser` SHALL keep its `Promise<never>` signature,
take the pre-minted `BrowserConnectorEnvelope`, POST it to
`POST /api/connector/browser/navigate`, and on `!ok` SHALL call
`raiseConnectorError`. Because the gateway Cedar policy forbids browser
navigation, a real call yields a 403 `policy` deny → `GovernanceDenied`. A
2xx response SHALL be treated as a gateway bug (the stub route succeeding)
and SHALL throw `GatewayUnavailable`, never resolve. `executeBrowser` SHALL
NOT throw `NotImplementedError`.

#### Scenario: forbidden maps to denied

**WHEN** `executeBrowser` is invoked with a minted browser envelope and the
gateway answers 403 `{ error: { category: "policy" } }`
**THEN** it rejects with `GovernanceDenied`.

#### Scenario: success is a bug

**WHEN** the navigate route answers 2xx
**THEN** `executeBrowser` rejects with `GatewayUnavailable` rather than
returning a value.

### Requirement: Broaden the envelope builder

`ConnectorEnvelopeBuilder.build()` SHALL return the widened
`ConnectorEnvelope` union and SHALL mint db, file-read, file-write,
file-delete, and browser envelopes in addition to http. For each type the
builder SHALL extract the request from `input.params` with fail-loud
validation: a missing required field or a mistyped value throws a
descriptive error; nothing is silently dropped. Type-specific rules SHALL
hold:

- `db`: `connection_ref` and `sql_text` required; `result_format` defaults
  `"auto"`, `read_replica_ok` defaults `false`; `action_id` narrows to the
  binding's `default_action` (`query`/`mutate`).
- `file` read: `connection_ref`, `operation` required; `key` required
  non-empty UNLESS `operation === "list"` (empty = bucket-root list);
  `result_format` defaults `"auto"`.
- `file` write: `connection_ref` and `destination.{key,content_type}`
  required; exactly one of `from_handle`/`inline_content` (XOR) — zero or
  two throws.
- `file` delete: `connection_ref` and `key` required.
- `browser`: `url` required and SHALL parse as a URL (fail-fast at the
  builder boundary, mirroring `extractHttpRequest`'s existing URL check).

`action_id` SHALL narrow from `binding.default_action`; a `default_action`
inconsistent with `connector_type` throws (same convention as the existing
`narrowHttpAction`). `connector_mode` SHALL stamp from
`binding.default_mode`. The `llm` connector type SHALL be rejected by the
builder with a descriptive error — llm envelopes are minted by
`mintLlmEnvelope` inside `executeLlm`, not by this builder (the simplest
honest rule: one minter per family, and the tool-call path has no flat
`LlmInvokeRequest` to mint from).

On a proxy-mode build the builder SHALL copy `binding.credential_ref` onto
the envelope for `http` and `browser` types. A proxy http or browser
binding missing `credential_ref` SHALL throw at build time — before any
fetch — matching the fail-closed contract rule (proxy + non-connection_ref
type requires it). `db` and `file` envelopes SHALL NOT read
`binding.credential_ref` for their credential; their credential resolves
gateway-side via `request.connection_ref`.

#### Scenario: db mint

**WHEN** `build()` runs for a `db`-bound tool with `connection_ref`,
`sql_text`, and no optional fields
**THEN** it returns a `DbConnectorEnvelope` with `connector_type:"db"`,
the binding's `default_action`, `result_format:"auto"`,
`read_replica_ok:false`, and a fresh `attempt_id`.

#### Scenario: file-write XOR

**WHEN** a `file`-write build supplies both `from_handle` and
`inline_content`, or neither
**THEN** `build()` throws a descriptive XOR error.

#### Scenario: list-key rule

**WHEN** a `file` read build supplies `operation:"list"` with empty `key`
**THEN** it succeeds; `operation:"get"` or `"head"` with empty `key` throws.

#### Scenario: fail-loud extraction

**WHEN** a required field is missing or mistyped (e.g. non-string
`connection_ref`, numeric `sql_text`, non-uuid `from_handle`, a
`row_limit ≤ 0`, a `range` with `start_byte > end_byte` or a negative
bound, an empty `connection_ref`, or a `browser` `url` that is not a valid
URL)
**THEN** `build()` throws naming the field, and never emits a
partially-populated envelope.

#### Scenario: proxy credential copy

**WHEN** `build()` runs for a proxy-bound `http` or `browser` binding that
carries `credential_ref`
**THEN** the envelope's `credential_ref` equals `binding.credential_ref`
**AND** a proxy `http`/`browser` binding without `credential_ref` throws at
build time, before fetch.

### Requirement: Per-tool connector-mode branching in the agent loop

`AgentLoopConfig` SHALL gain optional `toolRegistry?: ToolRegistry`.
`executeToolCalls` SHALL delegate its connector routing to a new
`connector-tool-dispatch.ts` module and SHALL branch per tool call as
follows, given a `ConnectorToolBinding` resolved from the registry by
`toolCall.name`:

- `binding.default_mode === "proxy"` → build the envelope via
  `ConnectorEnvelopeBuilder.build({ tool_name, params, tenant_id, agent_id,
  agent_did })`, then dispatch to the matching
  `connectorProvider.execute*` method for `binding.connector_type`
  (`http→executeHttp`, `db→executeDb`, `file→executeFile{Read,Write,Delete}`
  chosen by `default_action`, `browser→executeBrowser`). The gateway result
  SHALL be converted to an `AgentToolResult` by the adapter in
  `connector-tool-dispatch.ts` (see the result-conversion requirement).
- `binding.default_mode === "approval"` OR the tool is unregistered → the
  existing local `tool.execute(id, validatedArgs, signal, onUpdate)` path,
  unchanged.
- proxy-bound tool + `config.connectorProvider` absent → an `isError` tool
  result; NO silent local fallback.
- proxy-bound tool + `config.connectorContext` absent → an `isError` tool
  result (the builder needs `tenant_id`/`agent_id`/`agent_did` from it).
- proxy dispatch throwing (`GovernanceDenied`, `ClassificationBlocked`,
  transport, etc.) → an `isError` tool result carrying the error message,
  same convention as a local `tool.execute` throw.

The builder input's `tenant_id`/`agent_id`/`agent_did` SHALL come from
`config.connectorContext` (the same identity record that drives LLM
envelope minting). The extraction SHALL keep `executeToolCalls`' existing
event lifecycle (`tool_execution_start`/`update`/`end`, `ToolResultMessage`
synthesis, steering-message skip) byte-for-byte — only the
"how does this call execute" branch changes.

**Abort / cancellation.** The pinned `ConnectorExecutor` signatures take no
`AbortSignal` for the envelope executors (`executeLlm` is the sole
exception with `signal?`), so an abort cannot interrupt an in-flight
gateway fetch through the interface. `executeToolCalls` today carries no
`signal.aborted` check between iterations — its only interruption is the
steering-message skip — so this phase does not add per-call cancellation;
that is a contract-honest gap, not a behavior to fake. A proxy-bound tool
that has dispatched its fetch completes its HTTP round-trip and produces
its tool result; the abort signal reaches the next queued tool only through
the steering mechanism that already exists. No new signal plumbing is added
to the pinned signatures; adding a between-call `signal.aborted` check is
deferred to the phase that can change the interface, and is recorded here
as a known limitation so the gap is explicit rather than silent.

#### Scenario: proxy dispatch

**WHEN** a registered tool with `default_mode:"proxy"` and
`connector_type:"db"` is called, and provider + context are present
**THEN** the loop mints a `DbConnectorEnvelope` and calls
`connectorProvider.executeDb`
**AND** the gateway result becomes the tool result content
**AND** `tool.execute` is never invoked.

#### Scenario: approval and unregistered stay local

**WHEN** a tool has `default_mode:"approval"`, or has no registry binding
**THEN** the loop runs local `tool.execute` with validated args
**AND** no envelope is built and no provider method is called.

#### Scenario: missing provider or context

**WHEN** a proxy-bound tool is called but `connectorProvider` or
`connectorContext` is absent
**THEN** the tool result is `isError` naming the missing prerequisite
**AND** `tool.execute` is not invoked as a fallback.

### Requirement: Gateway result → `AgentToolResult` adapter

`connector-tool-dispatch.ts` SHALL own an adapter that converts the raw
gateway result JSON returned by an `execute*` method into an
`AgentToolResult`. The gateway routes return a per-connector execution
result object (authoritative schemas:
`magcarta-contracts/src/schemas/execution-result.ts` — `HttpExecutionResult`,
`DbExecutionResult`, `FileReadResult`, `FileWriteResult`, `FileDeleteResult`).
The adapter SHALL NOT re-serialize or reshape the result — it wraps it.

The adapter SHALL validate the returned body against the mirrored result
shape selected by `binding.connector_type` **and** the dispatched
`action_id` — `file` read/write/delete share `connector_type:"file"` but
have distinct result schemas, so a `FileWriteResult` returned from
`executeFileRead` is a malformed result, not a valid one. (Mirroring the
relevant `*ExecutionResult` variant inline, no contracts import.)
Validation covers each variant the dispatched action can return: `db`
accepts both `inline` (carries `rows`) and `opaque_handle` (carries
`handle`); `file` read accepts `inline`/`opaque_handle`/`listing`/
`metadata`.

`AgentToolResult` has no `isError` field — the `isError` flag is set by the
`executeToolCalls` catch block on the emitted event and the
`ToolResultMessage`. On a parse or validation failure the adapter SHALL
therefore **throw** an error naming the action id and the validation
failure; the preserved loop catch then produces the `isError` tool result
and marks both the event and the message `isError:true`. A malformed
result is a contract violation, not a tool-level error, so it must surface
as `isError`, never as a silent success.

The mapped `AgentToolResult` SHALL carry:
- `content`: a single text content block whose text is
  `JSON.stringify(result)` — the full result object (rows / content /
  handle / status_code / headers), preserving opaque handles and base64
  file bytes verbatim so the model sees the structured payload.
- `details`: the parsed result object as `details` — the typed result
  carried for programmatic consumers (handle re-mint, classification).

The adapter SHALL distinguish gateway-side execution failures encoded in
the result shape from transport/governance errors: a 200 result whose
schema validates is a successful tool result even when the embedded
`status_code`/operation denotes an upstream failure (the model needs to see
a 404-from-HTTP-tool as data, not as a thrown error). Governance/
transport/classification failures thrown by the `execute*` method itself
become `isError` via the branch requirement, not via this adapter.

#### Scenario: inline db result

**WHEN** `executeDb` resolves to a `DbExecutionResult` with
`result_format:"inline"` and `rows`
**THEN** the adapter returns a non-error `AgentToolResult` whose `content`
text is the stringified result and whose `details` is the parsed object.

#### Scenario: opaque handle preserved

**WHEN** a `db` or `file` read result carries `result_format:"opaque_handle"`
and a `handle` block
**THEN** `details` and the stringified `content` carry the handle verbatim —
no re-mint, no unwrap.

#### Scenario: file-read variants

**WHEN** a `file` read result is any of `inline` / `listing` / `metadata`
**THEN** it validates and maps to a non-error `AgentToolResult` —
each supported variant round-trips through the adapter.

#### Scenario: malformed result

**WHEN** an `execute*` method resolves to a body that fails the mirrored
result schema — including a result valid for a different file action —
**THEN** the adapter throws naming the action id and the schema failure
**AND** the loop catch produces an `isError` tool result (event and
`ToolResultMessage` both `isError:true`).

#### Scenario: upstream failure is data

**WHEN** `executeHttp` resolves to a valid `HttpExecutionResult` whose
`status_code` is 404
**THEN** the adapter returns a non-error `AgentToolResult` carrying the 404
result — not a thrown error.

#### Scenario: abort between calls

**WHEN** `executeToolCalls` processes a queued list and the abort signal
fires while a proxy-bound tool's fetch is in flight
**THEN** that call completes its HTTP round-trip and produces its tool
result — the wire call is not aborted mid-flight and no new signal is added
**AND** the next queued call is skipped only by the existing
steering-message mechanism, not by a `signal.aborted` check (none exists
between iterations today).

### Requirement: Test coverage

New tests under `packages/agent/test/` SHALL cover, using `FetchLike` /
registry / provider doubles per the existing suite style and table-driven
rows:

- `test/providers/gateway-provider-executors.test.ts`: each of the five
  executors — happy JSON passthrough, 403 `policy` → `GovernanceDenied`,
  `classification` → `ClassificationBlocked`, `tokenProvider` throw →
  `TOKEN_PROVIDER_FAILED`, `fetchImpl` throw → `TRANSPORT_ERROR`, and a 200
  with a non-JSON body → `GatewayUnavailable`.
- `test/connector/envelope-builder-broaden.test.ts`: a happy mint per new
  type, the file-write XOR (both/neither), the file-read list-key rule,
  the proxy `credential_ref` copy + missing-credential throw for
  http/browser, and one fail-loud missing/mistyped case per type.
- `test/agent-loop-tool-mode.test.ts`: proxy mints + dispatches with the
  result→`AgentToolResult` adapter (content stringify + details carry),
  approval / unregistered local, missing provider → `isError`, missing
  context → `isError`, malformed-result (incl. a result valid for a
  different file action) → `isError` via adapter throw, and a valid-result /
  upstream-failure (e.g. http 404) → non-error.
- `test/providers/gateway-provider-executors.test.ts` (or the mode file):
  `executeBrowser` deny mapping (403 `policy` → `GovernanceDenied`) and 2xx
  → `GatewayUnavailable`.
- `test/connector/mode-coverage.test.ts`: update the two `browser` rows to
  the new `executeBrowser` expectation (no longer `NotImplementedError`).

#### Scenario: executor table

**WHEN** the executors test runs each executor against a `FetchLike` double
scripted with {200 JSON, 403 policy, classification, token-throw,
transport-throw}
**THEN** every row resolves or rejects with the class and code in the
route/error contract above.

#### Scenario: builder gates

**WHEN** the builder test runs the per-type table
**THEN** happy rows produce correctly-typed envelopes and each XOR /
list-key / fail-loud row throws its named error.

### Requirement: ADR `connector_mode` omission — de-scoped

pi-mono `packages/agent/src` SHALL contain no ADR serialization surface to assert against. `recordDecision` SHALL remain a `NotImplementedError` stub and `ConnectorAdrEvent` a type-only declaration — no code path emits or serializes an ADR event. The rule that a non-connector ADR omits `connector_mode` therefore lives gateway-side, and pi-mono asserts nothing about it. No test or assertion is added because there is no pi-mono surface to pin. Evidence: `recordDecision` stub at `src/providers/gateway-provider.ts` (~:196), `ConnectorAdrEvent` type-only at `src/governance.ts`; no `JSON.stringify` / emit of ADR events in `src/`.

#### Scenario: No pi-mono ADR surface

- **WHEN** `grep -rn "recordDecision\|ConnectorAdrEvent\|JSON.stringify.*adr\|emit.*adr" packages/agent/src/` is audited
- **THEN** it shows only the `recordDecision` `NotImplementedError` stub and the type-only `ConnectorAdrEvent` declaration — no serialization or emit path exists.

### Requirement: Keep-out — no governance action-type hardcodes

`src/agent-loop.ts` SHALL carry no `action_type: "model_call"` or
`action_type: "api_call"` hardcodes after the dispatch extraction. Verified
by grep returning no matches for `action_type` / `"model_call"` /
`"api_call"` in the file.

#### Scenario: grep keep-out

**WHEN** `agent-loop.ts` and `connector-tool-dispatch.ts` are searched for
`action_type`, `"model_call"`, `"api_call"`
**THEN** no matches are found.

## Acceptance criteria

1. **Type-check.** From the repo root of this worktree,
   `npx tsgo --noEmit` exits clean (the same invocation `npm run check`
   runs after `biome check`). Do NOT use `npm test` or `npm run build` —
   repo `AGENTS.md` forbids them.
2. **Targeted tests.** From `packages/agent`,
   `npx tsx ../../node_modules/vitest/dist/cli.js --run
   test/providers/gateway-provider-executors.test.ts
   test/connector/envelope-builder-broaden.test.ts
   test/agent-loop-tool-mode.test.ts
   test/connector/mode-coverage.test.ts` passes. The vitest binary resolves
   at the hoisted `node_modules/vitest/dist/cli.js`.
3. **E2E pin intact.** From `packages/agent`,
   `npx tsx ../../node_modules/vitest/dist/cli.js --run
   tests/e2e/governance-api.test.ts` still passes — `ConnectorExecutor` and
   the five sibling declarations remain byte-identical.
4. **Keep-out.** `grep -nE 'action_type|"model_call"|"api_call"'
   packages/agent/src/agent-loop.ts packages/agent/src/connector-tool-dispatch.ts`
   returns no matches.

## Exit criteria

- All seven `ConnectorExecutor` methods are wired on `GatewayProvider`; the
  only remaining `NotImplementedError` throws on the class are `classify()`
  and `recordDecision()` (a later phase).
- `ConnectorEnvelope` is the seven-variant union; the package still has no
  `@magcarta/contracts` import.
- `build()` mints http + db + file-read + file-write + file-delete +
  browser envelopes and rejects `llm` with a descriptive error.
- A proxy-bound tool dispatches through the provider; approval and
  unregistered tools run locally; missing provider/context on a proxy-bound
  tool yields an `isError` result with no local fallback.
- `executeBrowser` rejects via `GovernanceDenied` on the forbidden route,
  never resolves, and no longer throws `NotImplementedError`.
- `agent-loop.ts` shrinks below its prior line count after the dispatch
  extraction and carries no action-type hardcodes.
- The pinned `ConnectorExecutor` declaration and all executor tests pass.

## Sequencing

The build order implied by the structure: the type union is the foundation;
the provider executors are independent of the builder; the builder broadens
next; the loop config and dispatch module follow; `agent-loop.ts` delegates
last. The dependency is types → {provider, builder} → dispatch → loop.
