import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { findMetadata, parseMetadataCatalog } from "../src/metadata.ts";
import { metadataPath, readSavedMetadata, saveMetadata } from "../src/metadata-store.ts";

test("concurrent source updates retain normalized catalogs and leave complete JSON without temporary files", async (t) => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = await mkdtemp(join(tmpdir(), "pi-discovery-metadata-store-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	});
	const flat = parseMetadataCatalog({ data: [{ id: "flat", context_length: 128_000, apiKey: "not-metadata", headers: { Authorization: "not-metadata" },
		thinkingLevelMap: { max: "max" }, capabilities: { effort: { medium: false } },
		reasoning_options: [{ type: "effort", values: ["high", "max"], apiKey: "not-metadata" }],
	}] })!;
	const providers = parseMetadataCatalog({ origin: { models: { model: { limit: { context: 256_000 }, cost: { input: 0, cache_read: 0.5 },
		reasoning_options: [{ type: "budget_tokens", min: 1024 }, { type: "toggle" }],
	} } } })!;
	await Promise.all([saveMetadata("https://flat.example.com/models", flat), saveMetadata("https://catalog.example.com/models", providers)]);
	const saved = await readFile(metadataPath(), "utf-8");
	assert.equal(Object.keys(JSON.parse(saved).sources).length, 2);
	assert.ok(!saved.includes("not-metadata"));
	assert.deepEqual(await readdir(dirname(metadataPath())), ["metadata.json"]);
	assert.equal(findMetadata((await readSavedMetadata("https://flat.example.com/models"))!, "flat", "gateway")!.contextWindow, 128_000);
	assert.deepEqual(findMetadata((await readSavedMetadata("https://flat.example.com/models"))!, "flat", "gateway")!.thinking, flat.models.get("flat")!.thinking);
	const model = findMetadata((await readSavedMetadata("https://catalog.example.com/models"))!, "model", "gateway", "origin")!;
	assert.equal(model.contextWindow, 256_000);
	assert.equal(model.cost!.input, 0);
	assert.equal(model.cost!.cacheRead, 0.5);
	assert.deepEqual(model.thinking, providers.providers.get("origin")!.get("model")!.thinking);
	assert.equal(await readSavedMetadata("https://other.example.com/models"), undefined);
});
