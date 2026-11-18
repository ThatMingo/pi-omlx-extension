/** Read-only oMLX status discovery and translation into Pi model definitions. */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";

/** The provider id this extension registers. Every catalog entry it publishes names it. */
export const PROVIDER_ID = "omlx";

const REQUEST_TIMEOUT_MS = 10_000;

/** oMLX's canonical reasoning-effort vocabulary. */
const OMLX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiLevel = (typeof PI_LEVELS)[number];

const CHAT_MODEL_TYPES = new Set(["llm", "vlm"]);

const NON_CHAT_MODEL_TYPES = new Set([
	"embedding",
	"reranker",
	"audio_stt",
	"audio_tts",
	"audio_sts",
	"decision",
	"markitdown",
]);

const FALLBACK_CONTEXT_WINDOW = 32768;
const FALLBACK_MAX_TOKENS = 4096;

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
	reasoning_efforts?: string[] | null;
	thinking_default?: boolean | null;
	loaded?: boolean | null;
}

/** Persisted catalog entries include the provider field Pi's types omit. */
export type OmlxModelDefinition = ProviderModelConfig & { provider: string };

export interface Capability {
	/** Whether Pi should treat the model as a reasoning model at all. */
	reasoning: boolean;
	/** Effort levels to expose, in oMLX's own names. Empty when thinking is unavailable. */
	efforts: string[];
	/** Whether oMLX offers a thinking on/off switch (its `thinking_default` control). */
	toggle: boolean;
	/** Whether the model's template reads `reasoning_effort`, i.e. it has a depth dial. */
	supportsReasoningEffort: boolean;
	/** Pi level -> oMLX effort, or null to remove the level from Pi's selector. */
	thinkingLevelMap: Record<PiLevel, string | null>;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Honor the smaller of the runtime and checkpoint context limits. */
function contextWindowOf(model: OmlxModelStatus): number {
	const reported = [positiveInt(model.max_context_window), positiveInt(model.model_context_length)].filter(
		(value): value is number => value !== undefined,
	);
	return reported.length > 0 ? Math.min(...reported) : FALLBACK_CONTEXT_WINDOW;
}

function maxTokensOf(model: OmlxModelStatus, contextWindow: number): number {
	const reported = positiveInt(model.max_tokens) ?? FALLBACK_MAX_TOKENS;
	return Math.min(reported, contextWindow);
}

function nonChatType(modelType: string | null | undefined): boolean {
	if (!modelType) return false;
	const normalized = modelType.toLowerCase();
	return (
		NON_CHAT_MODEL_TYPES.has(normalized) ||
		normalized.startsWith("embedding") ||
		normalized.startsWith("audio_")
	);
}

/** Filter non-chat services without excluding newly supported chat families. */
export function isChatModel(model: OmlxModelStatus): { included: boolean; reason?: string } {
	if (model.is_helper === true) return { included: false, reason: "helper model (draft/MTP)" };
	if (model.is_hidden === true) return { included: false, reason: "hidden in oMLX" };
	if (model.realtime_voice === true || model.realtime_stt === true) {
		return { included: false, reason: "realtime voice model" };
	}
	if (nonChatType(model.model_type)) return { included: false, reason: `model_type=${model.model_type}` };
	if (model.model_type && !CHAT_MODEL_TYPES.has(model.model_type.toLowerCase())) {
		const reportsChatLimits = positiveInt(model.max_context_window) !== undefined || positiveInt(model.model_context_length) !== undefined;
		if (!reportsChatLimits) return { included: false, reason: `model_type=${model.model_type} without chat limits` };
	}
	return { included: true };
}

/** Match oMLX's reasoning slider, including its family-specific overrides. */
export function capabilityOf(model: OmlxModelStatus): Capability {
	const family = (model.config_model_type ?? "").toLowerCase().replace(/-/g, "_");
	const forced = family === "k2_horizon";
	const toggle = !forced && (
		model.thinking_default != null || family.startsWith("deepseek_v4") || family.startsWith("minimax_m3")
	);

	// The oMLX slider overrides template-detected levels for these families.
	let efforts: string[];
	if (forced || family === "gpt_oss") efforts = ["low", "medium", "high"];
	else if (family.startsWith("deepseek_v4")) efforts = ["low", "high", "max"];
	else if (model.reasoning_efforts == null) efforts = [];
	else efforts = model.reasoning_efforts.length
		? model.reasoning_efforts.filter((level) => typeof level === "string" && level.length > 0)
		: [...OMLX_EFFORTS];

	const thinkingLevelMap = Object.fromEntries(
		PI_LEVELS.map((level) => [
			level,
			level === "off" ? (toggle ? "off" : null) : level !== "minimal" && efforts.includes(level) ? level : null,
		]),
	) as Record<PiLevel, string | null>;

	// oMLX also offers a simple on/off switch when there is no effort dial.
	if (toggle && efforts.length === 0) thinkingLevelMap.low = "on";

	return {
		reasoning: forced || toggle || efforts.length > 0,
		efforts,
		toggle,
		supportsReasoningEffort: efforts.length > 0,
		thinkingLevelMap,
	};
}

export function levelsOf(capability: Capability): PiLevel[] {
	return PI_LEVELS.filter((level) => capability.thinkingLevelMap[level] !== null);
}

/** Build one Pi model definition from one oMLX status entry. */
export function modelConfigOf(model: OmlxModelStatus, baseUrl: string): OmlxModelDefinition {
	const capability = capabilityOf(model);
	const contextWindow = contextWindowOf(model);
	// Some text-only models run through the VLM engine; the discovered model type is authoritative.
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
		maxTokens: maxTokensOf(model, contextWindow),
		compat: {
			maxTokensField: "max_tokens",
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsStrictMode: false,
			supportsUsageInStreaming: true,
			supportsReasoningEffort: capability.supportsReasoningEffort,
			// oMLX takes thinking control as top-level `enable_thinking` (+ `reasoning_effort`)
			// and normalizes it into chat-template kwargs for every family itself.
			...(capability.reasoning && { thinkingFormat: "qwen" as const }),
		},
	};
}

