import type { ModelCostRates } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** 可能对应后端 effort 值的 Pi 思考档位（off 除外）。 */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
const THINKING_LEVELS = ["off", ...EFFORT_LEVELS] as const;
export type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

/** 模型列表声明的思考档位；缓存保存声明本身，注册时再结合 api 与 provider compat 推导映射。 */
export interface AdvertisedThinking {
	/** 模型条目显式给出的 Pi 档位映射。 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** capabilities.effort 中逐个后端 effort 值的支持情况；未声明的值不出现。 */
	effort?: Partial<Record<EffortLevel, boolean>>;
}

/** 模型列表条目按别名归一后的元数据；缺失字段由 buildModel 补默认值。 */
export interface ModelMetadata {
	id: string;
	api?: ProviderModelConfig["api"];
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ProviderModelConfig["input"];
	reasoning?: boolean;
	thinking?: AdvertisedThinking;
	cost?: Partial<ModelCostRates>;
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(...values: unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/** 只保留 Pi 已知档位的非空字符串或 null；没有有效项时视为未声明。 */
function validThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
	const raw = asRecord(value);
	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		const mapped = raw[level];
		if (mapped === null || nonEmptyString(mapped)) map[level] = mapped as string | null;
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

/** effort 整体声明不支持时不推导任何档位；逐值只接受布尔或 { supported: 布尔 }。 */
function effortSupport(value: unknown): AdvertisedThinking["effort"] {
	if (capabilitySupported(value) === false) return undefined;
	const raw = asRecord(value);
	const support: AdvertisedThinking["effort"] = {};
	for (const level of EFFORT_LEVELS) {
		const supported = capabilitySupported(raw[level]);
		if (supported !== undefined) support[level] = supported;
	}
	return Object.keys(support).length > 0 ? support : undefined;
}

/** 显式映射取第一个含有效项的别名；模型列表与缓存共用同一套校验。 */
export function advertisedThinking(maps: unknown[], effort: unknown): AdvertisedThinking | undefined {
	const thinkingLevelMap = maps.map(validThinkingLevelMap).find((map) => map !== undefined);
	const effortLevels = effortSupport(effort);
	return thinkingLevelMap || effortLevels ? { thinkingLevelMap, effort: effortLevels } : undefined;
}

function positiveTokenLimit(...values: unknown[]): number | undefined {
	return values.find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function nonNegativeCost(...values: unknown[]): number | undefined {
	return values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function capabilitySupported(value: unknown): boolean | undefined {
	const supported = typeof value === "boolean" ? value : asRecord(value).supported;
	return typeof supported === "boolean" ? supported : undefined;
}

/** 聊天模型始终接受 text；显式 input 数组或 vision 能力只决定是否加上 image。 */
function modelInput(input: unknown, capabilities: Record<string, unknown>): ProviderModelConfig["input"] | undefined {
	const image = Array.isArray(input) && (input.includes("text") || input.includes("image"))
		? input.includes("image")
		: capabilitySupported(capabilities.vision) ?? capabilitySupported(capabilities.image_input);
	return image === undefined ? undefined : image ? ["text", "image"] : ["text"];
}

/** 按 README「模型元数据」表的别名优先级归一单个模型列表条目；无有效 id 时返回 undefined。 */
export function canonicalizeModel(value: unknown): ModelMetadata | undefined {
	const raw = asRecord(value);
	if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
	const capabilities = asRecord(raw.capabilities);
	const cost = asRecord(raw.cost);
	const pricing = asRecord(raw.pricing);
	const limit = asRecord(raw.limit);
	const modalities = asRecord(raw.modalities);
	return {
		id: raw.id,
		api: raw.api === "openai-responses" || raw.api === "openai-completions" || raw.api === "anthropic-messages" || raw.api === "google-generative-ai"
			? raw.api : undefined,
		name: nonEmptyString(raw.name, raw.display_name),
		contextWindow: positiveTokenLimit(raw.context_window, raw.contextWindow, raw.max_model_len, raw.context_length, raw.max_context_length, raw.max_input_tokens, limit.context),
		maxTokens: positiveTokenLimit(raw.max_tokens, raw.maxTokens, raw.max_output_tokens, raw.max_completion_tokens, limit.output),
		input: modelInput(raw.input, capabilities) ?? modelInput(modalities.input, {}),
		reasoning: capabilitySupported(raw.reasoning)
			?? capabilitySupported(capabilities.reasoning)
			?? capabilitySupported(capabilities.thinking),
		thinking: advertisedThinking([raw.thinkingLevelMap, raw.thinking_level_map], capabilities.effort),
		cost: {
			input: nonNegativeCost(cost.input, pricing.input_per_million),
			output: nonNegativeCost(cost.output, pricing.output_per_million),
			cacheRead: nonNegativeCost(cost.cacheRead, cost.cache_read, pricing.cache_read_input_per_million),
			cacheWrite: nonNegativeCost(cost.cacheWrite, cost.cache_write, pricing.cache_creation_input_per_million),
		},
	};
}

/** Only explicit endpoint declarations restrict availability or select another protocol. */
export function endpointModel(value: unknown, api?: string): ModelMetadata | undefined {
	const raw = asRecord(value);
	const capabilities = asRecord(raw.capabilities);
	if (typeof raw.mode === "string" && ["embedding", "embeddings", "rerank", "reranking", "image_generation", "image-generation",
		"audio_generation", "speech", "transcription", "moderation"].includes(raw.mode.toLowerCase())) return undefined;
	const chat = capabilitySupported(capabilities.chat);
	const responses = capabilitySupported(capabilities.responses);
	if (chat === false && responses !== true) return undefined;
	if (capabilitySupported(capabilities.embedding) === true && chat !== true && responses !== true) return undefined;
	const model = canonicalizeModel(raw);
	if (model && !model.api && api === "openai-completions" && chat === false && responses === true) model.api = "openai-responses";
	return model;
}

export interface MetadataCatalog {
	models: Map<string, ModelMetadata>;
	providers: Map<string, Map<string, ModelMetadata>>;
}

/** Accept model-list APIs and the provider/model maps published by models.dev. */
export function parseMetadataCatalog(payload: unknown): MetadataCatalog | undefined {
	const catalog: MetadataCatalog = { models: new Map(), providers: new Map() };
	const entries = Array.isArray(payload) ? payload : asRecord(payload).data;
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			const model = canonicalizeModel(entry);
			if (model) catalog.models.set(model.id, model);
		}
	} else {
		for (const [providerId, entry] of Object.entries(asRecord(payload))) {
			const models = new Map<string, ModelMetadata>();
			for (const [id, value] of Object.entries(asRecord(asRecord(entry).models))) {
				const raw = asRecord(value);
				if (Object.keys(raw).length === 0) continue;
				const model = canonicalizeModel({ ...raw, id: nonEmptyString(raw.id) ?? id });
				if (model) models.set(model.id, model);
			}
			if (models.size > 0) catalog.providers.set(providerId, models);
		}
	}
	return catalog.models.size > 0 || catalog.providers.size > 0 ? catalog : undefined;
}

/** Never guess aliases or choose arbitrarily between catalogs with the same ID. */
export function findMetadata(catalog: MetadataCatalog, id: string, providerId: string, metadataProvider?: string): ModelMetadata | undefined {
	if (catalog.models.size > 0) return catalog.models.get(id);
	if (metadataProvider) {
		const models = catalog.providers.get(metadataProvider);
		return models?.get(id) ?? (id.startsWith(`${metadataProvider}/`) ? models?.get(id.slice(metadataProvider.length + 1)) : undefined);
	}
	const local = catalog.providers.get(providerId)?.get(id);
	if (local) return local;
	const slash = id.indexOf("/");
	if (slash > 0) {
		const qualified = catalog.providers.get(id.slice(0, slash))?.get(id.slice(slash + 1));
		if (qualified) return qualified;
	}
	const matches = [...catalog.providers.values()].map((models) => models.get(id)).filter((model) => model !== undefined);
	return matches.length === 1 ? matches[0] : undefined;
}

/** Endpoint declarations win, including false and zero; keep the endpoint's ID and thinking tiers. */
export function mergeMetadata(endpoint: ModelMetadata, fallback?: ModelMetadata): ModelMetadata {
	if (!fallback) return endpoint;
	return {
		id: endpoint.id,
		api: endpoint.api,
		name: endpoint.name ?? fallback.name,
		contextWindow: endpoint.contextWindow ?? fallback.contextWindow,
		maxTokens: endpoint.maxTokens ?? fallback.maxTokens,
		input: endpoint.input ?? fallback.input,
		reasoning: endpoint.reasoning ?? fallback.reasoning,
		thinking: endpoint.thinking,
		cost: {
			input: endpoint.cost?.input ?? fallback.cost?.input,
			output: endpoint.cost?.output ?? fallback.cost?.output,
			cacheRead: endpoint.cost?.cacheRead ?? fallback.cost?.cacheRead,
			cacheWrite: endpoint.cost?.cacheWrite ?? fallback.cost?.cacheWrite,
		},
	};
}
