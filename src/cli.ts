#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ConfigSchema, formatConfigErrors, loadConfig } from './config.js';
import { AftermathClient } from './aftermath.js';
import { runDoctor } from './doctor.js';
import { ClassicFlowRunner } from './runner.js';
import { runWalletBootstrap } from './onboarding.js';

loadDotenv({ path: resolve(process.cwd(), '.env.agent'), override: false, quiet: true });
loadDotenv({ override: false, quiet: true });

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
function flag(name: string) { return args.includes(name); }
function option(name: string, fallback?: string) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; }
function usage() {
  console.log(`Classic Flow public bot\n\nCommands:\n  setup [--output FILE]         one-time local wallet setup\n  doctor --config FILE          validate access, state and books\n  config show --config FILE     print effective configuration\n  config set MARKET FIELD VALUE update oi/size/chase/band/impact/leverage\n  config reset MARKET           remove all per-market overrides\n  start --config FILE [--once]  safe dry-run engine (default)\n  start --config FILE --live    live mode; also requires CLASSIC_FLOW_LIVE_CONFIRM\n  status [--state FILE]         show the last runtime snapshot\n  commands                      print operator command reference\n`);
}

function validId(value: string) { return /^0x[a-fA-F0-9]{64}$/.test(value.trim()); }
type ApiObject = Record<string, unknown>;
function apiInteger(value: unknown) { return Number(String(value ?? '0').replace(/n$/, '')); }
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`https://aftermath.finance/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Aftermath HTTP ${response.status} ${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}
async function createAgent(outputPath: string) {
  if (existsSync(outputPath)) throw new Error(`${outputPath} already exists; refusing to overwrite a key`);
  const keypair = new Ed25519Keypair();
  await writeFile(outputPath, `CLASSIC_FLOW_AGENT_PRIVATE_KEY=${keypair.getSecretKey()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return keypair.getPublicKey().toSuiAddress();
}

