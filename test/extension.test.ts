import assert from "node:assert/strict";
import test from "node:test";
import omlxExtension from "../pi-omlx-model-picker.ts";

type Publication = { persist?: { models?: Array<Record<string, any>>; checkedAt?: number }; update?: () => void };

type RefreshContext = {
	allowNetwork: boolean;
	signal: AbortSignal;
	baseUrl?: string;
	credential?: { type: "api_key"; key?: string } | { type: "oauth" };
	/** Pi's persisted provider entry (`models-store.json`), passed on every refresh phase. */
	stored?: { models?: Array<Record<string, any>>; checkedAt?: number };
};

type Registered = { name: string; config: Record<string, any> };

/**
 * Loads the extension against a stand-in for Pi's extension API and drives `refreshModels`
 * exactly as Pi's provider composer does: the returned array is published only after the call
 * returns, so a failed refresh leaves the current catalog in place.
 */
function load(configure?: (config: Record<string, any>) => void, options: { publishAccepts?: boolean } = {}) {
	const registrations: Registered[] = [];
	const pi = {
		registerProvider(name: string, config: Record<string, any>) {
			configure?.(config);
			registrations.push({ name, config });
		},
	} as unknown as Parameters<typeof omlxExtension>[0];

	omlxExtension(pi);
	const registration = registrations[0];
	const state = { models: registration.config.models as unknown[] | undefined, persisted: undefined as Publication["persist"] };

	const refresh = async (context: RefreshContext) => {
		const refreshed = await registration.config.refreshModels({
			publish: async (publication: Publication) => {
				if (publication.persist) state.persisted = publication.persist;
				publication.update?.();
				// Pi's publication is generation-checked: false means this refresh was superseded.
				return options.publishAccepts ?? true;
			},
			...context,
		});
		// Mirrors composeModelProvider: `if (refreshed) publish({ update })`.
		if (refreshed) state.models = refreshed;
		return refreshed;
	};

	return { registration, state, refresh, ids: () => (state.models ?? []).map((model: any) => model.id), persistedIds: () => (state.persisted?.models ?? []).map((model: any) => model.id) };
}

