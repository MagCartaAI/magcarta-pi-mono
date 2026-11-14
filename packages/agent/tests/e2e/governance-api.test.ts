import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

// Retired fields/events must not compile for a consumer; each retained E2
// declaration is pinned as exact text so a dropped field/`readonly` fails.
const retainedDeclarations: Record<string, string> = {
	ClassificationMetadata: `export interface ClassificationMetadata {
	readonly content_type: string;
	readonly size_bytes: number;
	readonly source_tool?: string;
}`,
	ClassificationResult: `export interface ClassificationResult {
	readonly classification_chain: ClassificationChain;
}`,
	GovernanceAuthorizer: `export interface GovernanceAuthorizer {
	authorize(envelope: ConnectorEnvelope): Promise<AuthorizationDecision>;
	classify(attemptId: string, content: Uint8Array, metadata: ClassificationMetadata): Promise<ClassificationResult>;
	recordDecision(event: ConnectorAdrEvent): Promise<void>;
}`,
	ConnectorExecutor: `export interface ConnectorExecutor {
	executeHttp(envelope: HttpConnectorEnvelope): Promise<unknown>;
	executeDb(envelope: ConnectorEnvelope): Promise<unknown>;
	executeFileRead(envelope: ConnectorEnvelope): Promise<unknown>;
	executeFileWrite(envelope: ConnectorEnvelope): Promise<unknown>;
	executeFileDelete(envelope: ConnectorEnvelope): Promise<unknown>;
	executeLlm(request: LlmInvokeRequest, signal?: AbortSignal): Promise<ConnectorLlmResult | AsyncGenerator<string>>;
	executeBrowser(envelope: ConnectorEnvelope): Promise<never>;
}`,
	MagCartaProvider: `export interface MagCartaProvider extends GovernanceAuthorizer, ConnectorExecutor {}`,
	ConnectorAdrEvent: `export interface ConnectorAdrEvent {
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
}`,
};

it("rejects retired public configuration and events while preserving the connector contract", async () => {
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const artifactsDir = resolve(packageRoot, "tests/e2e/artifacts");
	const consumerFile = resolve(artifactsDir, "local/governance-consumer.ts");
	const gates: string[] = [];
	let outcome = "FAIL";
	await mkdir(dirname(consumerFile), { recursive: true });
	try {
		const retiredConfigFields = ["governance", "governanceContext", "envelopeBuilder"];
		const retiredEventTypes = ["governance_evaluate", "governance_decision"];
		await writeFile(consumerFile, [
			'import type { AgentLoopConfig, AgentEvent, MagCartaProvider } from "@mariozechner/pi-agent-core";',
			"declare const config: AgentLoopConfig;",
			"declare const provider: MagCartaProvider;",
			"const currentConfig: AgentLoopConfig = { ...config, connectorProvider: provider };",
			'const currentEvent: AgentEvent = { type: "agent_start" };',
			...retiredConfigFields.map((field, index) =>
				`const retiredConfig${index}: AgentLoopConfig = { ...config, ${field}: undefined };`),
			...retiredEventTypes.map((event, index) =>
				`const retiredEvent${index}: AgentEvent["type"] = "${event}";`),
		].join("\n"));
		const program = ts.createProgram([consumerFile], {
			noEmit: true, strict: true, skipLibCheck: true,
			module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ES2022,
		});
		const diagnostics = ts.getPreEmitDiagnostics(program);
		const consumerDiagnostics = diagnostics.filter(
			(diagnostic) => diagnostic.file?.fileName === consumerFile,
		);
		const messageText = (diagnostic: ts.Diagnostic) =>
			ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
		// Each retired field/event must produce at least one consumer diagnostic
		// whose message names it — asserted by message text, not TS error codes
		// or line numbers, so a compiler version shift can't false-green a
		// still-compiling retired name.
		for (const name of [...retiredConfigFields, ...retiredEventTypes]) {
			const matching = consumerDiagnostics.filter((diagnostic) => {
				const text = messageText(diagnostic);
				return text.includes(`'${name}'`) || text.includes(`"${name}"`);
			});
			expect(
				matching.length,
				`expected a consumer diagnostic naming '${name}' (retired names must not compile)`,
			).toBeGreaterThan(0);
		}
		// The connector-compatibility statements (currentConfig, currentEvent)
		// stay clean. Locate them by identifier, not fixed line index, so a
		// one-line shift in the generated consumer can't move them out of scope.
		const connectorStatements = consumerDiagnostics.filter((diagnostic) => {
			if (!diagnostic.file || diagnostic.start === undefined) return false;
			const text = diagnostic.file.getFullText();
			const statementStart = text.lastIndexOf("const ", diagnostic.start);
			const statement = text.slice(statementStart, text.indexOf("\n", diagnostic.start));
			return /\bcurrentConfig\b|\bcurrentEvent\b/.test(statement);
		});
		expect(connectorStatements, "connector configuration must compile without diagnostics").toEqual([]);
		gates.push("published package rejects all three retired fields and both events; connector configuration compiles");

		const governanceSource = await readFile(resolve(packageRoot, "src/governance.ts"), "utf8");
		for (const [name, declaration] of Object.entries(retainedDeclarations)) {
			expect(
				governanceSource,
				`${name} declaration must remain byte-identical to the pre-removal contract`,
			).toContain(declaration);
		}
		gates.push("all six E2 declarations remain byte-identical to the pre-removal contract");

		for (const filename of ts.sys.readDirectory(resolve(packageRoot, "src"), [".ts"])) {
			expect(await readFile(filename, "utf8"), filename).not.toMatch(
				/ActionEnvelope|GatewayDecision|GovernanceProvider|GovernanceContext|\bToolBinding\b|ContextTaint|\bToolType\b|\bDataClassification\b|\bAdrEvent\b|governance_evaluate|governance_decision/,
			);
		}
		gates.push("agent source contains no retired E1 symbols or events");
		outcome = "PASS";
	} finally {
		await writeFile(resolve(artifactsDir, "governance-api.json"), `${JSON.stringify({ outcome, gates, mocks: [] }, null, 2)}\n`);
	}
});
