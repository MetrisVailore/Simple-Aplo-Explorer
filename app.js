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

// ERC-20 Transfer event signature
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
const deduplicator = new RequestDeduplicator();

// Chart data arrays
let blockTimeData = [];
let difficultyData = [];
let gasPriceData = [];
let gasUsageData = [];
let gasPriceHistory = [];

// Chart hover state per canvas
let chartStates = {};

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
async function init() {
    initTheme();

    try {
        provider = new ethers.providers.JsonRpcProvider('https://pub1.aplocoin.com');
        const blockNumber = await provider.getBlockNumber();
        currentBlockNumber = blockNumber;
        previousBlockNumber = blockNumber;
        updateConnectionStatus(true, 'Connected');

        // Start loading
        loadDashboard();
        startLiveUpdates();
        startBackgroundPreloader();

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
function navigateTo(page, data) {
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

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

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

        // Fetch blocks for stats and chart (reduced from 52 to 30)
        const blockPromises = [];
        for (let i = 0; i < 30; i++) {
            blockPromises.push(getBlockCached(blockNumber - i));
        }
        const blocks = (await Promise.allSettled(blockPromises))
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => r.value);

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
        blockTimeData = [];
        difficultyData = [];
        gasUsageData = [];

        if (blocks.length > 0) {
            // Difficulty & Hashrate
            const diff = Number(blocks[0].difficulty) || 0;
            if (diff > 0) {
                document.getElementById('networkDifficulty').textContent = formatLargeNumber(diff);
                document.getElementById('networkHashrate').textContent = formatHashrate(diff, avgTime);
            }
            for (let i = 0; i < blocks.length - 1; i++) {
                blockTimeData.push({ block: blocks[i].number, value: blocks[i].timestamp - blocks[i + 1].timestamp });
                difficultyData.push({ block: blocks[i].number, value: Number(blocks[i].difficulty) || 0 });
                const gu = blocks[i].gasUsed, gl = blocks[i].gasLimit;
                if (gu && gl && gl.toNumber() > 0) {
                    gasUsageData.push({ block: blocks[i].number, value: (gu.toNumber() / gl.toNumber()) * 100 });
                }
            }
            blockTimeData.reverse();
            difficultyData.reverse();
            gasUsageData.reverse();

            // Gas price from recent block headers (eth_getBlockByNumber doesn't include gasPrice, but we can estimate)
            // For gas price, we use the current gas price for now and track history
            gasPriceHistory.push({ block: blockNumber, value: parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei')) });
            if (gasPriceHistory.length > 50) gasPriceHistory.shift();
            gasPriceData = gasPriceHistory.slice().reverse();

            // Render all charts
            renderAllCharts();

            // Chart badges
            document.getElementById('chartAvgBadge').textContent = 'Avg: ' + avgTime.toFixed(1) + 's';
            document.getElementById('chartDiffBadge').textContent = 'Latest: ' + formatLargeNumber(difficultyData[0]?.value || 0);
            document.getElementById('chartGasBadge').textContent = 'Current: ' + parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei')).toFixed(2) + ' Gwei';
            const avgGasUsage = gasUsageData.length > 0 ? gasUsageData.reduce((s, d) => s + d.value, 0) / gasUsageData.length : 0;
            document.getElementById('chartGasUsageBadge').textContent = 'Avg: ' + avgGasUsage.toFixed(1) + '%';
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

        // Load latest transactions (reduced from 5 to 3 blocks)
        const txBlockPromises = [];
        for (let i = 0; i < 3; i++) {
            txBlockPromises.push(getBlockWithTxsCached(blockNumber - i));
        }
        const txBlocks = (await Promise.allSettled(txBlockPromises))
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => r.value);

        const txsHtml = [];
        let txCount = 0;
        for (const block of txBlocks) {
            if (txCount >= 15) break;
            if (block.transactions) {
                const recent = block.transactions.slice(-10).reverse();
                for (const tx of recent) {
                    if (txCount >= 15) break;
                    txsHtml.push(createTxItemHtml(tx, block.timestamp));
                    txCount++;
                }
            }
        }
        document.getElementById('latestTransactions').innerHTML =
            txsHtml.length > 0 ? txsHtml.join('') : '<div class="empty-state"><i class="fas fa-inbox"></i><p>No transactions found</p></div>';

        // Update hero tx count
        let totalTxs = 0;
        txBlocks.forEach(b => { if (b.transactions) totalTxs += b.transactions.length; });
        const avgTxsPerBlock = txBlocks.length > 0 ? totalTxs / txBlocks.length : 1;
        document.getElementById('heroTxs').textContent = '~' + (blockNumber * Math.max(avgTxsPerBlock, 1)).toLocaleString(undefined, {maximumFractionDigits: 0});

        // Load token transfers from recent blocks
        loadRecentTokenTransfers(txBlocks);

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

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 200 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '200px';
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = 200;
    const padding = { top: 16, right: 16, bottom: 28, left: 56 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#94a3b8' : '#64748b';
    const gridColor = isDark ? '#1e2a42' : '#e2e8f0';
    const lineColor = isDark ? opts.color : opts.colorLight;
    const fillColor = isDark ? opts.fillColor : opts.fillColorLight;
    const hoverColor = lineColor;

    const values = data.map(d => d.value);
    const maxVal = Math.max(...values) * 1.15;
    const minVal = Math.min(...values) * 0.85;
    const range = maxVal - minVal || 1;
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
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fillStyle = hoverColor;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x, y, 9, 0, Math.PI * 2);
            ctx.fillStyle = hoverColor + '25';
            ctx.fill();

            // Tooltip
            const tooltipText = opts.tooltipFn(d);
            ctx.font = '11px Inter, sans-serif';
            const textW = ctx.measureText(tooltipText).width;
            const tw = textW + 14;
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
                ctx.fillText('#' + d.block, x, h - 6);
            }
        });
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
                <div class="value">${parseFloat(value).toFixed(4)} APLO</div>
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

        return { from, to, value, contractAddress, txHash: log.transactionHash, blockNumber: log.blockNumber };
    } catch (e) {
        return null;
    }
}

