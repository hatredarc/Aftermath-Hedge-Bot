import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import type { ClassicFlowConfig } from './config.js';
import { buildMarketRegistry, effectiveLeverage, type MarketInfo, type MarketRegistry } from './markets.js';
import { managedClientOrderId, managedOrderKind } from './managed-orders.js';
import type { AccountSnapshot, Orderbook, PendingOrder, PositionSnapshot, Side, TxResult } from './types.js';

type Json = Record<string, unknown>;

function bigintString(value: number): string { return `${Math.max(0, Math.round(value))}n`; }
function asNumber(value: unknown): number {
  if (typeof value === 'string' && value.endsWith('n')) return Number(value.slice(0, -1));
  return Number(value ?? 0);
}
function txError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class AftermathClient {
  readonly sui: SuiJsonRpcClient;
  private keypair?: Ed25519Keypair;
  private vaultAccountId?: number;
  private collateralCoinType?: string;
  private marketCache?: { expiresAtMs: number; value: MarketRegistry };

  constructor(readonly config: ClassicFlowConfig, readonly live: boolean) {
    this.sui = new SuiJsonRpcClient({ url: config.rpcUrl, network: 'mainnet' });
    const secret = process.env.CLASSIC_FLOW_AGENT_PRIVATE_KEY;
    if (secret) this.keypair = Ed25519Keypair.fromSecretKey(secret);
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.config.apiBase}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${text.slice(0, 500)}`);
      return JSON.parse(text) as T;
    } finally { clearTimeout(timeout); }
  }

  async getOrderbook(info: MarketInfo): Promise<Orderbook> {
    const response = await this.post<Json>('/ccxt/orderbook', { chId: info.marketId });
    const parse = (input: unknown) => (Array.isArray(input) ? input : []).map((raw) => {
      if (Array.isArray(raw)) return { price: Number(raw[0]), size: Number(raw[1]) };
      const item = raw as Json; return { price: Number(item.price), size: Number(item.size) };
    }).filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0);
    return { bids: parse(response.bids), asks: parse(response.asks), timestampMs: Date.now() };
  }

  async getVaultAccountId(): Promise<number> {
    if (this.vaultAccountId) return this.vaultAccountId;
    const response = await this.post<{ vaults?: Json[] }>('/perpetuals/vaults', { vaultIds: [this.config.owner.vaultId] });
    const vault = response.vaults?.[0];
    if (!vault) throw new Error('configured Vault was not returned by Aftermath');
    if (String(vault.ownerAddress).toLowerCase() !== this.config.owner.walletAddress.toLowerCase()) throw new Error('Vault owner does not match configured owner wallet');
    const accountCollateral = await this.getCollateralCoinType();
    if (String(vault.collateralCoinType ?? '') !== accountCollateral) throw new Error('Account and Vault use different collateral coin types');
    this.vaultAccountId = asNumber(vault.accountId);
    if (!this.vaultAccountId) throw new Error('Vault response has no accountId');
    return this.vaultAccountId;
  }

  private async getCollateralCoinType(): Promise<string> {
    if (this.collateralCoinType) return this.collateralCoinType;
    const response = await this.post<{ accountCaps?: Json[] }>('/perpetuals/accounts', { accountIds: [bigintString(this.config.owner.accountId)] });
    const cap = response.accountCaps?.find((item) => asNumber(item.accountId) === this.config.owner.accountId);
    const coinType = String(cap?.collateralCoinType ?? '');
    if (!coinType.includes('::')) throw new Error('Aftermath Account response has no collateral coin type');
    this.collateralCoinType = coinType;
    return coinType;
  }

  async getMarkets(force = false): Promise<MarketRegistry> {
    if (!force && this.marketCache && Date.now() < this.marketCache.expiresAtMs) return this.marketCache.value;
    try {
      const collateralCoinType = await this.getCollateralCoinType();
      const response = await this.post<{ markets?: unknown[] }>('/perpetuals/all-markets', { collateralCoinType });
      const value = buildMarketRegistry(response.markets ?? [], this.config.selector.universe);
      this.marketCache = { expiresAtMs: Date.now() + 60_000, value };
      return value;
    } catch (error) {
      if (!force && this.marketCache) {
        console.warn(`[markets] refresh failed; using last verified parameters: ${txError(error)}`);
        return this.marketCache.value;
      }
      throw error;
    }
  }

  async getAccounts(marketRegistry?: MarketRegistry): Promise<{ maker: AccountSnapshot; vault: AccountSnapshot }> {
    const markets = marketRegistry ?? await this.getMarkets();
    const vaultAccountId = await this.getVaultAccountId();
    const ids = [this.config.owner.accountId, vaultAccountId];
    const response = await this.post<{ accounts?: Json[] }>('/perpetuals/accounts/positions', { accountIds: ids.map(bigintString) });
    const parsed = (response.accounts ?? []).map((account) => this.parseAccount(account));
    const maker = parsed.find((account) => Number(account.accountId) === this.config.owner.accountId);
    const vault = parsed.find((account) => Number(account.accountId) === vaultAccountId);
    if (!maker || !vault) throw new Error('Aftermath positions response did not contain both Account and Vault account');
    await Promise.all(this.config.selector.universe.map(async (symbol) => {
      const info = markets[symbol];
      const existing = maker.positions.find((position) => position.marketId === info.marketId);
      const metadata = new Map((existing?.pendingOrders ?? []).map((order) => [order.orderId, order]));
      const pending = await this.getPendingOrders(info, this.config.owner.accountId, metadata);
      if (existing) existing.pendingOrders = pending;
      else if (pending.length) maker.positions.push({ marketId: info.marketId, baseAmount: 0, notionalUsd: 0, entryPrice: 0, leverage: 0, pendingOrders: pending });
    }));
    return { maker, vault };
  }

  private async getPendingOrders(info: MarketInfo, accountNumber: number, metadata: Map<string, PendingOrder>): Promise<PendingOrder[]> {
    const response = await this.post<unknown>('/ccxt/myPendingOrders', { accountNumber, chId: info.marketId });
    const rows = Array.isArray(response) ? response : Array.isArray((response as Json)?.orders) ? (response as Json).orders as unknown[] : [];
    return rows.flatMap((raw) => {
      const order = raw as Json;
      const orderId = String(order.id ?? '').replace(/n$/, '');
      const meta = metadata.get(orderId);
      const kind = managedOrderKind(meta?.clientOrderId);
      // Never take ownership of a manual or another bot's order.
      if (!kind.managed) return [];
      const side: Side = order.side === 'sell' ? 'sell' : 'buy';
      const price = Number(order.price ?? 0);
      const sizeBase = Math.abs(Number(order.remaining ?? order.amount ?? 0));
      if (!/^\d+$/.test(orderId) || !(price > 0) || !(sizeBase > 0)) return [];
      return [{ orderId, clientOrderId: meta?.clientOrderId, side, price, sizeBase, reduceOnly: kind.reduceOnly }];
    });
  }

  private parseAccount(account: Json): AccountSnapshot {
    const positions = (Array.isArray(account.positions) ? account.positions : []).map((raw) => this.parsePosition(raw as Json));
    return {
      accountId: String(asNumber(account.accountId)),
      equityUsd: Number(account.totalEquityUsd ?? 0),
      availableCollateralUsd: Number(account.availableCollateralUsd ?? 0),
      positions,
    };
  }

  private parsePosition(position: Json): PositionSnapshot {
    const pendingOrders: PendingOrder[] = (Array.isArray(position.pendingOrders) ? position.pendingOrders : []).map((raw) => {
      const order = raw as Json;
      const signedSize = Number(order.size ?? order.baseAssetAmount ?? 0);
      return {
        orderId: String(order.orderId ?? order.id ?? '').replace(/n$/, ''),
        clientOrderId: order.clientOrderId == null ? undefined : String(order.clientOrderId).replace(/n$/, ''),
        side: Number(order.side) === 1 || signedSize < 0 ? 'sell' : 'buy',
        price: Number(order.price ?? 0),
        sizeBase: Math.abs(Number(order.currentSize ?? signedSize)),
        reduceOnly: Boolean(order.reduceOnly),
      } as PendingOrder;
    }).filter((order) => /^\d+$/.test(order.orderId));
    const baseAmount = Number(position.baseAssetAmount ?? 0);
    const notional = Number(position.quoteAssetNotionalAmount ?? 0);
    return {
      marketId: String(position.marketId ?? ''), baseAmount,
      notionalUsd: Math.sign(baseAmount || 1) * Math.abs(notional), entryPrice: Number(position.entryPrice ?? 0),
      leverage: Number(position.leverage ?? 0),
      marginRatioPct: Number(position.marginRatio ?? 0) * 100,
      pendingOrders,
    };
  }

  async verifyAccountOwnership(): Promise<void> {
    const response = await this.post<{ accountCaps?: Json[] }>('/perpetuals/accounts', { accountIds: [bigintString(this.config.owner.accountId)] });
    const cap = response.accountCaps?.find((item) => String(asNumber(item.accountId)) === String(this.config.owner.accountId)
      && String(item.objectId ?? '').toLowerCase() === this.config.owner.accountCapId.toLowerCase());
    if (!cap) throw new Error('configured Account was not returned by Aftermath');
    const owner = String(cap.walletAddress ?? '').toLowerCase();
    const agent = this.config.owner.agentWalletAddress.toLowerCase();
    if (owner !== agent || cap.isAgent !== true) throw new Error('configured AccountCap is not the Agent capability owned by Agent Wallet');
  }

  async verifyVaultAssistantAccess(): Promise<void> {
    const response = await this.post<{ ownedVaultAssistantCaps?: Json[] }>('/perpetuals/vaults/owned-vault-assistant-caps', { walletAddress: this.config.owner.agentWalletAddress });
    const cap = response.ownedVaultAssistantCaps?.find((item) => String(item.objectId ?? '').toLowerCase() === this.config.owner.vaultAssistantCapId.toLowerCase()
      && String(item.vaultId ?? '').toLowerCase() === this.config.owner.vaultId.toLowerCase());
    if (!cap) throw new Error('configured Vault assistant capability is not owned by Agent Wallet');
  }

  private async executeKind(txKind: string): Promise<TxResult> {
    try {
      const tx = Transaction.fromKind(txKind);
      tx.setSender(this.config.owner.agentWalletAddress);
      const bytes = await tx.build({ client: this.sui });
      const dry = await this.sui.dryRunTransactionBlock({ transactionBlock: bytes });
      const status = dry.effects?.status?.status;
      if (status !== 'success') return { ok: false, dryRun: true, error: dry.effects?.status?.error ?? `dry-run status=${status}` };
      if (!this.live) return { ok: true, dryRun: true };
      if (process.env.CLASSIC_FLOW_LIVE_CONFIRM !== 'I_UNDERSTAND') return { ok: false, dryRun: true, error: 'live confirmation is missing' };
      if (!this.keypair) return { ok: false, dryRun: true, error: 'CLASSIC_FLOW_AGENT_PRIVATE_KEY is missing' };
      if (this.keypair.getPublicKey().toSuiAddress().toLowerCase() !== this.config.owner.agentWalletAddress.toLowerCase()) return { ok: false, dryRun: true, error: 'agent private key does not match configured agentWalletAddress' };
      const signed = await this.keypair.signTransaction(bytes);
      const result = await this.sui.executeTransactionBlock({ transactionBlock: signed.bytes, signature: signed.signature, options: { showEffects: true } });
      const chainStatus = result.effects?.status?.status;
      return chainStatus === 'success' ? { ok: true, dryRun: false, digest: result.digest } : { ok: false, dryRun: false, error: result.effects?.status?.error ?? `chain status=${chainStatus}` };
    } catch (error) { return { ok: false, dryRun: !this.live, error: txError(error) }; }
  }

  async replaceMakerOrders(input: {
    info: MarketInfo; cancel: string[]; orders: { side: Side; price: number; sizeBase: number; reduceOnly: boolean }[]; hasPosition: boolean;
  }): Promise<TxResult> {
    const leverage = effectiveLeverage(input.info, this.config.marketOverrides[input.info.symbol]?.leverage ?? this.config.strategy.leverage);
    const body = {
      accountId: bigintString(this.config.owner.accountId), accountCapId: this.config.owner.accountCapId,
      walletAddress: this.config.owner.agentWalletAddress, marketId: input.info.marketId,
      orderIdsToCancel: input.cancel.map((id) => `${id}n`),
      ordersToPlace: input.orders.map((order) => ({
        side: order.side === 'buy' ? 0 : 1,
        price: bigintString(order.price * 1e9),
        size: bigintString(order.sizeBase * 1e9),
        clientOrderId: `${managedClientOrderId(input.info.symbol, order.side, order.reduceOnly)}n`,
      })),
      orderType: 2, reduceOnly: input.orders.every((order) => order.reduceOnly), hasPosition: input.hasPosition,
      shouldAbortOnMissingId: false, leverage,
    };
    const response = await this.post<{ txKind?: string }>('/perpetuals/account/transactions/cancel-and-place-orders', body);
    if (!response.txKind) return { ok: false, dryRun: !this.live, error: 'Aftermath returned no txKind for maker replacement' };
    return this.executeKind(response.txKind);
  }

  async placeVaultHedge(input: { info: MarketInfo; side: Side; sizeBase: number; hasPosition: boolean; reduceOnly: boolean }): Promise<TxResult> {
    const leverage = effectiveLeverage(input.info, this.config.marketOverrides[input.info.symbol]?.leverage ?? this.config.strategy.leverage);
    const body = {
      vaultId: this.config.owner.vaultId, walletAddress: this.config.owner.agentWalletAddress, marketId: input.info.marketId,
      side: input.side === 'buy' ? 0 : 1, size: bigintString(input.sizeBase * 1e9), collateralChange: 0,
      hasPosition: input.hasPosition, reduceOnly: input.reduceOnly, cancelSlTp: false,
      slippage: (this.config.marketOverrides[input.info.symbol]?.maxHedgeImpactBps ?? this.config.strategy.maxHedgeImpactBps) / 10_000, leverage,
    };
    const response = await this.post<{ txKind?: string }>('/perpetuals/vault/transactions/place-market-order', body);
    if (!response.txKind) return { ok: false, dryRun: !this.live, error: 'Aftermath returned no txKind for Vault hedge' };
    return this.executeKind(response.txKind);
  }
}
