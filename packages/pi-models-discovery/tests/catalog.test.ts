import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import discoveryExtension, { buildModel } from "../src/index.ts";

test("locales catalog provides zh-CN and en-US for every key", () => {
	const catalog = JSON.parse(
		readFileSync(new URL("../locales/index.json", import.meta.url), "utf-8"),
	) as Record<string, Record<string, string>>;
	for (const [key, entry] of Object.entries(catalog)) {
		assert.ok(typeof entry["zh-CN"] === "string" && entry["zh-CN"].length > 0, `${key} missing zh-CN`);
		assert.ok(typeof entry["en-US"] === "string" && entry["en-US"].length > 0, `${key} missing en-US`);
	}
});

test("default export is an extension factory", async () => {
	const mod = await import("../index.ts");
	assert.equal(typeof mod.default, "function");
});

/** 隔离 agent 配置目录与网络；通过扩展入口验证读取、注册和缓存。 */
async function discoveryHarness(t: TestContext, entries?: Array<Record<string, unknown>>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-models-discovery-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});
	const requests: Array<{ url: string; headers: RequestInit["headers"] }> = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		requests.push({ url, headers: init.headers });
		return Response.json({ data: entries ?? [{ id: `model-${requests.length}` }] });
	});
	const registrations = new Map<string, Parameters<ExtensionAPI["registerProvider"]>[1]>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const events = new Map<string, (event: unknown, ctx: unknown) => void>();
	const warnings: string[] = [];
	const pi: Pick<ExtensionAPI, "registerCommand" | "on"> & {
		registerProvider(id: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]): void;
	} = {
		registerProvider: (id, config) => {
			registrations.set(id, config);
		},
		registerCommand: (name, command) => {
			commands.set(name, command);
		},
		on: (name, handler) => { events.set(name, handler as (event: unknown, ctx: unknown) => void); },
	};
	return {
		dir,
		requests,
		registrations,
		commands,
		warnings: () => {
			events.get("session_start")?.({}, { ui: { notify: (message: string, level: string) => {
				if (level === "warning") warnings.push(message);
			} } });
			return warnings.splice(0);
		},
		configure: (providers: Record<string, unknown>) =>
			writeFile(join(dir, "models.json"), JSON.stringify({ providers })),
		start: () => discoveryExtension(pi as ExtensionAPI),
	};
}

const refreshContext = (allowNetwork: boolean) => ({
	allowNetwork,
	signal: new AbortController().signal,
	publish: async () => true,
});

const discoveryProvider = {
	baseUrl: "https://api.example.com/v1///",
	api: "openai-completions",
	discoverModels: true,
	refreshOnStartup: false,
};

test("discovery defaults to baseUrl/models when modelsUrl is absent or empty", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({
		absent: discoveryProvider,
		empty: { ...discoveryProvider, modelsUrl: "" },
		nonString: { ...discoveryProvider, modelsUrl: 123 },
	});
	await h.start();
	assert.deepEqual(h.requests.map((r) => r.url), ["https://api.example.com/v1/models"]);
	assert.equal(h.registrations.size, 3);
	for (const config of h.registrations.values()) assert.equal(config.models?.[0].id, "model-1");
});

test("modelsUrl is used verbatim with existing authentication and refresh behavior", async (t) => {
	const h = await discoveryHarness(t);
	const modelsUrl = "https://catalog.example.com/custom/models?region=test";
	await h.configure({ foo: {
		...discoveryProvider,
		modelsUrl,
		apiKey: "test-key",
		headers: { "X-Catalog": "test" },
	} });
	await h.start();
	const config = h.registrations.get("foo")!;
	assert.equal(config.baseUrl, discoveryProvider.baseUrl);
	assert.equal("modelsUrl" in config, false);
	assert.deepEqual(h.requests, [{ url: modelsUrl, headers: { "X-Catalog": "test", Authorization: "Bearer test-key" } }]);
	assert.equal((await config.refreshModels!(refreshContext(false)))[0].id, "model-1");
	assert.equal(h.requests.length, 1);
	assert.equal((await config.refreshModels!(refreshContext(true)))[0].id, "model-2");
	assert.equal(h.requests[1].url, modelsUrl);
	await h.commands.get("config:model-discovery-refresh")!.handler("", {
		hasUI: true,
		ui: { notify: () => {} },
	} as unknown as Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]);
	assert.equal(h.requests[2].url, modelsUrl);
});

test("request cache separates different modelsUrl values and shares identical endpoints", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({
		foo: { ...discoveryProvider, modelsUrl: "https://catalog.example.com/first" },
		bar: { ...discoveryProvider, modelsUrl: "https://catalog.example.com/second" },
		shared: { ...discoveryProvider, baseUrl: "https://other.example.com/v1", modelsUrl: "https://catalog.example.com/first" },
	});
	await h.start();
	assert.deepEqual(h.requests.map((r) => r.url), ["https://catalog.example.com/first", "https://catalog.example.com/second"]);
	assert.equal(h.registrations.get("foo")!.models?.[0].id, "model-1");
	assert.equal(h.registrations.get("bar")!.models?.[0].id, "model-2");
	assert.equal(h.registrations.get("shared")!.models?.[0].id, "model-1");
});

test("shared modelsUrl does not mix provider compatibility settings", async (t) => {
	const h = await discoveryHarness(t);
	const modelsUrl = "https://catalog.example.com/models";
	await h.configure({
		foo: { ...discoveryProvider, modelsUrl, compat: { supportsDeveloperRole: true } },
		bar: { ...discoveryProvider, modelsUrl, compat: { supportsDeveloperRole: false } },
	});
	await h.start();
	assert.equal(h.requests.length, 2);
	assert.deepEqual(h.registrations.get("foo")!.models?.[0].compat, { supportsDeveloperRole: true });
	assert.deepEqual(h.registrations.get("bar")!.models?.[0].compat, { supportsDeveloperRole: false });
});

