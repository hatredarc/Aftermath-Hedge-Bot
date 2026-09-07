import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { SUPPORTED_MARKETS } from './markets.js';

const objectId = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'expected a 32-byte Sui object/address');
export const supportedMarket = z.enum(SUPPORTED_MARKETS);
const marketOverride = z.object({
  targetOiUsdPerMarket: z.number().min(10).optional(),
  orderSizeUsd: z.number().min(1).optional(),
  flowBandUsd: z.number().min(0).optional(),
  chaseDistanceBps: z.number().min(0.5).max(100).optional(),
  maxHedgeImpactBps: z.number().min(0.1).max(100).optional(),
  hardHedgeImpactBps: z.number().min(0.1).max(100).optional(),
  hedgeWaitMs: z.number().int().min(0).max(120_000).optional(),
  leverage: z.union([z.literal('auto'), z.number().int().min(1).max(15)]).optional(),
});

export const ConfigSchema = z.object({
  version: z.literal(1),
  network: z.literal('mainnet'),
  apiBase: z.string().url().default('https://aftermath.finance/api'),
  rpcUrl: z.string().url().default('https://sui-rpc.publicnode.com'),
  owner: z.object({
    walletAddress: objectId,
    accountId: z.coerce.number().int().positive(),
    accountCapId: objectId,
    vaultId: objectId,
    vaultAssistantCapId: objectId,
    agentWalletAddress: objectId,
  }),
  strategy: z.object({
    mode: z.literal('classic_flow'),
    targetOiUsdPerMarket: z.number().min(10),
    orderSizeUsd: z.number().min(1),
    flowBandUsd: z.number().min(0),
    buildSide: z.enum(['auto', 'long', 'short']),
    chaseDistanceBps: z.number().min(0.5).max(100),
    maxHedgeImpactBps: z.number().min(0.1).max(100),
    hardHedgeImpactBps: z.number().min(0.1).max(100).default(30),
    hedgeWaitMs: z.number().int().min(0).max(120_000).default(15_000),
    leverage: z.union([z.literal('auto'), z.number().int().min(1).max(15)]),
    tickMs: z.number().int().min(250).max(30_000).default(1000),
    deltaToleranceUsd: z.number().min(0.1).default(2),
  }),
  marketOverrides: z.partialRecord(supportedMarket, marketOverride).default({}),
  selector: z.object({
    mode: z.enum(['auto_top_4', 'manual']),
    universe: z.array(supportedMarket).length(5).refine((items) => new Set(items).size === 5, 'must contain all five different markets'),
    initialMarkets: z.array(supportedMarket).length(4).refine((items) => new Set(items).size === 4, 'must contain four different markets'),
    sampleWindowSec: z.number().int().min(10).default(60),
    minimumValidSamples: z.number().int().min(1).default(48),
    candidateStableSec: z.number().int().min(1).default(30),
    rotateAfterBadSec: z.number().int().min(1).default(60),
    switchImprovementBps: z.number().min(0).default(1),
    switchImprovementRatio: z.number().min(0).max(1).default(0.2),
    cooldownSec: z.number().int().min(0).default(300),
    useCumulativeDepthVwap: z.literal(true),
  }),
  safety: z.object({
    postOnlyMaker: z.literal(true),
    hedgeActualFilledAmount: z.literal(true),
    pauseNewMakerWhileUnhedged: z.literal(true),
    preserveParkedCoreOi: z.literal(true),
    secretsRemainLocal: z.literal(true),
    maxPositionHealthPct: z.number().min(0).max(100).default(70),
  }),
});

export type ClassicFlowConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(path: string): Promise<ClassicFlowConfig> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const selector = raw.selector as Record<string, unknown> | undefined;
  if (selector?.mode === 'auto_top_3' && Array.isArray(selector.initialMarkets) && Array.isArray(selector.universe)) {
    const initial = selector.initialMarkets.map(String);
    const standby = selector.universe.map(String).find((symbol) => !initial.includes(symbol));
    selector.mode = 'auto_top_4';
    selector.initialMarkets = standby ? [...initial, standby] : initial;
    console.warn('[config] migrated legacy Auto Top 3 configuration to Auto Top 4 in memory');
  }
  return ConfigSchema.parse(raw);
}

export function formatConfigErrors(error: unknown): string[] {
  if (!(error instanceof z.ZodError)) return [String(error)];
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}