async function loadRecentTokenTransfers(blocks) {
    const container = document.getElementById('latestTokenTransfers');
    if (!container) return;

    const transfers = [];

    for (const block of blocks.slice(0, 3)) {
        if (!block.transactions) continue;
        for (const tx of block.transactions.slice(0, 20)) {
            try {
                const receipt = await getReceiptCached(tx.hash);
                if (receipt && receipt.logs) {
                    for (const log of receipt.logs) {
                        const transfer = parseTransferLog(log);
                        if (transfer) {
                            transfer.blockTimestamp = block.timestamp;
                            transfers.push(transfer);
                            if (transfers.length >= 10) break;
                        }
                    }
                }
            } catch (e) {}
            if (transfers.length >= 10) break;
        }
        if (transfers.length >= 10) break;
    }

    if (transfers.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-coins"></i><p>No ERC-20 token transfers found in recent blocks</p></div>';
        return;
    }        container.innerHTML = transfers.map(t => `
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
                <div class="value">${formatTokenValue(t.value)}</div>
                <div class="sub"><span class="hash-link" onclick="navigateTo('address', '${t.contractAddress}')">${truncateHash(t.contractAddress)}</span></div>
            </div>
        </div>
    `).join('');
}

function formatTokenValue(value) {
    try {
        const str = value.toString();
        if (str.length > 18) {
            const intPart = str.slice(0, str.length - 18);
            const decPart = str.slice(str.length - 18, str.length - 14);
            return intPart + '.' + decPart;
        }
        return '0.' + str.padStart(18, '0').slice(0, 4);
    } catch (e) {
        return value.toString();
    }
}