test("a failing modelsUrl keeps fallback registration without retrying baseUrl", async (t) => {
	const h = await discoveryHarness(t);
	const modelsUrl = "https://catalog.example.com/models";
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		requests.push(url);
		return url === modelsUrl ? new Response(null, { status: 401 }) : Response.json({ data: [{ id: "healthy" }] });
	});
	await h.configure({
		failed: { ...discoveryProvider, modelsUrl, models: [{ id: "handwritten" }] },
		healthy: discoveryProvider,
	});
	await h.start();
	assert.deepEqual(requests, [modelsUrl, "https://api.example.com/v1/models"]);
	const failed = h.registrations.get("failed")!;
	assert.equal(failed.baseUrl, discoveryProvider.baseUrl);
	assert.equal(failed.models, undefined, "do not override handwritten fallback models");
	await assert.rejects(() => failed.refreshModels!(refreshContext(false)));
	assert.equal(h.registrations.get("healthy")!.models?.[0].id, "healthy");
});

test("providers without modelsUrl reuse cache fingerprints from before this feature", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({ foo: discoveryProvider });
	const cacheDir = join(h.dir, "extensions", "pi-models-discovery");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "cache.json"), JSON.stringify({
		version: 1,
		providers: { foo: {
			fingerprint: JSON.stringify([discoveryProvider.baseUrl, discoveryProvider.api, "", {}, {}]),
			fetchedAt: "2026-01-01T00:00:00.000Z",
			models: [buildModel({ id: "cached" })],
		} },
	}));
	await h.start();
	assert.equal(h.requests.length, 0);
	assert.equal(h.registrations.get("foo")!.models?.[0].id, "cached");
});

test("persistent cache is reused and invalidated when modelsUrl is added, changed or removed", async (t) => {
	const h = await discoveryHarness(t);
	for (const modelsUrl of [undefined, "https://catalog.example.com/first", "https://catalog.example.com/second", undefined]) {
		await h.configure({ foo: { ...discoveryProvider, modelsUrl } });
		await h.start();
		const count = h.requests.length;
		await h.start();
		assert.equal(h.requests.length, count, "unchanged configuration must not fetch again");
		assert.equal(h.registrations.get("foo")!.models?.[0].id, `model-${count}`);
	}
	assert.deepEqual(h.requests.map((r) => r.url), [
		"https://api.example.com/v1/models",
		"https://catalog.example.com/first",
		"https://catalog.example.com/second",
		"https://api.example.com/v1/models",
	]);
});

test("context window falls back to vLLM max_model_len", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "vllm", max_model_len: 200_000 },
		{ id: "explicit", context_window: 128_000, max_model_len: 200_000 },
		{ id: "bare" },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	const windows = h.registrations.get("foo")!.models!.map((m) => [m.id, m.contextWindow]);
	assert.deepEqual(windows, [["vllm", 200_000], ["explicit", 128_000], ["bare", 1_000_000]]);
});

test("discovery reads gateway and Anthropic token limits without replacing existing aliases", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "gateway", context_length: 1_050_000, max_context_length: 2_000_000, max_output_tokens: 128_000, max_completion_tokens: 4096 },
		{ id: "anthropic", max_input_tokens: 200_000, max_tokens: 32_000 },
		{ id: "groq", context_window: 131_072, max_completion_tokens: 32_768 },
		{ id: "mistral", max_context_length: 32_768, max_input_tokens: 64_000 },
		{ id: "snake", context_window: 128_000, context_length: 256_000, max_tokens: 4096, max_output_tokens: 8192 },
		{ id: "camel", contextWindow: 64_000, context_length: 256_000, maxTokens: 2048, max_output_tokens: 8192 },
		{ id: "vllm", max_model_len: 48_000, context_length: 256_000, max_output_tokens: 1024 },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => [m.id, m.contextWindow, m.maxTokens]), [
		["gateway", 1_050_000, 128_000],
		["anthropic", 200_000, 32_000],
		["groq", 131_072, 32_768],
		["mistral", 32_768, 65_536],
		["snake", 128_000, 4096],
		["camel", 64_000, 2048],
		["vllm", 48_000, 1024],
	]);
});

test("invalid token limits fall through to a valid alias or the existing defaults", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "fallback", context_window: 0, contextWindow: -1, max_model_len: "broken", context_length: 256_000,
			max_tokens: -1, maxTokens: "broken", max_output_tokens: 8192 },
		{ id: "invalid", context_length: 1.5, max_input_tokens: null, max_output_tokens: 0 },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => [m.contextWindow, m.maxTokens]), [
		[256_000, 8192], [1_000_000, 65_536],
	]);
});

test("discovery uses display_name only when name is absent or invalid", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "named", name: "Explicit name", display_name: "Display name" },
		{ id: "display", display_name: "Display name" },
		{ id: "invalid", name: 123, display_name: "Valid display name" },
		{ id: "bare", name: "", display_name: null },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => m.name), [
		"Explicit name", "Display name", "Valid display name", "bare",
	]);
});

test("discovery maps advertised image and reasoning capabilities, preserving explicit false", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "text", capabilities: { vision: false, reasoning: false } },
		{ id: "anthropic", capabilities: { image_input: { supported: true }, thinking: { supported: true } } },
		{ id: "disabled", capabilities: { image_input: { supported: false }, thinking: { supported: false } } },
		{ id: "explicit", input: ["text"], reasoning: false, capabilities: { vision: true, thinking: { supported: true } } },
		{ id: "image-only", input: ["image", "audio"], capabilities: { vision: false } },
		{ id: "unknown", mode: "custom-conversational-mode" },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => [m.id, m.input, m.reasoning]), [
		["text", ["text"], false],
		["anthropic", ["text", "image"], true],
		["disabled", ["text"], false],
		["explicit", ["text"], false],
		["image-only", ["text", "image"], true],
		["unknown", ["text", "image"], true],
	]);
});

