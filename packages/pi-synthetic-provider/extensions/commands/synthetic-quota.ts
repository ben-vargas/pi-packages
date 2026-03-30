/**
 * /synthetic-quota command handler.
 * Displays current API usage quotas and limits in a TUI overlay.
 */

import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Container, matchesKey, Spacer, Text } from "@mariozechner/pi-tui";
import { getSyntheticApiKey } from "../auth.js";
import {
	buildProgressBar,
	fetchSyntheticQuota,
	formatTimeRemaining,
	getQuotaSystemLabel,
	getUsageColor,
	hasVisibleQuotaBucket,
	shouldDisplaySubscriptionQuota,
} from "../quota.js";
import type { QuotaBucket, RollingFiveHourLimit, WeeklyTokenLimit } from "../types.js";

export function registerSyntheticQuotaCommand(pi: ExtensionAPI): void {
	pi.registerCommand("synthetic-quota", {
		description: "Display your Synthetic API usage quotas and limits",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log("[Synthetic Provider] /synthetic-quota requires interactive mode");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish", "warning");
				return;
			}

			const apiKey = await getSyntheticApiKey(ctx);
			if (!apiKey) {
				ctx.ui.notify("Synthetic API key not configured. Set SYNTHETIC_API_KEY or add to auth.json.", "error");
				return;
			}

			ctx.ui.notify("Fetching quota from Synthetic API...", "info");

			try {
				const quota = await fetchSyntheticQuota(apiKey);

				const BAR_WIDTH = 30;
				let overlayRows = 44;
				let overlayCols = 140;

				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						overlayRows = tui.terminal.rows;
						overlayCols = tui.terminal.columns;

						const quotaSystemLabel = getQuotaSystemLabel(quota);
						const showSubscription = shouldDisplaySubscriptionQuota(quota);
						// API has moved tool-call quota from `toolCallDiscounts` to `freeToolCalls`;
						// keep both for backwards compatibility with older payloads.
						const toolCallBucket = hasVisibleQuotaBucket(quota.toolCallDiscounts)
							? quota.toolCallDiscounts
							: hasVisibleQuotaBucket(quota.freeToolCalls)
								? quota.freeToolCalls
								: undefined;
						const visibleSections = [
							showSubscription,
							Boolean(quota.rollingFiveHourLimit),
							Boolean(quota.weeklyTokenLimit),
							hasVisibleQuotaBucket(quota.search?.hourly),
							Boolean(toolCallBucket),
						].filter(Boolean).length;
						// Count how many sections we'll render to estimate needed height
						// Normal layout: ~7 lines/bucket + 3 separator lines between + 6 chrome
						// Compact layout: ~3 lines/bucket + 1 separator line between + 4 chrome
						const normalHeight = visibleSections * 7 + Math.max(0, visibleSections - 1) * 3 + 6;
						const compact = overlayRows < 45 || normalHeight > overlayRows * 0.75;
						const barWidth = compact ? 20 : BAR_WIDTH;
						const formatPercent = (value: number) => `${value.toFixed(2)}%`;

						const renderBucket = (label: string, bucket: QuotaBucket | undefined, icon: string): string[] => {
							if (!hasVisibleQuotaBucket(bucket)) return [];

							const { bar, percent } = buildProgressBar(bucket.requests, bucket.limit, barWidth);
							const color = getUsageColor(percent);
							const remaining = Math.max(0, bucket.limit - bucket.requests);
							const renewalStr = formatTimeRemaining(bucket.renewsAt);

							if (compact) {
								return [
									`${icon}  ${theme.fg("accent", theme.bold(label))}`,
									`   ${theme.fg(color, bar)}  ${theme.fg(color, formatPercent(percent))} used`,
									`   ${theme.bold(String(bucket.requests))} / ${bucket.limit} req ${theme.fg("muted", "·")} ${theme.fg(remaining > 0 ? "success" : "error", String(remaining))} left ${theme.fg("muted", "·")} resets ${theme.fg("accent", renewalStr)}`,
								];
							}

							return [
								`${icon}  ${theme.fg("accent", theme.bold(label))}`,
								"",
								`   ${theme.fg(color, bar)}  ${theme.fg(color, formatPercent(percent))} used`,
								"",
								`   ${theme.fg("muted", "Used:")}     ${theme.bold(String(bucket.requests))} / ${bucket.limit} requests`,
								`   ${theme.fg("muted", "Remaining:")} ${theme.fg(remaining > 0 ? "success" : "error", String(remaining))} requests`,
								`   ${theme.fg("muted", "Resets in:")} ${theme.fg("accent", renewalStr)}`,
							];
						};

						const renderWeeklyLimit = (label: string, weekly: WeeklyTokenLimit | undefined, icon: string): string[] => {
							if (!weekly) return [];

							const percentRemaining = Math.max(0, Math.min(weekly.percentRemaining, 100));
							const percentUsed = 100 - percentRemaining;
							const { bar } = buildProgressBar(percentUsed, 100, barWidth);
							const color = getUsageColor(percentUsed);
							const renewalStr = formatTimeRemaining(weekly.nextRegenAt);

							if (compact) {
								return [
									`${icon}  ${theme.fg("accent", theme.bold(label))}`,
									`   ${theme.fg(color, bar)}  ${theme.fg(color, formatPercent(percentUsed))} used`,
									`   ${theme.fg("success", formatPercent(percentRemaining))} remaining ${theme.fg("muted", "·")} regenerates ${theme.fg("accent", renewalStr)}`,
								];
							}

							return [
								`${icon}  ${theme.fg("accent", theme.bold(label))}`,
								"",
								`   ${theme.fg(color, bar)}  ${theme.fg(color, formatPercent(percentUsed))} used`,
								"",
								`   ${theme.fg("muted", "Remaining:")} ${theme.fg("success", formatPercent(percentRemaining))}`,
								`   ${theme.fg("muted", "Used:")}      ${theme.bold(formatPercent(percentUsed))}`,
								`   ${theme.fg("muted", "Regens in:")} ${theme.fg("accent", renewalStr)}`,
							];
						};

						const renderRollingLimit = (
							label: string,
							rolling: RollingFiveHourLimit | undefined,
							icon: string,
						): string[] => {
							if (!rolling) return [];

							const used = Math.max(0, rolling.max - rolling.remaining);
							const { bar, percent } = buildProgressBar(used, rolling.max, barWidth);
							const color = getUsageColor(percent);
							const tickStr = formatTimeRemaining(rolling.nextTickAt);

							if (compact) {
								return [
									`${icon}  ${theme.fg("accent", theme.bold(label))}`,
									`   ${theme.fg(color, bar)}  ${theme.fg(color, formatPercent(percent))} used`,
									`   ${theme.bold(String(rolling.remaining))} / ${rolling.max} left ${theme.fg("muted", "·")} ${rolling.limited ? theme.fg("error", "limited now") : theme.fg("success", "available")} ${theme.fg("muted", "·")} ticks ${theme.fg("accent", tickStr)}`,
								];
							}

							return [
								`${icon}  ${theme.fg("accent", theme.bold(label))}`,
								"",
								`   ${theme.fg(color, bar)}  ${theme.fg(color, formatPercent(percent))} used`,
								"",
								`   ${theme.fg("muted", "Remaining:")} ${theme.bold(String(rolling.remaining))} / ${rolling.max}`,
								`   ${theme.fg("muted", "Status:")}    ${rolling.limited ? theme.fg("error", "Limited") : theme.fg("success", "Available")}`,
								`   ${theme.fg("muted", "Next tick:")} ${theme.fg("accent", tickStr)} (${formatPercent(rolling.tickPercent * 100)})`,
							];
						};

						const sections: string[][] = [];
						if (showSubscription) {
							sections.push(renderBucket("Subscription", quota.subscription, "⚡"));
						}
						if (quota.rollingFiveHourLimit) {
							sections.push(renderRollingLimit("Rolling 5h Limit", quota.rollingFiveHourLimit, "⏱"));
						}
						if (quota.weeklyTokenLimit) {
							sections.push(renderWeeklyLimit("Weekly Token Limit", quota.weeklyTokenLimit, "🗓"));
						}
						if (hasVisibleQuotaBucket(quota.search?.hourly)) {
							sections.push(renderBucket("Search (hourly)", quota.search.hourly, "🔍"));
						}
						if (toolCallBucket) {
							const toolCallLabel = quota.toolCallDiscounts ? "Tool Call Discounts" : "Free Tool Calls";
							sections.push(renderBucket(toolCallLabel, toolCallBucket, "🔧"));
						}

						const container = new Container();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold("  Synthetic API Quota")), 1, 0));

						container.addChild(
							new Text(
								theme.fg(
									"muted",
									compact
										? `  ${quotaSystemLabel}`
										: `  ${quotaSystemLabel} · usage and limits for your Synthetic account`,
								),
								1,
								0,
							),
						);

						container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));

						if (!compact) {
							container.addChild(new Spacer(1));
						}

						for (let i = 0; i < sections.length; i++) {
							const section = sections[i];
							if (section.length > 0) {
								container.addChild(new Text(section.join("\n"), 1, 0));
								if (i < sections.length - 1) {
									if (!compact) {
										container.addChild(new Spacer(1));
									}
									container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));
								}
							}
						}

						if (!compact) {
							container.addChild(new Spacer(1));
						}
						container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));
						container.addChild(new Text(theme.fg("dim", "  Esc / Enter to close"), 1, 0));
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

						const panel = new Box(0, 0, (s: string) => theme.bg("customMessageBg", s));
						panel.addChild(container);

						return {
							render: (width) => panel.render(width),
							invalidate: () => panel.invalidate(),
							handleInput: (data) => {
								if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c")) {
									done(undefined);
								}
							},
						};
					},
					{
						overlay: true,
						overlayOptions: () => {
							const width = overlayCols < 100 ? "98%" : "70%";

							if (overlayRows < 30) {
								return {
									width: "100%",
									maxWidth: 80,
									minWidth: 50,
									maxHeight: "94%",
									anchor: "center" as const,
									margin: 0,
								};
							}

							if (overlayRows < 40) {
								return {
									width,
									maxWidth: 80,
									minWidth: 50,
									maxHeight: "88%",
									anchor: "top-center" as const,
									offsetY: 2,
									margin: 1,
								};
							}

							return {
								width,
								maxWidth: 80,
								minWidth: 50,
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
				ctx.ui.notify(`Failed to fetch quota: ${errorMessage}`, "error");
				console.error("[Synthetic Provider] Quota fetch failed:", error);
			}
		},
	});
}
