# mode-coverage QA — dismissed findings (orchestrator triage)

Lane: magcarta-pi-mono `packages/agent/test/connector/mode-coverage.test.ts`.
Two correctness-lens findings reviewed and DISMISSED with evidence — not fixed.

## [HIGH] `JSON.parse(init?.body ?? "null")` — claimed BodyInit→string type error
DISMISSED. `FetchLike` (src/providers/gateway-provider.ts:58-63) declares
`init.body?: string`, not standard `RequestInit.body: BodyInit`. `init?.body`
is already `string | undefined`; `?? "null"` narrows to `string`. `tsgo -p
packages/agent/tsconfig.build.json` exits 0 on the file. Reviewer assumed the
DOM fetch signature. Not a compile error.

## [MEDIUM] `vi.spyOn(connectorDispatch,"dispatchViaConnector")` won't intercept a named import
DISMISSED. `agent-loop.ts:14` does `import { dispatchViaConnector }` (named
import) and `vi.spyOn` on the module namespace intercepts it under this vitest
setup — proven empirically: the proxy row's
`expect(dispatchViaConnector).toHaveBeenCalledTimes(1)` PASSES (10/10 cases).
Reviewer speculated a failure that demonstrably does not occur.

Simplify lens PASSed; security PASSed. The two in-scope MEDIUMs from the prior
round (artifact-write in finally; llm-typed envelope to executeBrowser) WERE
fixed in commit 32675d31.
