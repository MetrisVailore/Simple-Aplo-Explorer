/* ========================================
   AploCoin Explorer - Professional Edition
   Live updates, ERC-20, themes, charts
   ======================================== */

// ========================================
// Cache System
// ========================================
class LRUCache {
    constructor(maxSize = 500, defaultTTL = 60000) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.defaultTTL = defaultTTL;
        this.hits = 0;
        this.misses = 0;
    }

    get(key) {
        if (this.cache.has(key)) {
            const entry = this.cache.get(key);
            if (Date.now() - entry.timestamp < entry.ttl) {
                this.cache.delete(key);
                this.cache.set(key, entry);
                this.hits++;
                return entry.value;
            }
            this.cache.delete(key);
        }
        this.misses++;
        return null;
    }

    set(key, value, ttl) {
        if (this.cache.has(key)) this.cache.delete(key);
        else if (this.cache.size >= this.maxSize) {
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, { value, timestamp: Date.now(), ttl: ttl || this.defaultTTL });
    }

    has(key) {
        if (this.cache.has(key)) {
            const entry = this.cache.get(key);
            return Date.now() - entry.timestamp < entry.ttl;
        }
        return false;
    }

    clear() { this.cache.clear(); }

    getStats() {
        return {
            size: this.cache.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: this.hits + this.misses > 0
                ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(1) + '%'
                : '0%'
        };
    }
}

// ========================================
// Request Deduplicator
// ========================================
class RequestDeduplicator {
    constructor() { this.pending = new Map(); }
    async dedupe(key, fn) {
        if (this.pending.has(key)) return this.pending.get(key);
        const promise = fn().finally(() => this.pending.delete(key));
        this.pending.set(key, promise);
        return promise;
    }
}

// ========================================
// Global State
// ========================================
let provider = null;
let currentPage = 'dashboard';
let blocksPerPage = 20;
let txsPerPage = 20;
let blocksPage = 1;
let txsPage = 1;
let tokenTransfersPage = 1;
let isLoading = false;
let lastRefreshTime = 0;
let currentBlockNumber = 0;
let previousBlockNumber = 0;

// Keep the explorer responsive while still looking far enough back to find
// activity on low-volume networks. These are deliberately separate: headers
// are cheap, full transactions are not.
const HISTORY = Object.freeze({
    dashboardTransactionBlocks: 10_000,
    dashboardTransferBlocks: 10_000,
    transactionsBlocks: 50_000,
    transfersBlocks: 100_000,
    validatorsBlocks: 5_000,
    validatorSamples: 500,
    transferLogChunk: 250,
    transferLogMaxChunk: 2_000,
    transactionBlockChunk: 500,
    dashboardItems: 25,
    transferPageSize: 20
});

// ERC-20 Transfer event signature
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// APLO ERC-20 Token (special contract address)
const APLO_TOKEN_ADDRESS = '0x0000000000000000000000000000000000001235';
const KNOWN_TOKEN_METADATA = Object.freeze({
    '0x0000000000000000000000000000000000001234': { name: 'GAPLO', symbol: 'Gas Aplo', decimals: 18 },
    '0x0000000000000000000000000000000000001235': { name: 'Aplo native', symbol: 'APLO', decimals: 18 }
});

// ERC-20 balanceOf(address) function selector: 0x70a08231
async function getTokenBalance(tokenAddress, walletAddress) {
    try {
        const data = '0x70a08231' + walletAddress.slice(2).toLowerCase().padStart(64, '0');
        const rpcUrl = provider?.connection?.url || 'https://pub1.aplocoin.com';
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'eth_call',
                params: [{ to: tokenAddress, data: data }, 'latest'],
                id: 1
            })
        });
        const result = await response.json();
        if (result.result && result.result !== '0x') {
            return ethers.BigNumber.from(result.result);
        }
        return ethers.BigNumber.from(0);
    } catch (error) {
        console.warn('Failed to fetch token balance:', error);
        return ethers.BigNumber.from(0);
    }
}

function decodeTokenText(result) {
    if (!result || result === '0x') return null;
    try {
        return ethers.utils.defaultAbiCoder.decode(['string'], result)[0].trim() || null;
    } catch (_) {
        try { return ethers.utils.parseBytes32String(result).trim() || null; } catch (_) { return null; }
    }
}

const tokenMetadataCache = new LRUCache(2_000, 24 * 60 * 60 * 1000);

// Resolve name, symbol, and decimals in one JSON-RPC batch. Results are keyed
// by request id because JSON-RPC is allowed to return a batch out of order.
async function getTokenMetadataBatch(tokenAddresses) {
    const unique = [...new Set(tokenAddresses.filter(Boolean).map(a => a.toLowerCase()))];
    if (!provider || unique.length === 0) return new Map();
    const metadata = new Map();
    const missing = [];
    unique.forEach(address => {
        const known = KNOWN_TOKEN_METADATA[address];
        const cached = tokenMetadataCache.get(`token_meta_${address}`);
        if (known || cached) metadata.set(address, known || cached);
        else missing.push(address);
    });
    if (!missing.length) return metadata;

    const MAX_RETRIES = 2;
    const rpcUrl = provider?.connection?.url || 'https://pub1.aplocoin.com';
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        if (retry > 0) await new Promise(r => setTimeout(r, 100 * retry));
        const rpcBatch = missing.flatMap((tokenAddr, index) => [
            { jsonrpc: '2.0', method: 'eth_call', params: [{ to: tokenAddr, data: '0x06fdde03' }, 'latest'], id: index * 3 },
            { jsonrpc: '2.0', method: 'eth_call', params: [{ to: tokenAddr, data: '0x95d89b41' }, 'latest'], id: index * 3 + 1 },
            { jsonrpc: '2.0', method: 'eth_call', params: [{ to: tokenAddr, data: '0x313ce567' }, 'latest'], id: index * 3 + 2 }
        ]);
        try {
            const response = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rpcBatch)
            });
            const results = await response.json();
            if (Array.isArray(results)) {
                const byId = new Map(results.map(result => [Number(result.id), result]));
                missing.forEach((address, index) => {
                    const name = decodeTokenText(byId.get(index * 3)?.result);
                    const symbol = decodeTokenText(byId.get(index * 3 + 1)?.result);
                    let decimals = 18;
                    try {
                        const value = ethers.BigNumber.from(byId.get(index * 3 + 2)?.result || '0x12').toNumber();
                        if (value >= 0 && value <= 36) decimals = value;
                    } catch (_) {}
                    const entry = { name: name || symbol || `Token ${address.slice(0, 6)}…${address.slice(-4)}`, symbol: symbol || name || 'TOKEN', decimals };
                    tokenMetadataCache.set(`token_meta_${address}`, entry);
                    metadata.set(address, entry);
                });
                return metadata;
            }
        } catch (error) {
            if (retry === MAX_RETRIES) {
                console.warn('Failed to batch fetch token names:', error);
            }
        }
    }
    missing.forEach(address => metadata.set(address, { name: `Token ${address.slice(0, 6)}…${address.slice(-4)}`, symbol: 'TOKEN', decimals: 18 }));
    return metadata;
}

// Batch fetch multiple ERC-20 token balances (single HTTP request)
async function getTokenBalancesBatch(tokenAddresses, walletAddress) {
    if (!provider || tokenAddresses.length === 0) return [];
    const MAX_RETRIES = 2;
    const rpcUrl = provider?.connection?.url || 'https://pub1.aplocoin.com';
    const addrData = '0x70a08231' + walletAddress.slice(2).toLowerCase().padStart(64, '0');
    
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        if (retry > 0) await new Promise(r => setTimeout(r, 100 * retry));
        
        const rpcBatch = tokenAddresses.map((tokenAddr, idx) => ({
            jsonrpc: '2.0',
            method: 'eth_call',
            params: [{ to: tokenAddr, data: addrData }, 'latest'],
            id: idx
        }));
        
        try {
            const response = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rpcBatch)
            });
            const results = await response.json();
            if (Array.isArray(results) && results.length === tokenAddresses.length) {
                const byId = new Map(results.map(result => [Number(result.id), result]));
                return tokenAddresses.map((_, index) => {
                    const res = byId.get(index);
                    if (res.result && res.result !== '0x') {
                        return ethers.BigNumber.from(res.result);
                    }
                    return ethers.BigNumber.from(0);
                });
            }
        } catch (error) {
            if (retry === MAX_RETRIES) {
                console.warn('Failed to batch fetch token balances after retries:', error);
            }
        }
    }
    return tokenAddresses.map(() => ethers.BigNumber.from(0));
}



// Rate Limiter - prevents flooding the RPC node
class RateLimiter {
    constructor(minIntervalMs = 200) {
        this.minInterval = minIntervalMs;
        this.lastCall = 0;
        this.queue = [];
        this.processing = false;
    }
    async throttle() {
        const now = Date.now();
        const elapsed = now - this.lastCall;
        if (elapsed < this.minInterval) {
            await new Promise(r => setTimeout(r, this.minInterval - elapsed));
        }
        this.lastCall = Date.now();
    }
}
const rateLimiter = new RateLimiter(150); // 150ms between calls

// Cache instances
const blockCache = new LRUCache(300, 60000);    // 60s TTL - longer since blocks are immutable
const txCache = new LRUCache(500, 120000);      // 120s TTL
const balanceCache = new LRUCache(200, 30000);  // 30s TTL
const statsCache = new LRUCache(10, 15000);
const viewCache = new LRUCache(80, 30000);      // Short-lived rendered-data snapshots
const deduplicator = new RequestDeduplicator();

async function getCachedView(key, loader, ttl = 30000) {
    const cached = viewCache.get(key);
    if (cached) return cached;
    return deduplicator.dedupe(`view_${key}`, async () => {
        const fresh = await loader();
        viewCache.set(key, fresh, ttl);
        return fresh;
    });
}

// Chart data arrays
let blockTimeData = [];
let difficultyData = [];
let gasPriceData = [];
let gasUsageData = [];
let gasPriceHistory = [];
const DEFAULT_CHART_BLOCKS = 21;
const chartTimeframes = { blockTime: DEFAULT_CHART_BLOCKS, difficulty: DEFAULT_CHART_BLOCKS, gasPrice: DEFAULT_CHART_BLOCKS, gasUsage: DEFAULT_CHART_BLOCKS };
const chartRequestVersions = { blockTime: 0, difficulty: 0, gasPrice: 0, gasUsage: 0 };
const MAX_CHART_SAMPLES = 480;



// Chart hover state per canvas
let chartStates = {};
let chartResizeObserver = null;
let chartResizeFrame = null;

// Shared chart configurations (single source of truth)
const CHARTS = [
    { id: 'blockTimeChart', getData: () => blockTimeData, color: '#3b82f6', colorLight: '#2563eb', fill: 'rgba(59,130,246,0.1)', fillLight: 'rgba(37,99,235,0.08)', tip: d => `Block #${d.block} — ${d.value.toFixed(1)}s` },
    { id: 'difficultyChart', getData: () => difficultyData, color: '#a855f7', colorLight: '#9333ea', fill: 'rgba(168,85,247,0.1)', fillLight: 'rgba(147,51,234,0.08)', tip: d => `Block #${d.block} — ${formatLargeNumber(d.value)}`, vfn: v => formatLargeNumber(v) },
    { id: 'gasPriceChart', getData: () => gasPriceData, color: '#22c55e', colorLight: '#16a34a', fill: 'rgba(34,197,94,0.1)', fillLight: 'rgba(22,163,74,0.08)', tip: d => `Block #${d.block} — ${d.value.toFixed(2)} Gwei` },
    { id: 'gasUsageChart', getData: () => gasUsageData, color: '#f59e0b', colorLight: '#d97706', fill: 'rgba(245,158,11,0.1)', fillLight: 'rgba(217,119,6,0.08)', tip: d => `Block #${d.block} — ${d.value.toFixed(2)}%` }
];

function renderAllCharts() {
    CHARTS.forEach(c => {
        const data = c.getData();
        if (data && data.length > 1) {
            drawInteractiveChart(c.id, data, { color: c.color, colorLight: c.colorLight, fillColor: c.fill, fillColorLight: c.fillLight, tooltipFn: c.tip, valueFn: c.vfn });
        }
    });
}

// Animated counter state
let animatedValues = {};

// ========================================
// Cached RPC Helpers
// ========================================
async function getBlockCached(num) {
    const k = `block_${num}`;
    const c = blockCache.get(k);
    if (c) return c;
    return deduplicator.dedupe(k, async () => {
        await rateLimiter.throttle();
        const b = await provider.getBlock(num);
        if (b) blockCache.set(k, b, 60000);
        return b;
    });
}

async function getBlockWithTxsCached(num) {
    const k = `blockTxs_${num}`;
    const c = blockCache.get(k);
    if (c) return c;
    return deduplicator.dedupe(k, async () => {
        await rateLimiter.throttle();
        const b = await provider.getBlockWithTransactions(num);
        if (b) blockCache.set(k, b, 60000);
        return b;
    });
}

