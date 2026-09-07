import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export interface WalletBootstrapPlan {
  ownerAddress: string;
  agentWalletAddress: string;
  accountId: number;
  vaultId: string;
  agentGasMist: bigint;
  txKind?: string;
}

interface WalletBootstrapOptions {
  plan: WalletBootstrapPlan;
  verify: () => Promise<void>;
  complete: () => Promise<void>;
  timeoutMs?: number;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Classic Flow · one-time approval</title>
<style>
body{margin:0;background:#0b0e12;color:#eef2f7;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:700px;margin:8vh auto;padding:28px;background:#111720;border:1px solid #253142;border-radius:14px}h1{font-size:22px;margin:0 0 8px}p,li{color:#c3cfdd}code{word-break:break-all;color:#82e6be}button{background:#4ee0a7;color:#042016;border:0;border-radius:8px;padding:12px 16px;font-weight:750;font-size:16px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}select{display:block;width:100%;margin:0 0 12px;padding:11px 12px;border:1px solid #34445a;border-radius:8px;background:#0b0e12;color:#eef2f7;font:inherit}select[hidden]{display:none}.notice{border-left:3px solid #f0c36d;padding:8px 12px;background:#1d1a13}#status{margin-top:16px;color:#82e6be}.error{color:#ff8585!important}label{display:block;margin:18px 0}
</style></head><body><main class="wrap"><h1>One-time Classic Flow setup</h1>
<p>This page runs only on your computer (<code>localhost</code>). It never asks for the owner's seed phrase or private key.</p>
<div class="notice">Review the transaction contents before signing. The Agent Wallet may trade, but cannot withdraw collateral or grant new permissions.</div>
<ul id="summary"></ul><label><input id="acknowledge" type="checkbox"> I understand the contents of this one on-chain transaction.</label>
<select id="wallet" hidden aria-label="Sui Wallet"></select><button id="connect" disabled>Looking for a Sui Wallet…</button><p id="status">Loading setup plan…</p></main><script src="/assets/onboarding.js"></script></body></html>`;

function reply(response: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'none'; style-src 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
  response.end(body);
}

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function verifyEventually(verify: () => Promise<void>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await verify(); return; }
    catch (error) { lastError = error; await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)); }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runWalletBootstrap(options: WalletBootstrapOptions): Promise<void> {
  const assetPath = resolve(process.cwd(), '.classic-flow-ui', 'onboarding.js');
  const asset = await readFile(assetPath, 'utf8').catch(() => { throw new Error('onboarding bundle not found; run npm run build:onboarding'); });
  const token = randomBytes(24).toString('hex');
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  let done = false;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/') return reply(response, 200, PAGE, 'text/html; charset=utf-8');
        if (request.method === 'GET' && url.pathname === '/assets/onboarding.js') return reply(response, 200, asset, 'application/javascript; charset=utf-8');
        if (request.method === 'GET' && url.pathname === '/api/plan') {
          return reply(response, 200, JSON.stringify({ ...options.plan, agentGasMist: String(options.plan.agentGasMist), token }), 'application/json; charset=utf-8');
        }
        if (request.method === 'POST' && url.pathname === '/api/complete') {
          const submitted = JSON.parse(await bodyOf(request)) as { token?: string; digest?: string };
          if (submitted.token !== token) return reply(response, 403, 'invalid local setup token');
          await verifyEventually(options.verify);
          await options.complete();
          done = true;
          reply(response, 200, JSON.stringify({ ok: true, digest: submitted.digest ?? null }), 'application/json; charset=utf-8');
          setTimeout(() => { server.close(); resolvePromise(); }, 200);
          return;
        }
        return reply(response, 404, 'not found');
      } catch (error) {
        reply(response, 500, error instanceof Error ? error.message : String(error));
      }
    });
    const timer = setTimeout(() => {
      if (!done) { server.close(); rejectPromise(new Error('wallet confirmation timed out after 15 minutes')); }
    }, timeoutMs);
    server.once('close', () => clearTimeout(timer));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); rejectPromise(new Error('could not allocate localhost setup port')); return; }
      const link = `http://localhost:${address.port}/`;
      console.log(`\nOpen this local one-time setup page: ${link}`);
      console.log('It binds only to your computer and will close after confirmation.\n');
    });
  });
}
