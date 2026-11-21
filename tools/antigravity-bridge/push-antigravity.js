#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const AGENT_URL = process.env.PHONEBOX_URL || 'http://127.0.0.1:8765';
const PUSH_TTL_SEC = Number(process.env.PHONEBOX_PUSH_TTL || 600);
const INTERVAL_SEC = Number(process.env.PHONEBOX_PUSH_INTERVAL || 60);

function getDevToolsPort() {
  const override = process.env.AG_DEVTOOLS_PORT_FILE;
  let portFile = override;
  if (!portFile) {
    const home = process.env.HOME || os.homedir();
    const base = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config')));
    portFile = path.join(base, 'Antigravity', 'DevToolsActivePort');
  }
  if (!fs.existsSync(portFile)) return null;
  const raw = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
  const port = Number(raw);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : null;
}

function httpJson(urlStr, method = 'GET', payload = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = payload === null ? null : (typeof payload === 'string' ? payload : JSON.stringify(payload));
    const reqHeaders = { ...headers };
    if (body !== null) {
      reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json; charset=utf-8';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: reqHeaders
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { out += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, headers: res.headers, body: out });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 300)}`));
          }
        });
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error(`HTTP timeout: ${urlStr}`)));
    req.on('error', reject);
    if (body !== null) req.end(body);
    else req.end();
  });
}

async function queryCdpPages(port) {
  const res = await httpJson(`http://127.0.0.1:${port}/json/list`);
  const list = JSON.parse(res.body);
  return Array.isArray(list)
    ? list.filter((p) => p && p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url || ''))
    : [];
}

async function cdpEval(wsUrl, expression) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('WebSocket is unavailable; run with Node >= 22 or Antigravity ELECTRON_RUN_AS_NODE=1');
  }
  const ws = new globalThis.WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 3000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket connect failed')); }, { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error('CDP Runtime.evaluate timeout')), 8000);
      const onMessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', onMessage);
            if (msg.error || msg.result?.exceptionDetails) {
              reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails)));
            } else {
              resolve(msg.result?.result?.value);
            }
          }
        } catch (err) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMessage);
          reject(err);
        }
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }));
    });
  } finally {
    try { ws.close(); } catch {}
  }
}

/**
 * Fetch Antigravity quota snapshot through the running antigravity-usage-suite telemetry hub.
 */
