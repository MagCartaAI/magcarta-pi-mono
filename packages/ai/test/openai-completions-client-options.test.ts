import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	lastClientOptions: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}

		chat = {
			completions: {
				create: async () => ({
					async *[Symbol.asyncIterator]() {
						yield {
							choices: [{ delta: {}, finish_reason: "stop" }],
							usage: {
								prompt_tokens: 1,
								completion_tokens: 1,
								prompt_tokens_details: { cached_tokens: 0 },
								completion_tokens_details: { reasoning_tokens: 0 },
							},
						};
					},
				}),
			},
		};
	}

	return { default: FakeOpenAI };
});

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");

function setBrowserOrigin(origin: string): void {
	Object.defineProperty(globalThis, "location", {
		value: { origin },
		configurable: true,
	});
}

async function createClientOptions(baseUrl: string): Promise<unknown> {
	mockState.lastClientOptions = undefined;

	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	void _compat;

	const model: Model<"openai-completions"> = {
		...baseModel,
		api: "openai-completions",
		baseUrl,
	};
	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	await streamSimple(model, context, { apiKey: "test" }).result();

	return mockState.lastClientOptions;
}

afterEach(() => {
	mockState.lastClientOptions = undefined;
	if (originalLocation) {
		Object.defineProperty(globalThis, "location", originalLocation);
		return;
	}
	Reflect.deleteProperty(globalThis, "location");
});

describe("openai-completions client fetch options", () => {
	it("includes credentials for same-origin proxy base URLs", async () => {
		setBrowserOrigin("https://demo.magcarta.test");

		const clientOptions = await createClientOptions("/api/model");

		expect(clientOptions).toMatchObject({
			baseURL: "https://demo.magcarta.test/api/model",
			fetchOptions: { credentials: "include" },
		});
	});

	it("includes credentials for absolute same-origin base URLs", async () => {
		setBrowserOrigin("https://demo.magcarta.test");

		const clientOptions = await createClientOptions("https://demo.magcarta.test/api/model");

		expect(clientOptions).toMatchObject({
			baseURL: "https://demo.magcarta.test/api/model",
			fetchOptions: { credentials: "include" },
		});
	});

	it("omits credentials for cross-origin base URLs", async () => {
		setBrowserOrigin("https://demo.magcarta.test");

		const clientOptions = await createClientOptions("https://openrouter.ai/api/v1");

		expect(clientOptions).toMatchObject({
			baseURL: "https://openrouter.ai/api/v1",
		});
		expect(clientOptions).not.toHaveProperty("fetchOptions");
	});
});
