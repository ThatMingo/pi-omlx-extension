import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, capabilityOf, isChatModel, levelsOf, modelConfigOf, statusUrlOf, fetchModelStatus, PI_LEVELS } from "../src/omlx.ts";
import * as fixtures from "./fixtures/omlx-status.ts";

const BASE_URL = "http://127.0.0.1:8000/v1";

test("filtering keeps every chat model and drops oMLX's non-chat entries", () => {
	const kept = fixtures.catalog.filter((model) => isChatModel(model).included).map((model) => model.id);
	assert.deepEqual(kept, fixtures.expectedChatIds);

	assert.equal(isChatModel(fixtures.drafter).reason, "helper model (draft/MTP)");
	assert.equal(isChatModel(fixtures.hidden).reason, "hidden in oMLX");
	assert.equal(isChatModel(fixtures.realtime).reason, "realtime voice model");
	assert.equal(isChatModel(fixtures.markitdown).reason, "model_type=markitdown");
	assert.equal(isChatModel(fixtures.embedding).reason, "model_type=embedding");
	assert.equal(isChatModel(fixtures.audioService).reason, "model_type=audio_tts");
	assert.equal(isChatModel(fixtures.serviceWithoutLimits).reason, "model_type=indexer without chat limits");
});

test("an unknown chat family with reported limits is not excluded", () => {
	assert.equal(isChatModel(fixtures.unknownChatType).included, true);
	assert.equal(isChatModel(fixtures.limitlessChat).included, true, "a chat model without limit fields stays selectable");
});

test("catalog build returns exactly the selectable chat models", () => {
	const models = buildCatalog(fixtures.catalog, BASE_URL);
	assert.deepEqual(models.map((model) => model.id), fixtures.expectedChatIds);
	assert.deepEqual(models.map((model) => model.name), fixtures.expectedChatIds, "Pi id and label are oMLX's own model id");
	for (const model of models) {
		assert.equal(model.provider, "omlx");
		assert.equal(model.api, "openai-completions");
		assert.equal(model.baseUrl, BASE_URL, "the base URL Pi configured for this provider");
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	}
});

test("full dial exposes off + reported efforts and nothing else", () => {
	const capability = capabilityOf(fixtures.fullDial);
	assert.equal(capability.reasoning, true);
	assert.equal(capability.supportsReasoningEffort, true);
	assert.deepEqual(levelsOf(capability), ["off", "low", "medium", "high", "xhigh"]);
	assert.deepEqual(capability.thinkingLevelMap, {
		off: "off",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	});
});

test("a missing stop is removed rather than remapped to a neighbour", () => {
	const capability = capabilityOf(fixtures.missingHigh);
	assert.equal(capability.thinkingLevelMap.high, null, "oMLX would alias 'high' to 'xhigh'; the extension does not");
	assert.deepEqual(levelsOf(capability), ["off", "low", "medium", "xhigh"]);
});

test('"max" is offered only when oMLX names it', () => {
	assert.equal(capabilityOf(fixtures.withMax).thinkingLevelMap.max, "max");
	assert.deepEqual(levelsOf(capabilityOf(fixtures.withMax)), ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.equal(capabilityOf(fixtures.fullDial).thinkingLevelMap.max, null);
});

test("thinking toggle without a dial offers one thinking level and sends no effort", () => {
	const capability = capabilityOf(fixtures.toggleOnly);
	assert.equal(capability.reasoning, true);
	assert.equal(capability.supportsReasoningEffort, false);
	assert.deepEqual(levelsOf(capability), ["off", "low"]);
});

test("an effort dial without a thinking switch offers no off level", () => {
	const capability = capabilityOf(fixtures.effortNoToggle);
	assert.equal(capability.thinkingLevelMap.off, null, "oMLX offers no 'off' for this model either");
	assert.deepEqual(levelsOf(capability), ["low", "high"]);
});

test("a template that reads reasoning_effort without naming levels gets oMLX's canonical dial", () => {
	assert.deepEqual(levelsOf(capabilityOf(fixtures.unnamedEfforts)), ["off", "low", "medium", "high", "xhigh", "max"]);
});

test("a model without reasoning control is not a reasoning model", () => {
	const capability = capabilityOf(fixtures.plainChat);
	assert.equal(capability.reasoning, false);
	assert.equal(capability.supportsReasoningEffort, false);
	assert.deepEqual(capability.efforts, []);
});

test("oMLX family-specific reasoning overrides match its own selector", () => {
	const base = { ...fixtures.plainChat, thinking_default: null, reasoning_efforts: null };
	const levels = (config_model_type: string, changes: Partial<typeof base> = {}) =>
		levelsOf(capabilityOf({ ...base, config_model_type, ...changes }));

	assert.deepEqual(levels("DeepSeek-V4"), ["off", "low", "high", "max"]);
	assert.deepEqual(levels("deepseek_v41"), ["off", "low", "high", "max"]);
	assert.deepEqual(levels("minimax_m3"), ["off", "low"]);
	assert.deepEqual(levels("gpt_oss", { reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] }), ["low", "medium", "high"]);
	assert.deepEqual(levels("k2_horizon", { thinking_default: true }), ["low", "medium", "high"], "K2 Horizon forces thinking on");
});

