// Core Keepa analysis logic — mirrors keepa_analyzer.py

const KEEPA_BASE = "https://api.keepa.com/product";
const KEEPA_EPOCH_START = new Date("2011-01-01T00:00:00Z").getTime();

function keepaTimeToDt(keepaMinutes) {
  try {
    return new Date(KEEPA_EPOCH_START + keepaMinutes * 60 * 1000);
  } catch {
    return null;
  }
}

function kp(val) {
  return val && val > 0 ? Math.round(val) / 100 : null;
}

function validatePrice(p, maxPrice = 5000) {
  if (p && p > maxPrice) return null;
  return p;
}

function last12Months() {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    let m = now.getMonth() + 1 - i;
    let y = now.getFullYear();
    while (m <= 0) { m += 12; y -= 1; }
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return months;
}

function parseMonthlySales(prod) {
  const now = new Date();
  const monthly = {};
  const history = prod.monthlySoldHistory;
  if (history && Array.isArray(history) && history.length >= 2) {
    for (let i = 0; i < history.length - 1; i += 2) {
      const kt = history[i];
      const count = history[i + 1];
      if (kt == null || count == null || count < 0) continue;
      const dt = keepaTimeToDt(kt);
      if (dt && (now - dt) / (1000 * 60 * 60 * 24) <= 395) {
        const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
        monthly[key] = Math.floor(count);
      }
    }
    if (Object.keys(monthly).length > 0) return monthly;
  }
  const ms = prod.monthlySold;
  if (ms && ms > 0) {
    const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    monthly[key] = Math.floor(ms);
  }
  return monthly;
}

function getAllPrices(prod) {
  const stats = prod.stats || {};
  function bbFromAvg(arr) {
    if (Array.isArray(arr) && arr.length > 18) {
      const v = arr[18];
      return v && v > 0 ? kp(v) : null;
    }
    return null;
  }

  let current = null;
  const bb = stats.buyBoxPrice;
  if (Array.isArray(bb)) {
    const v = bb.find(x => typeof x === "number" && x >= 0);
    if (v) current = kp(v);
  }
  if (!current) {
    const csvData = prod.csv || [];
    for (const ci of [18, 1]) {
      if (csvData.length > ci && Array.isArray(csvData[ci])) {
        const arr = csvData[ci];
        for (let j = arr.length - 1; j > 0; j -= 2) {
          const val = arr[j];
          if (typeof val === "number" && val > 0) {
            current = kp(val);
            break;
          }
        }
      }
      if (current) break;
    }
  }

  return {
    current: validatePrice(current),
    avg30: validatePrice(bbFromAvg(stats.avg30)),
    avg90: validatePrice(bbFromAvg(stats.avg90)),
    avg180: validatePrice(bbFromAvg(stats.avg180)),
    avg365: validatePrice(bbFromAvg(stats.avg365)),
  };
}

function calcFees(price, referralPct = 15.0, pickAndPack = null) {
  if (!price) return { referralFee: null, ppFee: null, totalFee: null };
  const ref = Math.round(price * (referralPct / 100.0) * 100) / 100;
  let ful;
  if (pickAndPack != null) {
    ful = pickAndPack;
  } else {
    if (price < 10) ful = 2.47;
    else if (price < 15) ful = 3.22;
    else if (price < 20) ful = 4.75;
    else if (price < 40) ful = 5.85;
    else if (price < 75) ful = 7.17;
    else ful = 9.73;
  }
  ful = Math.round(ful * 100) / 100;
  return {
    referralFee: ref,
    ppFee: ful,
    totalFee: Math.round((ref + ful) * 100) / 100,
  };
}

