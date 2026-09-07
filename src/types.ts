export type Side = 'buy' | 'sell';
export type Phase = 'BUILD' | 'SYNC' | 'FLOW' | 'REDUCE' | 'HOLD';
export type MarketLifecycle = 'ACTIVE' | 'DEGRADED' | 'ROTATING_OUT' | 'PARKED' | 'WARMING_UP' | 'STANDBY';

export interface Level { price: number; size: number }
export interface Orderbook { bids: Level[]; asks: Level[]; timestampMs: number }

export interface ExecutionQuote {
  side: Side;
  requestedUsd: number;
  filledUsd: number;
  filledBase: number;
  bestPrice: number;
  vwap: number;
  impactBps: number;
  complete: boolean;
}

export interface PositionSnapshot {
  marketId: string;
  baseAmount: number;
  notionalUsd: number;
  entryPrice: number;
  leverage: number;
  marginRatioPct?: number;
  pendingOrders: PendingOrder[];
}

export interface PendingOrder {
  orderId: string;
  clientOrderId?: string;
  side: Side;
  price: number;
  sizeBase: number;
  reduceOnly: boolean;
}

export interface AccountSnapshot {
  accountId: string;
  equityUsd: number;
  availableCollateralUsd: number;
  positions: PositionSnapshot[];
}

export interface MarketScore {
  symbol: string;
  timestampMs: number;
  scoreBps: number;
  buyImpactBps: number;
  sellImpactBps: number;
  complete: boolean;
}

export interface StrategyView {
  phase: Phase;
  makerUsd: number;
  vaultUsd: number;
  matchedOiUsd: number;
  netDeltaUsd: number;
  coreDirection: 1 | -1;
  makerSides: Side[];
  makerCapacityUsd: Partial<Record<Side, number>>;
  hedge?: { side: Side; usd: number; reduceOnly: boolean };
  reason: string;
}

export interface TxResult {
  ok: boolean;
  dryRun: boolean;
  digest?: string;
  error?: string;
}
