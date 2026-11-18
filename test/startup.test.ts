/**
 * Startup regression test against Pi's real startup path.
 *
 * Reproduces the reported bug in the code path `pi` itself takes: `createAgentSessionServices`
 * (extensions load and providers register, each refreshing with `allowNetwork: false`) followed by
 * `createAgentSessionFromServices`, which is where Pi resolves the selected model, clamps the saved
 * thinking level, and builds the scoped `/model` list. Pi only reads oMLX over the network *after*
 * that, from the interactive mode's background catalog refresh, so a model resolved at startup can
 * only know what the offline refresh published.
 *
 * The scratch agent directory carries a `models.json` entry for the selected model that says
 * `reasoning: false` while oMLX reports `reasoning_efforts: ["low","medium","high","xhigh"]` and
 * `thinking_default: true` — the exact mismatch in the report. Nothing here touches the real
 * `~/.pi`: the agent directory, session directory, settings, auth, and store are all scratch files
 * inside this project directory, and the oMLX server is a local `node:http` server on a free port.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { PROVIDER_ID, buildCatalog } from "../src/omlx.ts";
import { catalog as fixtureCatalog, expectedChatIds, fullDial } from "./fixtures/omlx-status.ts";

const PI_DIR = process.env.PI_PACKAGE_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_AI_DIR = `${PI_DIR}/node_modules/@earendil-works/pi-ai/dist`;
const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_PATH = join(PROJECT_DIR, "pi-omlx-model-picker.ts");
const skip = existsSync(PI_DIR) ? false : `Skipped: Pi package not found at ${PI_DIR}. Set PI_PACKAGE_DIR to the pi-coding-agent package directory.`;

let agentServices: any;
let SessionManager: any;
let openaiCompletions: any;
let modelsModule: any;
if (!skip) {
	agentServices = await import(`${PI_DIR}/dist/core/agent-session-services.js`);
	({ SessionManager } = await import(`${PI_DIR}/dist/core/session-manager.js`));
	openaiCompletions = await import(`${PI_AI_DIR}/api/openai-completions.js`);
	modelsModule = await import(`${PI_AI_DIR}/models.js`);
}

const MODEL_ID = fullDial.id;
const API_KEY = "pi-configured-omlx-key";
/** What `~/.pi/agent/models.json` holds for oMLX: the same static entry, `reasoning: false`. */
const modelsJson = (baseUrl: string): unknown => ({
	providers: {
		omlx: {
			baseUrl,
			api: "openai-completions",
			apiKey: API_KEY,
			authHeader: true,
			models: [
				{
					id: MODEL_ID,
					name: MODEL_ID,
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 262144,
					maxTokens: 65536,
				},
			],
		},
	},
});

let home: string;
let cwd: string;
let sessionDir: string;
let server: ReturnType<typeof createServer>;
let port = 0;
let served = [...fixtureCatalog];
/** Path of every `GET /v1/models/status` the fake oMLX served, in order. */
const statusRequests: string[] = [];

function writeAgentConfig(): void {
	home = mkdtempSync(join(PROJECT_DIR, ".startup-home-"));
	cwd = join(home, "workspace");
	sessionDir = join(home, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(home, "auth.json"), "{}\n");
	writeFileSync(join(home, "models.json"), JSON.stringify(modelsJson(`http://127.0.0.1:${port}/v1`), null, 2));
	writeFileSync(join(home, "settings.json"), JSON.stringify({ defaultProvider: "omlx", defaultModel: MODEL_ID, modelThinkingLevels: { [`omlx/${MODEL_ID}`]: "medium" } }, null, 2));
}

const storePath = (): string => join(home, "models-store.json");
const readStore = (): Record<string, any> | undefined => {
	if (!existsSync(storePath())) return undefined;
	const raw = readFileSync(storePath(), "utf8").trim();
	return raw ? JSON.parse(raw) : undefined;
};

/** One Pi process startup: services (extensions, provider registration, offline refresh) plus the session. */
async function startupPi(): Promise<{ services: any; session: any; requestsAtStartup: number }> {
	const requestsBefore = statusRequests.length;
	const services = await agentServices.createAgentSessionServices({
		cwd,
		agentDir: home,
		modelRuntimeSignal: AbortSignal.timeout(20_000),
		resourceLoaderOptions: { additionalExtensionPaths: [EXTENSION_PATH] },
	});
	const { session } = await agentServices.createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.create(cwd, sessionDir),
	});
	return { services, session, requestsAtStartup: statusRequests.length - requestsBefore };
}

/** What `InteractiveMode.run()` does after the session exists: refresh dynamic providers over the network. */
async function backgroundRefresh(services: any): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
	return services.modelRuntime.refresh({ allowNetwork: true, context: { cwd } });
}

const sseBody = [
	'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
	'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
	'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n',
	"data: [DONE]\n\n",
].join("");