test("discovery maps per-million prices directly into Pi token costs", async (t) => {
	const h = await discoveryHarness(t, [{
		id: "priced",
		pricing: {
			input_per_million: 1.36,
			output_per_million: 6.8,
			cache_read_input_per_million: 0.068,
			cache_creation_input_per_million: 1.7,
		},
	}]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models![0].cost, {
		input: 1.36, output: 6.8, cacheRead: 0.068, cacheWrite: 1.7,
	});
});

test("explicit costs win over pricing and invalid prices never become negative or unknown-unit costs", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "explicit", cost: { input: 0, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			pricing: { input_per_million: 3, output_per_million: 4 } },
		{ id: "snake", cost: { input: -1, cache_read: 0.3, cache_write: 0.4 },
			pricing: { input_per_million: 1, output_per_million: 2 } },
		{ id: "invalid", pricing: { input_per_million: -1, output_per_million: "broken",
			cache_read_input_per_million: null, prompt: "0.000001", completion: "0.000002" } },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => m.cost), [
		{ input: 0, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		{ input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0.4 },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	]);
});

test("advertised metadata survives cached startup, offline reads and online refresh", async (t) => {
	const entries = [{ id: "metadata", display_name: "Metadata", context_length: 256_000,
		max_output_tokens: 8192, input: ["text"], reasoning: false,
		pricing: { input_per_million: 1, output_per_million: 2 } }];
	const h = await discoveryHarness(t, entries);
	await h.configure({ foo: discoveryProvider });
	for (let startup = 0; startup < 2; startup++) {
		await h.start();
		const config = h.registrations.get("foo")!;
		for (const models of [config.models!, await config.refreshModels!(refreshContext(false))]) {
			assert.equal(models[0].name, "Metadata");
			assert.equal(models[0].contextWindow, 256_000);
			assert.equal(models[0].maxTokens, 8192);
			assert.deepEqual(models[0].input, ["text"]);
			assert.equal(models[0].reasoning, false);
			assert.deepEqual(models[0].cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
		}
	}
	assert.equal(h.requests.length, 1, "cached startup and offline reads must not fetch");
	entries[0].max_output_tokens = 16_384;
	entries[0].pricing.input_per_million = 3;
	const refreshed = await h.registrations.get("foo")!.refreshModels!(refreshContext(true));
	assert.equal(refreshed[0].maxTokens, 16_384);
	assert.equal(refreshed[0].cost.input, 3);
	assert.equal(h.requests.length, 2);
});

test("provider reasoning overrides take priority over advertised metadata", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "disabled", reasoning: false },
		{ id: "enabled", capabilities: { thinking: { supported: true } } },
	]);
	await h.configure({
		on: { ...discoveryProvider, compat: { reasoning: true } },
		off: { ...discoveryProvider, compat: { reasoning: false } },
	});
	for (let startup = 0; startup < 2; startup++) {
		await h.start();
		for (const [id, config] of h.registrations) {
			for (const models of [config.models!, await config.refreshModels!(refreshContext(false)), await config.refreshModels!(refreshContext(true))]) {
				assert.deepEqual(models.map((m) => m.reasoning), id === "on" ? [true, true] : [false, false]);
			}
		}
	}
});

test("discovered models do not assume xhigh and max support", () => {
	const model = buildModel({ id: "some-model" }) as unknown as Model<Api>;
	assert.deepEqual(model.thinkingLevelMap, { xhigh: null, max: null });
	assert.deepEqual(getSupportedThinkingLevels(model), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
	]);
});

test("provider thinking overrides apply to discovery, cache and online refresh", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({
		local: { ...discoveryProvider, compat: {
			reasoning: false,
			thinkingLevelMap: { minimal: null, high: null, xhigh: null, max: null },
			supportsReasoningEffort: false,
			thinkingFormat: "qwen",
		} },
		optIn: { ...discoveryProvider, compat: { thinkingLevelMap: { xhigh: "high", max: "max" } } },
	});
	for (let startup = 0; startup < 2; startup++) {
		await h.start();
		for (const [id, config] of h.registrations) {
			for (const models of [config.models!, await config.refreshModels!(refreshContext(false)), await config.refreshModels!(refreshContext(true))]) {
				const model = models[0] as unknown as Model<Api>;
				if (id === "local") {
					assert.equal(model.reasoning, false);
					assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
					assert.deepEqual(model.thinkingLevelMap, { minimal: null, high: null, xhigh: null, max: null });
					assert.deepEqual(model.compat, { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "qwen" });
				} else {
					assert.equal(model.reasoning, true);
					assert.deepEqual(getSupportedThinkingLevels(model), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
					assert.deepEqual(model.thinkingLevelMap, { xhigh: "high", max: "max" });
				}
			}
		}
	}
	assert.equal(h.requests.length, 6, "second startup must reuse the persistent cache");
});

test("legacy cached thinking defaults are corrected without network access", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({ foo: discoveryProvider });
	const cacheDir = join(h.dir, "extensions", "pi-models-discovery");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "cache.json"), JSON.stringify({
		version: 1,
		providers: { foo: {
			fingerprint: JSON.stringify([discoveryProvider.baseUrl, discoveryProvider.api, "", {}, {}]),
			models: [{ ...buildModel({ id: "cached", name: "Cached", contextWindow: 128_000, maxTokens: 4096 }), thinkingLevelMap: { xhigh: "xhigh", max: "max" } }],
		} },
	}));
	await h.start();
	const config = h.registrations.get("foo")!;
	for (const models of [config.models!, await config.refreshModels!(refreshContext(false))]) {
		assert.deepEqual(models[0].thinkingLevelMap, { xhigh: null, max: null });
		assert.equal(models[0].name, "Cached");
		assert.equal(models[0].contextWindow, 128_000);
		assert.equal(models[0].maxTokens, 4096);
	}
	assert.equal(h.requests.length, 0);
});

