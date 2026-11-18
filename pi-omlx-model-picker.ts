/** Dynamic oMLX catalog for Pi. Discovers models and restores their capabilities at startup. */

import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASE_URL, PROVIDER_ID, buildCatalog, fetchModelStatus, storedCatalogOf, withBaseUrl } from "./src/omlx.ts";
import type { OmlxModelDefinition } from "./src/omlx.ts";

type OmlxRefreshContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];

export default function omlxExtension(pi: ExtensionAPI): void {
	// Remember the last published catalog for Pi's offline refresh phase.
	let catalog: OmlxModelDefinition[] | undefined;

	const refreshModels = async (context: OmlxRefreshContext): Promise<ProviderModelConfig[] | undefined> => {
		const baseUrl = context.baseUrl ?? DEFAULT_BASE_URL;

		// Startup is offline; reuse Pi's stored catalog and its current provider URL.
		const remembered = withBaseUrl(catalog ?? (context.stored ? storedCatalogOf(context.stored, PROVIDER_ID) : undefined), baseUrl);

		if (!context.allowNetwork || context.signal.aborted) return remembered;

		const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
		if (!apiKey) return remembered;

		const models = await fetchModelStatus({ baseUrl, apiKey, signal: context.signal });
		if (context.signal.aborted) return undefined;
		const discovered = buildCatalog(models, baseUrl);

		// Publish before remembering it: an obsolete refresh must not overwrite newer state.
		if (!(await context.publish({ persist: { models: discovered, checkedAt: Date.now() } }))) return undefined;

		catalog = discovered;
		return discovered;
	};

	pi.registerProvider(PROVIDER_ID, {
		name: "oMLX",
		api: "openai-completions",
		authHeader: true,
		// Pi's type omits the valid "keep current catalog" undefined return.
		refreshModels: refreshModels as NonNullable<ProviderConfig["refreshModels"]>,
	});
}
