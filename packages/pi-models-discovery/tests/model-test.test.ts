import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelRequestCompletion, ModelRequestContext } from "pi-model-request";
import { registerModelTestCommand, selectTestModels, testModel } from "../src/model-test.ts";

function model(id = "model", provider = "gateway", api: Api = "openai-completions"): Model<Api> {
	return { id, provider, api, name: id, baseUrl: "https://api.example.com/v1", reasoning: false, input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192 };
}

function response(target: Model<Api>, fields: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", provider: target.provider, api: target.api, model: target.id,
		content: [{ type: "text", text: "OK" }], stopReason: "stop", timestamp: 0,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...fields };
}

const ctx: ModelRequestContext = {
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "X-Gateway": "test" }, baseUrl: "https://resolved.example.com/v1" }) },
	sessionManager: { getSessionId: () => "session-test" },
};

test("model tests use resolved gateway auth, protocol and a bounded isolated prompt without history or tools", async () => {
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
		const target = model("nested/model", "opencode", api);
		const result = await testModel(ctx, target, { base: async (requested, context, options) => {
			assert.equal(requested.api, api);
			assert.equal(requested.baseUrl, "https://resolved.example.com/v1");
			assert.equal(options!.apiKey, "test-key");
			assert.deepEqual(options!.headers, { "X-Gateway": "test", "x-opencode-session": "session-test", "x-opencode-client": "pi" });
			assert.equal(options!.maxTokens, 64);
			assert.equal(options!.maxRetries, 0);
			assert.equal(options!.timeoutMs, 30_000);
			assert.equal(options!.reasoning, undefined);
			assert.equal(options!.transport, "sse");
			assert.ok(options!.signal instanceof AbortSignal);
			assert.equal(context.messages.length, 1);
			assert.equal(context.messages[0].role, "user");
			assert.ok(String(context.messages[0].content).includes("OK"));
			assert.equal(context.tools, undefined);
			assert.equal(context.systemPrompt, undefined);
			return response(requested);
		} });
		assert.equal(result.ok, true);
		assert.equal(result.reply, "OK");
		assert.equal(target.baseUrl, "https://api.example.com/v1", "do not mutate the selected model");
	}
});

test("authentication errors, rejected requests, empty replies and abort responses report failure", async () => {
	const target = model();
	let calls = 0;
	const denied: ModelRequestContext = { ...ctx, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "missing key" }) } };
	assert.equal((await testModel(denied, target, { base: async () => { calls++; return response(target); } })).ok, false);
	assert.equal(calls, 0);
	for (const fields of [{ stopReason: "error", errorMessage: "HTTP 404 model unavailable" }, { stopReason: "aborted" },
		{ content: [] }, { content: [{ type: "thinking", thinking: "hidden" }] }]) {
		const result = await testModel(ctx, target, { base: async () => response(target, fields as Partial<AssistantMessage>) });
		assert.equal(result.ok, false);
		assert.ok(result.error);
	}
	const rejected = await testModel(ctx, target, { base: async () => { throw new Error("HTTP 429"); } });
	assert.equal(rejected.ok, false);
	assert.equal(rejected.error, "HTTP 429");
});

test("timeouts bound both authentication and completion and abort the underlying request", async () => {
	let requestSignal: AbortSignal | undefined;
	const result = await testModel(ctx, model(), { timeoutMs: 10, base: async (_model, _context, options) => {
		requestSignal = options!.signal;
		return new Promise(() => {});
	} });
	assert.equal(result.ok, false);
	assert.equal(requestSignal!.aborted, true);
	assert.ok(result.elapsedMs < 1000);
	const stalled: ModelRequestContext = { ...ctx, modelRegistry: { getApiKeyAndHeaders: async () => new Promise(() => {}) } };
	assert.equal((await testModel(stalled, model(), { timeoutMs: 10 })).ok, false);
	const controller = new AbortController();
	controller.abort();
	let called = false;
	assert.equal((await testModel(ctx, model(), { signal: controller.signal, base: async () => { called = true; return response(model()); } })).ok, false);
	assert.equal(called, false);
});

