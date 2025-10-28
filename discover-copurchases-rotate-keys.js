/**
 * discover-copurchases-rotate-keys.js
 * Versione leggera per test (da eseguire su server / Replit)
 *
 * Metti le tue API keys nella variabile d'ambiente:
 * SOLANATRACKER_API_KEYS="chiave1,chiave2"
 */

const axios = require('axios');
const fs = require('fs');

const BASE = process.env.SOLANATRACKER_BASE || 'https://data.solanatracker.io';
const KEYS_ENV = process.env.SOLANATRACKER_API_KEYS || process.env.SOLANATRACKER_API_KEY || '';
const API_KEYS = KEYS_ENV.split(',').map(k=>k.trim()).filter(Boolean);
if (API_KEYS.length === 0) {
  console.error('Errore: nessuna API key trovata. Imposta SOLANATRACKER_API_KEYS o SOLANATRACKER_API_KEY.');
  process.exit(1);
}
let keyIndex = 0;
function getKey() { const k = API_KEYS[keyIndex % API_KEYS.length]; keyIndex++; return k; }

// CONFIG per test
const TOP_TRADERS_LIMIT = 20;
const LOOKBACK_MS = 1000 * 60 * 30; // 30 minuti
const MIN_WALLETS_FOR_SIGNAL = 3;
const REQUEST_DELAY_MS = 500;

const httpFactory = (apiKey) => axios.create({
  baseURL: BASE,
  headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
  timeout: 25000
});

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function timeNowMs(){ return Date.now(); }

async function doRequest(path, params = {}) {
  const attempts = Math.max(3, API_KEYS.length * 2);
  let lastErr = null;
  for (let i=0;i<attempts;i++) {
    const k = getKey();
    const http = httpFactory(k);
    try {
      const res = await http.get(path, { params });
      return res.data;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 429) await sleep(800 + (i*200));
      else await sleep(300);
    }
  }
  throw lastErr || new Error('Errore in doRequest');
}

async function fetchTopTraders(limit = TOP_TRADERS_LIMIT) {
  const candidates = [
    ['/top-traders/all', { limit }],
    ['/top-traders', { limit }],
    ['/top_traders', { limit }],
    ['/top-traders/top', { limit }],
    ['/traders/top', { limit }]
  ];
  for (const [path, params] of candidates) {
    try {
      const data = await doRequest(path, params);
      if (!data) continue;
      if (Array.isArray(data)) return data;
      if (data.traders && Array.isArray(data.traders)) return data.traders;
      if (data.data && Array.isArray(data.data)) return data.data;
      if (data.items && Array.isArray(data.items)) return data.items;
      if (data.results && Array.isArray(data.results)) return data.results;
    } catch (e) {}
  }
  return [];
}

async function fetchWalletTrades(owner, limit = 200) {
  const candidates = [
    [`/wallet/${owner}/trades`, { limit }],
    [`/wallet/${owner}`, { limit }],
    [`/wallets/${owner}/trades`, { limit }],
    [`/wallets/${owner}`, { limit }]
  ];
  for (const [path, params] of candidates) {
    try {
      const data = await doRequest(path, params);
      if (!data) continue;
      if (Array.isArray(data)) return data;
      if (data.trades && Array.isArray(data.trades)) return data.trades;
      if (data.data && Array.isArray(data.data)) return data.data;
      if (data.items && Array.isArray(data.items)) return data.items;
    } catch (e) {}
  }
  return [];
}

function toMs(t) {
  if (!t) return null;
  if (t > 1e12) return t;
  if (t > 1e9) return t * 1000;
  return null;
}

(async () => {
  try {
    console.log('Fetching top traders...');
    const top = await fetchTopTraders(TOP_TRADERS_LIMIT);
    console.log('Top raw count:', top.length);

    const walletAddresses = top
      .map(t => (t && (t.wallet || t.owner || t.address || t.account || t.pubkey || t.key)) )
      .filter(Boolean);

    console.log('Wallets extracted:', walletAddresses.length);

    const cutoff = timeNowMs() - LOOKBACK_MS;
    const tokenToWallets = {};
    const walletStats = [];

    for (let i=0; i<walletAddresses.length; i++) {
      const w = walletAddresses[i];
      await sleep(REQUEST_DELAY_MS);
      let trades = [];
      try { trades = await fetchWalletTrades(w, 200); } catch(e){ console.warn('fetchWalletTrades error', w); }
      if (!Array.isArray(trades)) trades = [];

      const recentBuys = trades.filter(tr => {
        const t = toMs(tr?.time || tr?.timestamp || tr?.ts);
        if (!t) return false;
        if (t < cutoff) return false;
        const typ = (tr.type || tr.side || tr.direction || '').toString().toLowerCase();
        if (typ) return typ.includes('buy') || typ.includes('receive') || typ.includes('mint') || typ.includes('purchase');
        const amt = Number(tr.amount || tr.amount_token || tr.token_amount || 0);
        return amt > 0;
      });

      walletStats.push({ wallet: w, totalTrades: trades.length, recentBuys: recentBuys.length });

      for (const b of recentBuys) {
        const token = b?.token || b?.mint || b?.tokenAddress || b?.token_address || b?.asset || b?.tokenAddressTo || b?.tokenAddressFrom;
        if (!token) continue;
        if (!tokenToWallets[token]) tokenToWallets[token] = new Set();
        tokenToWallets[token].add(w);
      }
    }

    const candidates = Object.entries(tokenToWallets)
      .map(([token, set]) => ({ token, wallets: Array.from(set), count: set.size }))
      .filter(c => c.count >= MIN_WALLETS_FOR_SIGNAL)
      .sort((a,b) => b.count - a.count);

    const out = {
      generated_at: new Date().toISOString(),
      config: { TOP_TRADERS_LIMIT, LOOKBACK_MS, MIN_WALLETS_FOR_SIGNAL },
      walletStats,
      candidates
    };

    fs.writeFileSync('copurchase_signals.json', JSON.stringify(out, null, 2));
    console.log('Saved copurchase_signals.json — candidates:', candidates.length);

    const csvLines = ['token,count,wallets'];
    for (const c of candidates) csvLines.push(`${c.token},${c.count},"${c.wallets.join(' ')}"`);
    fs.writeFileSync('copurchase_signals.csv', csvLines.join('\n'));
    console.log('Saved copurchase_signals.csv');

    console.table(candidates.slice(0, 30).map(c => ({ token: c.token, count: c.count })));
    console.log('Done.');
  } catch (e) {
    console.error('Errore principale:', e.message || e);
    process.exit(1);
  }
})();
