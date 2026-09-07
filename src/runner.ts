import { writeFile } from 'node:fs/promises';
import type { ClassicFlowConfig } from './config.js';
import { AftermathClient } from './aftermath.js';
import { executableBaseWithinBps, executionBpsFromReference, executionQuoteForBase, floorToLot, makerPrice, marketScore, robustMidForUsd } from './execution.js';
import type { MarketInfo, MarketRegistry, SupportedMarket } from './markets.js';
import { TopFourSelector } from './selector.js';
import { deriveStrategy } from './strategy.js';
import type { Orderbook, PendingOrder, PositionSnapshot, Side } from './types.js';

interface RuntimeMarket {
  coreDirection?: 1 | -1;
  lastActionMs: number;
  lastError?: string;
  lastMakerPrices?: Partial<Record<Side, number>>;
  hedgeWaitStartedMs?: number;
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function bpsDistance(a: number, b: number) { return b > 0 ? Math.abs(a / b - 1) * 10_000 : Infinity; }
function nearestFirst<T extends { side: Side; price: number }>(orders: T[], side: Side): T[] {
  return orders.filter((order) => order.side === side).sort((a, b) => side === 'buy' ? b.price - a.price : a.price - b.price);
}

export function hedgeIsReduceOnly(vaultBase: number, side: Side, sizeBase: number, lotSize: number): boolean {
  const pointsTowardZero = vaultBase !== 0 && Math.sign(vaultBase) === (side === 'sell' ? 1 : -1);
  return pointsTowardZero && sizeBase <= Math.abs(vaultBase) + lotSize / 2;
}

function shouldReplaceOrders(pending: PendingOrder[], desired: { side: Side; price: number; sizeBase: number; reduceOnly: boolean }[], chaseBps: number): boolean {
  if (pending.length !== desired.length) return true;
  for (const side of ['buy', 'sell'] as const) {
    const current = nearestFirst(pending, side);
    const planned = nearestFirst(desired, side);
    if (current.length !== planned.length) return true;
    for (let index = 0; index < planned.length; index += 1) {
      const order = current[index]!;
      const target = planned[index]!;
      if (order.reduceOnly !== target.reduceOnly) return true;
      const currentUsd = order.sizeBase * order.price;
      const targetUsd = target.sizeBase * target.price;
      if (Math.abs(currentUsd - targetUsd) > Math.max(0.01, targetUsd * 0.02)) return true;
    }
    const order = current[0];
    const target = planned[0];
    if (!order || !target) continue;
    // Chase only when price moves away from the order. Never move a buy down or a sell up
    // when the market is approaching it, because that would run away from a fill.
    const escaped = side === 'buy' ? target.price > order.price : target.price < order.price;
    if (escaped && bpsDistance(target.price, order.price) >= chaseBps) return true;
  }
  return false;
}

export class ClassicFlowRunner {
  private readonly api: AftermathClient;
  private readonly selector: TopFourSelector;
  private readonly runtime = new Map<SupportedMarket, RuntimeMarket>();
  private stopped = false;

  constructor(private readonly config: ClassicFlowConfig, private readonly live: boolean) {
    this.api = new AftermathClient(config, live);
    this.selector = new TopFourSelector(config.selector);
    for (const symbol of config.selector.universe) this.runtime.set(symbol, { lastActionMs: 0 });
  }

  stop() { this.stopped = true; }

  async run() {
    console.log(`[classic-flow] mode=${this.live ? 'LIVE' : 'DRY-RUN'} universe=${this.config.selector.universe.join(',')} active=4`);
    while (!this.stopped) {
      const started = Date.now();
      try { await this.tick(started); }
      catch (error) { console.error(`[tick] ${error instanceof Error ? error.message : String(error)}`); }
      await sleep(Math.max(50, this.config.strategy.tickMs - (Date.now() - started)));
    }
  }

  async once() { await this.tick(Date.now()); }