async function getTxCached(hash) {
    const k = `tx_${hash}`;
    const c = txCache.get(k);
    if (c) return c;
    return deduplicator.dedupe(k, async () => {
        await rateLimiter.throttle();
        const tx = await provider.getTransaction(hash);
        if (tx) txCache.set(k, tx, 120000);
        return tx;
    });
}

async function getReceiptCached(hash) {
    const k = `receipt_${hash}`;
    const c = txCache.get(k);
    if (c) return c;
    return deduplicator.dedupe(k, async () => {
        await rateLimiter.throttle();
        const r = await provider.getTransactionReceipt(hash);
        if (r) txCache.set(k, r, 120000);
        return r;
    });
}

async function getBalanceCached(addr) {
    const k = `bal_${addr.toLowerCase()}`;
    const c = balanceCache.get(k);
    if (c) return c;
    return deduplicator.dedupe(k, async () => {
        await rateLimiter.throttle();
        const b = await provider.getBalance(addr);
        balanceCache.set(k, b, 30000);
        return b;
    });
}

// ========================================
// Parallel Batch Loader
// ========================================
async function parallelBatch(items, fn, concurrency = 10) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkResults = await Promise.allSettled(chunk.map(fn));
        results.push(...chunkResults);
    }
    return results;
}

// ========================================
// JSON-RPC Batch Fetching (Single HTTP Request)
// ========================================
const blockBatchCache = new Map(); // Simple in-memory cache for batch results
const MAX_CACHE_SIZE = 4_096;
const blockWithTransactionsBatchCache = new LRUCache(2_000, 120000);
const PERSISTED_CACHE_KEY = 'aplo-explorer-test-cache-v1';
const PERSISTED_CACHE_TTL = 15 * 60 * 1000;

function restorePersistentCaches() {
    try {
        const saved = JSON.parse(localStorage.getItem(PERSISTED_CACHE_KEY) || 'null');
        if (!saved || saved.expiresAt <= Date.now()) return;
        (saved.blocks || []).forEach(([key, value]) => blockBatchCache.set(key, value));
        (saved.transactionBlocks || []).forEach(([key, value]) => blockWithTransactionsBatchCache.set(key, value, PERSISTED_CACHE_TTL));
        (saved.tokenMetadata || []).forEach(([key, value]) => tokenMetadataCache.set(key, value, PERSISTED_CACHE_TTL));
    } catch (error) {
        console.warn('Persistent cache restore skipped:', error);
    }
}

function persistCaches() {
    try {
        // Keep the browser cache compact: immutable headers cover the common
        // refresh path; only a small recent set of full blocks is retained.
        const payload = {
            expiresAt: Date.now() + PERSISTED_CACHE_TTL,
            blocks: Array.from(blockBatchCache.entries()).slice(-1_200),
            transactionBlocks: Array.from(blockWithTransactionsBatchCache.cache.entries()).slice(-200).map(([key, entry]) => [key, entry.value]),
            tokenMetadata: Array.from(tokenMetadataCache.cache.entries()).slice(-300).map(([key, entry]) => [key, entry.value])
        };
        localStorage.setItem(PERSISTED_CACHE_KEY, JSON.stringify(payload));
    } catch (error) {
        // Quota failures must never block the live explorer.
        console.warn('Persistent cache save skipped:', error);
    }
}

async function fetchBlocksBatch(blockNumbers, includeTransactions = false, onProgress = null) {
    if (!provider || blockNumbers.length === 0) return [];

    if (includeTransactions) {
        const cached = [];
        const toFetch = [];
        for (const number of blockNumbers) {
            const block = blockWithTransactionsBatchCache.get(`block_txs_${number}`);
            cached.push(block);
            if (!block) toFetch.push(number);
        }
        if (toFetch.length === 0) return cached;

        const fetched = await fetchBlocksBatchRaw(toFetch, true, onProgress);
        let fetchedIndex = 0;
        return cached.map(block => {
            if (block) return block;
            const fetchedBlock = fetched[fetchedIndex++];
            if (fetchedBlock) blockWithTransactionsBatchCache.set(`block_txs_${fetchedBlock.number}`, fetchedBlock);
            return fetchedBlock;
        });
    }
    
    // Check cache first (only for non-transaction requests)
    if (!includeTransactions) {
        const cached = [];
        const toFetch = [];
        for (const num of blockNumbers) {
            const cacheKey = `block_${num}`;
            if (blockBatchCache.has(cacheKey)) {
                cached.push(blockBatchCache.get(cacheKey));
            } else {
                cached.push(null);
                toFetch.push(num);
            }
        }
        
        // If all blocks are cached, return immediately
        if (toFetch.length === 0) return cached;
        
        // Fetch missing blocks in batch
        const fetched = await fetchBlocksBatchRaw(toFetch, false);
        
        // Merge results and update cache
        const result = [];
        let fetchIdx = 0;
        for (let i = 0; i < blockNumbers.length; i++) {
            if (cached[i]) {
                result.push(cached[i]);
            } else {
                const block = fetched[fetchIdx++];
if (block) {
                    blockBatchCache.set(`block_${block.number}`, block);
                    if (blockBatchCache.size > MAX_CACHE_SIZE) {
                        const firstKey = blockBatchCache.keys().next().value;
                        blockBatchCache.delete(firstKey);
                    }
                }
                result.push(block);
            }
        }
        return result;
    }
    
    return fetchBlocksBatchRaw(blockNumbers, includeTransactions, onProgress);
}

async function fetchBlocksBatchRaw(blockNumbers, includeTransactions = false, onProgress = null) {
    const BATCH_SIZE = 250;
    const MAX_RETRIES = 2;
    const totalBlocks = blockNumbers.length;

    const batches = [];
    for (let index = 0; index < blockNumbers.length; index += BATCH_SIZE) {
        batches.push(blockNumbers.slice(index, index + BATCH_SIZE));
    }
    let completed = 0;
    const settledBatches = await parallelBatch(batches, async batch => {
        let batchResults = null;
        for (let retry = 0; retry <= MAX_RETRIES && !batchResults; retry++) {
            if (retry > 0) await new Promise(r => setTimeout(r, 100 * retry));
            const rpcBatch = batch.map((num, idx) => ({
                jsonrpc: '2.0',
                method: 'eth_getBlockByNumber',
                params: ['0x' + num.toString(16), includeTransactions],
                id: idx
            }));
            
            try {
                const rpcUrl = provider?.connection?.url || 'https://pub1.aplocoin.com';
                const response = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(rpcBatch)
                });
                const results = await response.json();
                
                if (Array.isArray(results)) {
                    const byId = new Map(results.map(result => [Number(result.id), result]));
                    batchResults = batch.map((_, index) => {
                        const res = byId.get(index) || {};
                        if (res.result) {
                            return {
                                number: parseInt(res.result.number, 16),
                                timestamp: parseInt(res.result.timestamp, 16),
                                transactions: res.result.transactions || [],
                                gasUsed: res.result.gasUsed ? parseInt(res.result.gasUsed, 16) : 0,
                                gasLimit: res.result.gasLimit ? parseInt(res.result.gasLimit, 16) : 0,
                                miner: res.result.miner || 'Unknown',
                                difficulty: res.result.difficulty ? parseInt(res.result.difficulty, 16) : 0,
                                baseFeePerGas: res.result.baseFeePerGas ? parseInt(res.result.baseFeePerGas, 16) : null
                            };
                        }
                        return null;
                    });
                }
            } catch (error) {
                if (retry === MAX_RETRIES) {
                    console.warn(`Batch fetch failed for blocks ${batch[0]}-${batch[batch.length-1]}:`, error);
                }
            }
        }
        completed += batch.length;
        if (onProgress) onProgress(completed, totalBlocks);
        return batchResults || batch.map(() => null);
    }, includeTransactions ? 4 : 6);

    return settledBatches.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

// Search transaction-bearing blocks progressively. On this chain most blocks
// are empty, so stopping as soon as a page is full avoids paying to hydrate an
// entire historical range on every page load.
async function findRecentTransactions(latestBlock, wanted, maxBlocks, matches = null) {
    const results = [];
    const earliest = Math.max(0, latestBlock - maxBlocks + 1);
    let toBlock = latestBlock;

    while (toBlock >= earliest && results.length < wanted) {
        const fromBlock = Math.max(earliest, toBlock - HISTORY.transactionBlockChunk + 1);
        const blockNumbers = [];
        for (let block = toBlock; block >= fromBlock; block--) blockNumbers.push(block);
        // Headers contain only transaction hashes. Full transaction objects
        // are fetched only for the few blocks that are not empty.
        const headers = await fetchBlocksBatch(blockNumbers, false);
        const candidateNumbers = headers.filter(block => block?.transactions?.length).map(block => block.number);
        const blocks = candidateNumbers.length ? await fetchBlocksBatch(candidateNumbers, true) : [];
        for (const block of blocks) {
            if (!block?.transactions?.length) continue;
            for (const transaction of block.transactions.slice().reverse()) {
                if (!matches || matches(transaction)) {
                    results.push({ ...transaction, blockNumber: block.number, blockTimestamp: block.timestamp });
                    if (results.length >= wanted) break;
                }
            }
            if (results.length >= wanted) break;
        }
        toBlock = fromBlock - 1;
    }
    return results;
}

// Batch fetch transaction receipts (single HTTP request)
async function fetchReceiptsBatch(txHashes) {
    if (!provider || txHashes.length === 0) return [];
    const BATCH_SIZE = Math.min(250, Math.max(50, Math.ceil(txHashes.length / 8)));
    const MAX_RETRIES = 2;
    const allReceipts = [];
    const rpcUrl = provider?.connection?.url || 'https://pub1.aplocoin.com';
    
    for (let i = 0; i < txHashes.length; i += BATCH_SIZE) {
        const batch = txHashes.slice(i, i + BATCH_SIZE);
        let batchResults = null;
        
        for (let retry = 0; retry <= MAX_RETRIES && !batchResults; retry++) {
            if (retry > 0) await new Promise(r => setTimeout(r, 100 * retry));
            
            const rpcBatch = batch.map((hash, idx) => ({
                jsonrpc: '2.0',
                method: 'eth_getTransactionReceipt',
                params: [hash],
                id: idx
            }));
            
            try {
                const response = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(rpcBatch)
                });
                const results = await response.json();
                if (Array.isArray(results)) {
                    const byId = new Map(results.map(result => [Number(result.id), result]));
                    batchResults = batch.map((_, index) => byId.get(index)?.result || null);
                }
            } catch (error) {
                if (retry === MAX_RETRIES) {
                    console.warn(`Receipt batch fetch failed after ${MAX_RETRIES + 1} attempts:`, error);
                }
            }
        }
        
        if (batchResults) {
            allReceipts.push(...batchResults);
        } else {
            batch.forEach(() => allReceipts.push(null));
        }
    }
    return allReceipts;
}

// ========================================
// eth_getLogs for efficient ERC-20 transfer discovery (single RPC call for 100k+ blocks)
// ========================================
async function fetchLogsByAddress(address, fromBlock, toBlock) {
    if (!provider) return [];
    const MAX_RETRIES = 2;
    const rpcUrl = provider?.connection?.url || 'https://pub1.aplocoin.com';
    const addrPadded = '0x' + address.slice(2).toLowerCase().padStart(64, '0');
    
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        if (retry > 0) await new Promise(r => setTimeout(r, 200 * retry));
        
        const rpcBatch = [
            {
                jsonrpc: '2.0',
                method: 'eth_getLogs',
                params: [{
                    fromBlock: '0x' + fromBlock.toString(16),
                    toBlock: '0x' + toBlock.toString(16),
                    topics: [TRANSFER_TOPIC, null, addrPadded]
                }],
                id: 0
            },
            {
                jsonrpc: '2.0',
                method: 'eth_getLogs',
                params: [{
                    fromBlock: '0x' + fromBlock.toString(16),
                    toBlock: '0x' + toBlock.toString(16),
                    topics: [TRANSFER_TOPIC, addrPadded, null]
                }],
                id: 1
            }
        ];
        
        try {
            const response = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rpcBatch)
            });
            const results = await response.json();
            const allLogs = [];
            if (Array.isArray(results)) {
                for (const res of results) {
                    if (res.result && Array.isArray(res.result)) {
                        allLogs.push(...res.result);
                    }
                }
            }
            return allLogs;
        } catch (error) {
            if (retry === MAX_RETRIES) {
                console.warn('eth_getLogs failed after retries:', error);
            }
        }
    }
    return [];
}

// Fetch Transfer logs directly instead of reading every transaction receipt.
// This is substantially cheaper and also finds transfers in otherwise quiet
// blocks, which the old receipt scan skipped.
async function fetchTransferLogs(fromBlock, toBlock) {
    if (!provider || fromBlock > toBlock) return [];
    const rpcUrl = provider?.connection?.url || 'https://pub1.aplocoin.com';
    const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_getLogs',
            params: [{
                fromBlock: '0x' + fromBlock.toString(16),
                toBlock: '0x' + toBlock.toString(16),
                topics: [TRANSFER_TOPIC]
            }],
            id: 1
        })
    });
    if (!response.ok) throw new Error(`eth_getLogs failed (${response.status})`);
    const result = await response.json();
    if (result.error) throw new Error(result.error.message || 'eth_getLogs failed');
    return Array.isArray(result.result) ? result.result : [];
}