// ========================================
// Token Transfers Page
// ========================================
async function loadTokenTransfers() {
    const tbody = document.getElementById('tokenTransfersBody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell"><div class="skeleton-table-row"></div></td></tr>';

    try {
        const latestBlock = await provider.getBlockNumber();
        const transfers = [];

        // Scan blocks for token transfers - batch receipts for speed
        const blockNumbers = [];
        for (let i = latestBlock; i >= Math.max(0, latestBlock - 100) && blockNumbers.length < 30; i--) {
            blockNumbers.push(i);
        }
        const blockResults = await parallelBatch(blockNumbers, (n) => getBlockWithTxsCached(n), 5);

        for (const r of blockResults) {
            if (transfers.length >= tokenTransfersPage * 20) break;
            if (r.status !== 'fulfilled' || !r.value || !r.value.transactions) continue;
            const txs = r.value.transactions.slice(0, 30);

            // Batch fetch all receipts for this block
            const receiptResults = await parallelBatch(
                txs.map(tx => tx.hash),
                (h) => getReceiptCached(h),
                10
            );

            for (const rr of receiptResults) {
                if (rr.status !== 'fulfilled' || !rr.value || !rr.value.logs) continue;
                for (const log of rr.value.logs) {
                    const transfer = parseTransferLog(log);
                    if (transfer) transfers.push(transfer);
                }
            }
        }

        // Paginate
        const start = (tokenTransfersPage - 1) * 20;
        const pageTxs = transfers.slice(start, start + 20);

        tbody.innerHTML = pageTxs.map(t => `
            <tr>
                <td><span class="hash-link" onclick="navigateTo('tx-detail', '${t.txHash}')">${truncateHash(t.txHash)}</span></td>
                <td>${t.blockNumber}</td>
                <td><span class="hash-link" onclick="navigateTo('address', '${t.from}')">${truncateHash(t.from)}</span></td>
                <td><span class="hash-link" onclick="navigateTo('address', '${t.to}')">${truncateHash(t.to)}</span></td>
                <td>${formatTokenValue(t.value)}</td>
                <td><span class="hash-link" onclick="navigateTo('address', '${t.contractAddress}')">${truncateHash(t.contractAddress)}</span></td>
            </tr>
        `).join('') || '<tr><td colspan="6" class="loading-cell">No token transfers found</td></tr>';

        // Simple pagination
        const totalPages = Math.max(1, Math.ceil(transfers.length / 20));
        renderSimplePagination('tokenTransfersPagination', tokenTransfersPage, totalPages, (p) => {
            tokenTransfersPage = p;
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
        const minerCounts = {};
        const minerLastBlock = {};
        const blocksToScan = 200;

        // Scan blocks
        const blockNumbers = [];
        for (let i = latestBlock; i >= Math.max(0, latestBlock - blocksToScan); i--) {
            blockNumbers.push(i);
        }

        const results = await parallelBatch(blockNumbers, (num) => getBlockCached(num), 15);

        for (const r of results) {
            if (r.status !== 'fulfilled' || !r.value) continue;
            const b = r.value;
            if (b.miner) {
                minerCounts[b.miner] = (minerCounts[b.miner] || 0) + 1;
                if (!minerLastBlock[b.miner] || b.number > minerLastBlock[b.miner]) {
                    minerLastBlock[b.miner] = b.number;
                }
            }
        }

        // Sort by blocks mined
        const sorted = Object.entries(minerCounts)
            .sort((a, b) => b[1] - a[1]);
        const totalBlocks = sorted.reduce((s, [, c]) => s + c, 0);

        tbody.innerHTML = sorted.map(([addr, count], i) => `
            <tr>
                <td>${i + 1}</td>
                <td><span class="hash-link" onclick="navigateTo('address', '${addr}')">${truncateHash(addr)}</span></td>
                <td>${count}</td>
                <td>${((count / totalBlocks) * 100).toFixed(2)}%</td>
                <td>${minerLastBlock[addr] ? '#' + minerLastBlock[addr] : '-'}</td>
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
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell"><div class="skeleton-table-row"></div></td></tr>';

    try {
        const latestBlock = await provider.getBlockNumber();
        const startBlock = latestBlock - (blocksPage - 1) * blocksPerPage;
        const endBlock = Math.max(0, startBlock - blocksPerPage + 1);

        const nums = [];
        for (let i = startBlock; i >= endBlock; i--) nums.push(i);

        const results = await parallelBatch(nums, (n) => getBlockCached(n), 10);
        const blocks = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

        tbody.innerHTML = blocks.map(b => `
            <tr>
                <td><span class="hash-link" onclick="navigateTo('block-detail', ${b.number})">${b.number}</span></td>
                <td>${getTimeAgo(b.timestamp)}</td>
                <td>${b.transactions ? b.transactions.length : 0}</td>
                <td>${b.gasUsed ? b.gasUsed.toNumber().toLocaleString() : '-'}</td>
                <td>${b.gasLimit ? b.gasLimit.toNumber().toLocaleString() : '-'}</td>
                <td><span class="hash-link" onclick="navigateTo('address', '${b.miner}')">${truncateHash(b.miner)}</span></td>
            </tr>
        `).join('');

        document.getElementById('blocksSubtitle').textContent = `Block #${startBlock} to #${endBlock}`;
        renderBlocksPagination(latestBlock);
    } catch (error) {
        console.error('Blocks error:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Error loading blocks</td></tr>';
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

function goToBlocksPage(p) { if (p < 1) return; blocksPage = p; loadBlocks(); }

// ========================================
// Transactions Page
// ========================================
async function loadTransactions() {
    const tbody = document.getElementById('transactionsTableBody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell"><div class="skeleton-table-row"></div></td></tr>';

    try {
        const latestBlock = await provider.getBlockNumber();
        const blockNums = [];
        for (let i = latestBlock; i >= Math.max(0, latestBlock - 50); i--) blockNums.push(i);

        const results = await parallelBatch(blockNums, (n) => getBlockWithTxsCached(n), 5);
        const allTxs = [];

        for (const r of results) {
            if (r.status !== 'fulfilled' || !r.value) continue;
            const b = r.value;
            if (b.transactions) {
                for (const tx of b.transactions) {
                    allTxs.push({ ...tx, blockTimestamp: b.timestamp });
                }
            }
        }

        allTxs.reverse();
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
                txFee = parseFloat(ethers.utils.formatEther(tx.gasUsed.mul(tx.gasPrice))).toFixed(6) + ' APLO';
            }
            return `
                <tr>
                    <td><span class="hash-link" onclick="navigateTo('tx-detail', '${tx.hash}')">${truncateHash(tx.hash)}</span></td>
                    <td><span class="hash-link" onclick="navigateTo('block-detail', ${tx.blockNumber})">${tx.blockNumber || '-'}</span></td>
                    <td><span class="hash-link" onclick="navigateTo('address', '${tx.from}')">${truncateHash(tx.from)}</span></td>
                    <td>${tx.to ? `<span class="hash-link" onclick="navigateTo('address', '${tx.to}')">${truncateHash(tx.to)}</span>` : '<em>Contract</em>'}</td>
                    <td>${parseFloat(value).toFixed(4)} APLO</td>
                    <td>${txFee}</td>
                </tr>
            `;
        }).join('') || '<tr><td colspan="6" class="loading-cell">No transactions found</td></tr>';

        renderSimplePagination('transactionsPagination', txsPage, 100, (p) => {
            txsPage = p;
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

        const gasPercent = block.gasUsed && block.gasLimit ? ((block.gasUsed.toNumber() / block.gasLimit.toNumber()) * 100).toFixed(2) : '-';

        let html = `
            <div class="detail-row"><div class="detail-label"><i class="fas fa-hashtag"></i> Block Number</div><div class="detail-value">${block.number}</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-clock"></i> Timestamp</div><div class="detail-value">${new Date(block.timestamp * 1000).toLocaleString()} (${getTimeAgo(block.timestamp)})</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-link"></i> Hash</div><div class="detail-value">${block.hash} <button class="copy-btn" onclick="copyToClipboard('${block.hash}')"><i class="fas fa-copy"></i> Copy</button></div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-arrow-left"></i> Parent Hash</div><div class="detail-value"><span class="hash-link" onclick="navigateTo('block-detail', ${block.number - 1})">${block.parentHash}</span></div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-user"></i> Miner</div><div class="detail-value"><span class="hash-link" onclick="navigateTo('address', '${block.miner}')">${block.miner}</span> <button class="copy-btn" onclick="copyToClipboard('${block.miner}')"><i class="fas fa-copy"></i></button></div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-gas-pump"></i> Gas Used</div><div class="detail-value">${block.gasUsed ? block.gasUsed.toNumber().toLocaleString() : '-'} (${gasPercent}%)</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-fire"></i> Gas Limit</div><div class="detail-value">${block.gasLimit ? block.gasLimit.toNumber().toLocaleString() : '-'}</div></div>
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
                                    <div class="item-detail">From: <span class="hash-link" onclick="navigateTo('address', '${tx.from}')">${truncateHash(tx.from)}</span> → ${tx.to ? `<span class="hash-link" onclick="navigateTo('address', '${tx.to}')">${truncateHash(tx.to)}</span>` : 'Contract'} | ${parseFloat(ethers.utils.formatEther(tx.value)).toFixed(4)} APLO</div>
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
            gasUsed = receipt.gasUsed.toNumber().toLocaleString();
            txFee = parseFloat(ethers.utils.formatEther(receipt.gasUsed.mul(tx.gasPrice))).toFixed(6) + ' APLO';
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
            <div class="detail-row"><div class="detail-label"><i class="fas fa-coins"></i> Value</div><div class="detail-value">${parseFloat(value).toFixed(6)} APLO</div></div>
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
                html += `<div class="detail-row"><div class="detail-label"><i class="fas fa-coins"></i> Token Transfers</div><div class="detail-value"><div class="detail-txs">`;
                for (const log of tokenTransfers) {
                    const t = parseTransferLog(log);
                    if (t) {
                        html += `
                            <div class="token-transfer-item">
                                <div class="token-item-icon" style="width:32px;height:32px;font-size:14px"><i class="fas fa-coins"></i></div>
                                <div class="item-info">
                                    <div class="item-detail">
                                        <span class="hash-link" onclick="navigateTo('address', '${t.from}')">${truncateHash(t.from)}</span>
                                        → <span class="hash-link" onclick="navigateTo('address', '${t.to}')">${truncateHash(t.to)}</span>
                                        | ${formatTokenValue(t.value)} tokens
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
        const [balance, txCount] = await Promise.all([
            getBalanceCached(address),
            provider.getTransactionCount(address)
        ]);

        let html = `
            <div class="detail-row"><div class="detail-label"><i class="fas fa-wallet"></i> Address</div><div class="detail-value">${address} <button class="copy-btn" onclick="copyToClipboard('${address}')"><i class="fas fa-copy"></i> Copy</button></div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-coins"></i> Balance</div><div class="detail-value">${parseFloat(ethers.utils.formatEther(balance)).toFixed(6)} APLO</div></div>
            <div class="detail-row"><div class="detail-label"><i class="fas fa-exchange-alt"></i> Transactions</div><div class="detail-value">${txCount}</div></div>
        `;

        content.innerHTML = html;

        // Scan for transactions
        const latestBlock = await provider.getBlockNumber();
        const txs = [];
        const blockNums = [];
        for (let i = latestBlock; i >= Math.max(0, latestBlock - 100) && txs.length < 20; i--) blockNums.push(i);

        const results = await parallelBatch(blockNums, (n) => getBlockWithTxsCached(n), 5);
        for (const r of results) {
            if (txs.length >= 20) break;
            if (r.status !== 'fulfilled' || !r.value) continue;
            const b = r.value;
            if (b.transactions) {
                for (const tx of b.transactions) {
                    if (tx.from === address || tx.to === address) {
                        txs.push({ ...tx, blockTimestamp: b.timestamp });
                        if (txs.length >= 20) break;
                    }
                }
            }
        }

        if (txs.length > 0) {
            content.innerHTML += `
                <div class="detail-row">
                    <div class="detail-label"><i class="fas fa-list"></i> Recent Transactions</div>
                    <div class="detail-value"><div class="detail-txs">
                        ${txs.map(tx => `
                            <div class="tx-item">
                                <div class="tx-item-icon" style="width:32px;height:32px;font-size:14px"><i class="fas fa-exchange-alt"></i></div>
                                <div class="item-info">
                                    <div class="item-row"><span class="item-link" onclick="navigateTo('tx-detail', '${tx.hash}')">${truncateHash(tx.hash)}</span><span class="item-time">${getTimeAgo(tx.blockTimestamp)}</span></div>
                                    <div class="item-detail">${tx.from.toLowerCase() === address.toLowerCase() ? `<span style="color:var(--danger)">Out</span> → ${tx.to ? `<span class="hash-link" onclick="navigateTo('address', '${tx.to}')">${truncateHash(tx.to)}</span>` : 'Contract'}` : `<span style="color:var(--success)">In</span> ← <span class="hash-link" onclick="navigateTo('address', '${tx.from}')">${truncateHash(tx.from)}</span>`} | ${parseFloat(ethers.utils.formatEther(tx.value)).toFixed(4)} APLO</div>
                                </div>
                            </div>
                        `).join('')}
                    </div></div>
                </div>
            `;
        }
    } catch (error) {
        content.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Error: ${escapeHtml(error.message)}</p></div>`;
    }
}

// ========================================
// Search
// ========================================
let searchTimeout = null;
function performSearch() {
    const input = document.getElementById('searchInput').value.trim();
    if (!input) return;

    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        if (/^\d+$/.test(input)) { navigateTo('block-detail', parseInt(input)); return; }
        if (/^0x[a-fA-F0-9]{64}$/.test(input)) { navigateTo('tx-detail', input); return; }
        if (/^0x[a-fA-F0-9]{40}$/.test(input)) { navigateTo('address', input); return; }
        showToast('Invalid search. Enter a block number, tx hash, or address.');
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
    if (blockTimeData.length > 0) renderAllCharts();
}, 250));

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
