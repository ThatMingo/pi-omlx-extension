/**
 * Read-only verification against a running oMLX server.
 *
 *   node scripts/verify-omlx.ts                 catalog + the exact fields Pi would send
 *   node scripts/verify-omlx.ts --probe [model]  also runs short completions on a model oMLX
 *                                               already has loaded (never loads a model)
 *
 * The endpoint and API key are the ones Pi already has for the `omlx` provider (its `models.json`
 * or stored credential); the key is never printed. Nothing is written to Pi or oMLX, and no model
 * is loaded, unloaded, or reconfigured.
 */

import { existsSync, readFileSync } from "node:fs";
import omlxExtension from "../pi-omlx-model-picker.ts";

const PI_DIR = process.env.PI_PACKAGE_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_AI_DIR = `${PI_DIR}/node_modules/@earendil-works/pi-ai/dist`;
const PROVIDER_ID = "omlx";

const composer = await import(`${PI_DIR}/dist/core/provider-composer.js`);
const openaiCompletions = await import(`${PI_AI_DIR}/api/openai-completions.js`);
const { getSupportedThinkingLevels } = await import(`${PI_AI_DIR}/models.js`);
const { fetchModelStatus, isChatModel, PI_LEVELS } = await import("../src/omlx.ts");

function piProviderConfig(): { entry: Record<string, any>; path: string } {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`;
	const path = `${agentDir}/models.json`;
	const parsed = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, any>) : {};
	return { entry: parsed?.providers?.[PROVIDER_ID] ?? {}, path };
}

function extensionConfig(): Record<string, any> {
	let config: Record<string, any> | undefined;
	omlxExtension({ registerProvider: (_name: string, input: Record<string, any>) => (config = input) } as never);
	if (!config) throw new Error("extension did not register a provider");
	return config;
}

function publish() {
	return async (publication: { update?: () => void }) => {
		publication.update?.();
		return true;
	};
}

const { entry, path: modelsJsonPath } = piProviderConfig();
const modelConfig = { getProvider: (id: string) => (id === PROVIDER_ID ? entry : undefined) };
const provider = composer.composeModelProvider(PROVIDER_ID, undefined, modelConfig, extensionConfig());
const credential = provider.auth.apiKey
	? await provider.auth.apiKey.resolve({ ctx: { env: async (name: string) => process.env[name] }, signal: new AbortController().signal })
	: undefined;

console.log(`oMLX  ${provider.baseUrl}   (base URL from ${modelsJsonPath})`);
console.log(`API key: ${credential ? `${credential.source} [value not shown]` : "not configured in Pi"}`);

// One status read, reused for the catalog path and for reporting what was filtered out.
const statusModels = credential
	? await fetchModelStatus({ baseUrl: provider.baseUrl, apiKey: credential.auth.apiKey, signal: AbortSignal.timeout(15_000) })
	: [];
const statusFetch = globalThis.fetch;
globalThis.fetch = (async () =>
	new Response(JSON.stringify({ models: statusModels }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
try {
	await provider.refreshModels({
		allowNetwork: true,
		force: true,
		signal: AbortSignal.timeout(15_000),
		baseUrl: provider.baseUrl,
		credential: credential ? { type: "api_key", key: credential.auth.apiKey } : undefined,
		publish: publish(),
	});
} catch (error) {
	console.error(`catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
} finally {
	globalThis.fetch = statusFetch;
}

const models = provider.getModels() as any[];
console.log(`\nPi /model catalog (${models.length} chat models)`);
for (const model of models) {
	console.log(`  ${model.id}  [${model.input.join("+")}]  ctx ${model.contextWindow}, max ${model.maxTokens}`);
	console.log(
		`     levels: ${getSupportedThinkingLevels(model).join(", ")}   depth dial: ${model.compat?.supportsReasoningEffort ? "reasoning_effort" : "enable_thinking only"}`,
	);
}

const skipped = statusModels.filter((item) => !isChatModel(item).included);
if (skipped.length > 0) {
	console.log(`\nfiltered out by oMLX metadata (${skipped.length})`);
	for (const item of skipped) console.log(`  - ${item.id}: ${isChatModel(item).reason}`);
}

const captureOnly = (async () =>
	new Response(
		[
			'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
			'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		].join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	)) as unknown as typeof fetch;

const requestPayload = async (model: any, level: string, fetchImpl: typeof fetch, prompt = "hi", signal?: AbortSignal) => {
	let payload: Record<string, any> | undefined;
	const chunks: { thinking: string; text: string } = { thinking: "", text: "" };
	const stream = openaiCompletions.streamSimple(
		model,
		{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }], tools: [] },
		{
			apiKey: credential?.auth.apiKey,
			reasoning: level as (typeof PI_LEVELS)[number],
			maxTokens: 1024,
			maxRetries: 0,
			...(signal ? { signal } : {}),
			onPayload: (candidate: Record<string, any>) => {
				payload = candidate;
			},
			fetch: fetchImpl,
		},
	);
	for await (const event of stream) {
		if (event.type === "thinking_delta") chunks.thinking += event.delta ?? "";
		if (event.type === "text_delta") chunks.text += event.delta ?? "";
	}
	return { payload, ...chunks };
};

console.log(`\nwhat Pi sends per level ("!" = level Pi removes for this model; no inference performed)`);
for (const model of models) {
	const offered = getSupportedThinkingLevels(model);
	console.log(`  ${model.id}  offered: ${offered.join(", ")}`);
	for (const level of PI_LEVELS) {
		const { payload } = await requestPayload(model, level, captureOnly);
		const thinking = payload?.enable_thinking === undefined ? "absent" : payload.enable_thinking ? "true" : "false";
		const mark = offered.includes(level) ? " " : "!";
		console.log(
			`   ${mark} ${level.padEnd(7)} enable_thinking=${thinking.padEnd(6)} reasoning_effort=${JSON.stringify(payload?.reasoning_effort ?? null).padEnd(8)} max_tokens=${payload?.max_tokens}`,
		);
	}
}

const probeFlag = process.argv.indexOf("--probe");
if (probeFlag !== -1) {
	const requested = process.argv[probeFlag + 1];
	const loadedIds = new Set(statusModels.filter((item) => item.loaded === true).map((item) => item.id));
	const probeModel = models.find((model) => (requested ? model.id === requested : loadedIds.has(model.id)));
	if (!probeModel) {
		console.log("\n--probe: no loaded chat model available, nothing probed (the extension never loads a model)");
	} else {
		const levels = [...new Set(["off", "minimal", "low", "high", "max", getSupportedThinkingLevels(probeModel).at(-1) ?? "off"])];
		console.log(`\nlive probe on ${probeModel.id} (already loaded in oMLX; "!" = level Pi clamps for this model)`);
		for (const level of levels) {
			const started = Date.now();
			const { payload, thinking, text } = await requestPayload(
				probeModel,
				level,
				globalThis.fetch,
				"What is 17+25? Answer with the number only.",
				AbortSignal.timeout(120_000),
			);
			const offered = getSupportedThinkingLevels(probeModel).includes(level);
			console.log(
				`  ${offered ? " " : "!"}${level.padEnd(7)} sent enable_thinking=${String(payload?.enable_thinking).padEnd(5)} reasoning_effort=${JSON.stringify(payload?.reasoning_effort ?? null)}`,
			);
			console.log(
				`     thinking ${String(thinking.length).padStart(5)} chars | answer ${JSON.stringify(text.trim().slice(0, 40))} | ${((Date.now() - started) / 1000).toFixed(1)}s`,
			);
		}
	}
}
