/**
 * Integration checks against Pi's own provider machinery (read-only imports of the installed
 * package). Nothing here mocks Pi: the extension's registration config is composed by
 * `composeModelProvider` exactly as the coding agent composes it, the thinking levels are read
 * through the same helper Pi's native selectors use, and the request body is produced by Pi's real
 * OpenAI-compatible request builder.
 *
 * Set PI_PACKAGE_DIR to point at a different Pi installation.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import omlxExtension from "../pi-omlx-model-picker.ts";
import { expectedChatIds, statusPayload } from "./fixtures/omlx-status.ts";

const PI_DIR = process.env.PI_PACKAGE_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_AI_DIR = `${PI_DIR}/node_modules/@earendil-works/pi-ai/dist`;
const skip = existsSync(PI_DIR) ? false : `Pi package not found at ${PI_DIR}`;

const composer = await import(`${PI_DIR}/dist/core/provider-composer.js`);
const openaiCompletions = await import(`${PI_AI_DIR}/api/openai-completions.js`);
const modelsModule = await import(`${PI_AI_DIR}/models.js`);

/** The `omlx` entry as Pi's `models.json` configures it today, including a stale manual model. */
const modelsJsonProvider = {
	baseUrl: "http://127.0.0.1:8000/v1",
	api: "openai-completions",
	apiKey: "pi-configured-omlx-key",
	authHeader: true,
	models: [
		{
			id: "FullDial-Model",
			name: "stale manual entry",
			reasoning: false,
			contextWindow: 4096,
			maxTokens: 512,
		},
	],
};

const modelConfig = {
	getProvider: (providerId: string) => (providerId === "omlx" ? modelsJsonProvider : undefined),
};

function extensionConfig() {
	let captured: Record<string, any> | undefined;
	omlxExtension({
		registerProvider: (_name: string, config: Record<string, any>) => {
			captured = config;
		},
	} as never);
	if (!captured) throw new Error("extension did not register a provider");
	return captured;
}

function compose() {
	return composer.composeModelProvider("omlx", undefined, modelConfig, extensionConfig());
}

async function refresh(provider: any) {
	await provider.refreshModels({
		allowNetwork: true,
		force: true,
		signal: new AbortController().signal,
		baseUrl: provider.baseUrl,
		credential: { type: "api_key", key: modelsJsonProvider.apiKey },
		publish: async (publication: { update?: () => void }) => {
			publication.update?.();
			return true;
		},
	});
}

function serveStatus(models: unknown[]) {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ models }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

const sseBody = [
	'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
	'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
	'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n',
	"data: [DONE]\n\n",
].join("");

const context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] } as never;