export function buildCatalog(models: readonly OmlxModelStatus[], baseUrl: string): OmlxModelDefinition[] {
	return models.filter((model) => model.id && isChatModel(model).included).map((model) => modelConfigOf(model, baseUrl));
}

/** Restored entries must use Pi's current URL rather than a persisted, possibly retired one. */
export function withBaseUrl(models: OmlxModelDefinition[] | undefined, baseUrl: string): OmlxModelDefinition[] | undefined {
	if (!models) return undefined;
	return models.map((model) => (model.baseUrl === baseUrl ? model : { ...model, baseUrl }));
}

/** Only accept persisted entries belonging to this provider. */
export function storedCatalogOf(stored: { models?: readonly unknown[] } | undefined, providerId: string): OmlxModelDefinition[] {
	if (!stored || !Array.isArray(stored.models)) return [];
	return stored.models.filter((model): model is OmlxModelDefinition => {
		if (typeof model !== "object" || model === null) return false;
		const definition = model as { id?: unknown; provider?: unknown; type?: unknown };
		return typeof definition.id === "string" && definition.id.length > 0 && definition.provider === providerId && (definition.type === undefined || definition.type === "chat");
	});
}

export function statusUrlOf(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? `${trimmed}/models/status` : `${trimmed}/v1/models/status`;
}

export async function fetchModelStatus(options: {
	baseUrl: string;
	apiKey: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<OmlxModelStatus[]> {
	const url = statusUrlOf(options.baseUrl);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
		: AbortSignal.timeout(REQUEST_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
			signal,
		});
	} catch (error) {
		// Never echo the request: it carries the credential.
		throw new Error(`oMLX catalog request failed (${url}): ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		const code = (detail.match(/"code"\s*:\s*"([^"]+)"/) ?? [])[1];
		throw new Error(`oMLX ${url} returned ${response.status}${code ? ` (${code})` : ""}`);
	}
	const payload = (await response.json()) as { models?: OmlxModelStatus[] };
	if (!Array.isArray(payload?.models)) throw new Error(`oMLX ${url} returned no model list`);
	return payload.models;
}