test("cached startup ignores non-boolean reasoning values", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({ foo: discoveryProvider });
	const cacheDir = join(h.dir, "extensions", "pi-models-discovery");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "cache.json"), JSON.stringify({
		version: 1,
		providers: { foo: {
			fingerprint: JSON.stringify([discoveryProvider.baseUrl, discoveryProvider.api, "", {}, {}]),
			models: [{ ...buildModel({ id: "cached" }), reasoning: "no" }],
		} },
	}));
	await h.start();
	assert.equal(h.registrations.get("foo")!.models![0].reasoning, true);
	assert.equal(h.requests.length, 0);
});

/**
 * 用 Pi 真实的模型注册表组合扩展注册结果与 models.json（含 modelOverrides）。
 * 凭据与模型存储放在内存里：registerProvider 会在后台刷新并写存储文件，落盘会与测试清理临时目录竞争（ENOTEMPTY）。
 */
async function piRegistry(h: { dir: string; registrations: Map<string, Parameters<ExtensionAPI["registerProvider"]>[1]> }) {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: join(h.dir, "models.json"),
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	const registry = new ModelRegistry(runtime);
	for (const [id, config] of h.registrations) registry.registerProvider(id, config);
	return registry;
}

const requestStreams: Record<string, (model: Model<Api>, context: never, options: SimpleStreamOptions) => AsyncIterable<unknown>> = {
	"anthropic-messages": anthropicStream as never,
	"openai-completions": completionsStream as never,
	"openai-responses": responsesStream as never,
};

/** 经 Pi 真实的请求转换生成请求体（假 fetch，不联网），返回实际发送的 effort 字段。 */
async function requestedEffort(model: Model<Api>, reasoning: ThinkingLevel): Promise<unknown> {
	let payload: Record<string, any> = {};
	const events = requestStreams[model.api](model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, {
		apiKey: "test-key",
		reasoning,
		maxRetries: 0,
		onPayload: (body) => {
			payload = body as Record<string, any>;
			return undefined;
		},
		fetch: async () => new Response("{}", { status: 400 }),
	});
	for await (const _event of events) { /* 请求被假 fetch 拒绝即结束 */ }
	if (model.api === "anthropic-messages") return payload.output_config?.effort;
	if (model.api === "openai-responses") return payload.reasoning?.effort;
	return payload.reasoning_effort;
}

/** Pi 提供的每个非 off 档位及其实际请求值；结果里没有的档位即 Pi 不提供。 */
async function offeredEfforts(model: Model<Api>): Promise<Partial<Record<ThinkingLevel, unknown>>> {
	const efforts: Partial<Record<ThinkingLevel, unknown>> = {};
	for (const level of getSupportedThinkingLevels(model)) {
		if (level !== "off") efforts[level] = await requestedEffort(model, level);
	}
	return efforts;
}

const thinkingLevels = (models: unknown[]): ModelThinkingLevel[][] =>
	models.map((model) => getSupportedThinkingLevels(model as Model<Api>));

test("explicit model thinking maps are validated per alias and omitted levels keep the fallback", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "camel", thinkingLevelMap: { xhigh: "xhigh", max: null, low: null } },
		{ id: "snake", thinking_level_map: { max: "max", minimal: "low" } },
		{ id: "camel-wins", thinkingLevelMap: { xhigh: "xhigh" }, thinking_level_map: { max: "max" } },
		{ id: "malformed-camel", thinkingLevelMap: { xhigh: 1, max: "", turbo: "turbo", high: ["high"] }, thinking_level_map: { max: "max" } },
		{ id: "partly-valid", thinkingLevelMap: { xhigh: "xhigh", max: true, ultra: "ultra" } },
		{ id: "invalid", thinkingLevelMap: ["xhigh"], thinking_level_map: "max" },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	const models = h.registrations.get("foo")!.models!;
	assert.deepEqual(models.map((m) => [m.id, m.thinkingLevelMap]), [
		["camel", { xhigh: "xhigh", max: null, low: null }],
		["snake", { xhigh: null, max: "max", minimal: "low" }],
		["camel-wins", { xhigh: "xhigh", max: null }],
		["malformed-camel", { xhigh: null, max: "max" }],
		["partly-valid", { xhigh: "xhigh", max: null }],
		["invalid", { xhigh: null, max: null }],
	]);
	assert.deepEqual(thinkingLevels(models), [
		["off", "minimal", "medium", "high", "xhigh"],
		["off", "minimal", "low", "medium", "high", "max"],
		["off", "minimal", "low", "medium", "high", "xhigh"],
		["off", "minimal", "low", "medium", "high", "max"],
		["off", "minimal", "low", "medium", "high", "xhigh"],
		["off", "minimal", "low", "medium", "high"],
	]);
});