function fetchReturning(payloads: Array<() => unknown>) {
	const requests: string[] = [];
	let call = 0;
	const fetchImpl = (async (url: string | URL) => {
		requests.push(String(url));
		const next = payloads[Math.min(call++, payloads.length - 1)];
		return new Response(JSON.stringify(next()), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	globalThis.fetch = fetchImpl;
	return requests;
}

const status = (...models: Array<Record<string, unknown>>) => ({ models });
const chatModel = (id: string) => ({
	id,
	model_type: "llm",
	engine_type: "batched",
	is_helper: false,
	is_hidden: false,
	realtime_voice: false,
	realtime_stt: false,
	model_context_length: 32768,
	max_context_window: 32768,
	max_tokens: 4096,
	reasoning_efforts: ["low", "medium"],
	thinking_default: true,
	loaded: true,
});

const signal = () => new AbortController().signal;

test("registers the oMLX provider as a dynamic provider with Pi's own credentials", () => {
	const { registration } = load();
	assert.equal(registration.name, "omlx");
	assert.equal(registration.config.name, "oMLX");
	assert.equal(registration.config.api, "openai-completions");
	assert.equal(registration.config.authHeader, true, "sends Pi's existing key as a bearer token");
	assert.equal(typeof registration.config.refreshModels, "function");
	assert.equal(registration.config.apiKey, undefined, "the extension introduces no credential");
	assert.equal(registration.config.baseUrl, undefined, "Pi's configured base URL stays authoritative");
	assert.equal(registration.config.models, undefined, "the catalog comes from refreshModels");
	assert.equal(Object.keys(registration.config).sort().join(","), "api,authHeader,name,refreshModels");
});

test("an offline refresh keeps the current catalog and never touches the network", async () => {
	const requests = fetchReturning([() => status(chatModel("Model-A"))]);
	const harness = load();

	assert.equal(await harness.refresh({ allowNetwork: false, signal: signal() }), undefined);
	assert.equal(requests.length, 0, "no network in the offline phase");
	assert.deepEqual(harness.ids(), []);

	await harness.refresh({ allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } });
	assert.deepEqual(harness.ids(), ["Model-A"]);

	// A later offline refresh (PI_OFFLINE=1) re-publishes what was last discovered.
	const offline = await harness.refresh({ allowNetwork: false, signal: signal() });
	assert.deepEqual((offline ?? []).map((model: any) => model.id), ["Model-A"]);
	assert.deepEqual(harness.ids(), ["Model-A"]);
	assert.equal(requests.length, 1);
});

test("no Pi-configured key means no request and no catalog change", async () => {
	const requests = fetchReturning([() => status(chatModel("Model-A"))]);
	const harness = load();
	await harness.refresh({ allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1" });
	await harness.refresh({ allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "oauth" } });
	assert.equal(requests.length, 0);
	assert.deepEqual(harness.ids(), []);
});

test("models installed in oMLX appear and models removed from oMLX disappear", async () => {
	const requests = fetchReturning([
		() => status(chatModel("Model-A"), chatModel("Model-B")),
		() => status(chatModel("Model-A"), chatModel("Model-C")),
		() => status(chatModel("Model-A")),
	]);
	const harness = load();
	const context = { allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } };

	await harness.refresh(context);
	assert.deepEqual(harness.ids(), ["Model-A", "Model-B"]);

	await harness.refresh(context);
	assert.deepEqual(harness.ids(), ["Model-A", "Model-C"], "added model appears, removed model disappears");

	await harness.refresh(context);
	assert.deepEqual(harness.ids(), ["Model-A"]);
	assert.equal(requests.length, 3);
});

test("the base URL used for the request is the one Pi composed for the provider", async () => {
	const requests = fetchReturning([() => status(chatModel("Model-A"))]);
	const harness = load();
	await harness.refresh({ allowNetwork: true, signal: signal(), baseUrl: "http://lanhost:8100/v1", credential: { type: "api_key", key: "k" } });
	assert.deepEqual(requests, ["http://lanhost:8100/v1/models/status"]);

	await harness.refresh({ allowNetwork: true, signal: signal(), credential: { type: "api_key", key: "k" } });
	assert.deepEqual(requests[1], "http://127.0.0.1:8000/v1/models/status", "loopback default when Pi has no base URL");
});

test("a failed refresh rejects so Pi reports it and keeps the previous catalog", async () => {
	let fail = false;
	const requests: string[] = [];
	globalThis.fetch = (async (url: string | URL) => {
		requests.push(String(url));
		if (fail) return new Response('{"error":{"code":"server_error"}}', { status: 503, headers: { "content-type": "application/json" } });
		return new Response(JSON.stringify(status(chatModel("Model-A"))), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;

	const harness = load();
	const context = { allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } };
	await harness.refresh(context);
	assert.deepEqual(harness.ids(), ["Model-A"]);

	fail = true;
	const error = await harness.refresh(context).catch((e) => e);
	assert.match(error.message, /503/);
	assert.deepEqual(harness.ids(), ["Model-A"], "the last known catalog survives a failing refresh");

	// The retained catalog is what an offline refresh would show.
	const offline = await harness.refresh({ allowNetwork: false, signal: signal() });
	assert.deepEqual((offline ?? []).map((model: any) => model.id), ["Model-A"]);
	assert.deepEqual(harness.ids(), ["Model-A"]);
});

test("helper and non-chat entries never reach Pi's catalog", async () => {
	fetchReturning([
		() =>
			status(
				chatModel("Chat-Model"),
				{ ...chatModel("Draft-Model"), is_helper: true },
				{ ...chatModel("Hidden-Model"), is_hidden: true },
				{ ...chatModel("Voice-Model"), realtime_voice: true },
				{ ...chatModel("Embed-Model"), model_type: "embedding" },
				{ id: "MarkItDown", model_type: "markitdown", engine_type: "markitdown" },
			),
	]);
	const harness = load();
	await harness.refresh({ allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } });
	assert.deepEqual(harness.ids(), ["Chat-Model"]);
});

test("a successful read hands the catalog to Pi's own store, offline phases never write it", async () => {
	const requests = fetchReturning([() => status(chatModel("Model-A"))]);
	const harness = load();
	await harness.refresh({ allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } });
	assert.deepEqual(harness.persistedIds(), ["Model-A"], "published through Pi's context.publish, so Pi's models-store.json holds it");
	assert.equal(typeof harness.state.persisted?.checkedAt, "number");

	const persisted = harness.state.persisted;
	await harness.refresh({ allowNetwork: false, signal: signal() });
	assert.equal(harness.state.persisted, persisted, "an offline refresh persists nothing: an absent or failed read must not overwrite what was discovered");
	assert.equal(requests.length, 1);
});

test("a fresh extension instance restores the persisted catalog in its offline phase", async () => {
	fetchReturning([() => status(chatModel("Model-A"))]);
	const first = load();
	await first.refresh({ allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } });
	assert.deepEqual(first.persistedIds(), ["Model-A"]);

	// Next Pi process: new extension instance, no memory of the previous read, Pi hands over the entry.
	const requests = fetchReturning([() => status(chatModel("Model-A"))]);
	const second = load();
	const offline = await second.refresh({ allowNetwork: false, signal: signal(), stored: { models: first.state.persisted?.models, checkedAt: 1746000000000 } });
	assert.deepEqual((offline ?? []).map((model: any) => model.id), ["Model-A"], "startup must already know the models and their capabilities");
	assert.equal(offline?.[0].reasoning, true);
	assert.equal(offline?.[0].thinkingLevelMap.medium, "medium", "the persisted capability map survives, unmodified");
	assert.equal(offline?.[0].thinkingLevelMap.high, null, "a level oMLX never reported stays unavailable");
	assert.equal(requests.length, 0, "restoring is offline work");
});

test("a stored entry can only restore this provider's own chat models", async () => {
	const harness = load();
	const offline = await harness.refresh({
		allowNetwork: false,
		signal: signal(),
		stored: {
			models: [
				{ id: "Model-A", provider: "omlx", api: "openai-completions" },
				{ id: "AnotherProvider", provider: "openai", api: "openai-completions" },
				{ id: "NotChat", provider: "omlx", type: "classifier" },
				{ id: "", provider: "omlx" },
				{ id: 7, provider: "omlx" },
				"nonsense",
				{ id: "Chat", provider: "omlx", type: "chat" },
			],
		},
	});
	assert.deepEqual((offline ?? []).map((model: any) => model.id), ["Model-A", "Chat"], "a foreign or malformed entry cannot inject models");
});

test("a restored catalog adopts the base URL Pi is configured with now", async () => {
	fetchReturning([() => status(chatModel("Model-A"))]);
	const first = load();
	await first.refresh({ allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } });
	assert.equal(first.state.persisted?.models?.[0].baseUrl, "http://127.0.0.1:8000/v1");

	// oMLX now listens elsewhere. The restored entry must not keep the retired URL: Pi honors a
	// model's own base URL above the provider URL, so an unrestamped entry would talk to the old
	// host for the whole session — the read that could correct it only happens after startup.
	const requests = fetchReturning([() => status(chatModel("Model-A"))]);
	const second = load();
	const offline = await second.refresh({
		allowNetwork: false,
		signal: signal(),
		baseUrl: "http://lanhost:8100/v1",
		stored: { models: first.state.persisted?.models, checkedAt: 1746000000000 },
	});
	assert.deepEqual((offline ?? []).map((model: any) => model.baseUrl), ["http://lanhost:8100/v1"], "the configured URL wins over the stored one");
	assert.equal(offline?.[0].reasoning, true, "restamping changes the URL, not the capabilities");
	assert.equal(offline?.[0].thinkingLevelMap.medium, "medium");
	assert.equal(requests.length, 0, "restoring is still offline work");
});

