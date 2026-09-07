import type { ClassicFlowConfig } from './config.js';
import { AftermathClient } from './aftermath.js';
import { executionBpsFromReference, executionQuote, executionQuoteForBase, floorToLot, makerPrice } from './execution.js';
import { effectiveLeverage, type MarketRegistry } from './markets.js';

export interface DoctorCheck { name: string; ok: boolean; detail: string }

export async function runDoctor(config: ClassicFlowConfig): Promise<DoctorCheck[]> {
  const api = new AftermathClient(config, false);
  const checks: DoctorCheck[] = [];
  let markets: MarketRegistry | undefined;
  const marketRegistry = async () => markets ??= await api.getMarkets(true);
  async function check(name: string, action: () => Promise<string>) {
    try { checks.push({ name, ok: true, detail: await action() }); }
    catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  }

  await check('Account ownership', async () => { await api.verifyAccountOwnership(); return `account ${config.owner.accountId} matches AccountCap`; });
  await check('Vault ownership', async () => `vault account ${await api.getVaultAccountId()} belongs to owner`);
  await check('Vault Agent access', async () => { await api.verifyVaultAssistantAccess(); return `assistant cap ${config.owner.vaultAssistantCapId} belongs to Agent Wallet`; });
  await check('Live market parameters', async () => {
    const current = await marketRegistry();
    return config.selector.universe.map((symbol) => {
      const info = current[symbol];
      return `${symbol} tick=${info.tickSize} lot=${info.lotSize} min=$${info.minOrderUsd} lev=${info.maxLeverage}x`;
    }).join(' · ');
  });
  await check('Account + Vault state', async () => {
    const { maker, vault } = await api.getAccounts(await marketRegistry());
    return `equity account=$${maker.equityUsd.toFixed(2)} vault=$${vault.equityUsd.toFixed(2)}`;
  });
  for (const symbol of config.selector.universe) {
    await check(`${symbol} orderbook`, async () => {
      const settings = { ...config.strategy, ...(config.marketOverrides[symbol] ?? {}) };
      const info = (await marketRegistry())[symbol];
      const book = await api.getOrderbook(info);
      const buy = executionQuote(book, 'buy', settings.orderSizeUsd);
      const sell = executionQuote(book, 'sell', settings.orderSizeUsd);
      if (!buy.complete || !sell.complete) throw new Error(`insufficient depth for $${settings.orderSizeUsd}`);
      const pairBps: number[] = [];
      for (const side of ['buy', 'sell'] as const) {
        const price = makerPrice(book, side, info.tickSize);
        const size = floorToLot(settings.orderSizeUsd / price, info.lotSize);
        if (!(size > 0) || size * price + 1e-8 < info.minOrderUsd) throw new Error(`$${settings.orderSizeUsd} maker order is below current exchange minimum after lot rounding`);
        const hedgeSide = side === 'buy' ? 'sell' : 'buy';
        const hedge = executionQuoteForBase(book, hedgeSide, size);
        pairBps.push(executionBpsFromReference(hedgeSide, hedge.vwap, price));
      }
      return `maker-buy→hedge-sell ${pairBps[0]!.toFixed(2)}bps · maker-sell→hedge-buy ${pairBps[1]!.toFixed(2)}bps · leverage ${effectiveLeverage(info, settings.leverage)}x`;
    });
  }
  checks.push({ name: 'Live gate', ok: process.env.CLASSIC_FLOW_LIVE_CONFIRM === 'I_UNDERSTAND', detail: process.env.CLASSIC_FLOW_LIVE_CONFIRM === 'I_UNDERSTAND' ? 'explicit live confirmation present' : 'safe default: dry-run only' });
  return checks;
}