test("advertised effort support never maps a Pi level to a rejected backend effort", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "observed", capabilities: { thinking: { supported: true }, effort: {
			supported: true, low: { supported: false }, medium: { supported: true }, high: { supported: false }, max: { supported: false },
		} } },
		{ id: "extended", capabilities: { effort: {
			supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true },
			xhigh: { supported: true }, max: { supported: true },
		} } },
		{ id: "partial", capabilities: { effort: { low: true, high: { supported: true } } } },
		{ id: "unsupported", capabilities: { effort: { supported: false, low: { supported: false }, xhigh: { supported: true } } } },
		{ id: "malformed", capabilities: { effort: { low: "no", xhigh: { supported: "yes" }, max: 1 } } },
	]);
	const gateway = { ...discoveryProvider, apiKey: "test-key" };
	await h.configure({
		adaptive: { ...gateway, api: "anthropic-messages", compat: { forceAdaptiveThinking: true } },
		completions: gateway,
		responses: { ...gateway, api: "openai-responses" },
		budget: { ...gateway, api: "anthropic-messages" },
	});
	await h.start();
	const registry = await piRegistry(h);
	const efforts = async (provider: string) => Object.fromEntries(await Promise.all(
		["observed", "extended", "partial", "unsupported", "malformed"].map(async (id) => [id, await offeredEfforts(registry.find(provider, id)!)]),
	));
	const anthropicDefaults = { minimal: "low", low: "low", medium: "medium", high: "high" };
	assert.deepEqual(await efforts("adaptive"), {
		observed: { medium: "medium" },
		extended: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		partial: anthropicDefaults,
		unsupported: anthropicDefaults,
		malformed: anthropicDefaults,
	});
	const openAIDefaults = { minimal: "minimal", low: "low", medium: "medium", high: "high" };
	for (const provider of ["completions", "responses"]) {
		assert.deepEqual(await efforts(provider), {
			observed: { minimal: "minimal", medium: "medium" },
			extended: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
			partial: openAIDefaults,
			unsupported: openAIDefaults,
			malformed: openAIDefaults,
		}, provider);
	}
	// 预算式思考不发送 effort，声明的 effort 档位不适用，沿用保守默认值。
	const budgetDefaults = { minimal: undefined, low: undefined, medium: undefined, high: undefined };
	assert.deepEqual(await efforts("budget"), {
		observed: budgetDefaults, extended: budgetDefaults, partial: budgetDefaults, unsupported: budgetDefaults, malformed: budgetDefaults,
	});
});

test("provider and per-model overrides take precedence over advertised thinking levels", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "advertised", capabilities: { effort: { low: false, medium: true, high: true, xhigh: true, max: true } } },
		{ id: "explicit", thinkingLevelMap: { low: "low", max: "max" } },
		{ id: "overridden" },
		{ id: "plain" },
	]);
	const gateway = { ...discoveryProvider, api: "anthropic-messages", apiKey: "test-key" };
	await h.configure({
		foo: {
			...gateway,
			// provider 覆盖逐项生效：关闭声明支持的 max，把声明不支持的 low 改映射到 medium。
			compat: { forceAdaptiveThinking: true, thinkingLevelMap: { max: null, low: "medium" } },
			modelOverrides: {
				advertised: { thinkingLevelMap: { high: null, minimal: "low" } },
				overridden: { thinkingLevelMap: { xhigh: "xhigh" } },
			},
		},
		off: { ...gateway, compat: { forceAdaptiveThinking: true, reasoning: false } },
	});
	await h.start();
	const registry = await piRegistry(h);
	assert.deepEqual(await offeredEfforts(registry.find("foo", "advertised")!), {
		minimal: "low", low: "medium", medium: "medium", xhigh: "xhigh",
	});
	assert.deepEqual(await offeredEfforts(registry.find("foo", "explicit")!), {
		minimal: "low", low: "medium", medium: "medium", high: "high",
	});
	assert.deepEqual(await offeredEfforts(registry.find("foo", "overridden")!), {
		minimal: "low", low: "medium", medium: "medium", high: "high", xhigh: "xhigh",
	});
	// 同一网关下其他模型不会因某个模型的声明而开放额外档位。
	assert.deepEqual(await offeredEfforts(registry.find("foo", "plain")!), {
		minimal: "low", low: "medium", medium: "medium", high: "high",
	});
	for (const id of ["advertised", "explicit", "overridden", "plain"]) {
		assert.deepEqual(getSupportedThinkingLevels(registry.find("off", id)!), ["off"]);
	}
});

test("advertised thinking levels survive cached startup and offline reads, and update on online refresh", async (t) => {
	const effort: Record<string, unknown> = { supported: true, medium: { supported: true }, xhigh: { supported: true } };
	const h = await discoveryHarness(t, [
		{ id: "effort", capabilities: { effort } },
		{ id: "explicit", thinking_level_map: { max: "max" } },
	]);
	await h.configure({ foo: { ...discoveryProvider, api: "openai-responses" } });
	for (let startup = 0; startup < 2; startup++) {
		await h.start();
		const config = h.registrations.get("foo")!;
		for (const models of [config.models!, await config.refreshModels!(refreshContext(false))]) {
			assert.deepEqual(thinkingLevels(models), [
				["off", "minimal", "low", "medium", "high", "xhigh"],
				["off", "minimal", "low", "medium", "high", "max"],
			]);
		}
	}
	assert.equal(h.requests.length, 1, "cached startup and offline reads must not fetch");
	effort.medium = { supported: false };
	effort.xhigh = { supported: false };
	const changed = [["off", "minimal", "low", "high"], ["off", "minimal", "low", "medium", "high", "max"]];
	assert.deepEqual(thinkingLevels(await h.registrations.get("foo")!.refreshModels!(refreshContext(true))), changed);
	await h.start();
	assert.deepEqual(thinkingLevels(h.registrations.get("foo")!.models!), changed);
	assert.equal(h.requests.length, 2);
});

test("cached thinking metadata is revalidated and caches without it keep conservative defaults", async (t) => {
	const h = await discoveryHarness(t);
	const provider = { ...discoveryProvider, api: "openai-responses" };
	await h.configure({ foo: provider });
	const cacheDir = join(h.dir, "extensions", "pi-models-discovery");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "cache.json"), JSON.stringify({
		version: 1,
		providers: { foo: {
			fingerprint: JSON.stringify([provider.baseUrl, provider.api, "", {}, {}]),
			models: [
				{ ...buildModel({ id: "legacy" }), thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
				{ ...buildModel({ id: "tampered" }), thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
			],
			advertisedThinking: { tampered: { thinkingLevelMap: { xhigh: 1, max: "" }, effort: { xhigh: "yes", max: { supported: 1 } } } },
		} },
	}));
	await h.start();
	const config = h.registrations.get("foo")!;
	for (const models of [config.models!, await config.refreshModels!(refreshContext(false))]) {
		assert.deepEqual(models.map((m) => m.thinkingLevelMap), [{ xhigh: null, max: null }, { xhigh: null, max: null }]);
	}
	assert.equal(h.requests.length, 0);
});