async function readAntigravityQuota() {
  const port = getDevToolsPort();
  if (!port) throw new Error('Antigravity DevToolsActivePort not found');
  const pages = await queryCdpPages(port);
  if (!pages.length) throw new Error('No Antigravity renderer window found');

  let lastErr = null;
  for (const page of pages) {
    try {
      const res = await cdpEval(
        page.webSocketDebuggerUrl,
        `(async () => {
          const t = window.__AGUnifiedTelemetry;
          if (!t) return { ok: false, reason: 'telemetry_missing' };
          let raw = t.getUserStatus?.();
          let meta = t.getUserStatusMeta?.();
          if (t.refreshUserStatus) {
            try {
              const refreshed = await t.refreshUserStatus(true);
              if (refreshed) raw = refreshed;
              meta = t.getUserStatusMeta?.() || meta;
            } catch {}
          }
          const us = raw?.userStatus || raw;
          const configs = meta?.modelConfigs || us?.cascadeModelConfigData?.clientModelConfigs || [];
          return {
            ok: true,
            fetchedAt: meta?.fetchedAt || Date.now(),
            planName: meta?.planName || us?.planStatus?.planInfo?.planName || us?.userTier?.name || 'Antigravity',
            tierName: meta?.tierName || us?.userTier?.name || null,
            promptCredits: us?.planStatus?.availablePromptCredits ?? null,
            models: configs.map((m) => ({
              label: m.label || '',
              remainingFraction: m.quotaInfo?.remainingFraction,
              resetTime: m.quotaInfo?.resetTime || null
            }))
          };
        })()`
      );
      if (res && res.ok && Array.isArray(res.models) && res.models.length > 0) {
        return res;
      }
      lastErr = new Error(res?.reason || 'Empty model quota list');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Failed to read Antigravity telemetry');
}

function formatReset(iso) {
  if (!iso) return '重置时间未知';
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return '重置时间未知';
  const diffMs = targetMs - Date.now();
  const d = new Date(targetMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const clockStr = diffMs > 18 * 3600 * 1000 ? `${mo}-${da} ${hh}:${mm}` : `${hh}:${mm}`;
  if (diffMs <= 0) return `即将重置 (${clockStr})`;
  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const rel = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return `${rel} 后重置 (${clockStr})`;
}

function levelForRemaining(pct) {
  if (pct <= 10) return 'error';
  if (pct <= 30) return 'warn';
  return 'ok';
}

function summarizePools(snapshot) {
  const valid = snapshot.models.filter((m) => typeof m.remainingFraction === 'number' && m.remainingFraction >= 0 && m.remainingFraction <= 1);
  const pick = (pred) => valid.find(pred) || null;

  const geminiMain = pick((m) => /gemini\s*4\s*(hydrogen|neon)|gemini\s*3\.8\s*flash|orchestrator\s*\(neon\)/i.test(m.label))
    || pick((m) => /gemini/i.test(m.label) && !/argon/i.test(m.label));
  const claudeGpt = pick((m) => /claude|gpt-oss/i.test(m.label));
  const geminiArgon = pick((m) => /argon/i.test(m.label));

  const toCard = (name, model) => {
    if (!model) {
      return { value: '—', sub: '暂无测量数据', level: 'info' };
    }
    const pct = Math.round(model.remainingFraction * 1000) / 10;
    return {
      value: pct,
      unit: '%',
      progress: model.remainingFraction,
      sub: `剩余 · ${formatReset(model.resetTime)}`,
      level: levelForRemaining(pct),
      _pct: pct,
      _reset: formatReset(model.resetTime),
      _name: name
    };
  };

  const gCard = toCard('Gemini 4 / 3.8', geminiMain);
  const cCard = toCard('Claude 5.5 / GPT', claudeGpt);
  const aCard = toCard('Gemini 4 Argon', geminiArgon);

  const items = [];
  for (const c of [gCard, cCard, aCard]) {
    if (c._pct !== undefined) {
      items.push({ label: c._name, value: `${c._pct}% · ${c._reset}`, level: c.level });
    }
  }

  const knownPred = (m) =>
    /gemini\s*4\s*(hydrogen|neon)|gemini\s*3\.8\s*flash|orchestrator\s*\(neon\)|claude|gpt-oss|argon/i.test(m.label);
  const seenBuckets = new Set();
  for (const m of valid) {
    if (knownPred(m)) continue;
    const key = `${Math.round(m.remainingFraction * 1000)}|${m.resetTime || ''}`;
    if (seenBuckets.has(key)) continue;
    seenBuckets.add(key);
    const pct = Math.round(m.remainingFraction * 1000) / 10;
    items.push({ label: m.label, value: `${pct}% · ${formatReset(m.resetTime)}`, level: levelForRemaining(pct) });
  }

  if (snapshot.promptCredits !== null && snapshot.promptCredits !== undefined) {
    items.push({
      label: 'Prompt Credits',
      value: String(snapshot.promptCredits),
      level: snapshot.promptCredits <= 50 ? 'warn' : 'info'
    });
  }

  const now = new Date();
  const syncTime = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  items.push({ label: `套餐: ${snapshot.tierName || snapshot.planName}`, value: `同步 ${syncTime}`, level: 'info' });

  const cleanCard = ({ _pct, _reset, _name, ...rest }) => rest;
  return {
    'ag-quotas': { title: `Antigravity (${snapshot.tierName || snapshot.planName})`, items },
    'ag-gemini': { title: 'Gemini 4 / 3.8', ...cleanCard(gCard) },
    'ag-claude': { title: 'Claude 5.5 / GPT', ...cleanCard(cCard) },
    'ag-argon': { title: 'Gemini 4 Argon', ...cleanCard(aCard) }
  };
}

async function setupPhoneBoxPage() {
  const res = await httpJson(`${AGENT_URL}/api/settings`);
  const cfgVer = res.headers['x-config-version'];
  const cfg = JSON.parse(res.body);
  const agPage = {
    id: 'antigravity',
    title: 'Antigravity',
    icon: '✨',
    enabled: true,
    widgets: [
      { id: 'push-ag-list', type: 'push', x: 0, y: 0, w: 7, h: 6, options: { key: 'ag-quotas', title: 'Antigravity 配额', style: 'list' } },
      { id: 'push-ag-gemini', type: 'push', x: 7, y: 0, w: 5, h: 2, options: { key: 'ag-gemini', title: 'Gemini 4 / 3.8', style: 'big', unit: '%' } },
      { id: 'push-ag-claude', type: 'push', x: 7, y: 2, w: 5, h: 2, options: { key: 'ag-claude', title: 'Claude 5.5 / GPT', style: 'big', unit: '%' } },
      { id: 'push-ag-argon', type: 'push', x: 7, y: 4, w: 5, h: 2, options: { key: 'ag-argon', title: 'Gemini 4 Argon', style: 'big', unit: '%' } }
    ]
  };
  const pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  const idx = pages.findIndex((p) => p && p.id === 'antigravity');
  if (idx >= 0) pages[idx] = agPage;
  else {
    const homeIdx = pages.findIndex((p) => p && p.id === 'home');
    pages.splice(homeIdx >= 0 ? homeIdx + 1 : 0, 0, agPage);
  }
  cfg.pages = pages;
  const headers = cfgVer ? { 'X-Config-Version': String(cfgVer) } : {};
  const saveRes = await httpJson(`${AGENT_URL}/api/settings`, 'PUT', cfg, headers);
  return JSON.parse(saveRes.body);
}

async function pushOnce() {
  const snap = await readAntigravityQuota();
  const payloads = summarizePools(snap);
  for (const [key, data] of Object.entries(payloads)) {
    await httpJson(`${AGENT_URL}/api/push/${encodeURIComponent(key)}?ttl=${PUSH_TTL_SEC}`, 'POST', data);
  }
  return payloads;
}

async function main() {
  if (process.argv.includes('--setup-page')) {
    const saved = await setupPhoneBoxPage();
    console.log(JSON.stringify({ ok: true, page: 'antigravity', ...saved }));
    return;
  }

  if (process.argv.includes('--once')) {
    const res = await pushOnce();
    console.log(JSON.stringify({ ok: true, pushed: Object.keys(res), summary: res['ag-quotas'].items }, null, 2));
    return;
  }

  console.log(`[antigravity-bridge] pushing to ${AGENT_URL} every ${INTERVAL_SEC}s (ttl=${PUSH_TTL_SEC}s)`);
  const tick = async () => {
    try {
      const res = await pushOnce();
      const first = res['ag-quotas'].items.slice(0, 3).map((x) => `${x.label}=${x.value.split(' · ')[0]}`).join(', ');
      console.log(`${new Date().toLocaleTimeString()} pushed: ${first}`);
    } catch (err) {
      console.error(`${new Date().toLocaleTimeString()} push skipped: ${err.message}`);
    }
  };
  await tick();
  setInterval(tick, INTERVAL_SEC * 1000);
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
