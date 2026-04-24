/**
 * /synthetic-models command handler.
 * Displays all available Synthetic models with pricing and capabilities in an interactive TUI overlay.
 */

import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Container, type SelectItem, SelectList, type SelectListTheme, Spacer, Text } from "@mariozechner/pi-tui";
import { getSyntheticApiKey } from "../auth.js";
import { SYNTHETIC_MODELS_ENDPOINT } from "../config.js";
import {
	formatCatalogHeader,
	formatCatalogRow,
	formatContextTokens,
	formatDatacenters,
	formatPrice,
	formatTokenCount,
	getModelCapabilities,
	getProviderSortRank,
} from "../formatting.js";
import type { SyntheticModel, SyntheticModelsResponse } from "../types.js";

export function registerSyntheticModelsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("synthetic-models", {
		description: "Display all available Synthetic models with pricing and capabilities",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log("[Synthetic Provider] /synthetic-models requires interactive mode");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish before switching models", "warning");
				return;
			}

			ctx.ui.notify("Fetching model catalog from Synthetic API...", "info");

			try {
				const apiKey = await getSyntheticApiKey(ctx);
				const headers: Record<string, string> = {
					Accept: "application/json",
				};
				if (apiKey) {
					headers.Authorization = `Bearer ${apiKey}`;
				}

				const response = await fetch(SYNTHETIC_MODELS_ENDPOINT, { headers });
				if (!response.ok) {
					throw new Error(`API error: ${response.status} ${response.statusText}`);
				}

				const data = (await response.json()) as SyntheticModelsResponse;
				const models = data.data.filter((m) => m.always_on);

				// Sort with Synthetic-hosted models first, then provider/name
				models.sort((a, b) => {
					const rankCompare = getProviderSortRank(a.provider) - getProviderSortRank(b.provider);
					if (rankCompare !== 0) return rankCompare;

					const providerCompare = (a.provider || "unknown").localeCompare(b.provider || "unknown");
					if (providerCompare !== 0) return providerCompare;

					return (a.name || a.id).localeCompare(b.name || b.id);
				});

				if (models.length === 0) {
					ctx.ui.notify("No always-on models returned by Synthetic API", "warning");
					return;
				}

				const itemToModel = new Map<string, SyntheticModel>();
				const items: SelectItem[] = models.map((m) => {
					const provider = m.provider || "unknown";
					const itemKey = `${provider}:${m.id}`;
					itemToModel.set(itemKey, m);

					return {
						value: itemKey,
						label: formatCatalogRow(m),
					};
				});

				let overlayRows = 44;
				let overlayCols = 140;

				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						overlayRows = tui.terminal.rows;
						overlayCols = tui.terminal.columns;

						const selectTheme: SelectListTheme = {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: (text) => theme.fg("warning", text),
						};

						const listMaxVisible = Math.max(6, Math.min(14, overlayRows - 24));
						const selectList = new SelectList(items, Math.min(items.length, listMaxVisible), selectTheme);
						const detailsText = new Text("", 1, 0);

						const updateDetails = (model: SyntheticModel | undefined) => {
							if (!model) {
								detailsText.setText(theme.fg("muted", "No model selected"));
								return;
							}

							const provider = model.provider || "unknown";
							const caps = getModelCapabilities(model);
							const datacenters = formatDatacenters(model.datacenters);

							const lines = [
								theme.fg("accent", theme.bold("Selected model")),
								`${theme.fg("muted", "ID:")} ${model.id}`,
								`${theme.fg("muted", "Provider:")} ${provider}`,
								`${theme.fg("muted", "Context:")} ${formatContextTokens(model.context_length)} (${formatTokenCount(model.context_length)})`,
								`${theme.fg("muted", "Max output:")} ${formatContextTokens(model.max_output_length)} (${formatTokenCount(model.max_output_length)})`,
								`${theme.fg("muted", "Pricing ($/M):")} in ${formatPrice(model.pricing?.prompt)} · out ${formatPrice(model.pricing?.completion)} · cache ${formatPrice(model.pricing?.input_cache_reads)}`,
								`${theme.fg("muted", "Capabilities:")} ${caps.length > 0 ? caps.join(", ") : "none"}`,
								`${theme.fg("muted", "Datacenters:")} ${datacenters}`,
								"",
								`${theme.fg("muted", "Use with:")} synthetic/${model.id}`,
							];
							detailsText.setText(lines.join("\n"));
						};

						const initial = items[0];
						updateDetails(initial ? itemToModel.get(initial.value) : undefined);

						selectList.onSelectionChange = (item) => {
							updateDetails(itemToModel.get(item.value));
							tui.requestRender();
						};

						selectList.onSelect = (item) => {
							void (async () => {
								const selected = itemToModel.get(item.value);
								if (!selected) return;

								const modelRef = `synthetic/${selected.id}`;
								const registryModel = ctx.modelRegistry.find("synthetic", selected.id);
								if (!registryModel) {
									ctx.ui.notify(
										`Model ${modelRef} is not currently registered in pi (possibly unsupported for tools)`,
										"warning",
									);
									return;
								}

								const switched = await pi.setModel(registryModel);
								if (!switched) {
									ctx.ui.notify(`No API key available for ${modelRef}`, "error");
									return;
								}

								ctx.ui.notify(`Switched model to ${modelRef}`, "info");
								done(undefined);
							})();
						};

						selectList.onCancel = () => done(undefined);

						const container = new Container();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold("Synthetic Model Catalog")), 1, 0));
						container.addChild(
							new Text(
								theme.fg(
									"muted",
									`${models.length} always-on models · prices shown are $/million tokens · R-Cache = input cache read`,
								),
								1,
								0,
							),
						);
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", formatCatalogHeader()), 1, 0));
						container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));
						container.addChild(selectList);
						container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));
						container.addChild(new Spacer(1));
						container.addChild(detailsText);
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", "↑↓ navigate · Enter switches active model · Esc closes"), 1, 0),
						);
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

						const panel = new Box(0, 0, (s: string) => theme.bg("customMessageBg", s));
						panel.addChild(container);

						return {
							render: (width) => panel.render(width),
							invalidate: () => panel.invalidate(),
							handleInput: (data) => {
								selectList.handleInput(data);
								tui.requestRender();
							},
						};
					},
					{
						overlay: true,
						overlayOptions: () => {
							const width = overlayCols < 120 ? "98%" : "96%";

							if (overlayRows < 34) {
								return {
									width: "100%",
									maxHeight: "94%",
									anchor: "center" as const,
									margin: 0,
								};
							}

							if (overlayRows < 44) {
								return {
									width,
									maxHeight: "88%",
									anchor: "top-center" as const,
									offsetY: 2,
									margin: 1,
								};
							}

							if (overlayRows < 54) {
								return {
									width,
									maxHeight: "84%",
									anchor: "top-center" as const,
									offsetY: 3,
									margin: 1,
								};
							}

							return {
								width,
								maxHeight: "80%",
								anchor: "top-center" as const,
								offsetY: 4,
								margin: 1,
							};
						},
					},
				);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to fetch models: ${errorMessage}`, "error");
				console.error("[Synthetic Provider] Model listing failed:", error);
			}
		},
	});
}
