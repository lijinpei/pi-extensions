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

/** Validate before discovery; the first matching pattern wins. */
export function compileModelApi(map?: unknown): Array<[RegExp, string]> {
	if (map === undefined) return [];
	if (!map || typeof map !== "object" || Array.isArray(map)) {
		throw new Error(i18n.t("invalidModelApiMap"));
	}
	return Object.entries(map).map(([pattern, api]) => {
		if (typeof api !== "string" || !api.trim()) {
			throw new Error(i18n.t("invalidModelApiValue", { pattern }));
		}
		try {
			return [new RegExp(pattern), api] as [RegExp, string];
		} catch (error) {
			throw new Error(i18n.t("invalidModelApi", {
				pattern,
				reason: error instanceof Error ? error.message : String(error),
			}));
		}
	});
}

/** The api kind configured for this model id, if any. */
export function modelApiFor(rules: Array<[RegExp, string]>, id: string): string | undefined {
	return rules.find(([pattern]) => pattern.test(id))?.[1];
}