async function fetchTransferLogsResilient(fromBlock, toBlock) {
    try {
        return await fetchTransferLogs(fromBlock, toBlock);
    } catch (error) {
        // Some nodes enforce a result cap. Split only the failed range so the
        // normal case remains one request per chunk.
        if (fromBlock >= toBlock) {
            console.warn(`Transfer scan failed for block ${fromBlock}:`, error);
            return [];
        }
        const midpoint = Math.floor((fromBlock + toBlock) / 2);
        const [older, newer] = await Promise.all([
            fetchTransferLogsResilient(fromBlock, midpoint),
            fetchTransferLogsResilient(midpoint + 1, toBlock)
        ]);
        return older.concat(newer);
    }
}

async function findRecentTransfers(latestBlock, wanted, maxBlocks) {
    const earliest = Math.max(0, latestBlock - maxBlocks + 1);
    const transfers = [];
    let toBlock = latestBlock;
    let chunkSize = HISTORY.transferLogChunk;

    while (toBlock >= earliest && transfers.length < wanted) {
        const fromBlock = Math.max(earliest, toBlock - chunkSize + 1);
        const logs = await fetchTransferLogsResilient(fromBlock, toBlock);
        for (const log of logs) {
            const transfer = parseTransferLog(log);
            if (transfer) transfers.push(transfer);
        }
        chunkSize = logs.length ? HISTORY.transferLogChunk : Math.min(HISTORY.transferLogMaxChunk, chunkSize * 2);
        toBlock = fromBlock - 1;
    }

    return transfers.sort((a, b) => {
        const blockDiff = b.blockNumber - a.blockNumber;
        if (blockDiff) return blockDiff;
        return Number.parseInt(b.logIndex || '0x0', 16) - Number.parseInt(a.logIndex || '0x0', 16);
    }).slice(0, wanted);
}

async function addTransferMetadata(transfers) {
    const metadata = await getTokenMetadataBatch(transfers.map(transfer => transfer.contractAddress));
    return transfers.map(transfer => ({
        ...transfer,
        token: metadata.get(transfer.contractAddress.toLowerCase())
    }));
}

async function addTransferTimestamps(transfers) {
    const blockNumbers = [...new Set(transfers.map(t => t.blockNumber))];
    if (!blockNumbers.length) return transfers;
    const blocks = await fetchBlocksBatch(blockNumbers, false);
    const timestamps = new Map(blocks.filter(Boolean).map(block => [block.number, block.timestamp]));
    return transfers.map(transfer => ({ ...transfer, blockTimestamp: timestamps.get(transfer.blockNumber) }));
}

function buildEvenlySpacedBlockNumbers(latestBlock, span, samples) {
    const count = Math.min(span, samples);
    if (count <= 1) return [latestBlock];
    const numbers = [];
    const maxOffset = span - 1;
    for (let index = 0; index < count; index++) {
        numbers.push(latestBlock - Math.round((index * maxOffset) / (count - 1)));
    }
    return [...new Set(numbers)].filter(number => number >= 0);
}

// ========================================
// Theme Management
// ========================================
function initTheme() {
    const saved = localStorage.getItem('aplo-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon(saved);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('aplo-theme', next);
    updateThemeIcon(next);
}

function updateThemeIcon(theme) {
    const icon = document.getElementById('themeIcon');
    if (icon) {
        icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    }
    // Redraw all charts with new theme colors
    if (blockTimeData.length > 0) {
        requestAnimationFrame(() => renderAllCharts());
    }
}

// ========================================
// Initialize
// ========================================
function getRouteState() {
    const params = new URLSearchParams(window.location.search);
    const page = params.get('page') || 'dashboard';
    const allowedPages = new Set(['dashboard', 'blocks', 'transactions', 'token-transfers', 'validators', 'block-detail', 'tx-detail', 'address']);
    return {
        page: allowedPages.has(page) ? page : 'dashboard',
        data: params.get('id') || undefined,
        blocksPage: Math.max(1, Number.parseInt(params.get('blocksPage'), 10) || 1),
        txsPage: Math.max(1, Number.parseInt(params.get('txsPage'), 10) || 1),
        tokenTransfersPage: Math.max(1, Number.parseInt(params.get('tokenTransfersPage'), 10) || 1)
    };
}

function syncRouteState(mode = 'replace') {
    const params = new URLSearchParams();
    if (currentPage !== 'dashboard') params.set('page', currentPage);
    if (currentPage === 'blocks' && blocksPage > 1) params.set('blocksPage', blocksPage);
    if (currentPage === 'transactions' && txsPage > 1) params.set('txsPage', txsPage);
    if (currentPage === 'token-transfers' && tokenTransfersPage > 1) params.set('tokenTransfersPage', tokenTransfersPage);
    if (['block-detail', 'tx-detail', 'address'].includes(currentPage) && window.__routeData) params.set('id', window.__routeData);

    const query = params.toString();
    const url = `${window.location.pathname}${query ? '?' + query : ''}`;
    history[mode === 'push' ? 'pushState' : 'replaceState']({ page: currentPage }, '', url);
}

function restoreRouteFromUrl() {
    const route = getRouteState();
    currentPage = route.page;
    window.__routeData = route.data;
    blocksPage = route.blocksPage;
    txsPage = route.txsPage;
    tokenTransfersPage = route.tokenTransfersPage;
}

async function init() {
    initTheme();
    restorePersistentCaches();
    const initialRoute = getRouteState();
    if (initialRoute.page !== 'dashboard') document.querySelector('.hero')?.classList.add('page-hidden');

    try {
        provider = new ethers.providers.JsonRpcProvider('https://pub1.aplocoin.com');
        const blockNumber = await provider.getBlockNumber();
        currentBlockNumber = blockNumber;
        previousBlockNumber = blockNumber;
        updateConnectionStatus(true, 'Connected');

        // Restore a shareable/refresh-safe route before loading data.
        restoreRouteFromUrl();
        navigateTo(currentPage, window.__routeData, { replaceHistory: true, scroll: false });
        startLiveUpdates();
        startBackgroundPreloader();
        initTimeframeHandlers();
        initChartResizeObserver();

        // Auto-refresh dashboard
        setInterval(() => {
            if (currentPage === 'dashboard' && Date.now() - lastRefreshTime > 25000) {
                loadDashboard();
            }
        }, 30000); // Every 30s (reduced from 15s)

        // Update cache stats
        setInterval(updateCacheStats, 5000);

        console.log('AploCoin Explorer initialized. Latest block:', blockNumber);
    } catch (error) {
        console.error('Failed to connect:', error);
        updateConnectionStatus(false, 'Connection failed');
        showToast('Failed to connect to AploCoin node');
    }
}

// ========================================
// Live Updates (WebSocket-like via polling)
// ========================================
function startLiveUpdates() {
    setInterval(async () => {
        try {
            const latest = await provider.getBlockNumber();
            if (latest > currentBlockNumber) {
                previousBlockNumber = currentBlockNumber;
                currentBlockNumber = latest;
                updateBlockDelta(latest - previousBlockNumber);

                // Show live toast
                showLiveToast(`New block #${latest} detected`);

                // Update hero stats
                document.getElementById('heroBlocks').textContent = latest.toLocaleString();

                // If on dashboard, refresh
                if (currentPage === 'dashboard') {
                    loadDashboard();
                }
            }
        } catch (e) {
            // Silent fail for live updates
        }
    }, 12000); // Check every 12 seconds (reduced from 4s to be gentler on the node)
}

function updateBlockDelta(delta) {
    const badge = document.getElementById('blockDelta');
    if (badge) {
        badge.textContent = '+' + delta;
        badge.style.animation = 'none';
        badge.offsetHeight; // trigger reflow
        badge.style.animation = 'fadeIn 0.3s ease';
    }
}

function showLiveToast(message) {
    const toast = document.getElementById('liveToast');
    document.getElementById('liveToastMessage').textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// ========================================
// Background Preloader
// ========================================
function startBackgroundPreloader() {
    setInterval(async () => {
        try {
            await rateLimiter.throttle();
            const latest = await provider.getBlockNumber();
            // Preload next 3 blocks only (reduced from 5)
            for (let i = 1; i <= 3; i++) {
                getBlockCached(latest - i).catch(() => {});
                getBlockWithTxsCached(latest - i).catch(() => {});
            }
        } catch (e) {}
    }, 20000); // Every 20s (reduced from 8s)
}

// ========================================
// Connection Status
// ========================================
function updateConnectionStatus(connected, text) {
    const dot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    if (dot) dot.classList.toggle('connected', connected);
    if (statusText) statusText.textContent = text;
}

// ========================================
// Cache Stats
// ========================================
function updateCacheStats() {
    const el = document.getElementById('cacheStats');
    if (!el) return;
    const bs = blockCache.getStats();
    const ts = txCache.getStats();
    el.innerHTML = `
        <span title="Block cache: ${bs.size} items"><i class="fas fa-database"></i> Blocks: ${bs.hitRate}</span>
        <span title="Tx cache: ${ts.size} items"><i class="fas fa-database"></i> Txs: ${ts.hitRate}</span>
    `;
}

// ========================================
// Navigation
// ========================================
let navTimeout = null;
function navigateTo(page, data, options = {}) {
    if (navTimeout) return;
    navTimeout = setTimeout(() => { navTimeout = null; }, 80);

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`page-${page}`);
    if (target) target.classList.add('active');

    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
        if (link.dataset.page === page ||
            (link.dataset.page === 'blocks' && page === 'block-detail') ||
            (link.dataset.page === 'transactions' && page === 'tx-detail')) {
            link.classList.add('active');
        }
    });

    document.getElementById('mainNav').classList.remove('mobile-open');
    currentPage = page;
    const hero = document.querySelector('.hero');
    if (hero) hero.classList.toggle('page-hidden', page !== 'dashboard');
    window.__routeData = data;
    syncRouteState(options.replaceHistory ? 'replace' : 'push');

    // Update breadcrumb
    const bc = document.getElementById('breadcrumbBar');
    const bcText = document.getElementById('breadcrumbCurrent');
    if (bc && bcText) {
        const pageNames = {
            'dashboard': 'Dashboard',
            'blocks': 'Blocks',
            'transactions': 'Transactions',
            'token-transfers': 'Token Transfers',
            'validators': 'Validators',
            'block-detail': 'Block #' + data,
            'tx-detail': 'Transaction',
            'address': 'Address'
        };
        bcText.textContent = pageNames[page] || page;
        bc.style.display = page === 'dashboard' ? 'none' : 'block';
    }

    switch (page) {
        case 'dashboard': loadDashboard(); break;
        case 'blocks': loadBlocks(); break;
        case 'transactions': loadTransactions(); break;
        case 'token-transfers': loadTokenTransfers(); break;
        case 'validators': loadValidators(); break;
        case 'block-detail': loadBlockDetail(data); break;
        case 'tx-detail': loadTxDetail(data); break;
        case 'address': loadAddressDetail(data); break;
    }

    if (options.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.addEventListener('popstate', () => {
    if (!provider) return;
    restoreRouteFromUrl();
    navigateTo(currentPage, window.__routeData, { replaceHistory: true });
});

function toggleMobileMenu() {
    document.getElementById('mainNav').classList.toggle('mobile-open');
}

// ========================================
// Dashboard
// ========================================
async function loadDashboard() {
    if (isLoading) return;
    isLoading = true;
    lastRefreshTime = Date.now();

    try {
        // Rate limit initial calls
        await rateLimiter.throttle();
        const blockNumber = await provider.getBlockNumber();
        await rateLimiter.throttle();
        const [gasPrice, peerCount] = await Promise.all([
            provider.getGasPrice().catch(() => ethers.BigNumber.from(0)),
            provider.send('net_peerCount', []).catch(() => '0x0')
        ]);

        // Keep independent dashboard sections off the critical path. The
        // transaction scan and log query start together while headers/charts
        // are being rendered, instead of making the page wait for each one.
        const recentTransactionsPromise = findRecentTransactions(
            blockNumber,
            HISTORY.dashboardItems + 1,
            HISTORY.dashboardTransactionBlocks
        );
        loadRecentTokenTransfers(blockNumber).catch(error => {
            console.warn('Recent token transfers failed:', error);
        });

        currentBlockNumber = blockNumber;

        // Update hero stats
        document.getElementById('heroBlocks').textContent = blockNumber.toLocaleString();
        document.getElementById('heroGas').textContent = ethers.utils.formatUnits(gasPrice, 'gwei') + ' Gwei';

        // Update stat cards with animation
        const blockEl = document.getElementById('latestBlock');
        const oldBlock = parseInt(blockEl.textContent.replace(/[^0-9]/g, '')) || 0;
        animateValue(blockEl, oldBlock, blockNumber, 600, '#');
        const gasEl = document.getElementById('gasPrice');
        if (gasEl) gasEl.textContent = ethers.utils.formatUnits(gasPrice, 'gwei') + ' Gwei';
        document.getElementById('peerCount').textContent = parseInt(peerCount, 16);

        // Fetch blocks for stats and chart using batch RPC (single HTTP request)
        const blockNums = [];
        for (let i = 0; i <= DEFAULT_CHART_BLOCKS; i++) {
            blockNums.push(blockNumber - i);
        }
        const blocks = (await fetchBlocksBatch(blockNums, false)).filter(b => b !== null);

        // Calculate avg block time
        let avgTime = 14;
        if (blocks.length >= 2) {
            const timeDiff = blocks[0].timestamp - blocks[Math.min(50, blocks.length - 1)].timestamp;
            const count = Math.min(50, blocks.length - 1);
            avgTime = timeDiff / count;
            document.getElementById('avgBlockTime').textContent = avgTime.toFixed(1) + 's';
        }
        updateNetworkHealth(avgTime, parseInt(peerCount, 16));

        // Build chart data arrays and stats (only if we have blocks)
        const refreshBlockTime = chartTimeframes.blockTime === DEFAULT_CHART_BLOCKS;
        const refreshDifficulty = chartTimeframes.difficulty === DEFAULT_CHART_BLOCKS;
        const refreshGasPrice = chartTimeframes.gasPrice === DEFAULT_CHART_BLOCKS;
        const refreshGasUsage = chartTimeframes.gasUsage === DEFAULT_CHART_BLOCKS;
        if (refreshBlockTime) blockTimeData = [];
        if (refreshDifficulty) difficultyData = [];
        if (refreshGasUsage) gasUsageData = [];

        if (blocks.length > 0) {
            // Difficulty & Hashrate
            const diff = Number(blocks[0].difficulty) || 0;
            if (diff > 0) {
                document.getElementById('networkDifficulty').textContent = formatLargeNumber(diff);
                document.getElementById('networkHashrate').textContent = formatHashrate(diff, avgTime);
            }
            for (let i = 0; i < blocks.length - 1; i++) {
                if (refreshBlockTime) blockTimeData.push({ block: blocks[i].number, value: blocks[i].timestamp - blocks[i + 1].timestamp });
                if (refreshDifficulty) difficultyData.push({ block: blocks[i].number, value: Number(blocks[i].difficulty) || 0 });
                const gu = blocks[i].gasUsed, gl = blocks[i].gasLimit;
                if (refreshGasUsage && gu != null && gl != null && Number(gl) > 0) {
                    gasUsageData.push({ block: blocks[i].number, value: (Number(gu) / Number(gl)) * 100 });
                }
            }
            if (refreshBlockTime) blockTimeData.reverse();
            if (refreshDifficulty) difficultyData.reverse();
            if (refreshGasUsage) gasUsageData.reverse();

            // Gas price from block headers (baseFeePerGas) or fallback to current gas price
            if (refreshGasPrice) gasPriceHistory = [];
            let hasBaseFee = false;
            for (const block of blocks) {
                if (block.baseFeePerGas != null) {
                    hasBaseFee = true;
                    if (refreshGasPrice) gasPriceHistory.push({ block: block.number, value: parseFloat(ethers.utils.formatUnits(block.baseFeePerGas, 'gwei')) });
                }
            }
            if (!hasBaseFee) {
                // Fallback: use current gas price for all blocks if chain has no baseFeePerGas
                const gpVal = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei'));
                for (const block of blocks) {
                    if (refreshGasPrice) gasPriceHistory.push({ block: block.number, value: gpVal });
                }
            }
            if (refreshGasPrice) gasPriceData = gasPriceHistory.slice().reverse();

            // Render all charts
            renderAllCharts();

            // Chart badges
            if (refreshBlockTime) document.getElementById('chartAvgBadge').textContent = 'Avg: ' + avgTime.toFixed(1) + 's';
            if (refreshDifficulty) document.getElementById('chartDiffBadge').textContent = 'Latest: ' + formatLargeNumber(difficultyData[0]?.value || 0);
            if (refreshGasPrice) document.getElementById('chartGasBadge').textContent = 'Current: ' + parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei')).toFixed(2) + ' Gwei';
            const avgGasUsage = gasUsageData.length > 0 ? gasUsageData.reduce((s, d) => s + d.value, 0) / gasUsageData.length : 0;
            if (refreshGasUsage) document.getElementById('chartGasUsageBadge').textContent = 'Avg: ' + avgGasUsage.toFixed(1) + '%';
        }

        // Unique miners for validators preview
        const minerCounts = {};
        blocks.forEach(b => {
            if (b.miner) {
                minerCounts[b.miner] = (minerCounts[b.miner] || 0) + 1;
            }
        });
        document.getElementById('heroAddresses').textContent = Object.keys(minerCounts).length;

        // Render blocks (latest 10)
        const blocksHtml = blocks.slice(0, 10).map(b => createBlockItemHtml(b));
        document.getElementById('latestBlocks').innerHTML = blocksHtml.join('');

        // Scan a wider recent range so quiet blocks do not make the dashboard
        // look stale. Batched RPC keeps this to a handful of HTTP requests.
        // Fetch transaction blocks using batch RPC (single HTTP request)
        const recentTransactions = await recentTransactionsPromise;
        const txsHtml = recentTransactions.slice(0, HISTORY.dashboardItems).map(tx => createTxItemHtml(tx, tx.blockTimestamp));
        document.getElementById('latestTransactions').innerHTML =
            txsHtml.length > 0 ? txsHtml.join('') : '<div class="empty-state"><i class="fas fa-inbox"></i><p>No transactions in recent blocks</p><p class="sub">Try the <a href="#" onclick="navigateTo(\'transactions\')">Transactions page</a> for older data</p></div>';

        // Update hero tx count
        document.getElementById('heroTxs').textContent = recentTransactions.length > HISTORY.dashboardItems
            ? `${HISTORY.dashboardItems}+`
            : recentTransactions.length.toLocaleString();

    } catch (error) {
        console.error('Dashboard error:', error);
        showToast('Error loading dashboard data');
    } finally {
        isLoading = false;
    }
}

// ========================================
// Animated Counter
// ========================================
function animateValue(el, start, end, duration = 600, prefix = '') {
    if (start === end) { el.textContent = prefix + end.toLocaleString(); return; }
    const startTime = performance.now();
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + (end - start) * eased);
        el.textContent = prefix + current.toLocaleString();
        if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
}



