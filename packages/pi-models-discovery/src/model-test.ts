import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import { createModelRequester, type ModelRequestCompletion, type ModelRequestContext } from "pi-model-request";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));
const TEST_TIMEOUT_MS = 30_000;
const TEST_MAX_TOKENS = 64;

export interface ModelTestResult {
	model: Model<Api>;
	ok: boolean;
	elapsedMs: number;
	reply?: string;
	error?: string;
}

/** A separate, bounded request using Pi's resolved gateway authentication and protocol. */
export async function testModel(
	ctx: ModelRequestContext,
	model: Model<Api>,
	options: { base?: ModelRequestCompletion; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ModelTestResult> {
	const started = performance.now();
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	if (signal.aborted) return { model, ok: false, elapsedMs: 0, error: i18n.t("modelTestAborted") };
	let timer: ReturnType<typeof setTimeout>;
	let cancel: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		cancel = () => reject(new Error(i18n.t(controller.signal.aborted ? "modelTestTimeout" : "modelTestAborted")));
		signal.addEventListener("abort", cancel, { once: true });
		timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TEST_TIMEOUT_MS);
	});
	try {
		const request = createModelRequester<SimpleStreamOptions>(ctx, {
			base: options.base,
			authError: (reason) => new Error(i18n.t("modelTestAuthFailed", { reason })),
		});
		const response = await Promise.race([request(model, {
			messages: [{ role: "user", content: i18n.t("modelTestPrompt"), timestamp: Date.now() }],
		}, {
			maxTokens: Math.min(TEST_MAX_TOKENS, model.maxTokens),
			maxRetries: 0,
			transport: "sse",
			cacheRetention: "none",
			timeoutMs: options.timeoutMs ?? TEST_TIMEOUT_MS,
			signal,
		}), aborted]);
		if (response.stopReason === "error" || response.stopReason === "aborted" || response.errorMessage) {
			throw new Error(response.errorMessage || i18n.t(response.stopReason === "aborted" ? "modelTestAborted" : "modelTestResponseFailed"));
		}
		const reply = response.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
		if (!reply) throw new Error(i18n.t("modelTestEmptyReply"));
		return { model, ok: true, elapsedMs: Math.round(performance.now() - started), reply };
	} catch (error) {
		return { model, ok: false, elapsedMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	}
}

/** Qualified IDs are compared whole so model IDs may themselves contain slashes. */
export function selectTestModels(args: string, models: Model<Api>[], current?: Model<Api>): Model<Api>[] {
	const target = args.trim();
	if (!target) return current ? [current] : [];
	if (target === "all") return models;
	const qualified = models.find((model) => `${model.provider}/${model.id}` === target);
	if (qualified) return [qualified];
	if (target.endsWith("/*")) return models.filter((model) => model.provider === target.slice(0, -2));
	const providerModels = models.filter((model) => model.provider === target);
	if (providerModels.length) return providerModels;
	const matches = models.filter((model) => model.id === target);
	return matches.length === 1 ? matches : [];
}

type TestNoticeSink = (notice: { level: "info" | "warning" | "error"; message: string }, ctx: ExtensionCommandContext) => void;

export function registerModelTestCommand(
	pi: ExtensionAPI,
	sink: TestNoticeSink,
	getModels: () => Model<Api>[] = () => [],
	options: { base?: ModelRequestCompletion; getAllTargets?: (ctx: ExtensionCommandContext) => Promise<Model<Api>[]> } = {},
): void {
	let running = false;
	pi.registerCommand("model_test", {
		description: i18n.t("modelTestDescription"),
		getArgumentCompletions: (prefix) => {
			const models = getModels();
			const values = ["all", ...new Set(models.map((model) => `${model.provider}/*`)), ...models.map((model) => `${model.provider}/${model.id}`)];
			return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			if (running) {
				sink({ level: "warning", message: i18n.t("modelTestRunning") }, ctx);
				return;
			}
			running = true;
			let passed = 0;
			let tested = 0;
			try {
				const candidates = args.trim() === "all" && options.getAllTargets ? await options.getAllTargets(ctx) : ctx.modelRegistry.getAll();
				const models = selectTestModels(args, candidates, ctx.model);
				if (!models.length) {
					sink({ level: "warning", message: i18n.t("modelTestNoTarget", { target: args.trim() }) }, ctx);
					return;
				}
				sink({ level: "info", message: i18n.t("modelTestStarted", { count: models.length }) }, ctx);
				for (const model of models) {
					if (ctx.signal?.aborted) break;
					const result = await testModel(ctx, model, { base: options.base, signal: ctx.signal });
					tested++;
					if (result.ok) passed++;
					sink({ level: result.ok ? "info" : "warning", message: i18n.t(result.ok ? "modelTestPassed" : "modelTestFailed", {
						model: `${model.provider}/${model.id}`, api: model.api, elapsed: result.elapsedMs, reason: result.error ?? "",
					}) }, ctx);
				}
				sink({ level: passed === tested && tested === models.length ? "info" : "warning", message: i18n.t("modelTestSummary", { passed, tested, total: models.length }) }, ctx);
			} finally {
				running = false;
			}
		},
	});
}
