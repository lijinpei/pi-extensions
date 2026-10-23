import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeModel, findMetadata, parseMetadataCatalog } from "../src/metadata.ts";

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
