import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeModel, findMetadata, mergeMetadata, parseMetadataCatalog } from "../src/metadata.ts";

test("catalog matching resolves explicit providers, qualified IDs and unique IDs without guessing aliases", () => {
	const catalog = parseMetadataCatalog({
		origin: { models: { shared: { name: "Origin" }, unique: { name: "Unique" } } },
		gateway: { models: { shared: { name: "Gateway" } } },
	})!;
	assert.equal(findMetadata(catalog, "shared", "gateway")?.name, "Gateway");
	assert.equal(findMetadata(catalog, "shared", "proxy", "origin")?.name, "Origin");
	assert.equal(findMetadata(catalog, "origin/shared", "proxy")?.name, "Origin");
	assert.equal(findMetadata(catalog, "origin/shared", "proxy", "origin")?.name, "Origin");
	assert.equal(findMetadata(catalog, "unique", "proxy")?.name, "Unique");
	assert.equal(findMetadata(catalog, "shared", "proxy"), undefined, "ambiguous IDs must not pick an arbitrary price");
	assert.equal(findMetadata(catalog, "shared", "gateway", "missing"), undefined, "explicit source must not fall back to a different provider");
	assert.equal(findMetadata(catalog, "SHARED", "proxy", "origin"), undefined);
	assert.equal(findMetadata(catalog, "shared-latest", "proxy", "origin"), undefined);
});

test("metadata catalogs accept model-list envelopes and arrays, preserving exact IDs", () => {
	for (const payload of [[{ id: "origin/model", context_length: 128_000 }], { data: [{ id: "origin/model", context_length: 128_000 }] }]) {
		const catalog = parseMetadataCatalog(payload)!;
		assert.equal(findMetadata(catalog, "origin/model", "proxy", "origin")?.contextWindow, 128_000);
		assert.equal(findMetadata(catalog, "model", "proxy", "origin"), undefined);
	}
});

test("malformed and empty catalogs are rejected and invalid entries are ignored", () => {
	for (const payload of [null, true, 1, "invalid", [], {}, { data: [{}] }, { origin: { models: [null] } }]) {
		assert.equal(parseMetadataCatalog(payload), undefined);
	}
	const catalog = parseMetadataCatalog({ data: [null, false, { id: "" }, { id: "valid" }] })!;
	assert.deepEqual([...catalog.models.keys()], ["valid"]);
});

test("models.dev limits and modalities use the same validation as endpoint metadata", () => {
	const model = canonicalizeModel({ id: "model", limit: { context: -1, output: 1.5 }, modalities: { input: ["audio"] },
		cost: { input: "1", output: -2, cache_read: 0, cache_write: 0.25 } })!;
	assert.equal(model.contextWindow, undefined);
	assert.equal(model.maxTokens, undefined);
	assert.equal(model.input, undefined);
	assert.deepEqual(model.cost, { input: undefined, output: undefined, cacheRead: 0, cacheWrite: 0.25 });
});

test("models.dev reasoning options retain complete effort lists, toggles and budget limits without extra fields", () => {
	const model = canonicalizeModel({ id: "model", reasoning_options: [
		{ type: "effort", values: ["none", "low", "high", "max", "high", "turbo", null], apiKey: "secret" },
		{ type: "effort", values: ["medium"] },
		{ type: "toggle", apiKey: "secret" },
		{ type: "budget_tokens", min: 1024, max: 32768, headers: { secret: "secret" } },
		{ type: "unknown" }, null,
	] })!;
	assert.deepEqual(model.thinking!.reasoningOptions, [
		{ type: "effort", values: ["none", "low", "high", "max"] },
		{ type: "toggle" }, { type: "budget_tokens", min: 1024, max: 32768 },
	]);
	assert.ok(!JSON.stringify(model).includes("secret"));
	assert.deepEqual(canonicalizeModel(JSON.parse(JSON.stringify(model))), model, "normalized metadata must survive saving and reloading");
	for (const reasoning_options of [null, {}, [], [null, { type: "effort", values: [true, "turbo"] }, { type: "budget_tokens", min: 2048, max: 1024 }]]) {
		assert.equal(canonicalizeModel({ id: "invalid", reasoning_options })!.thinking, undefined);
	}
});

test("Claude spelling normalization is scoped to Anthropic, preserves versions and refuses ambiguous matches", () => {
	const catalog = parseMetadataCatalog({
		anthropic: { models: {
			"claude-sonnet-4-6": { name: "Sonnet" },
			"claude-opus-4-5-20251101": { name: "Dated" },
			"claude-opus-5": { name: "Canonical" },
			"Claude-Opus-5": { name: "Exact" },
		} },
		other: { models: { "claude-sonnet-4-6": { name: "Other" } } },
	})!;
	assert.equal(findMetadata(catalog, "Claude-Sonnet-4.6", "gateway", "anthropic")?.name, "Sonnet");
	assert.equal(findMetadata(catalog, "anthropic/Claude-Sonnet-4.6", "gateway")?.name, "Sonnet");
	assert.equal(findMetadata(catalog, "Claude-Sonnet-4.6", "anthropic")?.name, "Sonnet");
	assert.equal(findMetadata(catalog, "Claude-Opus-4.5-20251101", "gateway", "anthropic")?.name, "Dated");
	assert.equal(findMetadata(catalog, "Claude-Opus-5", "gateway", "anthropic")?.name, "Exact");
	assert.equal(findMetadata(catalog, "CLAUDE-OPUS-5", "gateway", "anthropic"), undefined, "normalization collisions must not pick arbitrarily");
	for (const id of ["Claude-Opus-4.5", "Claude-Sonnet-4.5", "Claude-Sonnet-4.6-latest", "vendor/Claude-Sonnet-4.6"]) {
		assert.equal(findMetadata(catalog, id, "gateway", "anthropic"), undefined);
	}
	assert.equal(findMetadata(catalog, "Claude-Sonnet-4.6", "gateway", "other"), undefined);
	assert.equal(findMetadata(catalog, "Claude-Sonnet-4.6", "gateway"), undefined, "an unselected namespace does not normalize");
	const flat = parseMetadataCatalog({ data: [{ id: "claude-sonnet-4-6" }] })!;
	assert.equal(findMetadata(flat, "Claude-Sonnet-4.6", "gateway", "anthropic"), undefined);
});

test("catalog reasoning options fill gaps while explicit endpoint controls and maps win", () => {
	const fallback = canonicalizeModel({ id: "canonical", reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] })!;
	const endpoint = canonicalizeModel({ id: "Gateway", capabilities: { effort: { max: false } }, thinkingLevelMap: { high: null } })!;
	const merged = mergeMetadata(endpoint, fallback);
	assert.equal(merged.id, "Gateway");
	assert.deepEqual(merged.thinking, { ...endpoint.thinking, reasoningOptions: fallback.thinking!.reasoningOptions });
	const explicit = canonicalizeModel({ id: "Gateway", reasoning_options: [{ type: "budget_tokens", min: 1024 }] })!;
	assert.deepEqual(mergeMetadata(explicit, fallback).thinking!.reasoningOptions, explicit.thinking!.reasoningOptions);
	assert.equal(mergeMetadata(canonicalizeModel({ id: "Gateway", capabilities: { effort: { supported: false } } })!, fallback).thinking!.effort, false);
});
