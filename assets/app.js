/* duha — front-end logic
   Data: same-origin /api (proxied + cached by the duha server). If the
   backend is unavailable, it tries CoinGecko directly, then falls back to
   clearly-labelled demo data. */

(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const API = {
    markets: "/api/markets",
    global: "/api/global",
    watchlist: "/api/watchlist",
    subscribe: "/api/subscribe",
    directMarkets:
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=12&page=1&sparkline=true&price_change_percentage=24h",
    directGlobal: "https://api.coingecko.com/api/v3/global",
  };
  const CAN_SYNC = location.protocol === "http:" || location.protocol === "https:";

  const COLORS = {
    BTC: "#f7931a", ETH: "#8a9dff", SOL: "#14f195", XRP: "#7fd1ff",
    BNB: "#f3ba2f", ADA: "#4a7dff", DOGE: "#d4b44a", AVAX: "#e84142",
    LINK: "#5b8cff", DOT: "#e6007a", TON: "#4db8ff", LTC: "#b8bcc4",
    SHIB: "#f00500", TRX: "#ff5b5b", UNI: "#ff6fb5",
  };
  const GLYPHS = { BTC: "₿", ETH: "Ξ", DOGE: "Ð" };

  const state = {
    coins: [],
    global: null,
    source: "connecting",
    lastUpdated: null,
    range: "7d",
    tab: "all",
    query: "",
    watchlist: loadWatchlist(),
    rates: [],
  };

  /* ---------- formatting helpers ---------- */
  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function fmtPrice(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return "—";
    if (n >= 1) {
      return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (n >= 0.01) {
      return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    }
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 8 });
  }

  function fmtCompact(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return "—";
    return "$" + new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(n);
  }

  function fmtQty(v, code) {
    if (!Number.isFinite(v)) return "—";
    if (code === "USD") {
      return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    let max = 8;
    if (v >= 1000) max = 2;
    else if (v >= 1) max = 4;
    else if (v >= 0.0001) max = 6;
    return v.toLocaleString("en-US", { maximumFractionDigits: max });
  }

  function pct(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return "—";
    if (Number(n.toFixed(2)) === 0) return "0.00%";
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
  }

  function changeClass(n) {
    return Number(Number(n).toFixed(2)) >= 0 ? "up" : "down";
  }

  function timeShort(date) {
    if (!date) return "";
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function coinColor(symbol) {
    return COLORS[String(symbol || "").toUpperCase()] || "#9aa4b9";
  }

  function coinGlyph(symbol) {
    const s = String(symbol || "?").toUpperCase();
    return GLYPHS[s] || s.charAt(0);
  }

  function coinIcon(coin, large = false) {
    const cls = large ? " lg" : "";
    if (coin && coin.image) {
      return `<img class="coin-logo${cls}" src="${esc(coin.image)}" alt="" width="${large ? 30 : 28}" height="${large ? 30 : 28}" loading="lazy" data-letter="${esc(coinGlyph(coin.symbol))}" data-color="${coinColor(coin.symbol)}">`;
    }
    return `<span class="coin-letter${cls}" style="--c:${coinColor(coin.symbol)}">${esc(coinGlyph(coin.symbol))}</span>`;
  }

  function sevenDayChange(prices) {
    if (!Array.isArray(prices) || prices.length < 2) return NaN;
    const first = prices[0];
    const last = prices[prices.length - 1];
    if (!first) return NaN;
    return ((last - first) / first) * 100;
  }

  function sparkline(prices, up) {
    if (!Array.isArray(prices) || prices.length < 2) return "";
    const step = Math.max(1, Math.floor(prices.length / 70));
    const pts = prices.filter((_, i) => i % step === 0);
    if (pts[pts.length - 1] !== prices[prices.length - 1]) pts.push(prices[prices.length - 1]);
    const w = 104, h = 32, pad = 3;
    const min = Math.min(...pts), max = Math.max(...pts);
    const span = max - min || 1;
    const points = pts.map((p, i) =>
      `${((i / (pts.length - 1)) * w).toFixed(2)},${(pad + (1 - (p - min) / span) * (h - pad * 2)).toFixed(2)}`
    ).join(" ");
    return `<svg class="spark ${up ? "up" : "down"}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  /* ---------- fallback dataset (used until / unless the API answers) ---------- */
  const FALLBACK = [
    { id: "bitcoin", symbol: "btc", name: "Bitcoin", price: 104820, mcap: 2070000000000, vol: 48600000000, chg: 1.84, vola: 0.016 },
    { id: "ethereum", symbol: "eth", name: "Ethereum", price: 3240.55, mcap: 390000000000, vol: 21400000000, chg: 2.71, vola: 0.019 },
    { id: "tether", symbol: "usdt", name: "Tether", price: 1.0, mcap: 118000000000, vol: 68000000000, chg: 0.02, vola: 0.0004 },
    { id: "solana", symbol: "sol", name: "Solana", price: 188.42, mcap: 90000000000, vol: 6200000000, chg: 5.62, vola: 0.026 },
    { id: "binancecoin", symbol: "bnb", name: "BNB", price: 690.18, mcap: 99000000000, vol: 2100000000, chg: -0.74, vola: 0.014 },
    { id: "ripple", symbol: "xrp", name: "XRP", price: 2.36, mcap: 134000000000, vol: 5400000000, chg: -2.18, vola: 0.021 },
    { id: "dogecoin", symbol: "doge", name: "Dogecoin", price: 0.2415, mcap: 35000000000, vol: 2900000000, chg: 3.44, vola: 0.03 },
    { id: "cardano", symbol: "ada", name: "Cardano", price: 0.82, mcap: 29000000000, vol: 860000000, chg: -1.63, vola: 0.02 },
    { id: "avalanche-2", symbol: "avax", name: "Avalanche", price: 32.14, mcap: 13600000000, vol: 540000000, chg: 4.12, vola: 0.025 },
    { id: "chainlink", symbol: "link", name: "Chainlink", price: 18.62, mcap: 11800000000, vol: 720000000, chg: -0.92, vola: 0.018 },
    { id: "toncoin", symbol: "ton", name: "Toncoin", price: 5.12, mcap: 12800000000, vol: 310000000, chg: 1.22, vola: 0.017 },
    { id: "litecoin", symbol: "ltc", name: "Litecoin", price: 96.4, mcap: 7300000000, vol: 380000000, chg: -1.05, vola: 0.016 },
  ];

  function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeSeries(seed, endPrice, vola, length = 168) {
    const rand = seededRandom(seed);
    const raw = [];
    let value = 100;
    for (let i = 0; i < length; i++) {
      value *= 1 + (rand() - 0.5) * vola * 2 + Math.sin(i / 19) * 0.0016;
      raw.push(value);
    }
    const factor = endPrice / raw[raw.length - 1];
    return raw.map((v) => +(v * factor).toFixed(8));
  }

  function fallbackCoins() {
    return FALLBACK.map((c, i) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      image: "",
      current_price: c.price,
      market_cap: c.mcap,
      total_volume: c.vol,
      price_change_percentage_24h: c.chg,
      market_cap_rank: i + 1,
      circulating_supply: c.mcap / c.price,
      sparkline_in_7d: { price: makeSeries(101 + i * 53, c.price, c.vola) },
    }));
  }

  function deriveGlobal(coins) {
    const mcap = coins.reduce((sum, c) => sum + (Number(c.market_cap) || 0), 0);
    const vol = coins.reduce((sum, c) => sum + (Number(c.total_volume) || 0), 0);
    const btc = coins.find((c) => c.id === "bitcoin");
    return {
      total_market_cap: { usd: mcap },
      total_volume: { usd: vol },
      market_cap_percentage: { btc: btc && mcap ? (btc.market_cap / mcap) * 100 : 0 },
      active_cryptocurrencies: 17432,
    };
  }

  function normalizeCoins(list) {
    return (Array.isArray(list) ? list : [])
      .filter((c) => c && Number.isFinite(Number(c.current_price)))
      .slice(0, 12)
      .map((c, i) => {
        const prices = c.sparkline_in_7d && Array.isArray(c.sparkline_in_7d.price)
          ? c.sparkline_in_7d.price.filter((p) => Number.isFinite(Number(p))).map(Number)
          : [];
        return {
          ...c,
          market_cap_rank: c.market_cap_rank || i + 1,
          price_change_percentage_24h: Number(c.price_change_percentage_24h) || 0,
          sparkline_in_7d: {
            price: prices.length > 1 ? prices : makeSeries(97 + i * 41, Number(c.current_price) || 1, 0.02),
          },
        };
      });
  }

  function loadWatchlist() {
    try {
      const raw = JSON.parse(localStorage.getItem("duha:watchlist") || "[]");
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  }

  let watchlistTimer = null;

  function saveWatchlist() {
    try {
      localStorage.setItem("duha:watchlist", JSON.stringify([...state.watchlist]));
    } catch {
      /* storage may be disabled; the server copy still syncs */
    }
    syncWatchlistSoon();
  }

  function pushWatchlist() {
    if (!CAN_SYNC) return;
    fetch(API.watchlist, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ coins: [...state.watchlist] }),
    }).catch(() => {
      /* offline — local watchlist still works */
    });
  }

  function syncWatchlistSoon() {
    if (!CAN_SYNC) return;
    clearTimeout(watchlistTimer);
    watchlistTimer = setTimeout(pushWatchlist, 400);
  }

  async function syncWatchlistFromServer() {
    if (!CAN_SYNC) return;
    try {
      const response = await fetch(API.watchlist, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const payload = await response.json();
      const serverCoins = Array.isArray(payload.coins)
        ? payload.coins.filter((id) => typeof id === "string")
        : [];
      if (serverCoins.length) {
        const before = state.watchlist.size;
        serverCoins.forEach((id) => state.watchlist.add(id));
        if (state.watchlist.size !== before) {
          try {
            localStorage.setItem("duha:watchlist", JSON.stringify([...state.watchlist]));
          } catch {
            /* storage may be disabled */
          }
          renderTable();
        }
      } else if (state.watchlist.size) {
        pushWatchlist();
      }
    } catch {
      /* no backend — local watchlist still works */
    }
  }

  /* ---------- image fallback ---------- */
  document.addEventListener("error", (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("coin-logo")) return;
    const span = document.createElement("span");
    span.className = "coin-letter" + (img.classList.contains("lg") ? " lg" : "");
    span.textContent = img.dataset.letter || "?";
    span.style.setProperty("--c", img.dataset.color || "#9aa4b9");
    img.replaceWith(span);
  }, true);

  /* ---------- hero ---------- */
  function heroPrices() {
    const coin = state.coins.find((c) => c.id === "bitcoin") || state.coins[0];
    if (!coin) return [];
    const prices = (coin.sparkline_in_7d && coin.sparkline_in_7d.price) || [];
    return state.range === "24h" ? prices.slice(-25) : prices;
  }

  function chartPath(points) {
    if (points.length < 2) return "";
    let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return d;
  }

  let chartPoints = [];

  function drawHeroChart() {
    const wrap = $("#hero-chart");
    const svg = $("#hero-chart-svg");
    if (!wrap || !svg) return;
    const prices = heroPrices();
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    if (!prices || prices.length < 2 || width < 10 || height < 10) return;

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const padTop = 14;
    const padBottom = 6;
    const usable = height - padTop - padBottom;

    chartPoints = prices.map((price, i) => ({
      x: 2 + (i / (prices.length - 1)) * (width - 4),
      y: padTop + (1 - (price - min) / span) * usable,
      price,
    }));

    const line = chartPath(chartPoints);
    const area = `${line} L ${(width - 2).toFixed(2)} ${height} L 2 ${height} Z`;
    const up = prices[prices.length - 1] >= prices[0];
    const color = up ? "#8bf6c0" : "#ff7d94";

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    $("#chart-line").setAttribute("d", line);
    $("#chart-line").setAttribute("stroke", color);
    $("#chart-area").setAttribute("d", area);
    $("#chart-fill-top").setAttribute("stop-color", color);
    $("#chart-fill-bottom").setAttribute("stop-color", color);
    $("#hover-dot").setAttribute("fill", color);
    $("#hover-line").setAttribute("y2", height);

    const title = $("#hero-chart-title");
    const coin = state.coins.find((c) => c.id === "bitcoin") || state.coins[0];
    if (title && coin) {
      title.textContent = `${coin.name} price over the ${state.range === "24h" ? "past 24 hours" : "past 7 days"}`;
    }
  }

  function renderHero() {
    const coin = state.coins.find((c) => c.id === "bitcoin") || state.coins[0];
    if (!coin) return;
    $("#hero-coin-name").textContent = coin.name;
    $("#hero-coin-symbol").textContent = String(coin.symbol).toUpperCase();
    $("#hero-coin-rank").textContent = "#" + (coin.market_cap_rank || 1);
    $("#hero-coin-icon").innerHTML = coinIcon(coin, true);
    $("#hero-price").textContent = fmtPrice(coin.current_price);

    const change = Number(coin.price_change_percentage_24h);
    const pill = $("#hero-change");
    pill.textContent = pct(change);
    pill.className = "change-pill " + changeClass(change);

    $("#hero-mcap").textContent = fmtCompact(coin.market_cap);
    $("#hero-volume").textContent = fmtCompact(coin.total_volume);
    const supply = Number(coin.circulating_supply);
    let supplyLabel = "—";
    if (Number.isFinite(supply) && supply > 0) {
      if (supply >= 1e9) supplyLabel = (supply / 1e9).toFixed(1) + "B";
      else if (supply >= 1e6) supplyLabel = (supply / 1e6).toFixed(2) + "M";
      else supplyLabel = supply.toLocaleString("en-US", { maximumFractionDigits: 0 });
      supplyLabel += " " + String(coin.symbol).toUpperCase();
    }
    $("#hero-supply").textContent = supplyLabel;

    drawHeroChart();
  }

  function bindChartHover() {
    const wrap = $("#hero-chart");
    const tip = $("#chart-tip");
    if (!wrap || !tip) return;

    const hide = () => {
      $("#chart-hover").setAttribute("opacity", "0");
      tip.classList.remove("is-visible");
    };

    wrap.addEventListener("pointermove", (event) => {
      if (!chartPoints.length) return;
      const rect = wrap.getBoundingClientRect();
      const x = clamp(event.clientX - rect.left, 0, rect.width);
      const index = Math.round((x / Math.max(rect.width, 1)) * (chartPoints.length - 1));
      const point = chartPoints[index];
      if (!point) return;

      const line = $("#hover-line");
      const dot = $("#hover-dot");
      line.setAttribute("x1", point.x);
      line.setAttribute("x2", point.x);
      dot.setAttribute("cx", point.x);
      dot.setAttribute("cy", point.y);
      $("#chart-hover").setAttribute("opacity", "1");

      const hoursAgo = (chartPoints.length - 1 - index) * (state.range === "24h" ? 1 : 1);
      let label = hoursAgo <= 0 ? "now" : hoursAgo < 24 ? `${hoursAgo}h ago` : `${Math.round(hoursAgo / 24)}d ago`;
      tip.innerHTML = `<strong>${fmtPrice(point.price)}</strong><span>${label}</span>`;
      tip.style.left = clamp(point.x, 52, rect.width - 52) + "px";
      tip.style.top = clamp(point.y, 38, rect.height) + "px";
      tip.classList.add("is-visible");
    });

    wrap.addEventListener("pointerleave", hide);
    wrap.addEventListener("pointercancel", hide);
  }

  function bindRangeTabs() {
    const tabs = $("#range-tabs");
    if (!tabs) return;
    tabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-range]");
      if (!button) return;
      state.range = button.dataset.range;
      $$(".seg", tabs).forEach((seg) => {
        const active = seg === button;
        seg.classList.toggle("is-active", active);
        seg.setAttribute("aria-pressed", String(active));
      });
      drawHeroChart();
    });
  }

  /* ---------- ticker ---------- */
  function renderTicker() {
    const group = $("#ticker-group");
    const clone = $("#ticker-group-clone");
    if (!group || !clone) return;
    const html = state.coins.slice(0, 10).map((coin) => {
      const change = Number(coin.price_change_percentage_24h);
      return `<span class="tick"><span class="tick-sym">${esc(String(coin.symbol).toUpperCase())}</span><span class="tick-price">${fmtPrice(coin.current_price)}</span><span class="tick-change ${changeClass(change)}">${pct(change)}</span></span>`;
    }).join("");
    group.innerHTML = html;
    clone.innerHTML = html;
  }

  /* ---------- stats ---------- */
  function animateStat(el, target, format, duration = 1000) {
    if (!el || !Number.isFinite(target)) return;
    const start = performance.now();
    const from = 0;
    function frame(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = format(from + (target - from) * eased);
      if (progress < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function renderStats(animate = true) {
    const g = state.global || {};
    const mcap = Number(g.total_market_cap && g.total_market_cap.usd) || 0;
    const volume = Number(g.total_volume && g.total_volume.usd) || 0;
    const dominance = Number(g.market_cap_percentage && g.market_cap_percentage.btc) || 0;
    const assets = Number(g.active_cryptocurrencies) || 0;

    const apply = (sel, value, format) => {
      const el = $(sel);
      if (!el) return;
      if (animate && value > 0) {
        animateStat(el, value, format);
      } else {
        el.textContent = format(value);
      }
    };

    apply("#stat-mcap", mcap / 1e12, (v) => "$" + v.toFixed(2) + "T");
    apply("#stat-volume", volume / 1e9, (v) => "$" + v.toFixed(1) + "B");
    apply("#stat-dominance", dominance, (v) => v.toFixed(1) + "%");
    apply("#stat-assets", assets, (v) => Math.round(v).toLocaleString("en-US"));
  }

  /* ---------- status ---------- */
  function updateStatus() {
    const el = $("#data-status");
    if (!el) return;
    if (state.source === "live") {
      el.className = "market-status live";
      el.innerHTML = `<span class="status-dot"></span>Live · CoinGecko${state.lastUpdated ? " · " + timeShort(state.lastUpdated) : ""}`;
    } else if (state.source === "connecting") {
      el.className = "market-status pending";
      el.innerHTML = `<span class="status-dot"></span>${state.lastUpdated ? "Refreshing market data…" : "Demo data · connecting to CoinGecko…"}`;
    } else {
      el.className = "market-status demo";
      el.innerHTML = `<span class="status-dot"></span>Demo data · live feed unavailable`;
    }
  }

  /* ---------- data fetch ---------- */
  function getJSON(url, timeout = 6500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .finally(() => clearTimeout(timer));
  }

  function extractCoins(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
  }

  function extractGlobal(payload) {
    if (!payload) return null;
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) return payload.data;
    if (payload.total_market_cap) return payload;
    return null;
  }

  async function fetchPair(marketsUrl, globalUrl) {
    const results = await Promise.allSettled([
      getJSON(marketsUrl),
      getJSON(globalUrl),
    ]);
    return {
      coins: results[0].status === "fulfilled" ? normalizeCoins(extractCoins(results[0].value)) : [],
      global: results[1].status === "fulfilled" ? extractGlobal(results[1].value) : null,
    };
  }

  async function loadLiveData() {
    let { coins, global } = await fetchPair(API.markets, API.global);

    if (!coins.length) {
      ({ coins, global } = await fetchPair(API.directMarkets, API.directGlobal));
    }

    if (coins.length) {
      state.coins = coins;
      state.global = global && global.total_market_cap ? global : deriveGlobal(coins);
      state.source = "live";
      state.lastUpdated = new Date();
    } else {
      state.source = state.lastUpdated ? "live" : "demo";
      state.global = state.global || deriveGlobal(state.coins);
    }

    renderAll(true);
  }

  /* ---------- markets table ---------- */
  function filteredCoins() {
    return state.coins.filter((coin) => {
      if (state.tab === "gainers" && !(Number(coin.price_change_percentage_24h) > 0)) return false;
      if (state.tab === "losers" && !(Number(coin.price_change_percentage_24h) < 0)) return false;
      if (state.tab === "watchlist" && !state.watchlist.has(coin.id)) return false;
      if (state.query) {
        const haystack = `${coin.name} ${coin.symbol}`.toLowerCase();
        if (!haystack.includes(state.query)) return false;
      }
      return true;
    });
  }

  function renderTable() {
    const tbody = $("#market-body");
    const empty = $("#empty-state");
    if (!tbody) return;

    const coins = filteredCoins();
    tbody.innerHTML = coins.map((coin) => {
      const prices = (coin.sparkline_in_7d && coin.sparkline_in_7d.price) || [];
      const change24 = Number(coin.price_change_percentage_24h);
      const change7 = sevenDayChange(prices);
      const up24 = changeClass(change24) === "up";
      const up7 = changeClass(change7) === "up";
      const starred = state.watchlist.has(coin.id);
      const symbol = String(coin.symbol).toUpperCase();
      return `<tr data-id="${esc(coin.id)}">
        <td class="col-rank">${coin.market_cap_rank || "—"}</td>
        <td>
          <div class="asset">
            <span class="coin-avatar">${coinIcon(coin)}</span>
            <span class="asset-name"><span>${esc(coin.name)}</span><span class="asset-symbol">${esc(symbol)}</span></span>
          </div>
        </td>
        <td class="price">${fmtPrice(coin.current_price)}</td>
        <td><span class="change-pill ${up24 ? "up" : "down"}">${pct(change24)}</span></td>
        <td class="pct-cell ${up7 ? "up" : "down"} hide-sm">${pct(change7)}</td>
        <td class="muted-cell hide-lg">${fmtCompact(coin.market_cap)}</td>
        <td class="muted-cell hide-md">${fmtCompact(coin.total_volume)}</td>
        <td class="spark-cell hide-lg"><span class="spark-wrap">${sparkline(prices, up7)}</span></td>
        <td class="star-cell">
          <button class="star ${starred ? "on" : ""}" type="button" data-star="${esc(coin.id)}"
            aria-pressed="${starred}" aria-label="${starred ? "Remove" : "Add"} ${esc(coin.name)} ${starred ? "from" : "to"} watchlist"
            title="${starred ? "Remove from watchlist" : "Add to watchlist"}">
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.9L12 3.6z" fill="currentColor"/></svg>
          </button>
        </td>
      </tr>`;
    }).join("");

    if (empty) {
      empty.hidden = coins.length > 0;
      if (!coins.length) {
        const title = $("#empty-title");
        const sub = $("#empty-sub");
        let t = "Nothing to show";
        let s = "Try a different filter.";
        if (!state.coins.length) {
          t = "Waiting for market data";
          s = "The feed hasn't loaded yet — try refreshing.";
        } else if (state.tab === "watchlist" && !state.query) {
          t = "Your watchlist is empty";
          s = "Tap the star next to any asset to pin it here. It stays on this device.";
        } else if (state.query) {
          t = "No assets match";
          s = `Nothing matches “${$("#coin-search") ? $("#coin-search").value.trim() : ""}”. Try a ticker like BTC.`;
        }
        if (title) title.textContent = t;
        if (sub) sub.textContent = s;
      }
    }
  }

  /* ---------- market pulse ---------- */
  function renderPulse() {
    if (!state.coins.length) return;
    const sorted = [...state.coins].sort((a, b) =>
      (Number(b.price_change_percentage_24h) || 0) - (Number(a.price_change_percentage_24h) || 0)
    );
    const gainer = sorted[0];
    const loser = sorted[sorted.length - 1];
    const volume = [...state.coins].sort((a, b) => (Number(b.total_volume) || 0) - (Number(a.total_volume) || 0))[0];

    const setPulse = (key, coin, valueText) => {
      const avatar = $(`#pulse-${key}-avatar`);
      const name = $(`#pulse-${key}-coin`);
      const value = $(`#pulse-${key}-value`);
      if (avatar) avatar.innerHTML = coinIcon(coin);
      if (name) name.textContent = `${coin.name} · ${String(coin.symbol).toUpperCase()}`;
      if (value) value.textContent = valueText;
    };

    setPulse("gainer", gainer, pct(gainer.price_change_percentage_24h));
    setPulse("loser", loser, pct(loser.price_change_percentage_24h));
    setPulse("volume", volume, fmtCompact(volume.total_volume));
  }

  /* ---------- converter ---------- */
  function getRate(code) {
    return state.rates.find((rate) => rate.code === code);
  }

  function updateConversion() {
    const sendInput = $("#send-input");
    const receiveInput = $("#receive-input");
    const sendSelect = $("#send-select");
    const receiveSelect = $("#receive-select");
    if (!sendInput || !receiveInput || !sendSelect || !receiveSelect) return;

    const from = getRate(sendSelect.value);
    const to = getRate(receiveSelect.value);
    const fromLabel = $("#send-code-label");
    const toLabel = $("#receive-code-label");
    if (fromLabel) fromLabel.textContent = from ? from.name : "—";
    if (toLabel) toLabel.textContent = to ? to.name : "—";

    const amount = parseFloat(sendInput.value);
    if (!from || !to || !Number.isFinite(amount)) {
      receiveInput.value = "—";
      $("#convert-rate").textContent = "—";
      return;
    }

    const out = amount * (from.price / to.price);
    receiveInput.value = fmtQty(out, to.code);
    const rateLine = $("#convert-rate");
    if (rateLine) {
      rateLine.textContent = `1 ${from.code} = ${fmtQty(from.price / to.price, to.code)} ${to.code}`;
    }
    const updated = $("#convert-updated");
    if (updated) {
      updated.textContent = state.source === "live" && state.lastUpdated
        ? `Rates · ${timeShort(state.lastUpdated)}`
        : "Indicative demo rates";
    }
  }

  function renderConverter() {
    const sendSelect = $("#send-select");
    const receiveSelect = $("#receive-select");
    if (!sendSelect || !receiveSelect) return;

    const previousFrom = sendSelect.value || "USD";
    const previousTo = receiveSelect.value || "BTC";

    state.rates = [
      { code: "USD", name: "US Dollar", price: 1 },
      ...state.coins.map((coin) => ({
        code: String(coin.symbol).toUpperCase(),
        name: coin.name,
        price: Number(coin.current_price) || 0,
      })),
    ].filter((rate, index, arr) => rate.price > 0 && arr.findIndex((r) => r.code === rate.code) === index);

    const options = state.rates.map((rate) =>
      `<option value="${esc(rate.code)}">${esc(rate.code)}</option>`
    ).join("");
    sendSelect.innerHTML = options;
    receiveSelect.innerHTML = options;

    let from = state.rates.some((r) => r.code === previousFrom) ? previousFrom : "USD";
    let to = state.rates.some((r) => r.code === previousTo) ? previousTo : "BTC";
    if (from === to) {
      const alternative = state.rates.find((r) => r.code !== from);
      to = alternative ? alternative.code : "USD";
    }
    sendSelect.value = from;
    receiveSelect.value = to;
    updateConversion();
  }

  function sanitizeAmount(raw) {
    let value = String(raw).replace(/[^\d.]/g, "");
    const firstDot = value.indexOf(".");
    if (firstDot !== -1) {
      value = value.slice(0, firstDot + 1) + value.slice(firstDot + 1).replace(/\./g, "");
    }
    return value;
  }

  /* ---------- events ---------- */
  function bindEvents() {
    const tabs = $("#market-tabs");
    if (tabs) {
      tabs.addEventListener("click", (event) => {
        const button = event.target.closest("[data-tab]");
        if (!button) return;
        state.tab = button.dataset.tab;
        $$(".tab", tabs).forEach((tab) => {
          const active = tab === button;
          tab.classList.toggle("is-active", active);
          tab.setAttribute("aria-pressed", String(active));
        });
        renderTable();
      });
    }

    const search = $("#coin-search");
    if (search) {
      search.addEventListener("input", () => {
        state.query = search.value.trim().toLowerCase();
        renderTable();
      });
    }

    const reset = $("#empty-reset");
    if (reset) {
      reset.addEventListener("click", () => {
        state.query = "";
        if (search) search.value = "";
        state.tab = "all";
        $$("#market-tabs .tab").forEach((tab) => {
          const active = tab.dataset.tab === "all";
          tab.classList.toggle("is-active", active);
          tab.setAttribute("aria-pressed", String(active));
        });
        renderTable();
        if (search) search.focus();
      });
    }

    const body = $("#market-body");
    if (body) {
      body.addEventListener("click", (event) => {
        const button = event.target.closest("[data-star]");
        if (!button) return;
        const id = button.dataset.star;
        if (!id) return;
        if (state.watchlist.has(id)) state.watchlist.delete(id);
        else state.watchlist.add(id);
        saveWatchlist();

        if (state.tab === "watchlist") {
          renderTable();
          const tabsEl = $("#market-tabs .tab[aria-pressed='true']");
          if (tabsEl) tabsEl.focus();
          return;
        }

        const coin = state.coins.find((c) => c.id === id);
        const on = state.watchlist.has(id);
        button.classList.toggle("on", on);
        button.setAttribute("aria-pressed", String(on));
        button.setAttribute("aria-label", `${on ? "Remove" : "Add"} ${coin ? coin.name : "asset"} ${on ? "from" : "to"} watchlist`);
        button.title = on ? "Remove from watchlist" : "Add to watchlist";
      });
    }

    const refresh = $("#refresh-btn");
    if (refresh) {
      refresh.addEventListener("click", async () => {
        if (refresh.classList.contains("is-spinning")) return;
        refresh.classList.add("is-spinning");
        state.source = "connecting";
        updateStatus();
        try {
          await loadLiveData();
        } finally {
          setTimeout(() => refresh.classList.remove("is-spinning"), 350);
        }
      });
    }

    const sendInput = $("#send-input");
    const sendSelect = $("#send-select");
    const receiveSelect = $("#receive-select");
    if (sendInput) {
      sendInput.addEventListener("input", () => {
        const cleaned = sanitizeAmount(sendInput.value);
        if (cleaned !== sendInput.value) sendInput.value = cleaned;
        updateConversion();
      });
    }
    if (sendSelect) sendSelect.addEventListener("change", updateConversion);
    if (receiveSelect) receiveSelect.addEventListener("change", updateConversion);

    const swap = $("#swap-btn");
    if (swap && sendSelect && receiveSelect && sendInput) {
      swap.addEventListener("click", () => {
        const received = String($("#receive-input").value).replace(/[^\d.]/g, "");
        const previousFrom = sendSelect.value;
        sendSelect.value = receiveSelect.value;
        receiveSelect.value = previousFrom;
        if (received && parseFloat(received) > 0) {
          sendInput.value = String(Number(parseFloat(received).toFixed(8)));
        }
        swap.classList.add("is-spun");
        setTimeout(() => swap.classList.remove("is-spun"), 280);
        updateConversion();
      });
    }

    const form = $("#newsletter-form");
    if (form) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const email = $("#newsletter-email");
        const message = $("#newsletter-msg");
        if (!email || !message) return;
        const value = email.value.trim();
        const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        if (!valid) {
          message.textContent = "Please enter a valid email address.";
          message.className = "form-msg is-error";
          email.focus();
          return;
        }

        const button = form.querySelector('button[type="submit"]');
        message.textContent = "Subscribing…";
        message.className = "form-msg";
        if (button) {
          button.disabled = true;
          button.dataset.label = button.textContent;
          button.textContent = "Joining…";
        }

        try {
          const response = await fetch(API.subscribe, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ email: value, source: "site" }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || "Subscription failed");
          message.textContent = "You're on the list — thank you.";
          message.className = "form-msg";
          form.reset();
        } catch {
          message.textContent = CAN_SYNC
            ? "Couldn't reach the server. Please try again."
            : "Subscribe is available on the live site.";
          message.className = "form-msg is-error";
        } finally {
          if (button) {
            button.disabled = false;
            button.textContent = button.dataset.label || "Subscribe";
          }
        }
      });
    }

    const header = $("#site-header");
    const menuBtn = $("#menu-btn");
    const setMenu = (open) => {
      if (!header || !menuBtn) return;
      header.classList.toggle("nav-open", open);
      menuBtn.setAttribute("aria-expanded", String(open));
      menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    if (menuBtn) {
      menuBtn.addEventListener("click", () => {
        setMenu(!(header && header.classList.contains("nav-open")));
      });
    }
    $$("#mobile-nav a").forEach((link) => link.addEventListener("click", () => setMenu(false)));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setMenu(false);
    });
    window.addEventListener("resize", () => {
      if (window.innerWidth > 940) setMenu(false);
    });

    const onScroll = () => {
      if (header) header.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const heroCard = $("#hero-card");
    if (heroCard) {
      heroCard.addEventListener("pointermove", (event) => {
        const rect = heroCard.getBoundingClientRect();
        heroCard.style.setProperty("--mx", `${event.clientX - rect.left}px`);
        heroCard.style.setProperty("--my", `${event.clientY - rect.top}px`);
      });
    }

    if ("IntersectionObserver" in window) {
      const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          revealObserver.unobserve(entry.target);
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
      $$(".reveal").forEach((el) => revealObserver.observe(el));

      const navLinks = $$(".nav-links a[data-nav]");
      if (navLinks.length) {
        const navObserver = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            navLinks.forEach((link) => {
              link.classList.toggle("is-active", link.dataset.nav === entry.target.id);
            });
          });
        }, { rootMargin: "-45% 0px -50% 0px" });
        ["markets", "pulse", "features", "learn", "convert"].forEach((id) => {
          const section = document.getElementById(id);
          if (section) navObserver.observe(section);
        });
      }
    } else {
      $$(".reveal").forEach((el) => el.classList.add("is-in"));
    }

    const chart = $("#hero-chart");
    if (chart && "ResizeObserver" in window) {
      new ResizeObserver(() => drawHeroChart()).observe(chart);
    } else {
      window.addEventListener("resize", drawHeroChart);
    }
  }


  /* ---------- boot ---------- */
  function init() {
    const year = $("#year");
    if (year) year.textContent = String(new Date().getFullYear());

    state.coins = fallbackCoins();
    state.global = deriveGlobal(state.coins);
    state.source = "connecting";
    state.lastUpdated = null;

    renderHero();
    renderTicker();
    renderStats(false);
    renderTable();
    renderPulse();
    renderConverter();
    updateStatus();

    bindChartHover();
    bindRangeTabs();
    bindEvents();

    loadLiveData();
    syncWatchlistFromServer();
  }

  function renderAll(animateStats = true) {
    renderHero();
    renderTicker();
    renderStats(animateStats);
    renderTable();
    renderPulse();
    renderConverter();
    updateStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