  private async tick(nowMs: number) {
    const markets = await this.api.getMarkets();
    const accounts = await this.api.getAccounts(markets);
    const bookEntries = await Promise.all(this.config.selector.universe.map(async (symbol) => {
      const book = await this.api.getOrderbook(markets[symbol]);
      const settings = { ...this.config.strategy, ...(this.config.marketOverrides[symbol] ?? {}) };
      this.selector.push(marketScore(symbol, book, settings.orderSizeUsd, nowMs));
      return [symbol, book] as const;
    }));
    const books = new Map<SupportedMarket, Orderbook>(bookEntries);
    const makerBySymbol = new Map(this.config.selector.universe.map((symbol) => [
      symbol, accounts.maker.positions.find((position) => position.marketId === markets[symbol].marketId),
    ]));
    const selection = this.selector.decide(nowMs, (symbol) => {
      const position = makerBySymbol.get(symbol as SupportedMarket);
      return Math.abs(position?.baseAmount ?? 0) > markets[symbol as SupportedMarket].lotSize / 2;
    });
    if (selection.changed) console.log(`[selector] ${selection.changed.out} -> ${selection.changed.in}`);

    for (const symbol of selection.active as SupportedMarket[]) {
      const info = markets[symbol];
      const book = books.get(symbol);
      if (!book) continue;
      await this.runMarket(
        info, book,
        accounts.maker.positions.find((position) => position.marketId === info.marketId),
        accounts.vault.positions.find((position) => position.marketId === info.marketId),
        nowMs,
      );
    }
    for (const symbol of this.config.selector.universe.filter((item) => !selection.active.includes(item))) {
      const info = markets[symbol];
      const book = books.get(symbol);
      if (!book) continue;
      const makerPos = accounts.maker.positions.find((position) => position.marketId === info.marketId);
      const vaultPos = accounts.vault.positions.find((position) => position.marketId === info.marketId);
      const needsSupervision = !!makerPos?.pendingOrders.length
        || Math.abs(makerPos?.baseAmount ?? 0) >= info.lotSize / 2
        || Math.abs(vaultPos?.baseAmount ?? 0) >= info.lotSize / 2;
      if (needsSupervision) await this.runParkedMarket(info, book, makerPos, vaultPos, nowMs);
    }
    await this.writeState(nowMs, accounts.maker.equityUsd, accounts.vault.equityUsd, markets);
  }

  private async syncVault(
    info: MarketInfo, book: Orderbook, makerPos: PositionSnapshot | undefined,
    vaultPos: PositionSnapshot | undefined, settings: ClassicFlowConfig['strategy'], nowMs: number, label: string,
  ): Promise<'NEUTRAL' | 'ACTED' | 'HOLD'> {
    const runtime = this.runtime.get(info.symbol)!;
    const mark = robustMidForUsd(book, Math.max(settings.orderSizeUsd, info.minOrderUsd));
    const netBase = (makerPos?.baseAmount ?? 0) + (vaultPos?.baseAmount ?? 0);
    const toleranceBase = info.lotSize / 2;
    if (Math.abs(netBase) <= toleranceBase) {
      runtime.hedgeWaitStartedMs = undefined;
      return 'NEUTRAL';
    }
    runtime.hedgeWaitStartedMs ??= nowMs;
    if (makerPos?.pendingOrders.length) {
      const cancel = await this.api.replaceMakerOrders({ info, cancel: makerPos.pendingOrders.map((order) => order.orderId), orders: [], hasPosition: !!makerPos });
      if (!cancel.ok) {
        runtime.lastError = `cannot pause maker before hedge: ${cancel.error}`;
        console.log(`[${info.symbol}] ${label} HOLD ${runtime.lastError}`);
        return 'HOLD';
      }
      runtime.lastActionMs = nowMs;
      return 'ACTED';
    }
    const side: Side = netBase > 0 ? 'sell' : 'buy';
    const makerSide: Side = side === 'buy' ? 'sell' : 'buy';
    const referencePrice = runtime.lastMakerPrices?.[makerSide] ?? mark;
    const preferredBps = settings.maxHedgeImpactBps;
    const hardBps = Math.max(preferredBps, settings.hardHedgeImpactBps);
    const waitedMs = nowMs - runtime.hedgeWaitStartedMs;
    const activeCapBps = waitedMs < settings.hedgeWaitMs ? preferredBps : hardBps;
    const availableBase = executableBaseWithinBps(book, side, Math.abs(netBase), referencePrice, activeCapBps);
    const sizeBase = floorToLot(availableBase, info.lotSize);
    if (!(sizeBase > 0) || sizeBase * mark + 1e-8 < info.minOrderUsd) {
      runtime.lastError = `hedge waiting ${Math.min(waitedMs, settings.hedgeWaitMs)}ms: no ${info.minOrderUsd.toFixed(2)} USD slice within ${activeCapBps.toFixed(2)}bps`;
      console.log(`[${info.symbol}] ${label} HOLD ${runtime.lastError}`);
      return 'HOLD';
    }
    const quote = executionQuoteForBase(book, side, sizeBase);
    const executionBps = executionBpsFromReference(side, quote.vwap, referencePrice);
    if (!quote.complete || executionBps > activeCapBps) {
      runtime.lastError = `hedge waiting: complete=${quote.complete} execution=${executionBps.toFixed(2)}bps`;
      console.log(`[${info.symbol}] ${label} HOLD ${runtime.lastError}`);
      return 'HOLD';
    }
    const vaultBase = vaultPos?.baseAmount ?? 0;
    const vaultWouldReduce = hedgeIsReduceOnly(vaultBase, side, sizeBase, info.lotSize);
    const result = await this.api.placeVaultHedge({ info, side, sizeBase, hasPosition: !!vaultPos, reduceOnly: vaultWouldReduce });
    runtime.lastActionMs = nowMs;
    runtime.lastError = result.ok ? undefined : result.error;
    const finished = sizeBase + info.lotSize / 2 >= Math.abs(netBase);
    if (result.ok && finished) {
      runtime.hedgeWaitStartedMs = undefined;
      if (runtime.lastMakerPrices) delete runtime.lastMakerPrices[makerSide];
    }
    console.log(`[${info.symbol}] ${label} ${result.dryRun ? 'DRY' : 'LIVE'} hedge ${side} $${quote.filledUsd.toFixed(2)} ${finished ? 'full' : 'partial'} ${executionBps.toFixed(2)}bps ${result.ok ? 'ok' : result.error}`);
    return result.ok ? 'ACTED' : 'HOLD';
  }