const metadataUrl = "https://catalog.example.com/models.json";
const canonicalCatalog = () => ({
	origin: { models: {
		known: { id: "known", name: "Known model", reasoning: false, limit: { context: 128_000, output: 8192 },
			modalities: { input: ["text", "image"] }, cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
			thinkingLevelMap: { max: "max" } },
		unavailable: { id: "unavailable", name: "Not offered by this endpoint" },
	} },
});

test("catalog metadata enriches only endpoint-listed models and never leaks provider credentials", async (t) => {
	const h = await discoveryHarness(t);
	const requests: Array<{ url: string; init: RequestInit }> = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		requests.push({ url, init });
		return Response.json(url === metadataUrl ? canonicalCatalog() : { data: [{ id: "known" }, { id: "custom" }] });
	});
	await h.configure({ proxy: { ...discoveryProvider, metadataUrl, metadataProvider: "origin",
		apiKey: "private-test-key", headers: { "X-Private": "private-test-value" } } });
	await h.start();
	const config = h.registrations.get("proxy")!;
	assert.deepEqual(config.models!.map((model) => model.id), ["known", "custom"]);
	const model = config.models![0];
	assert.equal(model.name, "Known model");
	assert.equal(model.contextWindow, 128_000);
	assert.equal(model.maxTokens, 8192);
	assert.equal(model.reasoning, false);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
	assert.deepEqual(model.thinkingLevelMap, { xhigh: null, max: null }, "catalog tiers do not prove gateway support");
	assert.equal(config.models![1].contextWindow, 1_000_000, "unknown endpoint models remain available");
	assert.equal(requests[0].init.headers["Authorization"], "Bearer private-test-key");
	assert.equal(requests[1].init.headers, undefined, "catalog requests must not inherit provider auth or headers");
	assert.ok(requests.every((request) => request.init.signal instanceof AbortSignal));
	assert.equal("metadataUrl" in config, false);
	assert.equal("metadataProvider" in config, false);
	await h.start();
	assert.deepEqual(h.registrations.get("proxy")!.models, config.models);
	assert.deepEqual(await h.registrations.get("proxy")!.refreshModels!(refreshContext(false)), config.models);
	assert.equal(requests.length, 2, "both enriched and unknown models survive offline startup");
});

test("endpoint metadata wins field by field, including false, text-only input and zero prices", async (t) => {
	const h = await discoveryHarness(t);
	t.mock.method(globalThis, "fetch", async (url: string) => Response.json(url === metadataUrl ? {
		data: [{ id: "known", name: "Catalog", reasoning: true, input: ["text", "image"], max_tokens: 8192,
			context_window: 256_000, cost: { input: 9, output: 10, cacheRead: 1, cacheWrite: 2 } }],
	} : [{ id: "known", name: "Endpoint", reasoning: false, input: ["text"], max_tokens: 4096,
		context_window: 0, cost: { input: 0, cacheRead: 0 }, thinkingLevelMap: { max: "maximum" } }]));
	await h.configure({ proxy: { ...discoveryProvider, metadataUrl } });
	await h.start();
	const model = h.registrations.get("proxy")!.models![0];
	assert.equal(model.name, "Endpoint");
	assert.equal(model.reasoning, false);
	assert.deepEqual(model.input, ["text"]);
	assert.equal(model.contextWindow, 256_000);
	assert.equal(model.maxTokens, 4096);
	assert.deepEqual(model.cost, { input: 0, output: 10, cacheRead: 0, cacheWrite: 2 });
	assert.equal(model.thinkingLevelMap?.max, "maximum");
});

test("metadata requests are shared while provider-specific catalog matches stay isolated", async (t) => {
	const h = await discoveryHarness(t);
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		requests.push(url);
		return Response.json(url === metadataUrl ? {
			one: { models: { shared: { id: "shared", limit: { context: 100_000 }, cost: { input: 1 } } } },
			two: { models: { shared: { id: "shared", limit: { context: 200_000 }, cost: { input: 2 } } } },
		} : { data: [{ id: "shared" }] });
	});
	await h.configure({
		one: { ...discoveryProvider, metadataUrl },
		two: { ...discoveryProvider, metadataUrl },
		proxy: { ...discoveryProvider, metadataUrl, metadataProvider: "one" },
	});
	await h.start();
	assert.equal(requests.filter((url) => url === metadataUrl).length, 1);
	assert.deepEqual([...h.registrations.values()].map((config) => config.models![0].contextWindow), [100_000, 200_000, 100_000]);
	assert.deepEqual([...h.registrations.values()].map((config) => config.models![0].cost.input), [1, 2, 1]);
});

test("catalog failures warn without preventing endpoint model registration and recover on refresh", async (t) => {
	const h = await discoveryHarness(t);
	let catalogResponse = new Response(null, { status: 503 });
	t.mock.method(globalThis, "fetch", async (url: string) => url === metadataUrl ? catalogResponse.clone()
		: Response.json({ data: [{ id: "known", max_tokens: 2048 }] }));
	await h.configure({ proxy: { ...discoveryProvider, metadataUrl, metadataProvider: "origin" } });
	for (const response of [new Response(null, { status: 503 }), Response.json({ error: "invalid shape" }), new Response("invalid json")]) {
		catalogResponse = response;
		await rm(join(h.dir, "extensions"), { recursive: true, force: true });
		await h.start();
		const model = h.registrations.get("proxy")!.models![0];
		assert.equal(model.id, "known");
		assert.equal(model.maxTokens, 2048);
		assert.equal(model.contextWindow, 1_000_000);
		assert.equal(h.warnings().length, 1);
	}
	catalogResponse = Response.json(canonicalCatalog());
	const models = await h.registrations.get("proxy")!.refreshModels!(refreshContext(true));
	assert.equal(models[0].contextWindow, 128_000);
	assert.equal(models[0].maxTokens, 2048);
});

