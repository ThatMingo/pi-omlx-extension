/**
 * Pi-omlx-model-picker — Pi <-> oMLX model picker.
 *
 * Two features, both built on Pi's native provider architecture:
 *
 *  1. `omlx` is registered as a dynamic provider with `refreshModels`, so Pi's own `/model`
 *     selector re-reads the oMLX catalog on every catalog refresh: models installed in oMLX
 *     appear, models removed from oMLX disappear, no Pi restart needed.
 *  2. Each model's reasoning controls come from oMLX itself and are encoded as Pi model metadata
 *     (`reasoning`, `thinkingLevelMap`, `compat`), so Pi's native thinking selector offers only
 *     levels the model's chat template actually accepts, and Pi's OpenAI-compatible request
 *     builder sends the matching `enable_thinking` / `reasoning_effort` on every request.
 *
 * Nothing else is added: no commands, no UI, no credentials, no config files, no automatic level
 * switching. Endpoint and API key are the ones Pi already has for the `omlx` provider; the
 * extension only issues GET requests. The catalog it reads is handed to Pi with
 * `context.publish({ persist })`, so Pi's own `models-store.json` holds it for the next process;
 * Pi's `models.json` is never written.
 */

import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASE_URL, PROVIDER_ID, buildCatalog, fetchModelStatus, storedCatalogOf, withBaseUrl } from "./src/omlx.ts";
import type { OmlxModelDefinition } from "./src/omlx.ts";

/** Pi's own refresh context, taken from the provider signature it declares — no hand-written copy of it. */
type OmlxRefreshContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];

export default function omlxExtension(pi: ExtensionAPI): void {
	// Last catalog read in this process, in memory only. On top of it Pi can hand back
	// what a previous process persisted, which is what makes a restart start correctly.
	let catalog: OmlxModelDefinition[] | undefined;

	const refreshModels = async (context: OmlxRefreshContext): Promise<ProviderModelConfig[] | undefined> => {
		const baseUrl = context.baseUrl ?? DEFAULT_BASE_URL;

		// What this process already learned, or what an earlier process persisted. Definitions carry
		// their own base URL and Pi honors that above `models.json`, so the restored set is re-stamped
		// with the URL Pi configured for this refresh: a changed oMLX host or port applies at startup
		// instead of lingering until the first successful network read.
		const remembered = withBaseUrl(catalog ?? (context.stored ? storedCatalogOf(context.stored, PROVIDER_ID) : undefined), baseUrl);

		// Pi runs only the offline phase while it starts up — `ModelRuntime.create`, every
		// `registerProvider`, and `createAgentSessionServices` all refresh with `allowNetwork: false` —
		// and only then resolves the selected model, its thinking level, and the scoped model list. The
		// network read happens afterwards, from the interactive mode's background refresh, so the session
		// is already bound to whatever this phase returned. Returning `undefined` leaves Pi's current
		// catalog untouched (its composer applies the list only `if (refreshed)`), which is what happens
		// when nothing has been discovered yet; a failing request rejects instead, so Pi reports it.
		if (!context.allowNetwork || context.signal.aborted) return remembered;

		// Pi supplies the effective credential and base URL its own `models.json` / stored credential
		// configure for this provider, so the extension adds no credential handling of its own.
		const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
		if (!apiKey) return remembered;

		const models = await fetchModelStatus({ baseUrl, apiKey, signal: context.signal });
		if (context.signal.aborted) return undefined;
		const discovered = buildCatalog(models, baseUrl);

		// `publish` is generation-checked: false means this refresh was superseded by a newer one, so
		// neither the persisted entry nor the catalog it produced may be applied — and this process must
		// not remember a catalog Pi has already discarded.
		if (!(await context.publish({ persist: { models: discovered, checkedAt: Date.now() } }))) return undefined;

		catalog = discovered;
		return discovered;
	};

	pi.registerProvider(PROVIDER_ID, {
		name: "oMLX",
		api: "openai-completions",
		authHeader: true,
		// The one deliberate departure from Pi's declared signature: Pi types `refreshModels` as
		// returning `ProviderModelConfig[]`, while returning `undefined` is how Pi is told to keep the
		// catalog it already has. Everything else here is checked against `ProviderConfig`.
		refreshModels: refreshModels as NonNullable<ProviderConfig["refreshModels"]>,
	});
}
