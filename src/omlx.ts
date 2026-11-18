/**
 * oMLX catalog and reasoning-capability discovery (read-only).
 *
 * One endpoint drives both features of the extension: `GET /v1/models/status` lists every model
 * oMLX knows (loaded or not) together with the metadata that decides
 *   - whether it is a chat model at all (helper/draft, hidden, non-chat services), and
 *   - which reasoning levels the model's own chat template accepts.
 *
 * oMLX fills `reasoning_efforts` by reading each checkpoint's chat template
 * (`model_discovery.detect_reasoning_effort`), so capability discovery is model-agnostic: it works
 * for any family oMLX supports, and the values it reports are exactly the values oMLX will accept
 * on `/v1/chat/completions`. Level names that Pi cannot express are dropped instead of guessed.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";

/** The provider id this extension registers. Every catalog entry it publishes names it. */
export const PROVIDER_ID = "omlx";

const REQUEST_TIMEOUT_MS = 10_000;

/** oMLX's canonical effort names (`model_discovery.REASONING_EFFORT_LEVELS`). */
const OMLX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Pi's fixed thinking-level vocabulary; nothing outside it can be offered. */
export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiLevel = (typeof PI_LEVELS)[number];

/** Chat-generation model types reported by oMLX. Unknown types are judged by their limits. */
const CHAT_MODEL_TYPES = new Set(["llm", "vlm"]);

/** Non-chat services in oMLX's own taxonomy (`model_discovery.detect_model_type` and services). */
const NON_CHAT_MODEL_TYPES = new Set([
	"embedding",
	"reranker",
	"audio_stt",
	"audio_tts",
	"audio_sts",
	"decision",
	"markitdown",
]);

/** Fallbacks used only when oMLX reports no limits for a chat model. */
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

/**
 * A model definition plus the `provider` field Pi itself puts on every catalog entry.
 * Pi's `ProviderModelConfig` does not declare `provider` (Pi fills it in when it composes models),
 * but a persisted catalog entry needs it: Pi hands `context.stored` back verbatim and
 * `storedCatalogOf` only trusts entries that name this provider.
 */
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

/** Tightest reported limit: oMLX's runtime cap never exceeds the checkpoint's context length. */
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

/**
 * Whether oMLX exposes this entry as a chat model. Only oMLX metadata decides: helper drafters
 * (dFlash/MTP), hidden entries, realtime voice models, and non-chat services are dropped. A model
 * type this extension has never seen is kept when oMLX reports chat limits for it, so new chat
 * families are not excluded by an out-of-date type list.
 */
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

/**
 * Derive a model's reasoning controls, following the same rule oMLX uses to build its own
 * reasoning slider (`admin/routes._reasoning_levels`), minus oMLX's family-specific overrides:
 *   - `thinking_default` set        -> thinking can be switched on and off
 *   - `reasoning_efforts` non-empty -> the template names those effort levels
 *   - `reasoning_efforts` empty     -> the template reads the value but names nothing,
 *                                      so oMLX offers its full canonical dial
 *   - `reasoning_efforts` null      -> the template does not read the value at all
 */
export function capabilityOf(model: OmlxModelStatus): Capability {
	const reported = model.reasoning_efforts;
	const efforts = reported === null || reported === undefined
		? []
		: reported.length === 0
			? [...OMLX_EFFORTS]
			: reported.filter((level) => typeof level === "string" && level.length > 0);
	const toggle = model.thinking_default !== null && model.thinking_default !== undefined;
	const thinkingLevelMap = Object.fromEntries(
		PI_LEVELS.map((level) => {
			if (level === "off") return [level, toggle ? "off" : null];
			if (level === "minimal") return [level, null]; // oMLX never names "minimal"
			return [level, efforts.includes(level) ? level : null];
		}),
	) as Record<PiLevel, string | null>;

	// A thinking model without a depth dial still needs one selectable "thinking on" level.
	// `supportsReasoningEffort: false` keeps Pi from sending an effort value it cannot honor.
	if (toggle && efforts.length === 0) thinkingLevelMap.low = "on";

	return {
		reasoning: toggle || efforts.length > 0,
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
	const vision = model.model_type?.toLowerCase() === "vlm" || model.engine_type?.toLowerCase() === "vlm";
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

/** Full catalog: filtered, capability-mapped definitions in oMLX's own order. */
export function buildCatalog(models: readonly OmlxModelStatus[], baseUrl: string): OmlxModelDefinition[] {
	return models.filter((model) => model.id && isChatModel(model).included).map((model) => modelConfigOf(model, baseUrl));
}

/**
 * Re-stamp definitions with the base URL Pi composed for this refresh.
 *
 * Every definition carries its own `baseUrl`, and Pi honors a model's own URL above the `models.json`
 * provider URL, so a catalog restored from an earlier run would otherwise keep a retired host or port
 * for the whole session — the network read that could correct it happens after Pi has already selected
 * the model. Re-stamping makes the configured URL authoritative the moment it is restored.
 */
export function withBaseUrl(models: OmlxModelDefinition[] | undefined, baseUrl: string): OmlxModelDefinition[] | undefined {
	if (!models) return undefined;
	return models.map((model) => (model.baseUrl === baseUrl ? model : { ...model, baseUrl }));
}

/**
 * The catalog Pi persisted for this provider in an earlier run (`context.stored`, i.e. the provider's
 * entry in `models-store.json`). Entries that are not this provider's own chat definitions are dropped,
 * so a foreign or malformed entry cannot inject models.
 */
export function storedCatalogOf(stored: { models?: readonly unknown[] } | undefined, providerId: string): OmlxModelDefinition[] {
	if (!stored || !Array.isArray(stored.models)) return [];
	return stored.models.filter((model): model is OmlxModelDefinition => {
		if (typeof model !== "object" || model === null) return false;
		const definition = model as { id?: unknown; provider?: unknown; type?: unknown };
		return typeof definition.id === "string" && definition.id.length > 0 && definition.provider === providerId && (definition.type === undefined || definition.type === "chat");
	});
}

/** `.../v1` -> `.../v1/models/status`; a bare host is completed with the OpenAI-compatible prefix. */
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