function getMonthlyPriceHistory(prod, targetMonths) {
  const csvData = prod.csv || [];
  if (csvData.length <= 18 || !Array.isArray(csvData[18])) return {};
  const bbArr = csvData[18];
  if (bbArr.length < 2) return {};

  const entries = [];
  for (let i = 0; i < bbArr.length - 1; i += 2) {
    const kt = bbArr[i];
    const prc = bbArr[i + 1];
    if (kt == null || prc == null) continue;
    if (prc <= 0) {
      const dt = keepaTimeToDt(kt);
      if (dt) entries.push({ dt, price: null });
      continue;
    }
    if (prc > 500000) continue;
    const dt = keepaTimeToDt(kt);
    if (dt) entries.push({ dt, price: Math.round(prc) / 100 });
  }
  if (!entries.length) return {};

  const result = {};
  for (const [yr, mo] of targetMonths) {
    const key = `${yr}-${String(mo).padStart(2, "0")}`;
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const moStart = new Date(Date.UTC(yr, mo - 1, 1));
    const moEnd = new Date(Date.UTC(yr, mo - 1, daysInMonth, 23, 59, 59));

    const pricesInMonth = [];
    for (let idx = 0; idx < entries.length; idx++) {
      const { dt, price } = entries[idx];
      const nextDt = idx + 1 < entries.length ? entries[idx + 1].dt : new Date(moEnd.getTime() + 86400000);
      if (nextDt <= moStart) continue;
      if (dt > moEnd) break;
      if (price == null) continue;

      const periodStart = dt > moStart ? dt : moStart;
      const periodEnd = nextDt < new Date(moEnd.getTime() + 1000) ? nextDt : new Date(moEnd.getTime() + 1000);
      const overlapSeconds = (periodEnd - periodStart) / 1000;
      if (overlapSeconds <= 0) continue;
      pricesInMonth.push({ price, days: overlapSeconds / 86400 });
    }

    if (!pricesInMonth.length) { result[key] = null; continue; }
    const totalDays = pricesInMonth.reduce((s, p) => s + p.days, 0);
    if (totalDays <= 0) { result[key] = null; continue; }

    const avgPrice = Math.round(pricesInMonth.reduce((s, p) => s + p.price * p.days, 0) / totalDays * 100) / 100;
    const minPrice = Math.min(...pricesInMonth.map(p => p.price));
    const daysAtLow = Math.round(pricesInMonth.filter(p => p.price === minPrice).reduce((s, p) => s + p.days, 0));

    if (avgPrice > 5000 || minPrice > 5000 || avgPrice <= 0) { result[key] = null; continue; }
    result[key] = { avg: avgPrice, low: minPrice, days_at_low: Math.max(1, daysAtLow) };
  }
  return result;
}

function cleanUpc(val) {
  let s = String(val).trim();
  if (s.toLowerCase().includes("e")) {
    try { s = String(Math.round(Number(s))); } catch { return [s]; }
  }
  s = s.replace(/\D/g, "");
  if (!s) return [val];
  if (s.length === 11) s = "0" + s;
  const variants = [s];
  if (s.length === 12) variants.push("0" + s);
  else if (s.length === 13 && s.startsWith("0")) variants.push(s.slice(1));
  return variants;
}

function cleanCost(val) {
  try {
    return parseFloat(String(val).replace(/[$,]/g, "").trim()) || 0;
  } catch {
    return 0;
  }
}

function autoCol(columns, candidates) {
  const colsLower = {};
  columns.forEach(c => { colsLower[c.toLowerCase()] = c; });
  for (const cand of candidates) {
    for (const [key, real] of Object.entries(colsLower)) {
      if (key.includes(cand)) return real;
    }
  }
  return null;
}

