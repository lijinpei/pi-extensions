import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { asRecord, parseMetadataCatalog, type MetadataCatalog, type ModelMetadata } from "./metadata.ts";
import { updateJsonFile } from "./storage.ts";

interface SavedCatalog {
	fetchedAt: string;
	models: Record<string, ModelMetadata>;
	providers: Record<string, { models: Record<string, ModelMetadata> }>;
}

interface MetadataFile {
	version: 1;
	sources: Record<string, SavedCatalog>;
}

export function metadataPath(): string {
	return join(getAgentDir(), "extensions", "pi-models-discovery", "metadata.json");
}

export async function readSavedMetadata(url: string): Promise<MetadataCatalog | undefined> {
	let data: MetadataFile;
	try {
		data = JSON.parse(await readFile(metadataPath(), "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (data.version !== 1) return undefined;
	const source = asRecord(asRecord(data.sources)[url]);
	return parseMetadataCatalog({ data: Object.values(asRecord(source.models)) })
		?? parseMetadataCatalog(source.providers);
}

/** Persist only normalized metadata, never gateway headers or credential fields. */
export async function saveMetadata(url: string, catalog: MetadataCatalog): Promise<void> {
	await updateJsonFile<MetadataFile>(metadataPath(), () => ({ version: 1, sources: {} }), (data) => {
		if (data.version !== 1 || !data.sources || typeof data.sources !== "object") {
			data.version = 1;
			data.sources = {};
		}
		data.sources[url] = {
			fetchedAt: new Date().toISOString(),
			models: Object.fromEntries(catalog.models),
			providers: Object.fromEntries([...catalog.providers].map(([id, models]) => [id, { models: Object.fromEntries(models) }])),
		};
	});
}