// ========================================
// Keyboard Shortcuts
// ========================================
document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Ctrl/Cmd + K = Focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.focus();
            searchInput.select();
        }
        return;
    }
    // Escape = Close mobile menu, blur search
    if (e.key === 'Escape') {
        document.getElementById('mainNav').classList.remove('mobile-open');
        document.activeElement.blur();
        return;
    }
    // D = Dashboard, B = Blocks, T = Transactions, V = Validators (when not in input)
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !inInput) {
        switch (e.key.toLowerCase()) {
            case 'd': navigateTo('dashboard'); break;
            case 'b': navigateTo('blocks'); break;
            case 't': navigateTo('transactions'); break;
            case 'v': navigateTo('validators'); break;
        }
    }
});

// ========================================
// Network Health Indicator
// ========================================
function updateNetworkHealth(avgBlockTime, peerCount) {
    const el = document.getElementById('networkHealth');
    if (!el) return;

    let health = 'excellent';
    let icon = 'fa-circle-check';
    let color = 'var(--success)';

    if (peerCount === 0) { health = 'offline'; icon = 'fa-circle-xmark'; color = 'var(--danger)'; }
    else if (peerCount < 3) { health = 'poor'; icon = 'fa-triangle-exclamation'; color = 'var(--danger)'; }
    else if (avgBlockTime > 30) { health = 'slow'; icon = 'fa-circle-exclamation'; color = 'var(--warning)'; }
    else if (avgBlockTime > 18) { health = 'fair'; icon = 'fa-circle-info'; color = 'var(--warning)'; }

    el.innerHTML = `<i class="fas ${icon}" style="color:${color}"></i> <span style="color:${color}">${health.charAt(0).toUpperCase() + health.slice(1)}</span>`;
}

// ========================================
// Reusable Interactive Chart Renderer
// ========================================
function drawInteractiveChart(canvasId, data, opts) {
    if (currentPage !== 'dashboard') return;
    const canvas = document.getElementById(canvasId);
    if (!canvas || !data || data.length < 2) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.floor(rect.width);
    if (w < 180) return;
    const h = Math.max(180, Math.min(240, Math.round(w * 0.42)));
    const padding = { top: 16, right: 16, bottom: 30, left: w < 360 ? 46 : 56 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;
    if (chartW <= 0 || chartH <= 0) return;

    // Setting width/height resets the canvas context, preventing transform
    // accumulation and keeping the backing store in sync with CSS pixels.
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = '100%';
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#94a3b8' : '#64748b';
    const gridColor = isDark ? '#1e2a42' : '#e2e8f0';
    const lineColor = isDark ? opts.color : opts.colorLight;
    const fillColor = isDark ? opts.fillColor : opts.fillColorLight;
    const hoverColor = lineColor;        const values = data.map(d => d.value).filter(v => v != null && !isNaN(v) && isFinite(v));
        if (values.length === 0) {
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#999';
            ctx.font = '13px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No data available', w / 2, h / 2);
            return;
        }
        let maxVal = Math.max(...values);
        let minVal = Math.min(...values);
        if (maxVal === minVal) {
            const paddingValue = Math.max(Math.abs(maxVal) * 0.15, 1);
            minVal -= paddingValue;
            maxVal += paddingValue;
        } else {
            const paddingValue = (maxVal - minVal) * 0.08;
            minVal -= paddingValue;
            maxVal += paddingValue;
        }
        const range = maxVal - minVal;
    const stepX = chartW / (data.length - 1);

    // Init hover state
    if (!chartStates[canvasId]) chartStates[canvasId] = { hoverIdx: -1 };
    const state = chartStates[canvasId];

    function formatValue(v) {
        if (opts.valueFn) return opts.valueFn(v);
        if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
        return v.toFixed(v < 10 ? 2 : 0);
    }

    function render(hoverIdx) {
        ctx.clearRect(0, 0, w, h);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.clip();

        // Grid lines (4 horizontal)
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = padding.top + (chartH / 4) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(w - padding.right, y);
            ctx.stroke();
            const val = maxVal - (range * i / 4);
            ctx.fillStyle = textColor;
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(formatValue(val), padding.left - 6, y + 3);
        }

        // Fill area with gradient
        const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
        gradient.addColorStop(0, fillColor);
        gradient.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.moveTo(padding.left, padding.top + chartH);
        data.forEach((d, i) => {
            const x = padding.left + i * stepX;
            const y = padding.top + chartH - ((d.value - minVal) / range) * chartH;
            ctx.lineTo(x, y);
        });
        ctx.lineTo(padding.left + (data.length - 1) * stepX, padding.top + chartH);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Line
        ctx.beginPath();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
data.forEach((d, i) => {
    if (d.value == null || isNaN(d.value) || !isFinite(d.value)) return;
    const x = padding.left + i * stepX;
    const y = padding.top + chartH - ((d.value - minVal) / range) * chartH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
});
        ctx.stroke();

        // Hover crosshair and tooltip
        if (hoverIdx >= 0 && hoverIdx < data.length) {
            const d = data[hoverIdx];
            const x = padding.left + hoverIdx * stepX;
            const y = padding.top + chartH - ((d.value - minVal) / range) * chartH;

            // Vertical crosshair
            ctx.beginPath();
            ctx.strokeStyle = hoverColor;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.moveTo(x, padding.top);
            ctx.lineTo(x, padding.top + chartH);
            ctx.stroke();
            ctx.setLineDash([]);

            // Horizontal crosshair
            ctx.beginPath();
            ctx.setLineDash([4, 4]);
            ctx.moveTo(padding.left, y);
            ctx.lineTo(w - padding.right, y);
            ctx.stroke();
            ctx.setLineDash([]);

            // Data point with glow
            if (d && d.value != null && !isNaN(d.value)) {
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2);
                ctx.fillStyle = hoverColor;
                ctx.fill();
            }
            ctx.beginPath();
            ctx.arc(x, y, 9, 0, Math.PI * 2);
            ctx.fillStyle = hoverColor + '25';
            ctx.fill();

            // Tooltip
            let tooltipText = opts.tooltipFn(d);
            ctx.font = '11px Inter, sans-serif';
            const maxTextWidth = Math.max(40, chartW - 14);
            while (tooltipText.length > 1 && ctx.measureText(tooltipText).width > maxTextWidth) {
                tooltipText = tooltipText.slice(0, -2) + '…';
            }
            const textW = ctx.measureText(tooltipText).width;
            const tw = Math.min(textW + 14, Math.max(80, chartW));
            const th = 26;
            const r = 5;
            let tooltipX = Math.min(Math.max(x - tw / 2, padding.left), w - padding.right - tw);
            let tooltipY = Math.max(y - th - 10, padding.top);

            // Rounded rect background
            ctx.fillStyle = isDark ? '#1a1f35' : '#ffffff';
            ctx.strokeStyle = isDark ? '#2a3352' : '#e2e8f0';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tooltipX + r, tooltipY);
            ctx.lineTo(tooltipX + tw - r, tooltipY);
            ctx.quadraticCurveTo(tooltipX + tw, tooltipY, tooltipX + tw, tooltipY + r);
            ctx.lineTo(tooltipX + tw, tooltipY + th - r);
            ctx.quadraticCurveTo(tooltipX + tw, tooltipY + th, tooltipX + tw - r, tooltipY + th);
            ctx.lineTo(tooltipX + r, tooltipY + th);
            ctx.quadraticCurveTo(tooltipX, tooltipY + th, tooltipX, tooltipY + th - r);
            ctx.lineTo(tooltipX, tooltipY + r);
            ctx.quadraticCurveTo(tooltipX, tooltipY, tooltipX + r, tooltipY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = isDark ? '#f1f5f9' : '#0f172a';
            ctx.textAlign = 'left';
            ctx.fillText(tooltipText, tooltipX + 7, tooltipY + 17);
        }

        // X labels
        ctx.fillStyle = textColor;
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'center';
        const xLabelInterval = Math.max(1, Math.floor(data.length / 5));
        data.forEach((d, i) => {
            if (i % xLabelInterval === 0 || i === data.length - 1) {
                const x = padding.left + i * stepX;
                ctx.textAlign = i === 0 ? 'left' : i === data.length - 1 ? 'right' : 'center';
                ctx.fillText('#' + d.block, x, h - 6);
            }
        });
        ctx.restore();
    }

    render(state.hoverIdx);

    // Remove old listeners
    canvas.onmousemove = null;
    canvas.onclick = null;
    canvas.onmouseleave = null;

    canvas.onmousemove = (e) => {
        const r = canvas.getBoundingClientRect();
        const mouseX = e.clientX - r.left;
        const idx = Math.round((mouseX - padding.left) / stepX);
        if (idx >= 0 && idx < data.length) {
            state.hoverIdx = idx;
            canvas.style.cursor = 'pointer';
            render(idx);
        } else {
            state.hoverIdx = -1;
            canvas.style.cursor = 'default';
            render(-1);
        }
    };

    canvas.onclick = () => {
        if (state.hoverIdx >= 0 && state.hoverIdx < data.length) {
            navigateTo('block-detail', data[state.hoverIdx].block);
        }
    };

    canvas.onmouseleave = () => {
        state.hoverIdx = -1;
        canvas.style.cursor = 'default';
        render(-1);
    };
}