test("metadata cannot supply availability when the provider endpoint fails or is empty", async (t) => {
	const h = await discoveryHarness(t);
	const requests: string[] = [];
	let endpointResponse = new Response(null, { status: 401 });
	t.mock.method(globalThis, "fetch", async (url: string) => {
		requests.push(url);
		return url === metadataUrl ? Response.json(canonicalCatalog()) : endpointResponse.clone();
	});
	await h.configure({ proxy: { ...discoveryProvider, metadataUrl, models: [{ id: "handwritten" }] } });
	for (const response of [new Response(null, { status: 401 }), Response.json({ data: [] })]) {
		endpointResponse = response;
		await h.start();
		assert.equal(h.registrations.get("proxy")!.models, undefined, "preserve handwritten fallback without registering catalog models");
		await assert.rejects(() => h.registrations.get("proxy")!.refreshModels!(refreshContext(false)));
	}
	assert.equal(requests.includes(metadataUrl), false, "metadata is only requested after availability is confirmed");
});

test("catalog source changes invalidate persistent caches and online refresh reloads both sources", async (t) => {
	const h = await discoveryHarness(t);
	const requests: string[] = [];
	let contextWindow = 128_000;
	t.mock.method(globalThis, "fetch", async (url: string) => {
		requests.push(url);
		return Response.json(url.includes("catalog.example.com") ? {
			one: { models: { known: { id: "known", limit: { context: contextWindow } } } },
			two: { models: { known: { id: "known", limit: { context: contextWindow * 2 } } } },
		} : { data: [{ id: "known" }] });
	});
	for (const options of [{}, { metadataUrl, metadataProvider: "one" },
		{ metadataUrl, metadataProvider: "two" }, { metadataUrl: `${metadataUrl}?revision=2`, metadataProvider: "two" }, {}]) {
		await h.configure({ proxy: { ...discoveryProvider, ...options } });
		const before = requests.length;
		await h.start();
		assert.equal(requests.length - before, "metadataUrl" in options ? 2 : 1);
		await h.start();
		assert.equal(requests.length - before, "metadataUrl" in options ? 2 : 1, "unchanged config reuses cache");
	}
	await h.configure({ proxy: { ...discoveryProvider, metadataUrl, metadataProvider: "one" } });
	await h.start();
	contextWindow = 256_000;
	const before = requests.length;
	const models = await h.registrations.get("proxy")!.refreshModels!(refreshContext(true));
	assert.equal(models[0].contextWindow, 256_000);
	assert.equal(requests.length - before, 2);
});

test("invalid metadata URLs warn and keep endpoint discovery without a catalog request", async (t) => {
	const h = await discoveryHarness(t, [{ id: "known" }]);
	for (const url of ["file:///catalog.json", "https://user:password@catalog.example.com/models", "invalid"]) {
		await h.configure({ proxy: { ...discoveryProvider, metadataUrl: url } });
		await h.start();
		assert.equal(h.registrations.get("proxy")!.models![0].id, "known");
		assert.equal(h.warnings().length, 1);
	}
	assert.equal(h.requests.length, 3, "only the endpoint model-list requests are sent");
});

test("model-picker refresh reports catalog failures immediately in the active session", async (t) => {
	const h = await discoveryHarness(t);
	let failCatalog = false;
	t.mock.method(globalThis, "fetch", async (url: string) => url === metadataUrl
		? failCatalog ? new Response(null, { status: 503 }) : Response.json(canonicalCatalog())
		: Response.json({ data: [{ id: "known" }] }));
	await h.configure({ proxy: { ...discoveryProvider, metadataUrl, metadataProvider: "origin" } });
	await h.start();
	assert.deepEqual(h.warnings(), [], "establish an active session without startup warnings");
	failCatalog = true;
	assert.equal((await h.registrations.get("proxy")!.refreshModels!(refreshContext(true)))[0].id, "known");
	assert.equal(h.warnings().length, 1, "refresh warnings must be delivered even after the startup queue has been flushed");
});

test("startup refresh defaults on, updates saved metadata and keeps cached models when the gateway fails", async (t) => {
	const h = await discoveryHarness(t);
	let contextWindow = 128_000;
	let gatewayDown = false;
	const urls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		urls.push(url);
		if (gatewayDown && url !== metadataUrl) throw new Error("gateway offline");
		return Response.json(url === metadataUrl ? { origin: { models: { known: { limit: { context: contextWindow } } } } }
			: { data: [{ id: "known" }] });
	});
	await h.configure({ proxy: { ...discoveryProvider, refreshOnStartup: undefined, metadataUrl, metadataProvider: "origin", apiKey: "test-key" } });
	const original = await readFile(join(h.dir, "models.json"), "utf-8");
	await h.start();
	contextWindow = 256_000;
	await h.start();
	assert.equal(h.registrations.get("proxy")!.models![0].contextWindow, 256_000);
	assert.equal(urls.length, 4, "refresh both sources even with an unchanged fingerprint");
	const saved = JSON.parse(await readFile(join(h.dir, "extensions/pi-models-discovery/metadata.json"), "utf-8"));
	assert.equal(saved.sources[metadataUrl].providers.origin.models.known.contextWindow, 256_000);
	assert.ok(!JSON.stringify(saved).includes("test-key"));
	assert.ok(!Number.isNaN(Date.parse(saved.sources[metadataUrl].fetchedAt)));
	gatewayDown = true;
	await h.start();
	const config = h.registrations.get("proxy")!;
	assert.equal(config.models![0].contextWindow, 256_000);
	assert.deepEqual(await config.refreshModels!(refreshContext(true)), config.models, "picker refresh failure must retain usable models");
	assert.ok(h.warnings().length >= 2);
	assert.equal(await readFile(join(h.dir, "models.json"), "utf-8"), original, "automatic refresh must not rewrite gateway configuration");
	assert.ok(h.commands.has("model_test"));
	assert.ok(!h.commands.has("model"), "Pi owns the built-in picker");
});

