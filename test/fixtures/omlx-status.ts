/**
 * `GET /v1/models/status` fixtures covering several capability shapes at once, plus the entries a
 * filter must drop. Field names, values, and null-vs-missing behavior match what the installed
 * oMLX reports (`engine_pool.py` / `model_discovery.py`): oMLX reports reasoning efforts only from
 * its canonical set ("low", "medium", "high", "xhigh", "max"), `null` when the chat template does
 * not read the value, and no limit fields at all for non-chat services.
 */

import type { OmlxModelStatus } from "../../src/omlx.ts";

const chat = { loaded: false, is_helper: false, is_hidden: false, realtime_voice: false, realtime_stt: false };

/** Full dial: oMLX reports low/medium/high/xhigh and a thinking switch. */
export const fullDial: OmlxModelStatus = {
	...chat,
	id: "FullDial-Model",
	model_type: "vlm",
	engine_type: "vlm",
	config_model_type: "some_vlm_family",
	model_context_length: 262144,
	max_context_window: 262144,
	max_tokens: 65536,
	reasoning_efforts: ["low", "medium", "high", "xhigh"],
	thinking_default: true,
};

/** Same family, different template: no "high" stop. */
export const missingHigh: OmlxModelStatus = {
	...fullDial,
	id: "MissingHigh-Model",
	reasoning_efforts: ["low", "medium", "xhigh"],
};

/** Template that also names "max", which Pi can only show if the map states it. */
export const withMax: OmlxModelStatus = {
	...fullDial,
	id: "MaxEffort-Model",
	reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
};

/** Thinking on/off only: the template ignores `reasoning_effort`. */
export const toggleOnly: OmlxModelStatus = {
	...chat,
	id: "ToggleOnly-Model",
	model_type: "llm",
	engine_type: "batched",
	config_model_type: "some_llm_family",
	model_context_length: 131072,
	max_context_window: 131072,
	max_tokens: 8192,
	reasoning_efforts: null,
	thinking_default: true,
};

/** Effort dial but no on/off switch: oMLX offers no "off" either. */
export const effortNoToggle: OmlxModelStatus = {
	...chat,
	id: "EffortNoToggle-Model",
	model_type: "llm",
	engine_type: "batched",
	model_context_length: 32768,
	max_context_window: 32768,
	max_tokens: 4096,
	reasoning_efforts: ["low", "high"],
	thinking_default: null,
};

/** Reads reasoning_effort but names none: oMLX exposes its canonical dial. */
export const unnamedEfforts: OmlxModelStatus = {
	...effortNoToggle,
	id: "UnnamedEfforts-Model",
	reasoning_efforts: [],
	thinking_default: true,
};

/** No reasoning control at all. */
export const plainChat: OmlxModelStatus = {
	...chat,
	id: "Plain-Model",
	model_type: "llm",
	engine_type: "batched",
	model_context_length: 8192,
	max_context_window: 8192,
	max_tokens: 2048,
	reasoning_efforts: null,
	thinking_default: null,
};

/** Chat model oMLX reports no limits for: kept, with conservative limits. */
export const limitlessChat: OmlxModelStatus = {
	...chat,
	id: "Limitless-Model",
	model_type: "llm",
	engine_type: "external",
};

/** Chat-capable model of a type this extension has never seen: kept, not excluded. */
export const unknownChatType: OmlxModelStatus = {
	...chat,
	id: "NewFamily-Model",
	model_type: "diffusion_lm",
	engine_type: "diffusion",
	model_context_length: 65536,
	max_context_window: 65536,
	max_tokens: 4096,
	reasoning_efforts: ["low", "high"],
	thinking_default: true,
};

/** Entries the filter must drop, one per metadata signal. */
export const drafter: OmlxModelStatus = { ...limitlessChat, id: "Draft-Model", is_helper: true, reasoning_efforts: null };
export const hidden: OmlxModelStatus = { ...plainChat, id: "Hidden-Model", is_hidden: true };
export const realtime: OmlxModelStatus = { ...plainChat, id: "Voice-Model", realtime_voice: true };
export const markitdown: OmlxModelStatus = { id: "MarkItDown", model_type: "markitdown", config_model_type: "markitdown", engine_type: "markitdown" };
export const embedding: OmlxModelStatus = { ...plainChat, id: "Embed-Model", model_type: "embedding", reasoning_efforts: null };
export const audioService: OmlxModelStatus = { ...plainChat, id: "TTS-Model", model_type: "audio_tts" };
export const serviceWithoutLimits: OmlxModelStatus = { id: "SomeService", model_type: "indexer" };

export const catalog = [
	fullDial,
	missingHigh,
	withMax,
	toggleOnly,
	effortNoToggle,
	unnamedEfforts,
	plainChat,
	limitlessChat,
	unknownChatType,
	drafter,
	hidden,
	realtime,
	markitdown,
	embedding,
	audioService,
	serviceWithoutLimits,
];

export const expectedChatIds = [
	"FullDial-Model",
	"MissingHigh-Model",
	"MaxEffort-Model",
	"ToggleOnly-Model",
	"EffortNoToggle-Model",
	"UnnamedEfforts-Model",
	"Plain-Model",
	"Limitless-Model",
	"NewFamily-Model",
];

export const statusPayload = { model_count: catalog.length, loaded_count: 1, models: catalog };