test("target selection handles current models, providers, ambiguous IDs and IDs containing slashes", () => {
	const models = [model("nested/model"), model("shared"), model("shared", "other")];
	assert.deepEqual(selectTestModels("", models, models[0]), [models[0]]);
	assert.deepEqual(selectTestModels("gateway/nested/model", models), [models[0]]);
	assert.deepEqual(selectTestModels("nested/model", models), [models[0]]);
	assert.deepEqual(selectTestModels("gateway", models), models.slice(0, 2));
	assert.deepEqual(selectTestModels("gateway/*", models), models.slice(0, 2));
	assert.deepEqual(selectTestModels("all", models), models);
	for (const target of ["shared", "missing", "none/*", ""]) assert.deepEqual(selectTestModels(target, models), []);
});

test("command tests provider models sequentially, continues on failure and preserves the current selection", async () => {
	const models = [model("one"), model("two"), model("three", "other")];
	let command: Parameters<ExtensionAPI["registerCommand"]>[1];
	const pi = { registerCommand: (name, value) => { assert.equal(name, "model_test"); command = value; } } as ExtensionAPI;
	const notices: { level: string; message: string }[] = [];
	let active = 0;
	const tested: string[] = [];
	const base: ModelRequestCompletion<SimpleStreamOptions> = async (target) => {
		active++;
		assert.equal(active, 1);
		tested.push(target.id);
		await Promise.resolve();
		active--;
		return response(target, target.id === "one" ? { stopReason: "error", errorMessage: "HTTP 404" } : {});
	};
	registerModelTestCommand(pi, (notice) => notices.push(notice), () => models, { base, getAllTargets: async () => models.slice(0, 2) });
	const context = { ...ctx, model: models[2], modelRegistry: { ...ctx.modelRegistry, getAll: () => models } } as ExtensionCommandContext;
	await command!.handler("all", context);
	assert.deepEqual(tested, ["one", "two"], "all should use configured discovery providers only");
	assert.equal(context.model, models[2]);
	assert.ok(notices.some((notice) => notice.message.includes("HTTP 404") && notice.level === "warning"));
	assert.ok(notices.some((notice) => notice.message.includes("gateway/two") && notice.level === "info"));
	assert.equal(notices.length, 4, "start, individual results and summary");
	assert.ok(command!.getArgumentCompletions!("gateway/")!.some((item) => item.value === "gateway/one"));
	await command!.handler("", context);
	assert.equal(tested.at(-1), "three");
	await command!.handler("missing", context);
	assert.equal(tested.length, 3);
});

test("only one model-test command runs while asynchronous target selection is pending", async () => {
	let command: Parameters<ExtensionAPI["registerCommand"]>[1];
	const pi = { registerCommand: (_name, value) => { command = value; } } as ExtensionAPI;
	let select: (models: Model<Api>[]) => void;
	const candidates = new Promise<Model<Api>[]>((resolve) => { select = resolve; });
	let calls = 0;
	const notices: string[] = [];
	registerModelTestCommand(pi, (notice) => notices.push(notice.message), () => [], {
		getAllTargets: async () => candidates,
		base: async (target) => { calls++; return response(target); },
	});
	const context = { ...ctx, modelRegistry: { ...ctx.modelRegistry, getAll: () => [model()] } } as ExtensionCommandContext;
	const first = command!.handler("all", context);
	await command!.handler("gateway/model", context);
	assert.equal(calls, 0);
	assert.equal(notices.length, 1, "second command must report the active test");
	select!([model()]);
	await first;
	assert.equal(calls, 1);
	await command!.handler("gateway/model", context);
	assert.equal(calls, 2, "running state must reset after the first command completes");
});
