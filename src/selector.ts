import type { ClassicFlowConfig } from './config.js';
import type { MarketLifecycle, MarketScore } from './types.js';

interface CandidateState { sinceMs: number; symbol: string }

export class TopFourSelector {
  private readonly history = new Map<string, MarketScore[]>();
  private readonly lifecycle = new Map<string, MarketLifecycle>();
  private active: string[];
  private candidate?: CandidateState;
  private lastSwitchMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly cfg: ClassicFlowConfig['selector'], initial = cfg.initialMarkets) {
    this.active = [...initial];
    for (const symbol of cfg.universe) this.lifecycle.set(symbol, this.active.includes(symbol) ? 'ACTIVE' : 'STANDBY');
  }

  push(score: MarketScore) {
    const cutoff = score.timestampMs - this.cfg.sampleWindowSec * 1000;
    const history = [...(this.history.get(score.symbol) ?? []), score].filter((item) => item.timestampMs >= cutoff);
    this.history.set(score.symbol, history);
  }

  private p75(symbol: string): number | undefined {
    const valid = (this.history.get(symbol) ?? []).filter((score) => score.complete && Number.isFinite(score.scoreBps)).map((score) => score.scoreBps).sort((a, b) => a - b);
    if (valid.length < this.cfg.minimumValidSamples) return undefined;
    return valid[Math.min(valid.length - 1, Math.floor(valid.length * 0.75))];
  }

  decide(nowMs: number, hasCoreOi: (symbol: string) => boolean): { active: string[]; changed?: { out: string; in: string } } {
    if (this.cfg.mode === 'manual') return { active: [...this.active] };
    const ranked = this.cfg.universe.flatMap((symbol) => {
      const score = this.p75(symbol);
      return score === undefined ? [] : [{ symbol, score }];
    }).sort((a, b) => a.score - b.score);
    if (ranked.length < 5 || nowMs - this.lastSwitchMs < this.cfg.cooldownSec * 1000) return { active: [...this.active] };

    const activeRanked = ranked.filter((item) => this.active.includes(item.symbol));
    const standbyRanked = ranked.filter((item) => !this.active.includes(item.symbol));
    const worst = activeRanked.at(-1);
    const best = standbyRanked[0];
    if (!worst || !best) return { active: [...this.active] };
    const improvement = worst.score - best.score;
    const enough = improvement >= this.cfg.switchImprovementBps && best.score <= worst.score * (1 - this.cfg.switchImprovementRatio);
    if (!enough) { this.candidate = undefined; return { active: [...this.active] }; }
    if (!this.candidate || this.candidate.symbol !== best.symbol) { this.candidate = { symbol: best.symbol, sinceMs: nowMs }; return { active: [...this.active] }; }
    const requiredMs = Math.max(this.cfg.candidateStableSec, this.cfg.rotateAfterBadSec) * 1000;
    if (nowMs - this.candidate.sinceMs < requiredMs) return { active: [...this.active] };

    this.lifecycle.set(worst.symbol, hasCoreOi(worst.symbol) ? 'PARKED' : 'STANDBY');
    this.lifecycle.set(best.symbol, 'WARMING_UP');
    this.active = this.active.filter((symbol) => symbol !== worst.symbol).concat(best.symbol);
    this.lifecycle.set(best.symbol, 'ACTIVE');
    this.lastSwitchMs = nowMs;
    this.candidate = undefined;
    return { active: [...this.active], changed: { out: worst.symbol, in: best.symbol } };
  }

  getState() { return { active: [...this.active], lifecycle: Object.fromEntries(this.lifecycle) }; }
}
