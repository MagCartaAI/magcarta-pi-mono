import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.js";

describe("generated model metadata", () => {
	it("never reports maxTokens above contextWindow", () => {
		const violations = Object.entries(MODELS).flatMap(([provider, models]) =>
			Object.values(models)
				.filter((model) => model.maxTokens > model.contextWindow)
				.map((model) => ({
					provider,
					id: model.id,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				})),
		);

		expect(violations).toEqual([]);
	});
});