async function fetchKeepaBatch(upcs, apiKey, domain = 1, retries = 3) {
  const params = new URLSearchParams({
    key: apiKey,
    domain: String(domain),
    code: upcs.join(","),
    stats: "365",
    history: "1",
    offers: "20",
    buybox: "1",
    rating: "0",
  });

  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(`${KEEPA_BASE}?${params}`, { signal: AbortSignal.timeout(120000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      const result = {};
      for (const prod of (data.products || [])) {
        if (!prod) continue;
        const allCodes = new Set();
        for (const c of (prod.upcList || [])) allCodes.add(String(c).trim());
        for (const c of (prod.eanList || [])) allCodes.add(String(c).trim());
        const codes = Array.isArray(prod.code) ? prod.code : prod.code ? [prod.code] : [];
        for (const c of codes) allCodes.add(String(c).trim());
        for (const c of allCodes) {
          if (!result[c]) result[c] = [];
          result[c].push(prod);
        }
      }
      return { data: result, tokensLeft: data.tokensLeft, refillIn: data.refillIn };
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        lastErr = `Timeout (attempt ${attempt + 1}/${retries})`;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      } else {
        throw e;
      }
    }
  }
  throw new Error(`Keepa timed out after ${retries} attempts: ${lastErr}`);
}

function analyzeItem(item, prod, settings) {
  const {
    threshold, minRoi, overhead, priceBasis, pbMap,
    activeMonths, orderBasis, orderPct, minProfit,
    phTargetMonths, useMonthlyLow,
  } = settings;

  const monthly = parseMonthlySales(prod);
  const everHit = Object.values(monthly).some(v => v >= threshold);

  // Filter to active months
  const filteredSales = {};
  for (const [k, v] of Object.entries(monthly)) {
    const mo = parseInt(k.split("-")[1]);
    if (activeMonths.includes(mo)) filteredSales[k] = v;
  }

  const peak = Object.values(filteredSales).length ? Math.max(...Object.values(filteredSales)) : 0;
  const peakAll = Object.values(monthly).length ? Math.max(...Object.values(monthly)) : 0;
  const numSelected = activeMonths.length || 12;
  const avgFiltered = activeMonths.length
    ? Math.round(Object.values(filteredSales).reduce((s, v) => s + v, 0) / numSelected * 10) / 10
    : 0;

  const allPrices = getAllPrices(prod);
  const asin = prod.asin || "";
  const title = (prod.title || item.name || item.upc).slice(0, 70);

  // Monthly price history
  const monthlyPh = phTargetMonths.length ? getMonthlyPriceHistory(prod, phTargetMonths) : {};

  // Referral fee %
  let referralPct = prod.referralFeePercent || prod.referralFeePercentage || 15.0;
  referralPct = parseFloat(referralPct) || 15.0;

  // Pick & Pack fee from Keepa
  let pickAndPack = null;
  const fbaFeesData = prod.fbaFees;
  if (fbaFeesData && typeof fbaFeesData === "object") {
    const pp = fbaFeesData.pickAndPackFee;
    if (pp && pp > 0) pickAndPack = Math.round(pp) / 100;
  }

  // Monthly low price
  const monthlyLows = Object.values(monthlyPh)
    .filter(d => d && d.low && d.low > 0)
    .map(d => d.low);
  const monthlyLowPrice = monthlyLows.length ? Math.round(Math.min(...monthlyLows) * 100) / 100 : null;

  // Determine price for ROI
  let amzPrice;
  if (priceBasis === "min_selected") {
    const candidates = [];
    for (const [k, v] of Object.entries(allPrices)) {
      if (pbMap[k] && v && v > 0) candidates.push(v);
    }
    if (useMonthlyLow && monthlyLowPrice) candidates.push(monthlyLowPrice);
    amzPrice = candidates.length ? Math.round(Math.min(...candidates) * 100) / 100 : null;
  } else if (priceBasis === "monthly_low") {
    amzPrice = monthlyLowPrice;
  } else {
    amzPrice = allPrices[priceBasis] || null;
  }

  const { referralFee, ppFee, totalFee } = calcFees(amzPrice, referralPct, pickAndPack);
  const feeSource = pickAndPack != null ? "Keepa" : "Est.";
  const trueCost = Math.round(item.cost * (1 + overhead) * 100) / 100;

  const netSale = amzPrice && totalFee != null ? Math.round((amzPrice - totalFee) * 100) / 100 : null;
  const netProfit = netSale != null ? Math.round((netSale - trueCost) * 100) / 100 : null;
  const roi = netProfit != null && trueCost > 0 ? Math.round((netProfit / trueCost) * 1000) / 10 : null;

  // Target buy price — with the fix: don't suggest paying MORE if already on target
  let targetSupplier = null;
  let priceGap = null;
  if (netSale != null) {
    const targetTcRoi = Math.round(netSale / (1 + minRoi / 100) * 100) / 100;
    const targetTcProfit = Math.round((netSale - minProfit) * 100) / 100;
    const targetTrueCost = Math.min(targetTcRoi, targetTcProfit);
    targetSupplier = Math.round(targetTrueCost / (1 + overhead) * 100) / 100;
    // FIX: if already on target, cap at current cost
    if (targetSupplier >= item.cost) {
      targetSupplier = item.cost;
      priceGap = 0;
    } else {
      priceGap = Math.round((item.cost - targetSupplier) * 100) / 100;
    }
  }

  // Decision
  let decision;
  if (everHit && roi != null && roi >= minRoi) decision = "Buy";
  else if (everHit && roi != null && roi >= minRoi * 0.5) decision = "Review";
  else if (everHit) decision = "Review";
  else decision = "Pass";

  const lowProfit = (decision === "Buy" || decision === "Review") && netProfit != null && netProfit < minProfit;

  // Order qty
  let suggestedQty = 0;
  let qtyBasis = "—";
  if (orderBasis === "avg" && avgFiltered > 0) {
    suggestedQty = Math.max(Math.ceil(avgFiltered * orderPct), 1);
    qtyBasis = `avg(${Math.round(avgFiltered)})×${Math.round(orderPct * 100)}%`;
  } else if (peak > 0) {
    suggestedQty = orderBasis === "avg"
      ? Math.max(Math.ceil(peak * orderPct), 1)
      : Math.max(Math.ceil(peak * 1.5), 6);
    qtyBasis = `peak(${peak})`;
  }

  // % off needed
  let pctOffNeeded = null;
  if (targetSupplier != null && item.cost > 0) {
    if (priceGap != null && priceGap <= 0) pctOffNeeded = 0;
    else pctOffNeeded = Math.round(((item.cost - targetSupplier) / item.cost) * 1000) / 10;
  }

  return {
    sku: item.sku, upc: item.upc, asin, title,
    cost: item.cost, trueCost,
    priceCurrent: allPrices.current,
    priceAvg30: allPrices.avg30,
    priceAvg90: allPrices.avg90,
    priceAvg180: allPrices.avg180,
    priceAvg365: allPrices.avg365,
    amzPrice,
    referralPct, referralFee, ppFee,
    fbaFee: totalFee, feeSource,
    netSale, netProfit, roi,
    monthly, monthlyPh, monthlyLowPrice,
    targetSupplier, priceGap, pctOffNeeded,
    peakFiltered: peak, peakAll,
    avgFiltered, suggestedQty, qtyBasis,
    lowProfit, decision,
    found: true, error: "",
  };
}

function notFoundResult(item, overhead) {
  return {
    sku: item.sku, upc: item.upc, asin: "", title: item.name || item.upc,
    cost: item.cost, trueCost: Math.round(item.cost * (1 + overhead) * 100) / 100,
    priceCurrent: null, priceAvg30: null, priceAvg90: null, priceAvg180: null, priceAvg365: null,
    amzPrice: null, referralPct: 15.0, referralFee: null, ppFee: null,
    fbaFee: null, feeSource: "—", netSale: null, netProfit: null, roi: null,
    monthly: {}, monthlyPh: {}, monthlyLowPrice: null,
    targetSupplier: null, priceGap: null, pctOffNeeded: null,
    peakFiltered: 0, peakAll: 0, avgFiltered: 0,
    suggestedQty: 0, qtyBasis: "—",
    lowProfit: false, decision: "Pass",
    found: false, error: "Not found in Keepa",
  };
}

export {
  last12Months, cleanUpc, cleanCost, autoCol,
  fetchKeepaBatch, analyzeItem, notFoundResult,
};