async function setupMaster(outputPath = resolve(option('--output', 'classic-flow.config.json')!)) {
  if (existsSync(outputPath)) throw new Error(`${outputPath} already exists; refusing to overwrite config`);
  const rl = createInterface({ input, output });
  const ask = async (label: string, fallback?: string) => {
    const answer = (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim();
    return answer || fallback || '';
  };
  const askId = async (label: string) => {
    for (;;) { const value = await ask(label); if (validId(value)) return value; console.log('  Enter a 0x address followed by 64 hexadecimal characters.'); }
  };
  const choose = async (label: string, items: ApiObject[], render: (item: ApiObject) => string) => {
    if (!items.length) throw new Error(`${label}: none found`);
    console.log(`\n${label}:`);
    items.forEach((item, index) => console.log(`  ${index + 1}. ${render(item)}`));
    for (;;) {
      const selected = Number(await ask('Select a number', '1'));
      if (Number.isInteger(selected) && selected >= 1 && selected <= items.length) return items[selected - 1]!;
      console.log(`  Enter a number from 1 to ${items.length}.`);
    }
  };
  try {
    console.log('\nClassic Flow setup · Account maker -> your Vault taker hedge\n');
    let agentSecret = process.env.CLASSIC_FLOW_AGENT_PRIVATE_KEY;
    if (!agentSecret) {
      const agentPath = resolve('.env.agent');
      const agentAddress = await createAgent(agentPath);
      agentSecret = (await readFile(agentPath, 'utf8')).trim().split('=', 2)[1];
      if (!agentSecret) throw new Error('could not read locally generated Agent Wallet key');
      process.env.CLASSIC_FLOW_AGENT_PRIVATE_KEY = agentSecret;
      console.log(`Created local Agent Wallet: ${agentAddress}`);
    }
    const agentWalletAddress = Ed25519Keypair.fromSecretKey(agentSecret).getPublicKey().toSuiAddress();
    console.log(`Agent Wallet: ${agentWalletAddress}`);
    const walletAddress = await askId('Owner wallet address');
    const ownerAccounts = await apiPost<{ accountCaps?: ApiObject[] }>('/perpetuals/accounts/owned', { walletAddress });
    const ownerAccount = await choose('Perpetuals Accounts owned by this wallet', ownerAccounts.accountCaps ?? [], (item) => `account ${apiInteger(item.accountId)} · ${String(item.collateralCoinType ?? '')}`);
    const accountId = apiInteger(ownerAccount.accountId);
    const accountCollateralCoinType = String(ownerAccount.collateralCoinType ?? '');
    const agentAccounts = await apiPost<{ accountCaps?: ApiObject[] }>('/perpetuals/accounts/owned', { walletAddress: agentWalletAddress });
    const agentAccountCap = (agentAccounts.accountCaps ?? []).find((item) => apiInteger(item.accountId) === accountId && item.isAgent === true);
    let accountCapId = agentAccountCap && validId(String(agentAccountCap.objectId ?? '')) ? String(agentAccountCap.objectId) : '';

    const ownerVaults = await apiPost<{ ownedVaultCaps?: ApiObject[] }>('/perpetuals/vaults/owned-vault-caps', { walletAddress });
    const compatibleVaults = (ownerVaults.ownedVaultCaps ?? []).filter((item) => String(item.collateralCoinType ?? '') === accountCollateralCoinType);
    const ownerVault = await choose('Vaults with the same collateral as the Account', compatibleVaults, (item) => `${String(item.vaultId ?? '')} · account ${apiInteger(item.accountId)} · ${String(item.collateralCoinType ?? '')}`);
    const vaultId = String(ownerVault.vaultId);
    if (!validId(vaultId)) throw new Error('Aftermath returned an invalid Vault ID');
    const vaultAccountId = apiInteger(ownerVault.accountId);
    if (!vaultAccountId) throw new Error('Aftermath returned no internal account for the selected Vault');
    const assistantCaps = await apiPost<{ ownedVaultAssistantCaps?: ApiObject[] }>('/perpetuals/vaults/owned-vault-assistant-caps', { walletAddress: agentWalletAddress });
    const assistantCap = (assistantCaps.ownedVaultAssistantCaps ?? []).find((item) => String(item.vaultId ?? '').toLowerCase() === vaultId.toLowerCase());
    const targetOiUsdPerMarket = Number(await ask('Target OI per active market, USD', '100'));
    const orderSizeUsd = Number(await ask('Maker limit order size, USD', '10'));
    const initialRaw = (await ask('Initial 4 markets, comma-separated', 'BTC,ETH,SUI,SOL')).toUpperCase().split(',').map((item) => item.trim());
    if (initialRaw.length !== 4 || new Set(initialRaw).size !== 4 || initialRaw.some((item) => !['BTC','ETH','SUI','ZEC','SOL'].includes(item))) {
      throw new Error('Initial markets must be four different values from BTC, ETH, SUI, ZEC, SOL');
    }
    const advanced = (await ask('Change advanced settings? y/n', 'n')).toLowerCase().startsWith('y');
    const chaseDistanceBps = advanced ? Number(await ask('Grid chase, bps', '2')) : 2;
    const flowBandUsd = advanced ? Number(await ask('FLOW band, USD', String(Math.max(orderSizeUsd, Math.min(targetOiUsdPerMarket * .1, orderSizeUsd * 5))))) : Math.max(orderSizeUsd, Math.min(targetOiUsdPerMarket * .1, orderSizeUsd * 5));
    const maxHedgeImpactBps = advanced ? Number(await ask('Max Vault hedge impact, bps', '3')) : 3;

    let txKind: string | undefined;
    if (!agentAccountCap || !validId(String(agentAccountCap.objectId ?? ''))) {
      const response = await apiPost<{ txKind?: string }>('/perpetuals/account/transactions/grant-agent-wallet', {
        accountId: `${accountId}n`, recipientAddress: agentWalletAddress,
      });
      txKind = response.txKind;
      if (!txKind) throw new Error('Aftermath returned no transaction for Account Agent access');
    }
    if (!assistantCap || !validId(String(assistantCap.objectId ?? ''))) {
      const response = await apiPost<{ txKind?: string }>('/perpetuals/vault/transactions/owner/grant-agent-wallet', {
        vaultId, recipientAddress: agentWalletAddress, ...(txKind ? { txKind } : {}),
      });
      txKind = response.txKind;
      if (!txKind) throw new Error('Aftermath returned no transaction for Vault Agent access');
    }
    let vaultAssistantCapId = assistantCap && validId(String(assistantCap.objectId ?? '')) ? String(assistantCap.objectId) : '';
    const configDraft = {
      version: 1, network: 'mainnet', apiBase: 'https://aftermath.finance/api', rpcUrl: 'https://sui-rpc.publicnode.com',
      owner: { walletAddress, accountId, accountCapId, vaultId, vaultAssistantCapId, agentWalletAddress },
      strategy: { mode: 'classic_flow', targetOiUsdPerMarket, orderSizeUsd, flowBandUsd, buildSide: 'auto', chaseDistanceBps, maxHedgeImpactBps, leverage: 'auto', tickMs: 1000, deltaToleranceUsd: 2 }, marketOverrides: {},
      selector: { mode: 'auto_top_4', universe: ['BTC','ETH','SUI','ZEC','SOL'], initialMarkets: initialRaw, sampleWindowSec: 60, minimumValidSamples: 48, candidateStableSec: 30, rotateAfterBadSec: 60, switchImprovementBps: 1, switchImprovementRatio: .2, cooldownSec: 300, useCumulativeDepthVwap: true },
      safety: { postOnlyMaker: true, hedgeActualFilledAmount: true, pauseNewMakerWhileUnhedged: true, preserveParkedCoreOi: true, secretsRemainLocal: true, maxPositionHealthPct: 70 },
    };

    await runWalletBootstrap({
      plan: { ownerAddress: walletAddress, agentWalletAddress, accountId, vaultId, agentGasMist: 50_000_000n, txKind },
      verify: async () => {
        const accounts = await apiPost<{ accountCaps?: ApiObject[] }>('/perpetuals/accounts/owned', { walletAddress: agentWalletAddress });
        const accountCap = (accounts.accountCaps ?? []).find((item) => apiInteger(item.accountId) === accountId && item.isAgent === true);
        if (!accountCap || !validId(String(accountCap.objectId ?? ''))) throw new Error('Account Agent access is not visible on-chain yet; wait a few seconds and retry setup');
        accountCapId = String(accountCap.objectId);
        const assistants = await apiPost<{ ownedVaultAssistantCaps?: ApiObject[] }>('/perpetuals/vaults/owned-vault-assistant-caps', { walletAddress: agentWalletAddress });
        const vaultCap = (assistants.ownedVaultAssistantCaps ?? []).find((item) => String(item.vaultId ?? '').toLowerCase() === vaultId.toLowerCase());
        if (!vaultCap || !validId(String(vaultCap.objectId ?? ''))) throw new Error('Vault Agent access is not visible on-chain yet; wait a few seconds and retry setup');
        vaultAssistantCapId = String(vaultCap.objectId);
      },
      complete: async () => {
        const finalConfig = ConfigSchema.parse({ ...configDraft, owner: { ...configDraft.owner, accountCapId, vaultAssistantCapId } });
        await writeFile(outputPath, `${JSON.stringify(finalConfig, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        console.log(`\nConfig saved: ${outputPath}`);
      },
    });
    console.log('\nNext: npm run verify, then npm run dry-run.');
  } finally { rl.close(); }
}

async function main() {
  if (command === 'help' || flag('--help') || flag('-h')) { usage(); return; }
  if (command === 'setup') {
    await setupMaster(); return;
  }
  if (command === 'agent' && args[1] === 'create') {
    const output = resolve(option('--output', '.env.agent')!);
    const address = await createAgent(output);
    console.log(`Agent address: ${address}`);
    console.log(`Secret saved to: ${output}`);
    return;
  }
  if (command === 'commands') {
    console.log([
      'npm run cli -- setup',
      'npm run cli -- doctor --config classic-flow.config.json',
      'npm run cli -- config show --config classic-flow.config.json',
      'npm run cli -- config set BTC oi 2000 --config classic-flow.config.json',
      'npm run cli -- config set BTC size 50 --config classic-flow.config.json',
      'npm run cli -- config set BTC chase 2 --config classic-flow.config.json',
      'npm run cli -- config set BTC band 250 --config classic-flow.config.json',
      'npm run cli -- config set BTC impact 3 --config classic-flow.config.json',
      'npm run cli -- config set BTC leverage auto --config classic-flow.config.json',
      'npm run cli -- config reset BTC --config classic-flow.config.json',
      'npm run cli -- start --config classic-flow.config.json --once',
      'npm run cli -- start --config classic-flow.config.json',
      'npm run cli -- status',
    ].join('\n'));
    return;
  }
  if (command === 'status') {
    const statePath = resolve(option('--state', 'classic-flow.state.json')!);
    console.log(await readFile(statePath, 'utf8')); return;
  }
  const configPath = resolve(option('--config', 'classic-flow.config.json')!);
  if (command === 'start' && !existsSync(configPath)) {
    console.log('No configuration found. Starting one-time local setup first.');
    await setupMaster(configPath);
  }
  let config;
  try { config = await loadConfig(configPath); }
  catch (error) { for (const line of formatConfigErrors(error)) console.error(`CONFIG ${line}`); process.exitCode = 2; return; }
  if (command === 'doctor') {
    const checks = await runDoctor(config);
    for (const item of checks) console.log(`${item.ok ? 'OK  ' : 'FAIL'} ${item.name}: ${item.detail}`);
    if (checks.some((item) => !item.ok && item.name !== 'Live gate')) process.exitCode = 1;
    return;
  }
  if (command === 'config' && args[1] === 'show') {
    console.log(JSON.stringify(config, null, 2)); return;
  }
  if (command === 'config' && args[1] === 'reset') {
    const market = String(args[2] ?? '').toUpperCase() as keyof typeof config.marketOverrides;
    if (!['BTC','ETH','SUI','ZEC','SOL'].includes(market)) throw new Error('market must be BTC, ETH, SUI, ZEC, or SOL');
    delete config.marketOverrides[market];
    await writeFile(configPath, `${JSON.stringify(ConfigSchema.parse(config), null, 2)}\n`, 'utf8');
    console.log(`${market} overrides removed`); return;
  }
  if (command === 'config' && args[1] === 'set') {
    const market = String(args[2] ?? '').toUpperCase() as keyof typeof config.marketOverrides;
    const field = String(args[3] ?? '').toLowerCase();
    const rawValue = String(args[4] ?? '');
    if (!['BTC','ETH','SUI','ZEC','SOL'].includes(market)) throw new Error('market must be BTC, ETH, SUI, ZEC, or SOL');
    const overrides = { ...(config.marketOverrides[market] ?? {}) };
    if (field === 'leverage') {
      const value = rawValue.toLowerCase() === 'auto' ? 'auto' : Number(rawValue);
      if (value !== 'auto' && !Number.isFinite(value)) throw new Error('leverage must be a number or auto');
      overrides.leverage = value;
    } else {
      const targetField = ({ oi: 'targetOiUsdPerMarket', size: 'orderSizeUsd', chase: 'chaseDistanceBps', band: 'flowBandUsd', impact: 'maxHedgeImpactBps' } as const)[field as 'oi'];
      if (!targetField) throw new Error('field must be oi, size, chase, band, impact, or leverage');
      const value = Number(rawValue);
      if (!Number.isFinite(value)) throw new Error('value must be a number');
      overrides[targetField] = value;
    }
    config.marketOverrides[market] = overrides;
    const validated = ConfigSchema.parse(config);
    await writeFile(configPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    console.log(`${market} overrides updated`); return;
  }
  if (command === 'start') {
    const live = flag('--live');
    if (live && option('--confirm-live') !== 'I_UNDERSTAND' && process.env.CLASSIC_FLOW_LIVE_CONFIRM !== 'I_UNDERSTAND') throw new Error('live mode requires --confirm-live I_UNDERSTAND');
    if (live) process.env.CLASSIC_FLOW_LIVE_CONFIRM = 'I_UNDERSTAND';
    if (live) {
      const checks = await runDoctor(config);
      for (const item of checks) console.log(`${item.ok ? 'OK  ' : 'FAIL'} ${item.name}: ${item.detail}`);
      if (checks.some((item) => !item.ok)) throw new Error('live start blocked by preflight checks');
    }
    const runner = new ClassicFlowRunner(config, live);
    process.once('SIGINT', () => runner.stop()); process.once('SIGTERM', () => runner.stop());
    if (flag('--once')) await runner.once(); else await runner.run();
    return;
  }
  usage(); process.exitCode = 2;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
