import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { apiBaseUrlOf, buildCatalog, DEFAULT_BASE_URL, fetchModelStatus, PROVIDER_ID, storedCatalogOf } from "./src/omlx.ts";
import type { OmlxModelDefinition } from "./src/omlx.ts";

type RefreshModels = NonNullable<ProviderConfig["refreshModels"]>;

export default function omlxExtension(pi: ExtensionAPI): void {
	let catalog: OmlxModelDefinition[] | undefined;

	const refreshModels = async (context: Parameters<RefreshModels>[0]) => {
		if (context.signal.aborted) return undefined;
		const baseUrl = apiBaseUrlOf(context.baseUrl ?? DEFAULT_BASE_URL);
		const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;

		if (!context.allowNetwork || !apiKey) {
			// Pi selects the startup model offline. Apply the current URL to its saved capabilities.
			return (catalog ?? storedCatalogOf(context.stored))?.map((model) => ({ ...model, baseUrl }));
		}

		const status = await fetchModelStatus({ baseUrl, apiKey, signal: context.signal });
		if (context.signal.aborted) return undefined;
		const discovered = buildCatalog(status, baseUrl);

		// Pi checks the refresh generation before updating the store and the in-memory snapshot.
		const published = await context.publish({
			persist: { models: discovered, checkedAt: Date.now() },
			update: () => { catalog = discovered; },
		});
		return published ? discovered : undefined;
	};

	pi.registerProvider(PROVIDER_ID, {
		name: "oMLX",
		api: "openai-completions",
		authHeader: true,
		// Pi's composer treats undefined as "keep current catalog".
		refreshModels: refreshModels as RefreshModels,
	});
}