function initChartResizeObserver() {
    if (!('ResizeObserver' in window)) return;
    chartResizeObserver?.disconnect();
    chartResizeObserver = new ResizeObserver(() => {
        if (currentPage !== 'dashboard' || chartResizeFrame) return;
        chartResizeFrame = requestAnimationFrame(() => {
            chartResizeFrame = null;
            renderAllCharts();
        });
    });
    document.querySelectorAll('.chart-body').forEach(body => chartResizeObserver.observe(body));
}

// ========================================
// HTML Generators
// ========================================
function createBlockItemHtml(block) {
    const age = getTimeAgo(block.timestamp);
    const txCount = block.transactions ? block.transactions.length : 0;

    return `
        <div class="block-item">
            <div class="block-item-icon"><i class="fas fa-cube"></i></div>
            <div class="item-info">
                <div class="item-row">
                    <span class="item-link" onclick="navigateTo('block-detail', ${block.number})">${block.number}</span>
                    <span class="item-time">${age}</span>
                </div>
                <div class="item-detail">
                    Miner: <span class="hash-link" onclick="navigateTo('address', '${block.miner}')">${truncateHash(block.miner)}</span>
                </div>
            </div>
            <div class="item-right">
                <div class="value">${txCount} txn${txCount !== 1 ? 's' : ''}</div>
                <div class="sub">~14s</div>
            </div>
        </div>
    `;
}

function createTxItemHtml(tx, blockTimestamp) {
    const age = blockTimestamp ? getTimeAgo(blockTimestamp) : '';
    const value = ethers.utils.formatEther(tx.value);

    return `
        <div class="tx-item">
            <div class="tx-item-icon"><i class="fas fa-exchange-alt"></i></div>
            <div class="item-info">
                <div class="item-row">
                    <span class="item-link" onclick="navigateTo('tx-detail', '${tx.hash}')">${truncateHash(tx.hash)}</span>
                    <span class="item-time">${age}</span>
                </div>
                <div class="item-detail">
                    From: <span class="hash-link" onclick="navigateTo('address', '${tx.from}')">${truncateHash(tx.from)}</span>
                    ${tx.to ? `→ <span class="hash-link" onclick="navigateTo('address', '${tx.to}')">${truncateHash(tx.to)}</span>` : '(Contract)'}
                </div>
            </div>
            <div class="item-right">
                <div class="value">${parseFloat(value).toFixed(4)} GAPLO</div>
                <div class="sub">Block #${tx.blockNumber || '-'}</div>
            </div>
        </div>
    `;
}

// ========================================
// Token Transfers Detection
// ========================================
function parseTransferLog(log) {
    try {
        if (!log.topics || log.topics.length < 3) return null;
        if (log.topics[0] !== TRANSFER_TOPIC) return null;

        const from = '0x' + log.topics[1].slice(26);
        const to = '0x' + log.topics[2].slice(26);
        const value = ethers.BigNumber.from(log.data);
        const contractAddress = log.address;

        return {
            from,
            to,
            value,
            contractAddress,
            txHash: log.transactionHash,
            blockNumber: typeof log.blockNumber === 'string' ? parseInt(log.blockNumber, 16) : log.blockNumber,
            logIndex: log.logIndex
        };
    } catch (e) {
        return null;
    }
}

async function loadRecentTokenTransfers(latestBlock) {
    const container = document.getElementById('latestTokenTransfers');
    if (!container) return;
    const transfers = await findRecentTransfers(
        latestBlock,
        10,
        HISTORY.dashboardTransferBlocks
    );
    const [transfersWithTimes, transfersWithMetadata] = await Promise.all([
        addTransferTimestamps(transfers),
        addTransferMetadata(transfers)
    ]);
    const renderedTransfers = transfersWithTimes.map((transfer, index) => ({ ...transfer, token: transfersWithMetadata[index].token }));

    if (transfers.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-coins"></i><p>No ERC-20 token transfers found in recent blocks</p></div>';
        return;
    }
    container.innerHTML = renderedTransfers.map(t => `
        <div class="token-transfer-item">
            <div class="token-item-icon"><i class="fas fa-coins"></i></div>
            <div class="item-info">
                <div class="item-row">
                    <span class="item-link" onclick="navigateTo('tx-detail', '${t.txHash}')">${truncateHash(t.txHash)}</span>
                    <span class="item-time">${getTimeAgo(t.blockTimestamp || 0)}</span>
                </div>
                <div class="item-detail">
                    <span class="hash-link" onclick="navigateTo('address', '${t.from}')">${truncateHash(t.from)}</span>
                    → <span class="hash-link" onclick="navigateTo('address', '${t.to}')">${truncateHash(t.to)}</span>
                </div>
            </div>
            <div class="item-right">
                <div class="value">${formatTokenValue(t.value, t.token)}</div>
                <div class="sub">${escapeHtml(t.token?.symbol || truncateHash(t.contractAddress))}</div>
            </div>
        </div>
    `).join('');
}

function formatTokenValue(value, token = null) {
    try {
        const decimals = token?.decimals ?? 18;
        const symbol = token?.symbol || 'TOKEN';
        const raw = ethers.BigNumber.from(value);
        const formatted = ethers.utils.formatUnits(raw, decimals);
        const numeric = Number(formatted);
        const display = Number.isFinite(numeric)
            ? numeric.toLocaleString(undefined, { maximumFractionDigits: 6 })
            : formatted;
        return `${display} ${escapeHtml(symbol)}`;
    } catch (e) {
        return `${value.toString()} ${escapeHtml(token?.symbol || 'TOKEN')}`;
    }
}

function formatGasUsage(gasUsed, gasLimit) {
    if (gasUsed == null || !gasLimit || Number(gasLimit) <= 0) return '-';
    const percent = (Number(gasUsed) / Number(gasLimit)) * 100;
    return `${Number(gasUsed).toLocaleString()} / ${Number(gasLimit).toLocaleString()} (${percent.toFixed(2)}%)`;
}

// ========================================
// Token Transfers Page
// ========================================
async function loadTokenTransfers() {
    const tbody = document.getElementById('tokenTransfersBody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell"><div class="skeleton-table-row"></div></td></tr>';

    try {
        const latestBlock = await provider.getBlockNumber();
        const wanted = tokenTransfersPage * HISTORY.transferPageSize + HISTORY.transferPageSize;
        const transfersWithMetadata = await getCachedView(
            `transfers_${latestBlock}_${wanted}`,
            async () => addTransferMetadata(await findRecentTransfers(latestBlock, wanted, HISTORY.transfersBlocks))
        );
        const subtitle = document.getElementById('tokenTransfersSubtitle');
        if (subtitle) subtitle.textContent = `Latest ERC-20 transfers, searching up to ${HISTORY.transfersBlocks.toLocaleString()} blocks`;

        // Paginate
        const start = (tokenTransfersPage - 1) * HISTORY.transferPageSize;
        const pageTxs = transfersWithMetadata.slice(start, start + HISTORY.transferPageSize);

        tbody.innerHTML = pageTxs.map(t => `
            <tr>
                <td><span class="hash-link" onclick="navigateTo('tx-detail', '${t.txHash}')">${truncateHash(t.txHash)}</span></td>
                <td>${t.blockNumber}</td>
                <td><span class="hash-link" onclick="navigateTo('address', '${t.from}')">${truncateHash(t.from)}</span></td>
                <td><span class="hash-link" onclick="navigateTo('address', '${t.to}')">${truncateHash(t.to)}</span></td>
                <td>${formatTokenValue(t.value, t.token)}</td>
                <td><span class="hash-link" onclick="navigateTo('address', '${t.contractAddress}')">${escapeHtml(t.token?.symbol || truncateHash(t.contractAddress))}</span><div class="table-token-name">${escapeHtml(t.token?.name || truncateHash(t.contractAddress))}</div></td>
            </tr>
        `).join('') || '<tr><td colspan="6" class="loading-cell">No token transfers found</td></tr>';

        // Simple pagination
        // The scan stops once it has enough rows for the next page. Expose a
        // next page when the current range was full, then continue scanning
        // only as the visitor asks for more results.
        const totalPages = Math.max(
            tokenTransfersPage,
            Math.ceil(transfersWithMetadata.length / HISTORY.transferPageSize),
            transfersWithMetadata.length >= wanted ? tokenTransfersPage + 1 : 1
        );
        renderSimplePagination('tokenTransfersPagination', tokenTransfersPage, totalPages, (p) => {
            tokenTransfersPage = p;
            syncRouteState();
            loadTokenTransfers();
        });

    } catch (error) {
        console.error('Token transfers error:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Error loading token transfers</td></tr>';
    }
}

function renderSimplePagination(containerId, current, total, callback) {
    const el = document.getElementById(containerId);
    if (!el) return;

    let html = '';
    html += `<button class="page-btn" onclick="void(0)" ${current === 1 ? 'disabled' : ''}><i class="fas fa-angle-left"></i></button>`;

    const start = Math.max(1, current - 2);
    const end = Math.min(total, current + 2);
    for (let i = start; i <= end; i++) {
        html += `<button class="page-btn ${i === current ? 'active' : ''}" onclick="void(0)">${i}</button>`;
    }

    html += `<button class="page-btn" onclick="void(0)" ${current === total ? 'disabled' : ''}><i class="fas fa-angle-right"></i></button>`;

    el.innerHTML = html;        // Attach click handlers
        el.querySelectorAll('.page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                const icon = btn.querySelector('i');
                if (icon && icon.classList.contains('fa-angle-left')) callback(current - 1);
                else if (icon && icon.classList.contains('fa-angle-right')) callback(current + 1);
                else {
                    const num = parseInt(btn.textContent.replace(/[^0-9]/g, ''));
                    if (!isNaN(num)) callback(num);
                }
            });
        });
}

