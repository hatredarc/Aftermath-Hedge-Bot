import { getWallets } from '@wallet-standard/app';
import { signAndExecuteTransaction } from '@mysten/wallet-standard';
import { Transaction } from '@mysten/sui/transactions';

type RegisteredWallet = ReturnType<typeof getWallets>['get'] extends () => readonly (infer Wallet)[] ? Wallet : never;

type BootstrapPlan = {
  token: string;
  ownerAddress: string;
  agentWalletAddress: string;
  accountId: number;
  vaultId: string;
  agentGasMist: string;
  txKind?: string;
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const status = $('#status');
const connect = $('#connect') as HTMLButtonElement;
const walletSelect = $('#wallet') as HTMLSelectElement;
const acknowledge = $('#acknowledge') as HTMLInputElement;
const summary = $('#summary');
let availableWallets: RegisteredWallet[] = [];
let busy = false;
let completed = false;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.className = error ? 'error' : '';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
  return JSON.parse(text) as T;
}

function accountAddress(account: { address: string }) { return account.address.toLowerCase(); }

function isSuiWallet(wallet: RegisteredWallet): boolean {
  return wallet.chains.some((chain) => chain.startsWith('sui:'))
    && Boolean(wallet.features['standard:connect'])
    && Boolean(wallet.features['sui:signAndExecuteTransaction'] ?? wallet.features['sui:signAndExecuteTransactionBlock']);
}

function replaceWalletOptions(wallets: RegisteredWallet[], ownerAddress: string) {
  const selectedName = availableWallets[Number(walletSelect.value)]?.name;
  const ownerWalletIndex = wallets.findIndex((wallet) => wallet.accounts.some((account) => accountAddress(account) === ownerAddress.toLowerCase()));
  availableWallets = wallets;
  walletSelect.replaceChildren(...wallets.map((wallet, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = wallet.name;
    option.selected = ownerWalletIndex >= 0 ? index === ownerWalletIndex : wallet.name === selectedName;
    return option;
  }));
  if (walletSelect.selectedIndex < 0 && wallets.length) walletSelect.selectedIndex = 0;
}

async function main() {
  const plan = await request<BootstrapPlan>('/api/plan');
  summary.innerHTML = [
    `<li><strong>Account ${plan.accountId}</strong>: grant the Agent Wallet trading-only access.</li>`,
    `<li><strong>Vault</strong> <code>${plan.vaultId}</code>: grant the same Agent Wallet trading-only access.</li>`,
    `<li><strong>${(Number(plan.agentGasMist) / 1_000_000_000).toFixed(3)} SUI</strong> for Agent Wallet gas. This is not collateral and does not grant withdrawal rights.</li>`,
  ].join('');

  const registry = getWallets();
  const refreshWallets = () => {
    const wallets = registry.get().filter(isSuiWallet);
    replaceWalletOptions(wallets, plan.ownerAddress);
    walletSelect.hidden = wallets.length < 2;
    connect.disabled = busy || completed || wallets.length === 0;
    connect.textContent = wallets.length ? `Connect ${wallets[walletSelect.selectedIndex]?.name ?? wallets[0]!.name}` : 'Looking for a Sui Wallet…';
    if (!busy && !completed) {
      setStatus(wallets.length
        ? `${wallets.length} compatible Sui wallet${wallets.length === 1 ? '' : 's'} detected.`
        : 'Waiting for a Sui Wallet extension. Open this URL in Chrome or Edge with the wallet enabled, then reload the page.', wallets.length === 0);
    }
  };

  const offRegister = registry.on('register', refreshWallets);
  const offUnregister = registry.on('unregister', refreshWallets);
  window.addEventListener('beforeunload', () => { offRegister(); offUnregister(); });
  walletSelect.addEventListener('change', () => {
    const wallet = availableWallets[Number(walletSelect.value)];
    if (wallet) connect.textContent = `Connect ${wallet.name}`;
  });
  refreshWallets();
  for (const delay of [250, 1_000, 2_500]) window.setTimeout(refreshWallets, delay);

  connect.addEventListener('click', async () => {
    if (!acknowledge.checked) { setStatus('Confirm that you have reviewed the transaction contents first.', true); return; }
    const wallet = availableWallets[Number(walletSelect.value)];
    if (!wallet) { refreshWallets(); return; }
    try {
      busy = true;
      connect.disabled = true;
      setStatus('Requesting wallet connection…');
      const feature = wallet.features['standard:connect'] as { connect: () => Promise<{ accounts: Array<{ address: string }> }> } | undefined;
      if (!feature) throw new Error(`${wallet.name} does not support Wallet Standard connect`);
      const connected = await feature.connect();
      const account = [...connected.accounts, ...wallet.accounts].find((item: { address: string }) => accountAddress(item) === plan.ownerAddress.toLowerCase());
      if (!account) throw new Error(`Connect the owner wallet ${plan.ownerAddress}; a different address is currently selected.`);

      if (plan.txKind) {
        setStatus('Open your wallet and carefully approve the single transaction…');
        const tx = Transaction.fromKind(plan.txKind);
        tx.setSender(account.address);
        const gas = tx.splitCoins(tx.gas, [tx.pure.u64(plan.agentGasMist)]);
        tx.transferObjects([gas], tx.pure.address(plan.agentWalletAddress));
        const result = await signAndExecuteTransaction(wallet as never, { transaction: tx, account: account as never, chain: 'sui:mainnet' });
        await request('/api/complete', { method: 'POST', body: JSON.stringify({ token: plan.token, digest: result.digest }) });
        setStatus(`Done. Transaction ${result.digest} was confirmed. Return to the terminal.`);
      } else {
        await request('/api/complete', { method: 'POST', body: JSON.stringify({ token: plan.token }) });
        setStatus('Agent permissions were already approved. Return to the terminal.');
      }
      completed = true;
      connect.textContent = 'Connected';
    } catch (error) {
      busy = false;
      connect.disabled = false;
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
}

main().catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