async function wirePayload(model: any, reasoning: string) {
	let payload: Record<string, any> | undefined;
	const stream = openaiCompletions.streamSimple(model, context, {
		apiKey: modelsJsonProvider.apiKey,
		reasoning,
		maxTokens: 1024,
		maxRetries: 0,
		onPayload: (candidate: Record<string, any>) => {
			payload = candidate;
		},
		fetch: (async () => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
	});
	for await (const event of stream) void event;
	if (!payload) throw new Error("no request payload was produced");
	return payload;
}

async function catalogWith(models: unknown[] = statusPayload.models) {
	serveStatus(models);
	const provider = compose();
	await refresh(provider);
	return { provider, models: provider.getModels() as any[] };
}

test("the extension registration composes into a Pi provider", { skip }, async () => {
	const provider = compose();
	assert.equal(provider.id, "omlx");
	assert.equal(provider.baseUrl, "http://127.0.0.1:8000/v1", "Pi's configured base URL is authoritative");
	assert.equal(typeof provider.refreshModels, "function", "dynamic provider: Pi refreshes it on /model");
	assert.equal(typeof provider.stream, "function");
	assert.equal(typeof provider.streamSimple, "function");
	assert.doesNotThrow(() => composer.validateExtensionProvider("omlx", undefined, modelsJsonProvider, extensionConfig()));
});

test("Pi's existing oMLX key is reused, with no new credential or login", { skip }, async () => {
	const provider = compose();
	assert.equal(typeof provider.auth.apiKey?.resolve, "function");
	const resolved = await provider.auth.apiKey.resolve({
		ctx: { env: async () => undefined },
		signal: new AbortController().signal,
	});
	assert.equal(resolved.auth.apiKey, "pi-configured-omlx-key");
	assert.equal(resolved.auth.headers?.Authorization, "Bearer pi-configured-omlx-key");
	assert.equal(resolved.source, "configured API key", "the key already configured in Pi's models.json");
});

test("a refresh replaces models.json's stale entry with oMLX's real capabilities", { skip }, async () => {
	const before = compose();
	assert.deepEqual(before.getModels().map((model: any) => model.id), ["FullDial-Model"]);
	assert.equal(before.getModels()[0].reasoning, false, "stale manual entry before the first refresh");

	const { models } = await catalogWith();
	assert.deepEqual(models.map((model) => model.id), expectedChatIds);

	const full = models.find((model) => model.id === "FullDial-Model");
	assert.equal(full.name, "FullDial-Model");
	assert.equal(full.reasoning, true);
	assert.equal(full.thinkingLevelMap.high, "high");
	assert.equal(full.contextWindow, 262144);
	assert.equal(full.maxTokens, 65536);
	assert.deepEqual(full.input, ["text", "image"]);
	assert.equal(full.compat.thinkingFormat, "qwen");
	assert.equal(full.baseUrl, "http://127.0.0.1:8000/v1");
});

test("added models appear and removed models disappear on the next refresh", { skip }, async () => {
	const entry = (id: string) => ({ ...statusPayload.models[0], id });
	const provider = compose();
	const step = async (ids: string[]) => {
		serveStatus(ids.map(entry));
		await refresh(provider);
		return (provider.getModels() as any[]).map((model) => model.id);
	};

	assert.deepEqual(await step(["A", "B"]), ["A", "B"]);
	assert.deepEqual(await step(["A", "C"]), ["A", "C"], "an installed model appears, a removed one disappears");
	assert.deepEqual(await step(["A"]), ["A"]);
	assert.deepEqual(await step(["A", "B", "C", "D"]), ["A", "B", "C", "D"]);
});

test("Pi's thinking selector offers only levels oMLX reported for that model", { skip }, async () => {
	const { models } = await catalogWith();
	const levels = (id: string) => modelsModule.getSupportedThinkingLevels(models.find((model) => model.id === id));

	assert.deepEqual(levels("FullDial-Model"), ["off", "low", "medium", "high", "xhigh"]);
	assert.deepEqual(levels("MissingHigh-Model"), ["off", "low", "medium", "xhigh"]);
	assert.deepEqual(levels("MaxEffort-Model"), ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(levels("ToggleOnly-Model"), ["off", "low"]);
	assert.deepEqual(levels("EffortNoToggle-Model"), ["low", "high"]);
	assert.deepEqual(levels("UnnamedEfforts-Model"), ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(levels("Plain-Model"), ["off"], "no thinking control is offered for a non-reasoning model");
	assert.deepEqual(levels("NewFamily-Model"), ["off", "low", "high"], "unknown chat family keeps oMLX's reported levels");
});

test("the wire payload carries exactly the level Pi selected", { skip }, async () => {
	const { models } = await catalogWith();
	const full = models.find((model) => model.id === "FullDial-Model");

	const medium = await wirePayload(full, "medium");
	assert.equal(medium.model, "FullDial-Model");
	assert.equal(medium.enable_thinking, true);
	assert.equal(medium.reasoning_effort, "medium");
	assert.equal(medium.max_tokens, 1024);
	assert.equal("max_completion_tokens" in medium, false);
	assert.equal("store" in medium, false, "unsupported fields are not sent to oMLX");

	const off = await wirePayload(full, "off");
	assert.equal(off.enable_thinking, false, "Off turns thinking off explicitly");
	assert.equal("reasoning_effort" in off, false);
});

test("a level the model does not support is clamped before it reaches oMLX", { skip }, async () => {
	const { models } = await catalogWith();
	const missingHigh = models.find((model) => model.id === "MissingHigh-Model");
	const toggleOnly = models.find((model) => model.id === "ToggleOnly-Model");
	const noToggle = models.find((model) => model.id === "EffortNoToggle-Model");
	const plain = models.find((model) => model.id === "Plain-Model");

	const high = await wirePayload(missingHigh, "high");
	assert.equal(high.reasoning_effort, "xhigh", "'high' is not in this model's vocabulary, so it is never sent");

	const minimal = await wirePayload(missingHigh, "minimal");
	assert.equal(minimal.reasoning_effort, "low", "Pi's 'minimal' level is not offered and clamps to the nearest supported level");

	const toggle = await wirePayload(toggleOnly, "high");
	assert.equal(toggle.enable_thinking, true);
	assert.equal("reasoning_effort" in toggle, false, "this template ignores reasoning_effort, so nothing is sent");

	const offAttempt = await wirePayload(noToggle, "off");
	assert.equal(offAttempt.enable_thinking, true, "this model has no thinking-off switch, so Off clamps up");
	assert.equal(offAttempt.reasoning_effort, "low");

	const plainRequest = await wirePayload(plain, "high");
	assert.equal("enable_thinking" in plainRequest, false, "a non-reasoning model gets no thinking parameters");
	assert.equal("reasoning_effort" in plainRequest, false);
});

test("a failed catalog read leaves the catalog untouched", { skip }, async () => {
	const provider = compose();
	globalThis.fetch = (async () =>
		new Response('{"error":{"code":"server_error"}}', { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
	const published = await provider
		.refreshModels({
			allowNetwork: true,
			signal: new AbortController().signal,
			baseUrl: provider.baseUrl,
			credential: { type: "api_key", key: modelsJsonProvider.apiKey },
			publish: async (publication: { update?: () => void }) => {
				publication.update?.();
				return true;
			},
		})
		.then(() => true)
		.catch(() => false);
	assert.equal(published, false, "the refresh rejects so Pi surfaces the error");
	assert.equal(provider.getModels()[0].id, "FullDial-Model", "the previous catalog is still there");
});