// ========================================
// Validators / Miners Page
// ========================================
async function loadValidators() {
    const tbody = document.getElementById('validatorsTableBody');
    tbody.innerHTML = '<tr><td colspan="5" class="loading-cell"><div class="skeleton-table-row"></div></td></tr>';

    try {
        const latestBlock = await provider.getBlockNumber();
        const snapshot = await getCachedView('validators_snapshot', async () => {
            const minerCounts = {};
            const minerLastBlock = {};
            const blockNumbers = buildEvenlySpacedBlockNumbers(
                latestBlock,
                HISTORY.validatorsBlocks,
                HISTORY.validatorSamples
            );
            const blocks = await fetchBlocksBatch(blockNumbers, false);
            for (const block of blocks) {
                if (!block?.miner) continue;
                minerCounts[block.miner] = (minerCounts[block.miner] || 0) + 1;
                if (!minerLastBlock[block.miner] || block.number > minerLastBlock[block.miner]) {
                    minerLastBlock[block.miner] = block.number;
                }
            }
            const sorted = Object.entries(minerCounts).sort((a, b) => b[1] - a[1]);
            return { sorted, minerLastBlock, totalBlocks: sorted.reduce((sum, [, count]) => sum + count, 0), blocksScanned: blocks.filter(Boolean).length };
        });
        const subtitle = document.getElementById('validatorsSubtitle');
        if (subtitle) subtitle.textContent = `Representative ${snapshot.blocksScanned.toLocaleString()}-block sample across the latest ${HISTORY.validatorsBlocks.toLocaleString()} blocks`;

        tbody.innerHTML = snapshot.sorted.map(([addr, count], i) => `
            <tr>
                <td>${i + 1}</td>
                <td><span class="hash-link" onclick="navigateTo('address', '${addr}')">${truncateHash(addr)}</span></td>
                <td>${count}</td>
                <td>${((count / snapshot.totalBlocks) * 100).toFixed(2)}%</td>
                <td>${snapshot.minerLastBlock[addr] ? '#' + snapshot.minerLastBlock[addr] : '-'}</td>
            </tr>
        `).join('') || '<tr><td colspan="5" class="loading-cell">No miner data found</td></tr>';

    } catch (error) {
        console.error('Validators error:', error);
        tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">Error loading validator data</td></tr>';
    }
}

// ========================================
// Blocks Page
// ========================================
async function loadBlocks() {
    const tbody = document.getElementById('blocksTableBody');
    tbody.innerHTML = '<tr><td colspan="5" class="loading-cell"><div class="skeleton-table-row"></div></td></tr>';

    try {
        const latestBlock = await provider.getBlockNumber();
        const startBlock = latestBlock - (blocksPage - 1) * blocksPerPage;
        const endBlock = Math.max(0, startBlock - blocksPerPage + 1);

        const nums = [];
        for (let i = startBlock; i >= endBlock; i--) nums.push(i);

        const blocks = (await fetchBlocksBatch(nums, false)).filter(b => b !== null);

        tbody.innerHTML = blocks.map(b => `
            <tr>
                <td><span class="hash-link" onclick="navigateTo('block-detail', ${b.number})">${b.number}</span></td>
                <td>${getTimeAgo(b.timestamp)}</td>
                <td>${b.transactions ? b.transactions.length : 0}</td>
                <td>${formatGasUsage(b.gasUsed, b.gasLimit)}</td>
                <td><span class="hash-link" onclick="navigateTo('address', '${b.miner}')">${truncateHash(b.miner)}</span></td>
            </tr>
        `).join('');

        document.getElementById('blocksSubtitle').textContent = `Block #${startBlock} to #${endBlock}`;
        renderBlocksPagination(latestBlock);
    } catch (error) {
        console.error('Blocks error:', error);
        tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">Error loading blocks</td></tr>';
    }
}

function renderBlocksPagination(latestBlock) {
    const totalPages = Math.ceil((latestBlock + 1) / blocksPerPage);
    const el = document.getElementById('blocksPagination');
    let html = '';
    html += `<button class="page-btn" onclick="goToBlocksPage(1)" ${blocksPage === 1 ? 'disabled' : ''}><i class="fas fa-angle-double-left"></i></button>`;
    html += `<button class="page-btn" onclick="goToBlocksPage(${blocksPage - 1})" ${blocksPage === 1 ? 'disabled' : ''}><i class="fas fa-angle-left"></i></button>`;
    const start = Math.max(1, blocksPage - 2);
    const end = Math.min(totalPages, blocksPage + 2);
    for (let i = start; i <= end; i++) {
        html += `<button class="page-btn ${i === blocksPage ? 'active' : ''}" onclick="goToBlocksPage(${i})">${i}</button>`;
    }
    html += `<button class="page-btn" onclick="goToBlocksPage(${blocksPage + 1})" ${blocksPage === totalPages ? 'disabled' : ''}><i class="fas fa-angle-right"></i></button>`;
    html += `<button class="page-btn" onclick="goToBlocksPage(${totalPages})" ${blocksPage === totalPages ? 'disabled' : ''}><i class="fas fa-angle-double-right"></i></button>`;
    el.innerHTML = html;
}

function goToBlocksPage(p) {
    if (p < 1) return;
    blocksPage = p;
    syncRouteState();
    loadBlocks();
}

// ========================================
// Chart Timeframe Handlers
// ========================================
function initTimeframeHandlers() {
    // Add click handlers to all timeframe buttons
    document.querySelectorAll('.chart-timeframe').forEach(container => {
        const chartType = container.id.replace('ChartTimeframe', '').replace('Chart', '');
        container.querySelectorAll('.timeframe-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                // Update active state
                container.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                // Update timeframe
                const blocks = parseInt(btn.dataset.blocks);
                
                chartTimeframes[chartType] = blocks;
                const requestVersion = ++chartRequestVersions[chartType];
                loadChartForTimeframe(chartType, blocks, requestVersion);
            });
        });
    });
}

function buildChartBlockNumbers(latestBlock, blocksToFetch) {
    const sampleCount = Math.min(blocksToFetch, MAX_CHART_SAMPLES);
    if (sampleCount <= 1) return [latestBlock];
    const maxOffset = blocksToFetch - 1;
    const numbers = [];
    let previous = null;
    for (let index = 0; index < sampleCount; index++) {
        const offset = Math.round((index * maxOffset) / (sampleCount - 1));
        const number = Math.max(0, latestBlock - offset);
        if (number !== previous) numbers.push(number);
        previous = number;
    }
    return numbers;
}

async function loadChartForTimeframe(chartType, blocksToFetch, requestVersion = ++chartRequestVersions[chartType]) {
    const canvasIdMap = {
        blockTime: 'blockTimeChart',
        difficulty: 'difficultyChart',
        gasPrice: 'gasPriceChart',
        gasUsage: 'gasUsageChart'
    };
    const canvas = document.getElementById(canvasIdMap[chartType]);
    let loadingOverlay = null;        // Cap blocks - with 100-block batches, 6171 blocks = ~62 requests
        blocksToFetch = Math.min(blocksToFetch, 6171);

    try {
        // Show loading overlay on the chart
        if (canvas && canvas.parentElement) {
            const parent = canvas.parentElement;
            parent.style.position = 'relative';
            parent.querySelectorAll('.chart-loading-overlay').forEach(overlay => overlay.remove());
            loadingOverlay = document.createElement('div');
            loadingOverlay.className = 'chart-loading-overlay';
            loadingOverlay.innerHTML = '<div class="loading-text"><i class="fas fa-spinner fa-spin"></i> Loading...<div class="chart-progress-bar"><div class="chart-progress-fill" id="chartProgressFill"></div></div></div>';
            parent.appendChild(loadingOverlay);
        }

        const blockNumber = await provider.getBlockNumber();
        // A 600px-wide canvas cannot show thousands of independent points.
        // Evenly sampling the range retains the trend while reducing 24-hour
        // work from 6,171 headers to at most 480.
        const blockNums = buildChartBlockNumbers(blockNumber, blocksToFetch);
        
        // Use JSON-RPC batch requests with progress callback
        const progressFill = document.getElementById('chartProgressFill');
        const blocksRaw = await fetchBlocksBatch(blockNums, false, (loaded, total) => {
            if (progressFill) {
                progressFill.style.width = Math.round((loaded / total) * 100) + '%';
            }
        });
        const blocks = blocksRaw.filter(b => b !== null);
        if (chartTimeframes[chartType] !== blocksToFetch || chartRequestVersions[chartType] !== requestVersion) return;
        
        if (blocks.length === 0) {
            throw new Error('No blocks fetched');
        }
        
        // Update the specific chart data
        switch (chartType) {
            case 'blockTime':
                blockTimeData = [];
                for (let i = 0; i < blocks.length - 1; i++) {
                    blockTimeData.push({
                        block: blocks[i].number,
                        value: (blocks[i].timestamp - blocks[i + 1].timestamp) /
                            Math.max(1, blocks[i].number - blocks[i + 1].number)
                    });
                }
                blockTimeData.reverse();
                break;
                
            case 'difficulty':
                difficultyData = [];
                for (let i = 0; i < blocks.length; i++) {
                    difficultyData.push({
                        block: blocks[i].number,
                        value: Number(blocks[i].difficulty) || 0
                    });
                }
                difficultyData.reverse();
                break;
                
            case 'gasUsage':
                gasUsageData = [];
                for (let i = 0; i < blocks.length; i++) {
                    const gu = blocks[i].gasUsed;
                    const gl = blocks[i].gasLimit;
                    if (gu != null && gl != null && Number(gl) > 0) {
                        gasUsageData.push({
                            block: blocks[i].number,
                            value: (Number(gu) / Number(gl)) * 100
                        });
                    }
                }
                gasUsageData.reverse();
                break;
                
            case 'gasPrice':
                // Use baseFeePerGas from block headers (already in batch response) - no extra RPC call needed
                gasPriceHistory = [];
                let hasBaseFee = false;
                for (const block of blocks) {
                    if (block.baseFeePerGas != null) {
                        hasBaseFee = true;
                        gasPriceHistory.push({
                            block: block.number,
                            value: parseFloat(ethers.utils.formatUnits(block.baseFeePerGas, 'gwei'))
                        });
                    }
                }
                // Fallback: if chain has no baseFeePerGas, use current gas price for all blocks
                if (!hasBaseFee) {
                    try {
                        const currentGasPrice = await provider.getGasPrice().catch(() => ethers.BigNumber.from(0));
                        const gpVal = parseFloat(ethers.utils.formatUnits(currentGasPrice, 'gwei'));
                        for (const block of blocks) {
                            gasPriceHistory.push({ block: block.number, value: gpVal });
                        }
                    } catch(e) {}
                }
                gasPriceData = gasPriceHistory.slice().reverse();
                break;
        }
        
        // Re-render the specific chart
        const chartConfig = CHARTS.find(c => {
            switch (chartType) {
                case 'blockTime': return c.id === 'blockTimeChart';
                case 'difficulty': return c.id === 'difficultyChart';
                case 'gasPrice': return c.id === 'gasPriceChart';
                case 'gasUsage': return c.id === 'gasUsageChart';
                default: return false;
            }
        });
        
        if (chartConfig) {
            const data = chartConfig.getData();
            if (data && data.length > 1) {
                drawInteractiveChart(chartConfig.id, data, {
                    color: chartConfig.color,
                    colorLight: chartConfig.colorLight,
                    fillColor: chartConfig.fill,
                    fillColorLight: chartConfig.fillLight,
                    tooltipFn: chartConfig.tip,
                    valueFn: chartConfig.vfn
                });
            }
        }
        
        // Update chart badges with new data
        updateChartBadges(chartType, blocks);
        
    } catch (error) {
        if (chartRequestVersions[chartType] === requestVersion) console.error(`Error loading ${chartType} chart:`, error);
    } finally {
        // Remove loading overlay
        if (loadingOverlay && loadingOverlay.parentElement && chartRequestVersions[chartType] === requestVersion) {
            loadingOverlay.parentElement.removeChild(loadingOverlay);
        }
    }
}

function updateChartBadges(chartType, blocks) {
    try {
        switch (chartType) {
            case 'blockTime': {
                let avgTime = 14;
                if (blocks.length >= 2) {
                    const timeDiff = blocks[0].timestamp - blocks[blocks.length - 1].timestamp;
                    avgTime = timeDiff / Math.max(1, blocks[0].number - blocks[blocks.length - 1].number);
                }
                document.getElementById('chartAvgBadge').textContent = 'Avg: ' + avgTime.toFixed(1) + 's';
                break;
            }
            case 'difficulty': {
                const diff = blocks.length > 0 ? Number(blocks[0].difficulty) || 0 : 0;
                document.getElementById('chartDiffBadge').textContent = 'Latest: ' + formatLargeNumber(diff);
                break;
            }
            case 'gasPrice': {
                // gasPriceData is reversed, so last element is newest
                const latest = gasPriceData.length > 0 ? gasPriceData[gasPriceData.length - 1].value : 0;
                document.getElementById('chartGasBadge').textContent = 'Current: ' + latest.toFixed(2) + ' Gwei';
                break;
            }
            case 'gasUsage': {
                let avgGas = 0;
                if (gasUsageData.length > 0) {
                    avgGas = gasUsageData.reduce((s, d) => s + d.value, 0) / gasUsageData.length;
                }
                document.getElementById('chartGasUsageBadge').textContent = 'Avg: ' + avgGas.toFixed(1) + '%';
                break;
            }
        }
    } catch (e) {
        console.error('Error updating chart badge:', e);
    }
}