test("a publication Pi rejects is applied nowhere and remembered nowhere", async () => {
	fetchReturning([() => status(chatModel("Model-A"))]);
	const harness = load(undefined, { publishAccepts: false });
	const result = await harness.refresh({ allowNetwork: true, signal: signal(), baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } });
	assert.equal(result, undefined, "a superseded refresh hands Pi no catalog");
	assert.deepEqual(harness.ids(), [], "and its models are not applied to the live catalog");

	const offline = await harness.refresh({ allowNetwork: false, signal: signal() });
	assert.equal(offline, undefined, "a catalog Pi discarded is not kept as this process's last known catalog");
});

test("a refresh Pi already cancelled asks oMLX nothing", async () => {
	const requests = fetchReturning([() => status(chatModel("Model-A"))]);
	const harness = load();
	const controller = new AbortController();
	controller.abort();
	const result = await harness.refresh({ allowNetwork: true, signal: controller.signal, baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } });
	assert.equal(result, undefined);
	assert.equal(requests.length, 0, "no request once the refresh has been cancelled");
});

test("a cancellation that races the response publishes nothing and applies nothing", async () => {
	const controller = new AbortController();
	globalThis.fetch = (async () => {
		// Cancelled while the response was in flight: the body still arrives, the refresh is still dead.
		controller.abort();
		return new Response(JSON.stringify(status(chatModel("Model-A"))), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;

	const harness = load();
	const result = await harness.refresh({ allowNetwork: true, signal: controller.signal, baseUrl: "http://127.0.0.1:8000/v1", credential: { type: "api_key", key: "k" } });
	assert.equal(result, undefined, "a cancelled refresh yields nothing");
	assert.equal(harness.state.persisted, undefined, "nothing is persisted for a cancelled refresh");
	assert.deepEqual(harness.ids(), []);
});
