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
 */

import type { ConnectorActionId, ConnectorMode, ConnectorType } from "./types.js";

export interface ConnectorToolBinding {
	readonly name: string;
	readonly connector_id: string;
	readonly connector_type: ConnectorType;
	readonly default_action: ConnectorActionId;
	readonly default_mode: ConnectorMode;
}

export class ToolRegistry {
	private readonly bindings = new Map<string, ConnectorToolBinding>();

	register(binding: ConnectorToolBinding): void {
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