// ========================================
// Transactions Page
// ========================================
async function loadTransactions() {
    const tbody = document.getElementById('transactionsTableBody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell"><div class="skeleton-table-row"></div></td></tr>';

    try {
        const latestBlock = await provider.getBlockNumber();
        const subtitle = document.getElementById('transactionsSubtitle');
        if (subtitle) subtitle.textContent = `Latest transactions, searching up to ${HISTORY.transactionsBlocks.toLocaleString()} blocks`;
        const wanted = txsPage * txsPerPage + txsPerPage;
        const allTxs = await getCachedView(
            `transactions_${latestBlock}_${wanted}`,
            () => findRecentTransactions(latestBlock, wanted, HISTORY.transactionsBlocks)
        );
        const start = (txsPage - 1) * txsPerPage;
        const pageTxs = allTxs.slice(start, start + txsPerPage);

        // Fetch receipts in parallel
        if (pageTxs.length > 0) {
            const receiptResults = await parallelBatch(
                pageTxs.map(tx => tx.hash),
                (h) => getReceiptCached(h),
                10
            );
            for (let i = 0; i < pageTxs.length; i++) {
                if (receiptResults[i] && receiptResults[i].status === 'fulfilled' && receiptResults[i].value) {
                    pageTxs[i].gasUsed = receiptResults[i].value.gasUsed;
                }
            }
        }

        tbody.innerHTML = pageTxs.map(tx => {
            const value = ethers.utils.formatEther(tx.value);
            let txFee = '-';
            if (tx.gasUsed && tx.gasPrice) {
                const fee = ethers.BigNumber.from(tx.gasUsed).mul(ethers.BigNumber.from(tx.gasPrice));
                txFee = parseFloat(ethers.utils.formatEther(fee)).toFixed(6) + ' GAPLO';
            }
            return `
                <tr>
                    <td><span class="hash-link" onclick="navigateTo('tx-detail', '${tx.hash}')">${truncateHash(tx.hash)}</span></td>
                    <td><span class="hash-link" onclick="navigateTo('block-detail', ${tx.blockNumber})">${tx.blockNumber || '-'}</span></td>
                    <td><span class="hash-link" onclick="navigateTo('address', '${tx.from}')">${truncateHash(tx.from)}</span></td>
                    <td>${tx.to ? `<span class="hash-link" onclick="navigateTo('address', '${tx.to}')">${truncateHash(tx.to)}</span>` : '<em>Contract</em>'}</td>
                    <td>${parseFloat(value).toFixed(4)} GAPLO</td>
                    <td>${txFee}</td>
                </tr>
            `;
        }).join('') || '<tr><td colspan="6" class="loading-cell">No transactions in recent blocks</td></tr>';

        const totalTxPages = Math.max(
            txsPage,
            Math.ceil(allTxs.length / txsPerPage),
            allTxs.length >= wanted ? txsPage + 1 : 1
        );
        renderSimplePagination('transactionsPagination', txsPage, totalTxPages, (p) => {
            txsPage = p;
            syncRouteState();
            loadTransactions();
        });
    } catch (error) {
        console.error('Transactions error:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Error loading transactions</td></tr>';
    }
}

// ========================================
// Block Detail
// ========================================
async function loadBlockDetail(blockNumber) {
    const content = document.getElementById('blockDetailContent');
    content.innerHTML = '<div class="skeleton-detail"><div class="skeleton-detail-row"></div><div class="skeleton-detail-row"></div><div class="skeleton-detail-row"></div></div>';

    try {
        const block = await getBlockWithTxsCached(blockNumber);
        if (!block) { content.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Block not found</p></div>'; return; }

        const gasPercent = block.gasUsed != null && block.gasLimit ? ((Number(block.gasUsed) / Number(block.gasLimit)) * 100).toFixed(2) : '-';

        let html = `
            <div class="detail-row"><div class="detail-label"><i class="fas fa-hashtag"></i> Block Number</div><div class="detail-value">${block.number}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-clock"></i> Timestamp</div><div class="detail-value">${new Date(block.timestamp * 1000).toLocaleString()} (${getTimeAgo(block.timestamp)})</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-link"></i> Hash</div><div class="detail-value">${block.hash} <button class="copy-btn" onclick="copyToClipboard('${block.hash}')"><i class="fas fa-copy"></i> Copy</button></div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-arrow-left"></i> Parent Hash</div><div class="detail-value"><span class="hash-link" onclick="navigateTo('block-detail', ${block.number - 1})">${block.parentHash}</span></div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-user"></i> Miner</div><div class="detail-value"><span class="hash-link" onclick="navigateTo('address', '${block.miner}')">${block.miner}</span> <button class="copy-btn" onclick="copyToClipboard('${block.miner}')"><i class="fas fa-copy"></i></button></div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-gas-pump"></i> Gas Used</div><div class="detail-value">${block.gasUsed != null ? Number(block.gasUsed).toLocaleString() : '-'} (${gasPercent}%)</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-fire"></i> Gas Limit</div><div class="detail-value">${block.gasLimit ? Number(block.gasLimit).toLocaleString() : '-'}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-file"></i> Transactions</div><div class="detail-value">${block.transactions ? block.transactions.length : 0}</div></div>
        `;

        content.innerHTML = html;

        // Render tx list
        if (block.transactions && block.transactions.length > 0) {
            const txHtml = `
                <div class="detail-row">
                    <div class="detail-label"><i class="fas fa-list"></i> Transactions</div>
                    <div class="detail-value"><div class="detail-txs">
                        ${block.transactions.slice(0, 100).map(tx => `
                            <div class="tx-item">
                                <div class="tx-item-icon" style="width:32px;height:32px;font-size:14px"><i class="fas fa-exchange-alt"></i></div>
                                <div class="item-info">
                                    <div class="item-row"><span class="item-link" onclick="navigateTo('tx-detail', '${tx.hash}')">${truncateHash(tx.hash)}</span></div>
                                    <div class="item-detail">From: <span class="hash-link" onclick="navigateTo('address', '${tx.from}')">${truncateHash(tx.from)}</span> → ${tx.to ? `<span class="hash-link" onclick="navigateTo('address', '${tx.to}')">${truncateHash(tx.to)}</span>` : 'Contract'} | ${parseFloat(ethers.utils.formatEther(tx.value)).toFixed(4)} GAPLO</div>
                                </div>
                            </div>
                        `).join('')}
                        ${block.transactions.length > 100 ? `<div class="empty-state"><p>... and ${block.transactions.length - 100} more</p></div>` : ''}
                    </div></div>
                </div>
            `;
            content.innerHTML += txHtml;
        }
    } catch (error) {
        content.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Error: ${escapeHtml(error.message)}</p></div>`;
    }
}

// ========================================
// Transaction Detail
// ========================================
async function loadTxDetail(txHash) {
    const content = document.getElementById('txDetailContent');
    content.innerHTML = '<div class="skeleton-detail"><div class="skeleton-detail-row"></div><div class="skeleton-detail-row"></div><div class="skeleton-detail-row"></div></div>';

    try {
        const [tx, receipt] = await Promise.all([
            getTxCached(txHash),
            getReceiptCached(txHash)
        ]);

        if (!tx) { content.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Transaction not found</p></div>'; return; }

        const value = ethers.utils.formatEther(tx.value);
        const gasPrice = tx.gasPrice ? ethers.utils.formatUnits(tx.gasPrice, 'gwei') : '-';
        let gasUsed = '-', txFee = '-', status = '-';

        if (receipt) {
            gasUsed = Number(receipt.gasUsed).toLocaleString();
            txFee = parseFloat(ethers.utils.formatEther(receipt.gasUsed.mul(tx.gasPrice))).toFixed(6) + ' GAPLO';
            status = receipt.status === 1
                ? '<span style="color:var(--success)"><i class="fas fa-check-circle"></i> Success</span>'
                : '<span style="color:var(--danger)"><i class="fas fa-times-circle"></i> Failed</span>';
        }

        let blockInfo = '-', timestampStr = '-';
        if (tx.blockNumber) {
            const block = await getBlockCached(tx.blockNumber);
            blockInfo = `<span class="hash-link" onclick="navigateTo('block-detail', ${tx.blockNumber})">${tx.blockNumber}</span> (${getTimeAgo(block.timestamp)})`;
            timestampStr = new Date(block.timestamp * 1000).toLocaleString();
        }

        let html = `
            <div class="detail-row"><div class="detail-label"><i class="fas fa-file-alt"></i> Tx Hash</div><div class="detail-value">${tx.hash} <button class="copy-btn" onclick="copyToClipboard('${tx.hash}')"><i class="fas fa-copy"></i> Copy</button></div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-check-circle"></i> Status</div><div class="detail-value">${status}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-cube"></i> Block</div><div class="detail-value">${blockInfo}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-clock"></i> Timestamp</div><div class="detail-value">${timestampStr}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-arrow-from-left"></i> From</div><div class="detail-value"><span class="hash-link" onclick="navigateTo('address', '${tx.from}')">${tx.from}</span> <button class="copy-btn" onclick="copyToClipboard('${tx.from}')"><i class="fas fa-copy"></i></button></div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-arrow-to-right"></i> To</div><div class="detail-value">${tx.to ? `<span class="hash-link" onclick="navigateTo('address', '${tx.to}')">${tx.to}</span> <button class="copy-btn" onclick="copyToClipboard('${tx.to}')"><i class="fas fa-copy"></i></button>` : '<em>Contract Creation</em>'}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-coins"></i> Value</div><div class="detail-value">${parseFloat(value).toFixed(6)} GAPLO</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-gas-pump"></i> Gas Price</div><div class="detail-value">${gasPrice} Gwei</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-fire"></i> Gas Used</div><div class="detail-value">${gasUsed}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-dollar-sign"></i> Tx Fee</div><div class="detail-value">${txFee}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-hashtag"></i> Nonce</div><div class="detail-value">${tx.nonce}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-tag"></i> Input Data</div><div class="detail-value" style="font-family:monospace;font-size:12px;word-break:break-all;max-height:200px;overflow-y:auto">${tx.data && tx.data !== '0x' ? escapeHtml(tx.data) : '<em>No input data</em>'}</div></div>
        `;

        // Contract creation
        if (receipt && receipt.contractAddress) {
            html += `<div class="detail-row"><div class="detail-label"><i class="fas fa-file-contract"></i> Contract</div><div class="detail-value"><span class="hash-link" onclick="navigateTo('address', '${receipt.contractAddress}')">${receipt.contractAddress}</span> <button class="copy-btn" onclick="copyToClipboard('${receipt.contractAddress}')"><i class="fas fa-copy"></i></button></div></div>`;
        }

        // Token transfers in this tx
        if (receipt && receipt.logs) {
            const tokenTransfers = receipt.logs.filter(l => l.topics && l.topics[0] === TRANSFER_TOPIC);
            if (tokenTransfers.length > 0) {
                const transferMetadata = await getTokenMetadataBatch(tokenTransfers.map(log => log.address));
                html += `<div class="detail-row"><div class="detail-label"><i class="fas fa-coins"></i> Token Transfers</div><div class="detail-value"><div class="detail-txs">`;
                for (const log of tokenTransfers) {
                    const t = parseTransferLog(log);
                    if (t) {
                        const token = transferMetadata.get(t.contractAddress.toLowerCase());
                        html += `
                            <div class="token-transfer-item">
                                <div class="token-item-icon" style="width:32px;height:32px;font-size:14px"><i class="fas fa-coins"></i></div>
                                <div class="item-info">
                                    <div class="item-detail">
                                        <span class="hash-link" onclick="navigateTo('address', '${t.from}')">${truncateHash(t.from)}</span>
                                        → <span class="hash-link" onclick="navigateTo('address', '${t.to}')">${truncateHash(t.to)}</span>
                                        | ${formatTokenValue(t.value, token)} (${escapeHtml(token?.name || 'ERC-20 Token')})
                                    </div>
                                </div>
                            </div>
                        `;
                    }
                }
                html += `</div></div></div>`;
            }
        }

        content.innerHTML = html;
    } catch (error) {
        content.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Error: ${escapeHtml(error.message)}</p></div>`;
    }
}

// ========================================
// Address Detail
// ========================================
async function loadAddressDetail(address) {
    const content = document.getElementById('addressDetailContent');
    content.innerHTML = '<div class="skeleton-detail"><div class="skeleton-detail-row"></div><div class="skeleton-detail-row"></div></div>';

    try {
        const [balance, txCount, aploBalance] = await Promise.all([
            getBalanceCached(address),
            provider.getTransactionCount(address),
            getTokenBalance(APLO_TOKEN_ADDRESS, address)
        ]);

        // Summary cards
        let html = `
            <div class="address-summary">
                <div class="address-balance-card">
                    <div class="label"><i class="fas fa-coins"></i> GAPLO Balance</div>
                    <div class="value">${parseFloat(ethers.utils.formatEther(balance)).toFixed(6)}</div>
                    <div class="sub">Native Coin</div>
                </div>
                <div class="address-balance-card">
                    <div class="label"><i class="fas fa-coins"></i> APLO Token Balance</div>
                    <div class="value">${parseFloat(ethers.utils.formatUnits(aploBalance, 18)).toFixed(6)}</div>
                    <div class="sub">ERC-20 Token</div>
                </div>
            </div>
            <div class="detail-row">
                <div class="detail-label"><i class="fas fa-wallet"></i> Address</div>
                <div class="detail-value">${address} <button class="copy-btn" onclick="copyToClipboard('${address}')"><i class="fas fa-copy"></i> Copy</button></div>
            </div>
            <div class="detail-row">
                <div class="detail-label"><i class="fas fa-exchange-alt"></i> Transactions</div>
                <div class="detail-value">${txCount}</div>
            </div>
        `;

        // Tabs
        html += `
            <div class="address-tabs">
                <button class="address-tab active" onclick="switchAddressTab('txs', this)">Transactions <span class="tab-count" id="addrTxCount">...</span></button>
                <button class="address-tab" onclick="switchAddressTab('tokens', this)">Token Holdings <span class="tab-count" id="addrTokenCount">...</span></button>
            </div>
            <div class="address-tab-content active" id="addrTabTxs"></div>
            <div class="address-tab-content" id="addrTabTokens"></div>
        `;

        content.innerHTML = html;

        // Search until we have the visible history rather than assuming a
        // wallet's transaction count says how far back its last activity is.
        const latestBlock = await provider.getBlockNumber();
        const addressLower = address.toLowerCase();
        const historyKey = `address_txs_${addressLower}_${latestBlock}`;
        const txsPromise = getCachedView(
            historyKey,
            () => findRecentTransactions(
                latestBlock,
                50,
                HISTORY.transactionsBlocks,
                tx => tx.from?.toLowerCase() === addressLower || tx.to?.toLowerCase() === addressLower
            )
        );
        const logScanDepth = Math.min(Math.max(txCount + 100, 10_000), 50_000);
        const logFromBlock = Math.max(0, latestBlock - logScanDepth);
        const transferLogsPromise = getCachedView(
            `address_logs_${addressLower}_${latestBlock}_${logScanDepth}`,
            () => fetchLogsByAddress(address, logFromBlock, latestBlock)
        );
        const txs = await txsPromise;

        // Render transactions tab
        document.getElementById('addrTxCount').textContent = txs.length + (txs.length >= 50 ? '+' : '');
        const txsTab = document.getElementById('addrTabTxs');
        if (txs.length > 0) {
            txsTab.innerHTML = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Tx Hash</th>
                            <th>Block</th>
                            <th>Age</th>
                            <th>From</th>
                            <th></th>
                            <th>To</th>
                            <th>Value</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${txs.map(tx => {
                            const isOut = tx.from?.toLowerCase() === address.toLowerCase();
                            return `<tr>
                                <td><span class="hash-link" onclick="navigateTo('tx-detail', '${tx.hash}')">${truncateHash(tx.hash)}</span></td>
                                <td><span class="hash-link" onclick="navigateTo('block-detail', ${tx.blockNumber || 0})">${tx.blockNumber || '-'}</span></td>
                                <td>${getTimeAgo(tx.blockTimestamp)}</td>
                                <td><span class="hash-link" onclick="navigateTo('address', '${tx.from}')">${truncateHash(tx.from)}</span></td>
                                <td><span style="color:${isOut ? 'var(--danger)' : 'var(--success)'};font-weight:600;font-size:11px">${isOut ? 'OUT' : 'IN'}</span></td>
                                <td>${tx.to ? `<span class="hash-link" onclick="navigateTo('address', '${tx.to}')">${truncateHash(tx.to)}</span>` : '<em>Contract</em>'}</td>
                                <td>${parseFloat(ethers.utils.formatEther(tx.value || 0)).toFixed(4)} GAPLO</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            `;
        } else {
            txsTab.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No transactions found in recent blocks</p></div>';
        }

        // Token Holdings tab - use eth_getLogs for efficient ERC-20 discovery (100k+ blocks!)
        const tokensTab = document.getElementById('addrTabTokens');
        tokensTab.innerHTML = '<div style="padding:16px;color:var(--text-secondary)"><i class="fas fa-spinner fa-spin"></i> Scanning for tokens via eth_getLogs...</div>';
        
        // The log request has been running alongside transaction discovery.
        const transferLogs = await transferLogsPromise;
        
        // Collect unique token contracts from Transfer events
        const tokenContracts = new Map();
        const addrLower = address.toLowerCase();
        for (const log of transferLogs) {
            if (log.topics && log.topics[0] === TRANSFER_TOPIC && log.topics.length >= 3) {
                const contractAddr = log.address.toLowerCase();
                if (!tokenContracts.has(contractAddr)) {
                    tokenContracts.set(contractAddr, log.address);
                }
            }
            if (tokenContracts.size >= 20) break;
        }
        
        // Batch fetch balances and names for discovered tokens (2 single HTTP requests)
        const tokenEntries = Array.from(tokenContracts.entries()).slice(0, 10);
        const tokenAddrs = tokenEntries.map(([_, addr]) => addr);
        const [tokenBals, tokenMetadata] = await Promise.all([
            getTokenBalancesBatch(tokenAddrs, address),
            getTokenMetadataBatch(tokenAddrs)
        ]);
        const discoveredTokens = [];
        for (let i = 0; i < tokenAddrs.length; i++) {
            const contractOrig = tokenAddrs[i];
            const bal = tokenBals[i];
            const resolvedMetadata = tokenMetadata.get(contractOrig.toLowerCase());
            if (bal && bal.gt(0)) {
                discoveredTokens.push({
                    address: contractOrig,
                    balance: bal,
                    token: resolvedMetadata,
                    name: resolvedMetadata?.name || ('Token ' + contractOrig.slice(0, 6) + '...' + contractOrig.slice(-4))
                });
            }
        }
        
        // Render token holdings
        let tokenCount = discoveredTokens.length + (aploBalance.gt(0) ? 1 : 0);
        document.getElementById('addrTokenCount').textContent = tokenCount;
        
        let tokenHtml = '<div class="token-holdings-list">';
        // Always show GAPLO
        tokenHtml += `
            <div class="token-holding-item">
                <div class="token-holding-icon" style="background:var(--bg-tertiary);color:var(--text-secondary)"><i class="fas fa-coins"></i></div>
                <div class="token-holding-info">
                    <div class="token-holding-name">GAPLO</div>
                    <div class="token-holding-address">Native Coin</div>
                </div>
                <div class="token-holding-balance">
                    <div class="token-holding-amount">${parseFloat(ethers.utils.formatEther(balance)).toFixed(6)}</div>
                    <div class="token-holding-usd">Native Balance</div>
                </div>
            </div>`;
        // Show APLO if balance > 0
        if (aploBalance.gt(0)) {
            tokenHtml += `
            <div class="token-holding-item">
                <div class="token-holding-icon">AP</div>
                <div class="token-holding-info">
                    <div class="token-holding-name">APLO</div>
                    <div class="token-holding-address">${APLO_TOKEN_ADDRESS}</div>
                </div>
                <div class="token-holding-balance">
                    <div class="token-holding-amount">${parseFloat(ethers.utils.formatUnits(aploBalance, 18)).toFixed(6)}</div>
                    <div class="token-holding-usd">APLO Token</div>
                </div>
            </div>`;
        }
        // Show discovered ERC-20 tokens
        for (const t of discoveredTokens) {
            tokenHtml += `
            <div class="token-holding-item">
                <div class="token-holding-icon" style="font-size:10px">${t.name.slice(0,2).toUpperCase()}</div>
                <div class="token-holding-info">
                    <div class="token-holding-name">${t.name}</div>
                    <div class="token-holding-address">${t.address}</div>
                </div>
                <div class="token-holding-balance">
                    <div class="token-holding-amount">${formatTokenValue(t.balance, t.token)}</div>
                    <div class="token-holding-usd">${escapeHtml(t.token?.symbol || 'ERC-20 Token')}</div>
                </div>
            </div>`;
        }
        tokenHtml += '</div>';
        tokensTab.innerHTML = tokenHtml;

    } catch (error) {
        content.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Error: ${escapeHtml(error.message)}</p></div>`;
    }
}

function switchAddressTab(tab, btn) {
    document.querySelectorAll('.address-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.address-tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(tab === 'txs' ? 'addrTabTxs' : 'addrTabTokens').classList.add('active');
}

// ========================================
// Search
// ========================================
let searchTimeout = null;
function performSearch() {
    const input = document.getElementById('searchInput').value.trim();
    if (!input) {
        showToast('Please enter a search term');
        return;
    }

    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        // Block number (plain digits)
        if (/^\d+$/.test(input)) {
            const blockNum = parseInt(input);
            if (blockNum < 0) {
                showToast('Block number must be positive');
                return;
            }
            navigateTo('block-detail', blockNum);
            return;
        }
        // Transaction or Block hash (0x + 64 hex chars)
        if (/^0x[a-fA-F0-9]{64}$/.test(input)) {
            // Try block hash first, then fall back to tx hash
            (async () => {
                try {
                    if (provider) {
                        const block = await provider.getBlock(input).catch(() => null);
                        if (block && block.number != null) {
                            navigateTo('block-detail', block.number);
                            return;
                        }
                    }
                } catch(e) {}
                navigateTo('tx-detail', input);
            })();
            return;
        }
        // Address (0x + 40 hex chars)
        if (/^0x[a-fA-F0-9]{40}$/.test(input)) {
            navigateTo('address', input);
            return;
        }
        // Partial match hints
        if (/^0x[a-fA-F0-9]{0,39}$/.test(input)) {
            showToast('Address must be 40 hex characters after 0x (' + input.length - 2 + '/40)');
        } else if (/^0x[a-fA-F0-9]{41,63}$/.test(input)) {
            showToast('Tx hash must be 64 hex characters after 0x (' + input.length - 2 + '/64)');
        } else if (/^0x/i.test(input)) {
            showToast('Invalid hex format. Check for typos.');
        } else {
            showToast('Search by block number, tx hash (0x...), or address (0x...)');
        }
    }, 150);
}

// ========================================
// Utilities
// ========================================
function truncateHash(h) {
    if (!h) return '-';
    if (h.length <= 16) return h;
    return h.substring(0, 8) + '...' + h.substring(h.length - 6);
}

function getTimeAgo(ts) {
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
}

function escapeHtml(t) {
    if (!t) return '';
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied!')).catch(() => {});
}

function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toastMessage').textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

function formatLargeNumber(n) {
    if (n >= 1e18) return (n / 1e18).toFixed(2) + ' E';
    if (n >= 1e15) return (n / 1e15).toFixed(2) + ' P';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + ' T';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' G';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + ' K';
    return n.toLocaleString();
}

function formatHashrate(difficulty, blockTime) {
    if (!difficulty || !blockTime || blockTime === 0) return '-';
    const hashrate = difficulty / blockTime;
    if (hashrate >= 1e12) return (hashrate / 1e12).toFixed(2) + ' TH/s';
    if (hashrate >= 1e9) return (hashrate / 1e9).toFixed(2) + ' GH/s';
    if (hashrate >= 1e6) return (hashrate / 1e6).toFixed(2) + ' MH/s';
    if (hashrate >= 1e3) return (hashrate / 1e3).toFixed(2) + ' KH/s';
    return hashrate.toFixed(2) + ' H/s';
}

// ========================================
// Init
// ========================================
document.addEventListener('DOMContentLoaded', init);
window.addEventListener('pagehide', persistCaches);

// Debounce helper
function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// Resize chart on window resize
window.addEventListener('resize', debounce(() => {
    if (currentPage === 'dashboard' && blockTimeData.length > 0) renderAllCharts();
}, 250));

function initSmoothWheelScroll() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || 'ontouchstart' in window) return;
    let targetY = window.scrollY;
    let currentY = window.scrollY;
    let animationFrame = null;

    const maxScrollY = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const animate = () => {
        currentY += (targetY - currentY) * 0.14;
        if (Math.abs(targetY - currentY) < 0.5) {
            window.scrollTo(0, targetY);
            animationFrame = null;
            return;
        }
        window.scrollTo(0, currentY);
        animationFrame = requestAnimationFrame(animate);
    };

    window.addEventListener('wheel', event => {
        if (event.ctrlKey || event.target.closest('.card-body, .table-container, .detail-value')) return;
        event.preventDefault();
        targetY = Math.max(0, Math.min(maxScrollY(), targetY + event.deltaY * 0.9));
        if (!animationFrame) animationFrame = requestAnimationFrame(animate);
    }, { passive: false });

    window.addEventListener('scroll', () => {
        if (!animationFrame) targetY = currentY = window.scrollY;
    }, { passive: true });
}

initSmoothWheelScroll();

// Clear stale caches on tab visibility change
let lastHiddenTime = 0;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        lastHiddenTime = Date.now();
    } else if (lastHiddenTime > 0 && Date.now() - lastHiddenTime > 60000) {
        blockCache.clear();
        txCache.clear();
        console.log('Cleared caches after tab was hidden');
    }
});