test("saved catalog enriches new endpoint models when metadata is offline and never crosses source URLs", async (t) => {
	const h = await discoveryHarness(t);
	let metadataDown = false;
	let list = [{ id: "known" }];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		if (url.startsWith(metadataUrl)) {
			if (metadataDown) throw new Error("catalog offline");
			return Response.json({ origin: { models: { known: { limit: { context: 128_000 } }, later: { limit: { context: 256_000 } } } } });
		}
		return Response.json({ data: list });
	});
	await h.configure({ proxy: { ...discoveryProvider, metadataUrl, metadataProvider: "origin" } });
	await h.start();
	metadataDown = true;
	list.push({ id: "later" });
	let models = await h.registrations.get("proxy")!.refreshModels!(refreshContext(true));
	assert.deepEqual(models.map((model) => model.contextWindow), [128_000, 256_000]);
	assert.equal(h.warnings().length, 1);
	await h.configure({ proxy: { ...discoveryProvider, metadataUrl: `${metadataUrl}?other-source`, metadataProvider: "origin" } });
	await h.start();
	models = h.registrations.get("proxy")!.models!;
	assert.deepEqual(models.map((model) => model.contextWindow), [1_000_000, 1_000_000]);
});

test("only conversational models register and Responses-only models preserve their protocol through Pi and cache", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "embedding", mode: "embedding", capabilities: { chat: false, responses: false, embedding: true } },
		{ id: "chat", mode: "chat", capabilities: { chat: true, responses: true } },
		{ id: "responses", mode: "chat", capabilities: { chat: false, responses: true, effort: { max: true } } },
		{ id: "image-generation", mode: "image_generation" },
		{ id: "unknown" },
		{ id: "chat" },
	]);
	await h.configure({ gateway: { ...discoveryProvider, apiKey: "test-key" } });
	await h.start();
	const config = h.registrations.get("gateway")!;
	assert.deepEqual(config.models!.map((model) => model.id), ["chat", "responses", "unknown"]);
	const registry = await piRegistry(h);
	assert.equal(registry.find("gateway", "chat")!.api, "openai-completions");
	assert.equal(registry.find("gateway", "responses")!.api, "openai-responses");
	assert.equal(registry.find("gateway", "responses")!.thinkingLevelMap.max, "max");
	assert.ok(registry.getAvailable().some((model) => model.provider === "gateway" && model.id === "responses"));
	assert.equal((await registry.getApiKeyAndHeaders(registry.find("gateway", "responses")!)).ok, true);
	await h.start();
	assert.equal(h.requests.length, 1);
	assert.equal(h.registrations.get("gateway")!.models!.find((model) => model.id === "responses")!.api, "openai-responses");
	assert.equal(h.registrations.get("gateway")!.models!.find((model) => model.id === "responses")!.thinkingLevelMap.max, "max");
});

test("shared model lists can be filtered independently while preserving each route's chat URL and protocol", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "chat-one", context_length: 128_000 }, { id: "chat-two" }, { id: "other-one" },
		{ id: "chat-embedding", mode: "embedding" }, { id: "CHAT-uppercase" },
	]);
	const modelsUrl = "https://catalog.example.com/shared/models";
	const baseUrl = "https://api.example.com/anthropic";
	await h.configure({
		messages: { ...discoveryProvider, baseUrl, modelsUrl, modelIdPrefix: "chat-", api: "anthropic-messages", apiKey: "test-key" },
		other: { ...discoveryProvider, modelsUrl, modelIdPrefix: "other-" },
	});
	await h.start();
	assert.deepEqual(h.registrations.get("messages")!.models!.map((model) => model.id), ["chat-one", "chat-two"]);
	assert.deepEqual(h.registrations.get("other")!.models!.map((model) => model.id), ["other-one"]);
	const registry = await piRegistry(h);
	const selected = registry.find("messages", "chat-one")!;
	assert.equal(selected.api, "anthropic-messages");
	assert.equal(selected.baseUrl, baseUrl);
	assert.equal(selected.contextWindow, 128_000);
	assert.equal(registry.find("messages", "other-one"), undefined);
	const count = h.requests.length;
	await h.start();
	assert.equal(h.requests.length, count, "filtered results persist in the startup cache");
	const models = await h.registrations.get("messages")!.refreshModels!(refreshContext(true));
	assert.deepEqual(models.map((model) => model.id), ["chat-one", "chat-two"]);
	assert.equal(h.requests.at(-1)!.url, modelsUrl, "refresh uses the shared catalog URL");
});

test("changing or clearing a model ID prefix invalidates cache without leaking previously excluded models", async (t) => {
	const h = await discoveryHarness(t, [{ id: "one-model" }, { id: "two-model" }]);
	for (const [prefix, expected] of [["one-", ["one-model"]], ["two-", ["two-model"]], ["", ["one-model", "two-model"]]] as const) {
		await h.configure({ route: { ...discoveryProvider, modelIdPrefix: prefix } });
		const before = h.requests.length;
		await h.start();
		assert.equal(h.requests.length, before + 1);
		assert.deepEqual(h.registrations.get("route")!.models!.map((model) => model.id), expected);
		await h.start();
		assert.equal(h.requests.length, before + 1);
	}
	await h.configure({ route: { ...discoveryProvider, modelIdPrefix: "missing-", metadataUrl } });
	await h.start();
	assert.equal(h.registrations.get("route")!.models, undefined, "empty filtered lists use static fallback");
	assert.ok(!h.requests.some((request) => request.url === metadataUrl), "catalog cannot establish route availability");
});