  private async runMarket(info: MarketInfo, book: Orderbook, makerPos: PositionSnapshot | undefined, vaultPos: PositionSnapshot | undefined, nowMs: number) {
    const runtime = this.runtime.get(info.symbol)!;
    const settings = { ...this.config.strategy, ...(this.config.marketOverrides[info.symbol] ?? {}) };
    for (const order of makerPos?.pendingOrders ?? []) {
      runtime.lastMakerPrices ??= {};
      runtime.lastMakerPrices[order.side] = order.price;
    }
    if (this.positionAtRisk(makerPos) || this.positionAtRisk(vaultPos)) {
      if (makerPos?.pendingOrders.length) await this.api.replaceMakerOrders({ info, cancel: makerPos.pendingOrders.map((order) => order.orderId), orders: [], hasPosition: !!makerPos });
      runtime.lastError = `margin risk >= ${this.config.safety.maxPositionHealthPct}%: maker orders paused`;
      console.log(`[${info.symbol}] HOLD ${runtime.lastError}`);
      return;
    }

    const sync = await this.syncVault(info, book, makerPos, vaultPos, settings, nowMs, 'SYNC');
    if (sync !== 'NEUTRAL') return;
    const mark = robustMidForUsd(book, settings.orderSizeUsd);
    const makerUsd = (makerPos?.baseAmount ?? 0) * mark;
    const vaultUsd = (vaultPos?.baseAmount ?? 0) * mark;
    if (!runtime.coreDirection && Math.abs(makerUsd) > info.minOrderUsd) runtime.coreDirection = makerUsd > 0 ? 1 : -1;
    if (!runtime.coreDirection && settings.buildSide === 'auto') {
      const makerBuyPrice = makerPrice(book, 'buy', info.tickSize);
      const makerSellPrice = makerPrice(book, 'sell', info.tickSize);
      const longSize = floorToLot(settings.orderSizeUsd / makerBuyPrice, info.lotSize);
      const shortSize = floorToLot(settings.orderSizeUsd / makerSellPrice, info.lotSize);
      const hedgeLong = executionQuoteForBase(book, 'sell', longSize);
      const hedgeShort = executionQuoteForBase(book, 'buy', shortSize);
      const longGap = executionBpsFromReference('sell', hedgeLong.vwap, makerBuyPrice);
      const shortGap = executionBpsFromReference('buy', hedgeShort.vwap, makerSellPrice);
      runtime.coreDirection = longGap <= shortGap ? 1 : -1;
    }
    const view = deriveStrategy({
      makerUsd, vaultUsd, targetOiUsd: settings.targetOiUsdPerMarket,
      flowBandUsd: settings.flowBandUsd, orderSizeUsd: settings.orderSizeUsd,
      deltaToleranceUsd: settings.deltaToleranceUsd,
      buildSide: settings.buildSide, lockedCoreDirection: runtime.coreDirection,
    });

    const makerBlocks: string[] = [];
    const desired = view.makerSides.flatMap((side) => {
      if ((view.makerCapacityUsd[side] ?? 0) + 0.01 < settings.orderSizeUsd) return [];
      const price = makerPrice(book, side, info.tickSize);
      const sizeBase = floorToLot(settings.orderSizeUsd / price, info.lotSize);
      if (!(sizeBase > 0) || sizeBase * price + 1e-8 < info.minOrderUsd) {
        makerBlocks.push(`${side}: order is below ${info.minOrderUsd.toFixed(2)} USD after lot rounding`);
        return [];
      }
      const hedgeSide: Side = side === 'buy' ? 'sell' : 'buy';
      const hedgeQuote = executionQuoteForBase(book, hedgeSide, sizeBase);
      const hedgeBps = executionBpsFromReference(hedgeSide, hedgeQuote.vwap, price);
      const hardBps = Math.max(settings.maxHedgeImpactBps, settings.hardHedgeImpactBps);
      if (!hedgeQuote.complete || hedgeBps > hardBps) {
        makerBlocks.push(`${side}: prospective hedge complete=${hedgeQuote.complete} execution=${hedgeBps.toFixed(2)}bps > hard ${hardBps.toFixed(2)}bps`);
        return [];
      }
      return [{ side, price, sizeBase, reduceOnly: view.phase === 'REDUCE' }];
    });
    const pending = makerPos?.pendingOrders ?? [];
    if (makerBlocks.length) console.log(`[${info.symbol}] maker gate ${makerBlocks.join(' · ')}`);
    if (view.makerSides.length && !desired.length && makerBlocks.length) {
      runtime.lastError = makerBlocks.join(' · ');
      console.log(`[${info.symbol}] HOLD ${runtime.lastError}`);
    }
    if (!shouldReplaceOrders(pending, desired, settings.chaseDistanceBps)) return;
    const result = await this.api.replaceMakerOrders({ info, cancel: pending.map((order) => order.orderId), orders: desired, hasPosition: !!makerPos });
    runtime.lastActionMs = nowMs;
    runtime.lastError = result.ok ? undefined : result.error;
    if (result.ok) {
      runtime.lastMakerPrices = Object.fromEntries(desired.map((order) => [order.side, order.price]));
    }
    console.log(`[${info.symbol}] ${view.phase} ${result.dryRun ? 'DRY' : 'LIVE'} maker ${desired.length} orders ${result.ok ? 'ok' : result.error}`);
  }

