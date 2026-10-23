import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

/** Read the regex source, converting legacy literal prefixes without changing their meaning. */
export function readModelIdRegex(config: Record<string, unknown>): string | undefined {
	if (typeof config.modelIdRegex === "string") return config.modelIdRegex;
	if (typeof config.modelIdPrefix !== "string") return undefined;
	const prefix = config.modelIdPrefix.trim();
	return prefix ? `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : undefined;
}

/** Compile once before discovery; malformed patterns must not disable filtering. */
export function compileModelIdRegex(source?: string): RegExp | undefined {
	if (!source) return undefined;
	try {
		return new RegExp(source);
	} catch (error) {
		throw new Error(i18n.t("invalidModelIdRegex", { reason: error instanceof Error ? error.message : String(error) }));
	}
}
