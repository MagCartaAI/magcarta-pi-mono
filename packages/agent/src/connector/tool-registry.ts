/**
 * ToolRegistry — per-tool connector metadata lookup (WE2-007, E2-Q9b).
 *
 * Agent runtimes register each tool with its connector ID, connector type,
 * default action, and default mode. The envelope builder reads this registry
 * when constructing a ConnectorEnvelope for an outbound tool call.
 *
 * Phase 9 (WE2-038) wires the demo tools (`search_web`, `query_db`,
 * `export_data`, `upload_file`) through this registry with default_mode set
 * to `proxy` per E2-Q9b.
 *
 * Duplicate registration semantics (review F5, round 3):
 * `register()` throws on duplicate tool names by default. If dynamic
 * reconfiguration is genuinely intended, callers must pass
 * `{ override: true }` explicitly. This prevents silent shadowing of a
 * registered tool by a later `register()` call — a likely source of
 * hard-to-debug misrouting during Phase 9 demo tool wiring.
 */

import type { ConnectorActionId, ConnectorMode, ConnectorType } from "./types.js";

export interface ConnectorToolBinding {
	readonly name: string;
	readonly connector_id: string;
	readonly connector_type: ConnectorType;
	readonly default_action: ConnectorActionId;
	readonly default_mode: ConnectorMode;
}

export interface ToolRegistryRegisterOptions {
	/**
	 * When true, replacing an existing binding under the same `name` is
	 * allowed. Defaults to false: duplicate names throw so misconfiguration
	 * is loud rather than silent.
	 */
	readonly override?: boolean;
}

export class DuplicateToolRegistrationError extends Error {
	constructor(public readonly toolName: string) {
		super(
			`ToolRegistry: tool "${toolName}" is already registered. ` +
				"Pass { override: true } if reconfiguration is intentional.",
		);
		this.name = "DuplicateToolRegistrationError";
	}
}

export class ToolRegistry {
	private readonly bindings = new Map<string, ConnectorToolBinding>();

	register(binding: ConnectorToolBinding, options?: ToolRegistryRegisterOptions): void {
		const override = options?.override ?? false;
		if (this.bindings.has(binding.name) && !override) {
			throw new DuplicateToolRegistrationError(binding.name);
		}
		this.bindings.set(binding.name, binding);
	}

	lookup(toolName: string): ConnectorToolBinding | undefined {
		return this.bindings.get(toolName);
	}

	has(toolName: string): boolean {
		return this.bindings.has(toolName);
	}

	list(): ReadonlyArray<ConnectorToolBinding> {
		return Array.from(this.bindings.values());
	}
}
