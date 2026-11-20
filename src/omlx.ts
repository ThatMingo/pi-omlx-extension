import type { Model } from "@earendil-works/pi-ai";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const PROVIDER_ID = "omlx";

const REQUEST_TIMEOUT_MS = 10_000;
const FALLBACK_CONTEXT_WINDOW = 32768;
const FALLBACK_MAX_TOKENS = 4096;

const OMLX_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const PI_LEVELS = ["off", "minimal", ...OMLX_EFFORTS] as const;
export type PiLevel = (typeof PI_LEVELS)[number];

const CHAT_MODEL_TYPES = new Set(["llm", "vlm"]);
const NON_CHAT_MODEL_TYPES = new Set(["reranker", "decision", "markitdown"]);

export interface OmlxModelStatus {
	id: string;
	model_type?: string | null;
	config_model_type?: string | null;
	engine_type?: string | null;
	is_helper?: boolean | null;
	is_hidden?: boolean | null;
	realtime_voice?: boolean | null;
	realtime_stt?: boolean | null;
	model_context_length?: number | null;
	max_context_window?: number | null;
	max_tokens?: number | null;
	reasoning_levels?: string[] | null;
	reasoning_efforts?: string[] | null;
	thinking_default?: boolean | null;
	loaded?: boolean | null;
}

// Pi's persisted models include their provider.
export type OmlxModelDefinition = Model<"openai-completions"> & { provider: typeof PROVIDER_ID };

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function isChatModel(model: OmlxModelStatus): { included: boolean; reason?: string } {
	if (model.is_helper === true) return { included: false, reason: "helper model (draft/MTP)" };
	if (model.is_hidden === true) return { included: false, reason: "hidden in oMLX" };
	if (model.realtime_voice === true || model.realtime_stt === true) {
		return { included: false, reason: "realtime voice model" };
	}

	const type = model.model_type?.toLowerCase();
	if (type && (NON_CHAT_MODEL_TYPES.has(type) || type.startsWith("embedding") || type.startsWith("audio_"))) {
		return { included: false, reason: `model_type=${model.model_type}` };
	}

	// Keep unfamiliar model types when oMLX reports a chat context limit.
	const contextLimit = positiveInt(model.max_context_window) ?? positiveInt(model.model_context_length);
	if (type && !CHAT_MODEL_TYPES.has(type) && contextLimit === undefined) {
		return { included: false, reason: `model_type=${model.model_type} without chat limits` };
	}
	return { included: true };
}

function reasoningLevelsOf(model: OmlxModelStatus): readonly string[] {
	if (model.reasoning_levels != null) return model.reasoning_levels;

	// Older oMLX builds expose template metadata and the checkpoint family.
	const family = model.config_model_type?.toLowerCase().replace(/-/g, "_") ?? "";
	if (family === "k2_horizon") return ["low", "medium", "high"];
	if (family.startsWith("deepseek_v4")) return ["off", "low", "high", "max"];

	let efforts: readonly string[] = model.reasoning_efforts ?? [];
	if (family === "gpt_oss") efforts = ["low", "medium", "high"];
	else if (model.reasoning_efforts?.length === 0) efforts = OMLX_EFFORTS;

	const toggle = typeof model.thinking_default === "boolean" || family.startsWith("minimax_m3");
	if (!toggle) return efforts;
	return efforts.length ? ["off", ...efforts] : ["off", "on"];
}

export function capabilityOf(model: OmlxModelStatus) {
	const levels = reasoningLevelsOf(model);
	const efforts = OMLX_EFFORTS.filter((effort) => levels.includes(effort));
	const canTurnOff = levels.includes("off");
	const canTurnOn = levels.includes("on");
	const thinkingLevelMap: Record<PiLevel, string | null> = {
		off: canTurnOff ? "off" : null,
		minimal: null,
		low: canTurnOn && !efforts.length ? "on" : null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	};
	for (const effort of efforts) thinkingLevelMap[effort] = effort;

	return {
		reasoning: canTurnOff || canTurnOn || efforts.length > 0,
		supportsReasoningEffort: efforts.length > 0,
		thinkingLevelMap,
	};
}

export function modelConfigOf(model: OmlxModelStatus, baseUrl: string): OmlxModelDefinition {
	const capability = capabilityOf(model);
	const limits = [positiveInt(model.max_context_window), positiveInt(model.model_context_length)]
		.filter((limit): limit is number => limit !== undefined);
	const contextWindow = limits.length ? Math.min(...limits) : FALLBACK_CONTEXT_WINDOW;
	const vision = model.model_type?.toLowerCase() === "vlm";

	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl,
		reasoning: capability.reasoning,
		...(capability.reasoning && { thinkingLevelMap: capability.thinkingLevelMap }),
		input: vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(positiveInt(model.max_tokens) ?? FALLBACK_MAX_TOKENS, contextWindow),
		compat: {
			maxTokensField: "max_tokens",
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsStrictMode: false,
			supportsUsageInStreaming: true,
			supportsReasoningEffort: capability.supportsReasoningEffort,
			// Pi's qwen format sends oMLX's top-level enable_thinking and reasoning_effort.
			...(capability.reasoning && { thinkingFormat: "qwen" as const }),
		},
	};
}

export function buildCatalog(models: readonly OmlxModelStatus[], baseUrl: string): OmlxModelDefinition[] {
	return models.filter((model) => isChatModel(model).included).map((model) => modelConfigOf(model, baseUrl));
}

export function storedCatalogOf(stored: { models?: readonly unknown[] } | undefined): OmlxModelDefinition[] | undefined {
	if (!Array.isArray(stored?.models)) return undefined;
	const models = stored.models.filter((model): model is OmlxModelDefinition => {
		if (typeof model !== "object" || model === null) return false;
		const { id, provider, type } = model as { id?: unknown; provider?: unknown; type?: unknown };
		return typeof id === "string" && id.trim().length > 0 && provider === PROVIDER_ID && (type === undefined || type === "chat");
	});
	return models.length > 0 || stored.models.length === 0 ? models : undefined;
}

export function apiBaseUrlOf(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function statusUrlOf(baseUrl: string): string {
	return `${apiBaseUrlOf(baseUrl)}/models/status`;
}

function isModelStatus(value: unknown): value is OmlxModelStatus {
	if (typeof value !== "object" || value === null) return false;
	const { id, model_type, config_model_type, reasoning_levels, reasoning_efforts } = value as Record<string, unknown>;
	return typeof id === "string" && id.trim().length > 0
		&& [model_type, config_model_type].every((type) => type == null || typeof type === "string")
		&& [reasoning_levels, reasoning_efforts].every((levels) => levels == null
			|| (Array.isArray(levels) && levels.every((level) => typeof level === "string")));
}

export async function fetchModelStatus(options: {
	baseUrl: string;
	apiKey: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<OmlxModelStatus[]> {
	const url = statusUrlOf(options.baseUrl);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
			signal,
		});
	} catch {
		const detail = timeout.aborted ? ": timed out" : "";
		throw new Error(`oMLX catalog request failed (${url})${detail}`);
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`oMLX ${url} returned ${response.status}`);
	}

	const payload = await response.json().catch(() => {
		const detail = timeout.aborted ? "timed out reading the model list" : "returned invalid JSON";
		throw new Error(`oMLX ${url} ${detail}`);
	}) as { models?: unknown };
	if (!Array.isArray(payload?.models)) throw new Error(`oMLX ${url} returned no model list`);
	if (!payload.models.every(isModelStatus)) throw new Error(`oMLX ${url} returned an invalid model entry`);
	return payload.models;
}
