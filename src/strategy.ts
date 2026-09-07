import type { Side, StrategyView } from './types.js';

export interface StrategyInput {
  makerUsd: number;
  vaultUsd: number;
  targetOiUsd: number;
  flowBandUsd: number;
  orderSizeUsd: number;
  deltaToleranceUsd: number;
  buildSide: 'auto' | 'long' | 'short';
  lockedCoreDirection?: 1 | -1;
}

function inferDirection(input: StrategyInput): 1 | -1 {
  if (input.lockedCoreDirection) return input.lockedCoreDirection;
  if (input.buildSide === 'long') return 1;
  if (input.buildSide === 'short') return -1;
  if (Math.abs(input.makerUsd) > 1) return input.makerUsd >= 0 ? 1 : -1;
  return 1;
}

export function buildIncreaseCapacityUsd(target: number, progress: number, orderSize: number, flowBand: number): number {
  const remaining = Math.max(0, target - Math.max(0, progress));
  if (!(remaining > 0) || !(orderSize > 0) || remaining + 0.01 >= orderSize) return remaining;
  return progress + orderSize <= target + Math.max(flowBand, orderSize) + 0.01 ? orderSize : remaining;
}

export function flowCapacities(target: number, flowBand: number, progress: number, orderSize: number) {
  const band = Math.max(orderSize, flowBand);
  const maximumLevels = Math.max(1, Math.min(1, Math.floor(band / orderSize + 1e-9)));
  const deviation = progress - target;
  const centerTolerance = Math.max(0.01, orderSize / 2);
  if (deviation > centerTolerance) {
    return { increase: 0, decrease: Math.min(maximumLevels, Math.ceil(deviation / orderSize - 1e-9)) * orderSize };
  }
  if (deviation < -centerTolerance) {
    return { increase: Math.min(maximumLevels, Math.ceil(Math.abs(deviation) / orderSize - 1e-9)) * orderSize, decrease: 0 };
  }
  return { increase: maximumLevels * orderSize, decrease: maximumLevels * orderSize };
}

export function deriveStrategy(input: StrategyInput): StrategyView {
  const coreDirection = inferDirection(input);
  const matchedOpposite = Math.sign(input.makerUsd) === -Math.sign(input.vaultUsd);
  const matchedOiUsd = matchedOpposite ? Math.min(Math.abs(input.makerUsd), Math.abs(input.vaultUsd)) : 0;
  const netDeltaUsd = input.makerUsd + input.vaultUsd;
  const tolerance = Math.max(input.deltaToleranceUsd, Math.min(input.orderSizeUsd * 0.1, 5));
  const targetFloor = Math.max(0, input.targetOiUsd * 0.98);
  const upper = input.targetOiUsd + input.flowBandUsd;
  const increaseSide: Side = coreDirection > 0 ? 'buy' : 'sell';
  const decreaseSide: Side = coreDirection > 0 ? 'sell' : 'buy';

  if (Math.abs(netDeltaUsd) > tolerance) {
    const side: Side = netDeltaUsd > 0 ? 'sell' : 'buy';
    const vaultWouldReduce = input.vaultUsd !== 0 && Math.sign(input.vaultUsd) === (side === 'sell' ? 1 : -1);
    return {
      phase: 'SYNC', makerUsd: input.makerUsd, vaultUsd: input.vaultUsd, matchedOiUsd, netDeltaUsd,
      coreDirection, makerSides: [], makerCapacityUsd: {}, hedge: { side, usd: Math.abs(netDeltaUsd), reduceOnly: vaultWouldReduce },
      reason: 'maker fill or manual change is not yet mirrored by the Vault',
    };
  }

  if (matchedOiUsd < targetFloor) {
    const capacity = buildIncreaseCapacityUsd(input.targetOiUsd, coreDirection * input.makerUsd, input.orderSizeUsd, input.flowBandUsd);
    return {
      phase: 'BUILD', makerUsd: input.makerUsd, vaultUsd: input.vaultUsd, matchedOiUsd, netDeltaUsd,
      coreDirection, makerSides: capacity >= input.orderSizeUsd - 0.01 ? [increaseSide] : [],
      makerCapacityUsd: { [increaseSide]: capacity },
      reason: 'build protected matched OI with one maker order on the selected side',
    };
  }

  if (matchedOiUsd > upper + tolerance) {
    return {
      phase: 'REDUCE', makerUsd: input.makerUsd, vaultUsd: input.vaultUsd, matchedOiUsd, netDeltaUsd,
      coreDirection, makerSides: [decreaseSide], makerCapacityUsd: { [decreaseSide]: matchedOiUsd - input.targetOiUsd },
      reason: 'target OI was lowered; reduce both legs sequentially',
    };
  }

  const flow = flowCapacities(input.targetOiUsd, input.flowBandUsd, coreDirection * input.makerUsd, input.orderSizeUsd);
  const makerSides: Side[] = [];
  const makerCapacityUsd: Partial<Record<Side, number>> = {};
  if (flow.increase >= input.orderSizeUsd - 0.01 && Math.abs(input.makerUsd) + input.orderSizeUsd <= upper + tolerance) {
    makerSides.push(increaseSide); makerCapacityUsd[increaseSide] = flow.increase;
  }
  if (flow.decrease >= input.orderSizeUsd - 0.01) {
    makerSides.push(decreaseSide); makerCapacityUsd[decreaseSide] = flow.decrease;
  }
  return {
    phase: 'FLOW', makerUsd: input.makerUsd, vaultUsd: input.vaultUsd, matchedOiUsd, netDeltaUsd,
    coreDirection, makerSides, makerCapacityUsd, reason: 'quote both directions when the OI band has room; hedge every actual fill',
  };
}
