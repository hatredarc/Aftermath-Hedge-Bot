export const SUPPORTED_MARKETS = ['BTC', 'ETH', 'SUI', 'ZEC', 'SOL'] as const;
export type SupportedMarket = typeof SUPPORTED_MARKETS[number];

export interface MarketInfo {
  symbol: SupportedMarket;
  marketId: string;
  tickSize: number;
  lotSize: number;
  minOrderUsd: number;
  protocolMaxLeverage: number;
  maxLeverage: number;
}

type Json = Record<string, unknown>;
const WIRE_SCALE = 1e9;
const STRATEGY_MAX_LEVERAGE = 15;

function wireNumber(value: unknown): number {
  const number = Number(typeof value === 'string' ? value.replace(/n$/, '') : value);
  return Number.isFinite(number) ? number : NaN;
}

function supportedSymbol(value: unknown): SupportedMarket | undefined {
  const symbol = String(value ?? '').toUpperCase().replace(/(?:\/)?USDC?$/, '');
  return (SUPPORTED_MARKETS as readonly string[]).includes(symbol) ? symbol as SupportedMarket : undefined;
}

export function parseMarketInfo(raw: unknown): MarketInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const market = raw as Json;
  const params = market.marketParams as Json | undefined;
  const symbol = supportedSymbol(params?.baseAssetSymbol);
  if (!symbol) return undefined;
  const marketId = String(market.objectId ?? '');
  const tickSize = wireNumber(params?.tickSize) / WIRE_SCALE;
  const lotSize = wireNumber(params?.lotSize) / WIRE_SCALE;
  const minOrderUsd = wireNumber(params?.minOrderUsdValue);
  const initialMarginRatio = wireNumber(params?.marginRatioInitial);
  if (!/^0x[a-fA-F0-9]{64}$/.test(marketId)) throw new Error(`${symbol}: Aftermath returned an invalid market id`);
  if (!(tickSize > 0) || !(lotSize > 0) || !(minOrderUsd > 0) || !(initialMarginRatio > 0)) {
    throw new Error(`${symbol}: Aftermath returned invalid tick/lot/minimum/leverage parameters`);
  }
  const protocolMaxLeverage = Math.max(1, Math.floor(1 / initialMarginRatio + 1e-9));
  return {
    symbol,
    marketId,
    tickSize,
    lotSize,
    minOrderUsd,
    protocolMaxLeverage,
    maxLeverage: Math.min(STRATEGY_MAX_LEVERAGE, protocolMaxLeverage),
  };
}

export type MarketRegistry = Record<SupportedMarket, MarketInfo>;

export function buildMarketRegistry(rows: unknown[], required: readonly SupportedMarket[] = SUPPORTED_MARKETS): MarketRegistry {
  const entries = new Map<SupportedMarket, MarketInfo>();
  for (const row of rows) {
    const info = parseMarketInfo(row);
    if (!info) continue;
    if (entries.has(info.symbol)) throw new Error(`Aftermath returned duplicate ${info.symbol} markets`);
    entries.set(info.symbol, info);
  }
  const missing = required.filter((symbol) => !entries.has(symbol));
  if (missing.length) throw new Error(`Aftermath market metadata is missing: ${missing.join(', ')}`);
  return Object.fromEntries(SUPPORTED_MARKETS.map((symbol) => [symbol, entries.get(symbol)!])) as MarketRegistry;
}

export function effectiveLeverage(info: MarketInfo, configured: 'auto' | number): number {
  return configured === 'auto' ? info.maxLeverage : Math.min(configured, info.maxLeverage);
}
