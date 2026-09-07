import type { MarketInfo } from './markets.js';
import type { Side } from './types.js';

// ASCII "CFLOW" in the high bytes, with a compact market/side/reduce suffix.
// The value stays within u64 and lets a restarted bot distinguish its own orders
// from orders the owner placed manually.
const PREFIX = 0x43464c4f57000000n;
const MASK = 0xffffffffff000000n;
const MARKET_INDEX: Record<MarketInfo['symbol'], bigint> = {
  BTC: 1n, ETH: 2n, SUI: 3n, ZEC: 4n, SOL: 5n,
};

export function managedClientOrderId(symbol: MarketInfo['symbol'], side: Side, reduceOnly: boolean): string {
  const suffix = (MARKET_INDEX[symbol] << 8n) | (side === 'sell' ? 2n : 1n) | (reduceOnly ? 4n : 0n);
  return String(PREFIX | suffix);
}

export function managedOrderKind(value: string | undefined): { managed: boolean; reduceOnly: boolean } {
  if (!value || !/^\d+$/.test(value)) return { managed: false, reduceOnly: false };
  const id = BigInt(value);
  if ((id & MASK) !== PREFIX) return { managed: false, reduceOnly: false };
  return { managed: true, reduceOnly: (id & 4n) !== 0n };
}
