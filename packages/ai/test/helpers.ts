import type { MODELS } from "../src/models.generated.js";
import { getModels } from "../src/models.js";
import type { Api, KnownProvider, Model } from "../src/types.js";

type ProviderModelId<TProvider extends KnownProvider> = keyof (typeof MODELS)[TProvider];

type ApiOfModel<T> = T extends { api: infer A } ? (A extends Api ? A : never) : never;

type ProviderModel<TProvider extends KnownProvider> = Model<
	ApiOfModel<(typeof MODELS)[TProvider][ProviderModelId<TProvider>]>
>;

type ProviderApi<TProvider extends KnownProvider> = ApiOfModel<(typeof MODELS)[TProvider][ProviderModelId<TProvider>]>;

/**
 * Return a registered model for `provider`, resolved from the live catalog at
 * runtime so tests stay valid when the generated model union rotates.
 * Pass `filter` to pick a model with specific properties (reasoning, input, id...).
 *
 * Without a filter, prefer a current alias id over a dated `-YYYYMMDD`
 * snapshot: the catalog has no `deprecated`/`eol` flag, but providers retire
 * the dated snapshots first (e.g. `claude-3-5-haiku-20241022`) while the
 * undated alias (`claude-haiku-4-5`, `gpt-5`) tracks the current release.
 * Tests needing a specific capability must still pass a filter — the default
 * only avoids the retired-snapshot trap, it does not pick a reasoning model.
 */
export function testModel<TProvider extends KnownProvider>(
	provider: TProvider,
	filter?: (model: ProviderModel<TProvider>) => boolean,
): ProviderModel<TProvider> {
	const models = getModels(provider) as ProviderModel<TProvider>[];
	const model = filter ? models.find(filter) : (models.find((m) => !/-\d{8}$/.test(m.id)) ?? models[0]);
	if (!model) {
		throw new Error(`No model found for provider "${provider}"${filter ? " matching filter" : ""}`);
	}
	return model;
}

/**
 * Like {@link testModel}, but narrows the return type to a specific `api`.
 * Use when the test calls a provider function typed to one api
 * (e.g. `streamAnthropic` needs `Model<"anthropic-messages">`).
 */
export function testModelForApi<TProvider extends KnownProvider, TApi extends ProviderApi<TProvider> & Api>(
	provider: TProvider,
	api: TApi & ProviderApi<TProvider>,
	filter?: (model: ProviderModel<TProvider>) => boolean,
): Model<TApi> {
	const models = getModels(provider) as ProviderModel<TProvider>[];
	const model = models.find((m) => m.api === api && (!filter || filter(m)));
	if (!model) {
		throw new Error(`No model with api "${api}" found for provider "${provider}"`);
	}
	return model as Model<TApi>;
}