test("vision depends on the discovered model type, not the serving engine", () => {
	const textOnly = modelConfigOf({ ...fixtures.plainChat, engine_type: "vlm", model_type: "llm" }, BASE_URL);
	const vision = modelConfigOf({ ...fixtures.plainChat, engine_type: "batched", model_type: "vlm" }, BASE_URL);
	assert.deepEqual(textOnly.input, ["text"]);
	assert.deepEqual(vision.input, ["text", "image"]);
});

test("model metadata: capabilities, modalities, and limits come from oMLX", () => {
	const model = modelConfigOf(fixtures.fullDial, BASE_URL);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"], "vlm engine reports image input");
	assert.equal(model.contextWindow, 262144);
	assert.equal(model.maxTokens, 65536);
	assert.equal(model.compat?.thinkingFormat, "qwen");
	assert.equal(model.compat?.supportsReasoningEffort, true);
	assert.equal(model.compat?.maxTokensField, "max_tokens");
	assert.equal(model.compat?.supportsStore, false);
	assert.equal(model.compat?.supportsDeveloperRole, false);
	assert.equal(model.compat?.supportsStrictMode, false);
	assert.equal(model.compat?.supportsUsageInStreaming, true);

	const plain = modelConfigOf(fixtures.plainChat, BASE_URL);
	assert.equal(plain.reasoning, false);
	assert.equal(plain.thinkingLevelMap, undefined);
	assert.equal(plain.compat?.thinkingFormat, undefined, "no thinking parameters are sent at all");
	assert.equal(plain.compat?.supportsReasoningEffort, false);
	assert.deepEqual(plain.input, ["text"]);
});

test("limits use the tightest reported value and never exceed the context window", () => {
	const capped = modelConfigOf(
		{ ...fixtures.plainChat, max_context_window: 4096, model_context_length: 131072, max_tokens: 65536 },
		BASE_URL,
	);
	assert.equal(capped.contextWindow, 4096);
	assert.equal(capped.maxTokens, 4096);

	const fallback = modelConfigOf(fixtures.limitlessChat, BASE_URL);
	assert.equal(fallback.contextWindow, 32768);
	assert.equal(fallback.maxTokens, 4096);
});

test("every definition states all Pi thinking levels explicitly", () => {
	for (const model of buildCatalog(fixtures.catalog, BASE_URL)) {
		if (!model.reasoning || !model.thinkingLevelMap) continue;
		assert.deepEqual(Object.keys(model.thinkingLevelMap).sort(), [...PI_LEVELS].sort());
	}
});

test("status URL derives from the provider base URL", () => {
	assert.equal(statusUrlOf("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1/models/status");
	assert.equal(statusUrlOf("http://127.0.0.1:8000/v1/"), "http://127.0.0.1:8000/v1/models/status");
	assert.equal(statusUrlOf("http://127.0.0.1:8000"), "http://127.0.0.1:8000/v1/models/status");
	assert.equal(statusUrlOf("http://host.test:8000/v1"), "http://host.test:8000/v1/models/status");
	assert.equal(statusUrlOf("http://host.test/api/v2"), "http://host.test/api/v2/models/status");
});

async function fetchWith(payload: unknown, init: { status?: number; text?: string } = {}) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl = (async (url: string | URL, requestInit?: RequestInit) => {
		calls.push({ url: String(url), init: requestInit ?? {} });
		return new Response(init.text ?? JSON.stringify(payload), {
			status: init.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

test("the catalog request is a GET that reuses the provided key as a bearer token", async () => {
	const { calls, fetchImpl } = await fetchWith(fixtures.statusPayload);
	const models = await fetchModelStatus({ baseUrl: BASE_URL, apiKey: "pi-configured-key", fetchImpl });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/models/status");
	assert.equal(calls[0].init.method ?? "GET", "GET");
	assert.deepEqual(calls[0].init.headers, { Accept: "application/json", Authorization: "Bearer pi-configured-key" });
	assert.equal(models.length, fixtures.catalog.length);
});

test("failures name the endpoint and status without repeating the key", async () => {
	const { fetchImpl } = await fetchWith({ error: { code: "authentication_error", message: "nope" } }, {
		status: 401,
		text: '{"error":{"code":"authentication_error","message":"nope"}}',
	});
	const error = await fetchModelStatus({ baseUrl: BASE_URL, apiKey: "secret-key-value", fetchImpl }).catch((e) => e);
	assert.match(error.message, /401/);
	assert.match(error.message, /authentication_error/);
	assert.ok(!error.message.includes("secret-key-value"), "errors must not echo the credential");

	const network = await fetchModelStatus({
		baseUrl: BASE_URL,
		apiKey: "secret-key-value",
		fetchImpl: (async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
		}) as unknown as typeof fetch,
	}).catch((e) => e);
	assert.match(network.message, /catalog request failed/);
	assert.match(network.message, /ECONNREFUSED/);
	assert.ok(!network.message.includes("secret-key-value"));

	const malformed = await fetchModelStatus({
		baseUrl: BASE_URL,
		apiKey: "key",
		fetchImpl: (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
	}).catch((e) => e);
	assert.match(malformed.message, /no model list/);
});
