// Core Keepa analysis logic — mirrors keepa_analyzer.py

const KEEPA_BASE = "https://api.keepa.com/product";
const KEEPA_EPOCH_START = new Date("2011-01-01T00:00:00Z").getTime();

// Amazon's seller ID across Amazon marketplaces. The US ID is the most common
// case for this app. If you ever support other marketplaces, extend this set.
const AMAZON_SELLER_IDS = new Set([
  "ATVPDKIKX0DER", // US
  "A1F83G8C2ARO7P", // UK
  "A1AM78C64UM0Y8", // MX
  "A2EUQ1WTGCTBG2", // CA
  "A1PA6795UKMFR9", // DE
  "A13V1IB3VIYZZH", // FR
  "APJ6JRA9NG5V4",  // IT
  "A1RKKUPIHCS9HS", // ES
  "A1VC38T7YXB528", // JP
]);

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

// ─── NEW: Competition metrics (seller counts, Amazon presence, BB win %) ──────
function getCompetitionMetrics(prod, activeMonths) {
  const stats = prod.stats || {};
  const offers = Array.isArray(prod.offers) ? prod.offers : [];
  const csvData = prod.csv || [];

  // 1) Current FBA / FBM split from live offers
  let fbaCount = 0;
  let fbmCount = 0;
  for (const o of offers) {
    if (!o) continue;
    if (o.isFBA === true) fbaCount++;
    else fbmCount++;
  }

  // 2) Current total seller count.
  // stats.totalOfferCount is the most reliable current count. Fall back to
  // length of the offers array (capped to whatever Keepa returned).
  let currentSellers = null;
  if (typeof stats.totalOfferCount === "number" && stats.totalOfferCount >= 0) {
    currentSellers = stats.totalOfferCount;
  } else if (offers.length) {
    currentSellers = offers.length;
  }

  // 3) Avg seller count over selected months (csv[11] = new offer count history)
  let avgSellersFiltered = null;
  if (Array.isArray(csvData[11]) && csvData[11].length >= 2 && Array.isArray(activeMonths) && activeMonths.length) {
    const entries = [];
    for (let i = 0; i < csvData[11].length - 1; i += 2) {
      const kt = csvData[11][i];
      const cnt = csvData[11][i + 1];
      if (kt == null || cnt == null || cnt < 0) continue;
      const dt = keepaTimeToDt(kt);
      if (dt) entries.push({ dt, count: cnt });
    }
    if (entries.length) {
      const now = new Date();
      // Look back over the last 365 days, weight by time spent at each count,
      // and only include samples whose calendar month is in activeMonths.
      const cutoff = new Date(now.getTime() - 365 * 86400000);
      const activeSet = new Set(activeMonths);
      let weightedSum = 0;
      let weightedDays = 0;
      for (let idx = 0; idx < entries.length; idx++) {
        const { dt, count } = entries[idx];
        const next = idx + 1 < entries.length ? entries[idx + 1].dt : now;
        const segStart = dt < cutoff ? cutoff : dt;
        const segEnd = next > now ? now : next;
        if (segEnd <= segStart) continue;
        // Walk segment day-by-day boundaries cheaply: split at each month boundary
        // it spans. For typical 365d windows there are at most ~13 months.
        let cursor = new Date(segStart);
        while (cursor < segEnd) {
          const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
          const sliceEnd = monthEnd < segEnd ? monthEnd : segEnd;
          const days = (sliceEnd - cursor) / 86400000;
          if (days > 0 && activeSet.has(cursor.getUTCMonth() + 1)) {
            weightedSum += count * days;
            weightedDays += days;
          }
          cursor = sliceEnd;
        }
      }
      if (weightedDays > 0) {
        avgSellersFiltered = Math.round((weightedSum / weightedDays) * 10) / 10;
      }
    }
  }

  // 4) Amazon on listing in the last 180 days (csv[0] = Amazon price history).
  // A non-zero, non-negative price entry within the last 180d means Amazon
  // had an offer at some point during that window.
  let amazonOnListing180d = false;
  if (Array.isArray(csvData[0]) && csvData[0].length >= 2) {
    const cutoff = Date.now() - 180 * 86400000;
    for (let i = 0; i < csvData[0].length - 1; i += 2) {
      const kt = csvData[0][i];
      const prc = csvData[0][i + 1];
      if (kt == null || prc == null) continue;
      if (prc <= 0) continue; // -1 means "Amazon not on listing"
      const dt = keepaTimeToDt(kt);
      if (dt && dt.getTime() >= cutoff) {
        amazonOnListing180d = true;
        break;
      }
    }
  }
  // Fallback: if Amazon currently has a price in stats, count that too
  if (!amazonOnListing180d) {
    const cur = Array.isArray(stats.current) ? stats.current[0] : null;
    if (typeof cur === "number" && cur > 0) amazonOnListing180d = true;
  }

  // 5) Buy Box win % — Amazon vs top non-Amazon seller (last 90d window per Keepa).
  let amazonBbWinPct = null;
  let topThirdPartyBbWinPct = null;
  let topThirdPartySellerId = null;
  const bbStats = stats.buyBoxStats;
  if (bbStats && typeof bbStats === "object") {
    for (const [sellerId, info] of Object.entries(bbStats)) {
      if (!info || typeof info.percentageWon !== "number") continue;
      const pct = info.percentageWon;
      if (AMAZON_SELLER_IDS.has(sellerId)) {
        if (amazonBbWinPct == null || pct > amazonBbWinPct) amazonBbWinPct = pct;
      } else {
        if (topThirdPartyBbWinPct == null || pct > topThirdPartyBbWinPct) {
          topThirdPartyBbWinPct = pct;
          topThirdPartySellerId = sellerId;
        }
      }
    }
  }
  // Round to 1 decimal place
  if (amazonBbWinPct != null) amazonBbWinPct = Math.round(amazonBbWinPct * 10) / 10;
  if (topThirdPartyBbWinPct != null) topThirdPartyBbWinPct = Math.round(topThirdPartyBbWinPct * 10) / 10;

  return {
    currentSellers,
    fbaCount,
    fbmCount,
    avgSellersFiltered,
    amazonOnListing180d,
    amazonBbWinPct,
    topThirdPartyBbWinPct,
    topThirdPartySellerId,
  };
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

async function fetchKeepaBatch(upcs, apiKey, domain = 1, retries = 3, includeRating = false) {
  const params = new URLSearchParams({
    key: apiKey,
    domain: String(domain),
    code: upcs.join(","),
    stats: "365",
    history: "1",
    offers: "20",
    buybox: "1",
    rating: includeRating ? "1" : "0",
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

  // Competition metrics (NEW)
  const comp = getCompetitionMetrics(prod, activeMonths);

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

  // Days to sell out (BB-aware estimate).
  // Uses avg monthly sales across selected months, subtracts Amazon's BB share,
  // and splits the remainder evenly across FBA sellers + you (the new seller).
  let daysToSellOut = null;
  if (suggestedQty > 0 && avgFiltered > 0 && comp.fbaCount != null) {
    // Amazon's share of sales (default to 0 if unknown). Capped at 100.
    const amzShare = Math.min(100, Math.max(0, comp.amazonBbWinPct ?? 0)) / 100;
    const remainingShare = Math.max(0, 1 - amzShare);
    // You + existing FBA sellers split the non-Amazon share.
    const competingFba = (comp.fbaCount || 0) + 1;
    const yourShare = remainingShare / competingFba;
    // Your projected monthly sales = total listing velocity × your share
    const yourMonthly = avgFiltered * yourShare;
    if (yourMonthly > 0) {
      const monthsToSell = suggestedQty / yourMonthly;
      // 30-day month for simplicity
      daysToSellOut = Math.round(monthsToSell * 30);
      // Cap absurd values to keep UI readable; >999d effectively means "don't bother"
      if (daysToSellOut > 9999) daysToSellOut = 9999;
    }
  }

  // Listing age, review count, and star rating.
  // Keepa stores listedSince as minutes since 2011-01-01; -1 means unknown.
  let listedSince = null;
  let listingAgeMonths = null;
  if (typeof prod.listedSince === "number" && prod.listedSince > 0) {
    const dt = keepaTimeToDt(prod.listedSince);
    if (dt) {
      listedSince = dt.toISOString().slice(0, 10); // YYYY-MM-DD
      const ageMs = Date.now() - dt.getTime();
      listingAgeMonths = Math.max(0, Math.round(ageMs / (1000 * 60 * 60 * 24 * 30.4375)));
    }
  }
  // Review count and star rating.
  // stats.current is a fixed-position array; index 16 = review count, index 17 = rating*10.
  let reviewCount = null;
  let rating = null;
  const statsCurrent = (prod.stats && Array.isArray(prod.stats.current)) ? prod.stats.current : null;
  if (statsCurrent) {
    const rc = statsCurrent[16];
    if (typeof rc === "number" && rc >= 0) reviewCount = rc;
    const rt = statsCurrent[17];
    if (typeof rt === "number" && rt > 0) rating = Math.round(rt) / 10; // 43 -> 4.3
  }
  // Fallback to walking the csv history if stats didn't give us anything
  if (reviewCount == null && Array.isArray(prod.csv) && Array.isArray(prod.csv[17])) {
    // csv[17] = review count history. Find latest non-negative value.
    const arr = prod.csv[17];
    for (let j = arr.length - 1; j > 0; j -= 2) {
      const v = arr[j];
      if (typeof v === "number" && v >= 0) { reviewCount = v; break; }
    }
  }
  if (rating == null && Array.isArray(prod.csv) && Array.isArray(prod.csv[16])) {
    const arr = prod.csv[16];
    for (let j = arr.length - 1; j > 0; j -= 2) {
      const v = arr[j];
      if (typeof v === "number" && v > 0) { rating = Math.round(v) / 10; break; }
    }
  }

  return {
    sku: item.sku, upc: item.upc, asin, title,
    qtyAvail: item.qtyAvail ?? null,
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
    // NEW: projected sell-out timeline
    daysToSellOut,
    // NEW: listing age + reviews
    listedSince, listingAgeMonths, reviewCount, rating,
    // NEW: competition metrics
    currentSellers: comp.currentSellers,
    fbaCount: comp.fbaCount,
    fbmCount: comp.fbmCount,
    avgSellersFiltered: comp.avgSellersFiltered,
    amazonOnListing180d: comp.amazonOnListing180d,
    amazonBbWinPct: comp.amazonBbWinPct,
    topThirdPartyBbWinPct: comp.topThirdPartyBbWinPct,
    found: true, error: "",
  };
}

function notFoundResult(item, overhead) {
  return {
    sku: item.sku, upc: item.upc, asin: "", title: item.name || item.upc,
    qtyAvail: item.qtyAvail ?? null,
    cost: item.cost, trueCost: Math.round(item.cost * (1 + overhead) * 100) / 100,
    priceCurrent: null, priceAvg30: null, priceAvg90: null, priceAvg180: null, priceAvg365: null,
    amzPrice: null, referralPct: 15.0, referralFee: null, ppFee: null,
    fbaFee: null, feeSource: "—", netSale: null, netProfit: null, roi: null,
    monthly: {}, monthlyPh: {}, monthlyLowPrice: null,
    targetSupplier: null, priceGap: null, pctOffNeeded: null,
    peakFiltered: 0, peakAll: 0, avgFiltered: 0,
    suggestedQty: 0, qtyBasis: "—",
    lowProfit: false, decision: "Pass",
    // NEW: projected sell-out timeline (null when not found)
    daysToSellOut: null,
    // NEW: listing age + reviews (null when not found)
    listedSince: null, listingAgeMonths: null, reviewCount: null, rating: null,
    // NEW: competition metrics (null when not found)
    currentSellers: null, fbaCount: null, fbmCount: null,
    avgSellersFiltered: null, amazonOnListing180d: null,
    amazonBbWinPct: null, topThirdPartyBbWinPct: null,
    found: false, error: "Not found in Keepa",
  };
}

export {
  last12Months, cleanUpc, cleanCost, autoCol,
  fetchKeepaBatch, analyzeItem, notFoundResult,
};