/** The body Pi's own openai-completions stream builder produces for this model and thinking level. */
async function wirePayload(model: any, reasoning: string): Promise<Record<string, any>> {
	let payload: Record<string, any> | undefined;
	const stream = openaiCompletions.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, {
		apiKey: API_KEY,
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

const handler = (req: any, res: any): void => {
	if (!req.url?.endsWith("/v1/models/status")) {
		res.writeHead(404).end();
		return;
	}
	statusRequests.push(req.url);
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ models: served }));
};
const listen = (server: ReturnType<typeof createServer>, port: number): Promise<ReturnType<typeof createServer>> =>
	new Promise((resolve) => {
		server.on("listening", () => resolve(server));
		server.listen(port, "127.0.0.1");
	});
const closeServer = (server: ReturnType<typeof createServer>): Promise<void> =>
	new Promise((resolve) => {
		// Drop pooled keep-alive sockets too, so a later request really is refused.
		server.closeAllConnections?.();
		server.close(() => resolve());
	});
/** Restart the fake oMLX on the same port, so the configured base URL stays valid. */
const restartServer = async (): Promise<void> => {
	await closeServer(server);
	server = await listen(createServer(handler), port);
};

if (!skip) {
	server = await listen(createServer(handler), 0);
	port = (server.address() as AddressInfo).port;
	writeAgentConfig();
	after(async () => {
		await closeServer(server);
		rmSync(home, { recursive: true, force: true });
	});
}

const skipOr = (fn: () => Promise<void> | void) => async () => {
	if (skip) {
		console.warn(`\n  ${skip}`);
		return;
	}
	await fn();
};

test(
	"the first run persists what it discovered, so the next startup starts from it",
	skipOr(async () => {
		const { services, session, requestsAtStartup } = await startupPi();
		// A cold process has no discovered catalog yet: startup can only resolve models.json's static
		// entry, and no oMLX request has happened at all.
		assert.equal(requestsAtStartup, 0, "startup must not read oMLX over the network");
		assert.equal(session.model.reasoning, false);

		await backgroundRefresh(services);
		const stored = readStore();
		assert.deepEqual(Object.keys(stored ?? {}), ["omlx"], "the discovered catalog must be persisted for later startups");
		const persisted = stored.omlx.models.find((model: any) => model.id === MODEL_ID);
		assert.equal(persisted.reasoning, true);
		assert.deepEqual(stored.omlx.models.map((model: any) => model.id), expectedChatIds);
		assert.equal(readFileSync(join(home, "models.json"), "utf8").includes('"reasoning": false'), true, "models.json is never rewritten by the extension");

		session.dispose();
	}),
);

test(
	"restart resolves the selected model with oMLX's capabilities before any catalog refresh",
	skipOr(async () => {
		// Simulate the persisted snapshot a previous Pi run wrote: keep what the extension stored, but
		// drop "high" so the restored capabilities are distinguishable from both models.json and a live read.
		const stored = readStore();
		const persisted = stored.omlx.models.find((model: any) => model.id === MODEL_ID);
		persisted.thinkingLevelMap.high = null;
		writeFileSync(storePath(), JSON.stringify(stored));

		const { services, session, requestsAtStartup } = await startupPi();
		assert.equal(requestsAtStartup, 0, "the capabilities at startup must come from the persisted catalog, not a startup network read");

		const model = services.modelRuntime.getModel("omlx", MODEL_ID);
		assert.ok(model, "the selected model must be known at startup");
		assert.equal(model.reasoning, true, "startup must not keep models.json's reasoning:false for a model oMLX reports as reasoning-capable");
		assert.equal(model.thinkingLevelMap.high, null, "the capability the previous run persisted, not models.json's, is what startup uses");
		assert.equal(model.thinkingLevelMap.off, "off");
		assert.equal(model.thinkingLevelMap.xhigh, "xhigh");
		assert.equal(model.compat.supportsReasoningEffort, true);
		assert.deepEqual(services.modelRuntime.getModels("omlx").map((entry: any) => entry.id), expectedChatIds, "model filtering survives a restart");
		assert.deepEqual(modelsModule.getSupportedThinkingLevels(model), ["off", "low", "medium", "xhigh"]);

		// The session is what Pi actually started with: same model, real levels, saved preference kept.
		assert.equal(session.model.id, MODEL_ID);
		assert.equal(session.model.reasoning, true);
		assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "low", "medium", "xhigh"]);
		assert.equal(session.thinkingLevel, "medium", "the saved thinking level is kept, not forced or clamped away");
		assert.notEqual(session.thinkingLevel, "off");

		session.dispose();
	}),
);

test(
	"restart keeps thinking control on a resumed session and sends the level to oMLX",
	skipOr(async () => {
		const services = await agentServices.createAgentSessionServices({
			cwd,
			agentDir: home,
			modelRuntimeSignal: AbortSignal.timeout(20_000),
			resourceLoaderOptions: { additionalExtensionPaths: [EXTENSION_PATH] },
		});
		const { session } = await agentServices.createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.continueRecent(cwd, sessionDir),
		});
		assert.equal(session.model.id, MODEL_ID);
		assert.equal(session.model.reasoning, true);
		// The reported symptom: Pi refused to change the thinking level because the model looked
		// non-reasoning. After a restart it is a reasoning model again.
		assert.ok(session.getAvailableThinkingLevels().includes("medium"));
		session.setThinkingLevel("medium");
		assert.equal(session.thinkingLevel, "medium");

		// The model Pi selected at startup is a usable definition: Pi's own openai-completions stream
		// builder turns its thinking level into the body oMLX reads.
		const payload = await wirePayload(session.model, session.thinkingLevel);
		assert.equal(payload.model, MODEL_ID);
		assert.equal(payload.enable_thinking, true);
		assert.equal(payload.reasoning_effort, "medium");

		session.dispose();
	}),
);

