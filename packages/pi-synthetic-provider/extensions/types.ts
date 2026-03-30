/**
 * Shared type definitions for the Synthetic provider extension.
 */

export interface SyntheticModel {
	id: string;
	hugging_face_id: string;
	name: string;
	input_modalities: string[];
	output_modalities: string[];
	context_length: number;
	max_output_length: number;
	pricing: {
		prompt?: string;
		completion?: string;
		input_cache_reads?: string;
		input_cache_writes?: string;
	};
	supported_features?: string[];
	always_on?: boolean;
	provider?: string;
	datacenters?: { country_code: string }[];
}

export interface SyntheticModelsResponse {
	data: SyntheticModel[];
}

export interface QuotaBucket {
	limit: number;
	requests: number;
	renewsAt: string;
}

export interface WeeklyTokenLimit {
	nextRegenAt: string;
	percentRemaining: number;
}

export interface RollingFiveHourLimit {
	nextTickAt: string;
	tickPercent: number;
	remaining: number;
	max: number;
	limited: boolean;
}

export interface SyntheticQuotaResponse {
	subscription?: QuotaBucket;
	search?: {
		hourly?: QuotaBucket;
	};
	freeToolCalls?: QuotaBucket;
	toolCallDiscounts?: QuotaBucket;
	weeklyTokenLimit?: WeeklyTokenLimit;
	rollingFiveHourLimit?: RollingFiveHourLimit;
}
