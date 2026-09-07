import type { ExecutionQuote, Level, Orderbook, Side } from './types.js';

function sortedLevels(book: Orderbook, side: Side): Level[] {
  const levels = side === 'buy' ? book.asks : book.bids;
  return [...levels]
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => side === 'buy' ? a.price - b.price : b.price - a.price);
}

export function executionQuote(book: Orderbook, side: Side, requestedUsd: number): ExecutionQuote {
  const levels = sortedLevels(book, side);
  const bestPrice = levels[0]?.price ?? 0;
  let remainingUsd = Math.max(0, requestedUsd);
  let filledUsd = 0;
  let filledBase = 0;
  let weighted = 0;

  for (const level of levels) {
    if (remainingUsd <= 1e-9) break;
    const levelUsd = level.price * level.size;
    const takeUsd = Math.min(remainingUsd, levelUsd);
    const takeBase = takeUsd / level.price;
    filledUsd += takeUsd;
    filledBase += takeBase;
    weighted += takeBase * level.price;
    remainingUsd -= takeUsd;
  }

  const vwap = filledBase > 0 ? weighted / filledBase : 0;
  const direction = side === 'buy' ? 1 : -1;
  const impactBps = bestPrice > 0 && vwap > 0 ? Math.max(0, direction * (vwap / bestPrice - 1) * 10_000) : Infinity;
  return { side, requestedUsd, filledUsd, filledBase, bestPrice, vwap, impactBps, complete: remainingUsd <= 0.01 };
}

export function executionQuoteForBase(book: Orderbook, side: Side, requestedBase: number): ExecutionQuote {
  const levels = sortedLevels(book, side);
  const bestPrice = levels[0]?.price ?? 0;
  let remainingBase = Math.max(0, requestedBase);
  let filledUsd = 0;
  let filledBase = 0;
  for (const level of levels) {
    if (remainingBase <= 1e-12) break;
    const takeBase = Math.min(remainingBase, level.size);
    filledBase += takeBase;
    filledUsd += takeBase * level.price;
    remainingBase -= takeBase;
  }
  const vwap = filledBase > 0 ? filledUsd / filledBase : 0;
  const direction = side === 'buy' ? 1 : -1;
  const impactBps = bestPrice > 0 && vwap > 0 ? Math.max(0, direction * (vwap / bestPrice - 1) * 10_000) : Infinity;
  return {
    side,
    requestedUsd: requestedBase * bestPrice,
    filledUsd,
    filledBase,
    bestPrice,
    vwap,
    impactBps,
    complete: remainingBase <= Math.max(1e-12, requestedBase * 1e-9),
  };
}

export function executionBpsFromReference(side: Side, executionPrice: number, referencePrice: number): number {
  if (!(executionPrice > 0) || !(referencePrice > 0)) return Infinity;
  return Math.max(0, (side === 'buy' ? executionPrice / referencePrice - 1 : 1 - executionPrice / referencePrice) * 10_000);
}

export function executableBaseWithinBps(book: Orderbook, side: Side, requestedBase: number, referencePrice: number, maxBps: number): number {
  let remaining = Math.max(0, requestedBase);
  let executable = 0;
  for (const level of sortedLevels(book, side)) {
    if (executionBpsFromReference(side, level.price, referencePrice) > maxBps + 1e-9) break;
    const take = Math.min(remaining, level.size);
    executable += take;
    remaining -= take;
    if (remaining <= 1e-12) break;
  }
  return executable;
}

  // A small top order must not make the execution estimate claim that a large order has a tiny spread.
// The displayed executable BBO is the price reached after enough cumulative same-side USD.
export function executableTopPrice(book: Orderbook, side: Side, requestedUsd: number): number {
  const levels = sortedLevels(book, side);
  const thresholdUsd = Math.max(1, Math.min(20, requestedUsd * 0.1));
  let cumulative = 0;
  for (const level of levels) {
    cumulative += level.price * level.size;
    if (cumulative >= thresholdUsd) return level.price;
  }
  return levels.at(-1)?.price ?? 0;
}

export function marketScore(symbol: string, book: Orderbook, orderSizeUsd: number, timestampMs = Date.now()) {
  const buy = executionQuote(book, 'buy', orderSizeUsd);
  const sell = executionQuote(book, 'sell', orderSizeUsd);
  const effectiveAsk = executableTopPrice(book, 'buy', orderSizeUsd);
  const effectiveBid = executableTopPrice(book, 'sell', orderSizeUsd);
  const mid = effectiveAsk > 0 && effectiveBid > 0 ? (effectiveAsk + effectiveBid) / 2 : 0;
  const effectiveSpreadBps = mid > 0 ? Math.max(0, (effectiveAsk - effectiveBid) / mid * 10_000) : Infinity;
  const scoreBps = Math.max(buy.impactBps, sell.impactBps) + effectiveSpreadBps / 2;
  return { symbol, timestampMs, scoreBps, buyImpactBps: buy.impactBps, sellImpactBps: sell.impactBps, complete: buy.complete && sell.complete };
}

export function makerPrice(book: Orderbook, side: Side, tickSize: number): number {
  const bestBid = Math.max(...book.bids.map((level) => level.price).filter((value) => value > 0));
  const bestAsk = Math.min(...book.asks.map((level) => level.price).filter((value) => value > 0));
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) throw new Error('empty orderbook');
  if (side === 'buy') return Math.min(bestBid + tickSize, bestAsk - tickSize);
  return Math.max(bestAsk - tickSize, bestBid + tickSize);
}

export function robustMidForUsd(book: Orderbook, requestedUsd: number): number {
  const buy = executionQuote(book, 'buy', requestedUsd);
  const sell = executionQuote(book, 'sell', requestedUsd);
  if (!buy.complete || !sell.complete || !(buy.vwap > 0) || !(sell.vwap > 0)) throw new Error(`insufficient two-sided depth for $${requestedUsd}`);
  return (buy.vwap + sell.vwap) / 2;
}

export function floorToLot(base: number, lotSize: number): number {
  return Math.floor(base / lotSize + 1e-10) * lotSize;
}