test(
	"the persisted catalog is a starting point, not a cache: a refresh replaces changed capabilities",
	skipOr(async () => {
		served = fixtureCatalog.map((model) => (model.id === MODEL_ID ? { ...model, reasoning_efforts: ["low", "medium", "high", "xhigh"], thinking_default: true } : model));
		const { services, session, requestsAtStartup } = await startupPi();
		assert.equal(requestsAtStartup, 0);
		assert.deepEqual(modelsModule.getSupportedThinkingLevels(session.model), ["off", "low", "medium", "xhigh"], "startup uses the persisted capabilities");

		await backgroundRefresh(services);
		const refreshed = services.modelRuntime.getModel("omlx", MODEL_ID);
		assert.deepEqual(modelsModule.getSupportedThinkingLevels(refreshed), ["off", "low", "medium", "high", "xhigh"], "the interactive refresh must still correct the catalog");
		assert.deepEqual(readStore().omlx.models.find((model: any) => model.id === MODEL_ID).thinkingLevelMap.high, "high", "the corrected catalog is persisted for the next startup");

		// A model removed from oMLX is gone after the refresh, not resurrected by the stored snapshot.
		served = served.filter((model) => model.id !== "MaxEffort-Model");
		await backgroundRefresh(services);
		assert.deepEqual(
			services.modelRuntime.getModels("omlx").map((model: any) => model.id),
			expectedChatIds.filter((id) => id !== "MaxEffort-Model"),
		);
		assert.equal(services.modelRuntime.getModel("omlx", "MaxEffort-Model"), undefined);

		session.dispose();
	}),
);

test(
	"startup with oMLX unreachable still knows the models it discovered before",
	skipOr(async () => {
		await closeServer(server);
		const { services, session, requestsAtStartup } = await startupPi();
		assert.equal(requestsAtStartup, 0);
		assert.ok(services.modelRuntime.getProvider("omlx"), "the provider must still be registered");
		assert.equal(services.modelRuntime.getRegisteredProviderIds().includes("omlx"), true);
		assert.equal(session.model.reasoning, true, "an unreachable oMLX must not fall back to models.json's stale entry");
		assert.ok(session.getAvailableThinkingLevels().includes("medium"));
		assert.equal(session.thinkingLevel, "medium");

		// The failed network read is still reported; it just does not decide the session.
		const result = await backgroundRefresh(services);
		assert.equal(result.errors.has("omlx"), true, `the failed refresh must still be reported: ${JSON.stringify([...result.errors.keys()])}`);
		assert.equal(session.model.reasoning, true, "a failed refresh must not drop the capabilities back to models.json's");
		assert.deepEqual(
			services.modelRuntime.getModels("omlx").map((model: any) => model.id),
			readStore().omlx.models.map((model: any) => model.id),
			"a failed read leaves the catalog on what the previous run persisted",
		);

		session.dispose();
		served = [...fixtureCatalog];
		await restartServer();
	}),
);

test(
	"a restored catalog adopts the base URL models.json configures, not the one it was stored with",
	skipOr(async () => {
		// A previous run persisted the catalog while oMLX listened on a host that is gone. Every model
		// definition carries its own base URL, and Pi honors a model's own URL above the provider URL
		// from models.json — so an unrestamped snapshot would send this session to the retired host
		// until the background refresh replaced it.
		const retiredUrl = "http://127.0.0.1:1/v1";
		writeFileSync(storePath(), JSON.stringify({ [PROVIDER_ID]: { models: buildCatalog(fixtureCatalog, retiredUrl), checkedAt: 1746000000000 } }));

		const configuredUrl = `http://127.0.0.1:${port}/v1`;
		const { services, session, requestsAtStartup } = await startupPi();
		assert.equal(requestsAtStartup, 0, "the correction happens without any oMLX request");

		const model = services.modelRuntime.getModel("omlx", MODEL_ID);
		assert.equal(model.baseUrl, configuredUrl, "the URL models.json configures wins over the stored one");
		assert.equal(session.model.baseUrl, configuredUrl, "the session Pi started with talks to the configured host");
		assert.equal(session.model.reasoning, true, "restamping changes the URL only, not the restored capabilities");
		assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "low", "medium", "high", "xhigh"]);

		await backgroundRefresh(services);
		assert.equal(
			readStore()[PROVIDER_ID].models.find((entry: any) => entry.id === MODEL_ID).baseUrl,
			configuredUrl,
			"the corrected URL is persisted for the next startup too",
		);

		session.dispose();
	}),
);