  private positionAtRisk(position: PositionSnapshot | undefined) {
    return Number(position?.marginRatioPct ?? 0) >= this.config.safety.maxPositionHealthPct;
  }

  private async runParkedMarket(info: MarketInfo, book: Orderbook, makerPos: PositionSnapshot | undefined, vaultPos: PositionSnapshot | undefined, nowMs: number) {
    const settings = { ...this.config.strategy, ...(this.config.marketOverrides[info.symbol] ?? {}) };
    const result = await this.syncVault(info, book, makerPos, vaultPos, settings, nowMs, 'PARKED SYNC');
    if (result === 'NEUTRAL' && makerPos?.pendingOrders.length) {
      const cancel = await this.api.replaceMakerOrders({ info, cancel: makerPos.pendingOrders.map((order) => order.orderId), orders: [], hasPosition: !!makerPos });
      const runtime = this.runtime.get(info.symbol)!;
      runtime.lastActionMs = nowMs; runtime.lastError = cancel.ok ? undefined : cancel.error;
      console.log(`[${info.symbol}] PARKED ${cancel.dryRun ? 'DRY' : 'LIVE'} cancel maker ${cancel.ok ? 'ok' : cancel.error}`);
    }
  }

  private async writeState(timestampMs: number, accountEquityUsd: number, vaultEquityUsd: number, markets: MarketRegistry) {
    const marketParameters = Object.fromEntries(this.config.selector.universe.map((symbol) => [symbol, {
      marketId: markets[symbol].marketId,
      tickSize: markets[symbol].tickSize,
      lotSize: markets[symbol].lotSize,
      minOrderUsd: markets[symbol].minOrderUsd,
      maxLeverage: markets[symbol].maxLeverage,
    }]));
    const state = {
      timestampMs, mode: this.live ? 'LIVE' : 'DRY-RUN', accountEquityUsd, vaultEquityUsd,
      selector: this.selector.getState(), marketParameters, markets: Object.fromEntries(this.runtime),
    };
    await writeFile('classic-flow.state.json', JSON.stringify(state, null, 2), 'utf8');
  }
}
