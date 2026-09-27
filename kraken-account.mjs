import { spawn } from 'node:child_process';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { extractKrakenFees } from './kraken-fees.mjs';

export function accountReader(root) {
  const directory = join(process.env.LOCALAPPDATA || root, 'EdgeLab');
  const status = { connected: false, secretStored: false, apiKeyStored: false, checkedAt: null, feePctByPair: {}, makerFeePctByPair: {}, error: null };
  let pending = null, lastNonce = 0, lastAttempt = 0, requestQueue = Promise.resolve();
  async function stored() {
    status.secretStored = await access(join(directory, 'kraken-api-secret.dpapi')).then(() => true, () => false);
    status.apiKeyStored = await access(join(directory, 'kraken-api-key.dpapi')).then(() => true, () => false);
    return status;
  }
  async function sign(request) {
    if (process.platform !== 'win32') throw Error('Windows credential store required');
    return new Promise((resolve, reject) => {
      const process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'kraken-sign.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => { process.kill(); reject(Error('Local credential signing timed out')); }, 8000);
      process.stdout.on('data', data => { output += data; if (output.length > 4096) process.kill(); });
      process.stderr.resume(); // Never log credential helper output or error objects.
      process.on('error', () => { clearTimeout(timer); reject(Error('Cannot start Windows credential signer')); });
      process.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(Error('Encrypted credentials unavailable or unreadable for this Windows account'));
        try { const value = JSON.parse(output); if (!value.apiKey || !value.signature) throw Error(); resolve(value); }
        catch { reject(Error('Credential signer returned invalid output')); }
        output = '';
      });
      process.stdin.on('error', () => {});
      process.stdin.end(JSON.stringify(request));
    });
  }
  function privateRead(method, params = {}) {
    const result = requestQueue.then(() => request(method, params));
    requestQueue = result.catch(() => {});
    return result;
  }
  async function request(method, params = {}) {
    if (!['Balance', 'BalanceEx', 'TradeVolume', 'GetApiKeyInfo', 'AddOrder', 'OpenOrders', 'ClosedOrders', 'QueryOrders'].includes(method)) throw Error('Unsupported Kraken method');
    const nonceFile = join(directory, 'kraken-nonce.txt');
    const previous = await readFile(nonceFile, 'utf8').then(Number, error => { if (error.code === 'ENOENT') return 0; throw Error('Cannot read Kraken nonce file'); });
    if (!Number.isSafeInteger(previous) || previous < 0) throw Error('Invalid saved Kraken nonce');
    const nonce = String(lastNonce = Math.max(Date.now(), lastNonce + 1, previous + 1));
    await mkdir(directory, { recursive: true }); await writeFile(nonceFile, nonce);
    const path = `/0/private/${method}`, payload = new URLSearchParams({ nonce, ...params }).toString();
    const auth = await sign({ path, payload, nonce });
    const response = await fetch(`https://api.kraken.com${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'API-Key': auth.apiKey, 'API-Sign': auth.signature }, body: payload });
    if (!response.ok) throw Error(`Kraken account check HTTP ${response.status}`);
    const body = await response.json();
    if (body.error?.length) {
      const known = ['EAPI:Invalid key', 'EAPI:Invalid signature', 'EAPI:Invalid nonce', 'EGeneral:Permission denied', 'EAPI:Rate limit exceeded', 'EAuth:Account temporary disabled', 'EOrder:Insufficient funds', 'EOrder:Order minimum not met', 'EOrder:Cost minimum not met', 'EOrder:Rate limit exceeded', 'EService:Deadline elapsed'];
      const code = body.error.find(error => known.includes(error));
      const error = Error(code || 'Kraken rejected the request; check permissions, order parameters or account restrictions'); error.rejected = true; throw error;
    }
    return body.result;
  }
  async function refresh(force = false) {
    if (pending) return pending;
    if (!force && Date.now() - lastAttempt < 10000) return status;
    lastAttempt = Date.now();
    pending = (async () => {
      await stored(); status.connected = false; status.error = null; status.gbpBalance = null; status.feePctByPair = {}; status.makerFeePctByPair = {};
      if (!status.secretStored || !status.apiKeyStored) { status.error = 'Both encrypted API key and private key are required'; return status; }
      try {
        const balances = await privateRead('BalanceEx');
        status.available = {};
        for (const [asset, names] of Object.entries({ GBP: ['ZGBP', 'GBP'], BTC: ['XXBT', 'XBT', 'BTC'], ETH: ['XETH', 'ETH'], SOL: ['SOL'] })) {
          const row = names.map(name => balances?.[name]).find(Boolean);
          const available = row ? Number(row.balance) - Number(row.credit_used || 0) - Number(row.hold_trade || 0) : 0;
          if (!Number.isFinite(available)) throw Error('Invalid available balance');
          status.available[asset] = Math.max(0, available); // Never spend borrowed credit.
        }
        const gbp = status.available.GBP;
        if (!Number.isFinite(gbp) || gbp < 0) throw Error('Kraken returned an invalid GBP balance');
        status.gbpBalance = gbp; status.connected = true;
        status.permissions = null;
        try { const info = await privateRead('GetApiKeyInfo'); status.permissions = Array.isArray(info?.permissions) ? info.permissions : null; }
        catch { status.permissions = null; }
        try {
          const volume = await privateRead('TradeVolume', { pair: 'XBTGBP,ETHGBP,SOLGBP,XDGGBP,PEPEGBP,WIFGBP,ETHXBT,SOLXBT' });
          Object.assign(status, extractKrakenFees(volume));
          if (Object.keys(status.feePctByPair).length !== 8) status.error = 'Connected; Kraken did not return all eight account fee rates. Paper fees remain assumptions.';
        } catch (error) { status.error = `Balance connected; fees unavailable: ${error.message}`; }
      } catch (error) { status.error = error.message; }
      status.checkedAt = Date.now();
      return status;
    })().finally(() => { pending = null; });
    return pending;
  }
  return { status, stored, refresh, call: privateRead };
}
