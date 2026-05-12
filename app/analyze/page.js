"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";

function cleanUpc(val) {
  let s = String(val).trim();
  if (s.toLowerCase().includes("e")) {
    try { s = String(Math.round(Number(s))); } catch { return [s]; }
  }
  s = s.replace(/\D/g, "");
  if (!s) return [String(val)];
  if (s.length === 11) s = "0" + s;
  const variants = [s];
  if (s.length === 12) variants.push("0" + s);
  else if (s.length === 13 && s.startsWith("0")) variants.push(s.slice(1));
  return variants;
}

function cleanCost(val) {
  try { return parseFloat(String(val).replace(/[$,]/g, "").trim()) || 0; } catch { return 0; }
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

function phMonthOptions() {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    let m = now.getMonth() + 1 - i;
    let y = now.getFullYear();
    while (m <= 0) { m += 12; y -= 1; }
    const label = new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
    months.push({ year: y, month: m, label, key: `${y}-${String(m).padStart(2, "0")}` });
  }
  return months;
}

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDollars(v) { return v != null ? `$${v.toFixed(2)}` : "—"; }
function fmtPct(v) { return v != null ? `${v.toFixed(1)}%` : "—"; }

// Parse FBA Inventory report (CSV or Excel). Returns Map<ASIN, { qty, sku, name }>.
async function parseInventoryReport(file) {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Amazon's Manage FBA Inventory report is tab-separated, but xlsx.read with
  // raw bytes typically handles both. Try sheet_to_json first.
  let rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  // Some reports come through as single-column rows if the delimiter is wrong.
  // Detect and re-parse as TSV if so.
  if (rows.length && Object.keys(rows[0]).length <= 2) {
    const text = new TextDecoder().decode(data);
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length >= 2) {
      const sep = lines[0].includes("\t") ? "\t" : ",";
      const headers = lines[0].split(sep);
      rows = lines.slice(1).map((line) => {
        const cells = line.split(sep);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
        return obj;
      });
    }
  }
  if (!rows.length) return new Map();

  // Find ASIN and quantity columns by best-match name. Amazon's column names:
  //   asin, afn-fulfillable-quantity, sku, product-name
  const cols = Object.keys(rows[0]);
  const find = (substrings) => {
    const lower = cols.map((c) => c.toLowerCase());
    for (const sub of substrings) {
      const idx = lower.findIndex((c) => c === sub);
      if (idx >= 0) return cols[idx];
    }
    for (const sub of substrings) {
      const idx = lower.findIndex((c) => c.includes(sub));
      if (idx >= 0) return cols[idx];
    }
    return null;
  };

  const asinCol = find(["asin"]);
  const qtyCol = find(["afn-fulfillable-quantity", "fulfillable quantity", "available", "afn-warehouse-quantity"]);
  const inboundShippedCol = find(["afn-inbound-shipped-quantity"]);
  const inboundReceivingCol = find(["afn-inbound-receiving-quantity"]);
  const inboundWorkingCol = find(["afn-inbound-working-quantity"]);
  const reservedCol = find(["afn-reserved-quantity"]);
  const skuCol = find(["sku"]);
  const nameCol = find(["product-name", "product name", "title"]);

  if (!asinCol || !qtyCol) return new Map();

  const toInt = (v) => {
    const n = parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return isNaN(n) ? 0 : n;
  };

  const map = new Map();
  for (const row of rows) {
    const asin = String(row[asinCol] || "").trim().toUpperCase();
    if (!asin) continue;
    const qty = toInt(row[qtyCol]);
    // Inbound = shipped + receiving (units en route to/being processed at FBA).
    // Working = upstream from these; we exclude it so the number reflects what
    // will actually be sellable soon, not what's still being prepped at your warehouse.
    const inbound = (inboundShippedCol ? toInt(row[inboundShippedCol]) : 0)
                  + (inboundReceivingCol ? toInt(row[inboundReceivingCol]) : 0);
    const reserved = reservedCol ? toInt(row[reservedCol]) : 0;
    const sku = skuCol ? String(row[skuCol] || "").trim() : "";
    const name = nameCol ? String(row[nameCol] || "").trim() : "";
    if (map.has(asin)) {
      const prev = map.get(asin);
      map.set(asin, {
        qty: (prev.qty || 0) + qty,
        inbound: (prev.inbound || 0) + inbound,
        reserved: (prev.reserved || 0) + reserved,
        sku: prev.sku || sku,
        name: prev.name || name,
      });
    } else {
      map.set(asin, { qty, inbound, reserved, sku, name });
    }
  }
  return map;
}

// Parse Business Report (Sales and Traffic by Child Item). Returns Map<ASIN, { units, sales }>.
async function parseSalesReport(file) {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  let rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  if (rows.length && Object.keys(rows[0]).length <= 2) {
    const text = new TextDecoder().decode(data);
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length >= 2) {
      const sep = lines[0].includes("\t") ? "\t" : ",";
      const headers = lines[0].split(sep);
      rows = lines.slice(1).map((line) => {
        const cells = line.split(sep);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
        return obj;
      });
    }
  }
  if (!rows.length) return new Map();

  const cols = Object.keys(rows[0]);
  // We specifically want CHILD ASIN, not parent. The Business Report has both.
  const childCol = cols.find((c) => /child.*asin/i.test(c)) || cols.find((c) => /^asin$/i.test(c)) || cols.find((c) => /asin/i.test(c) && !/parent/i.test(c));
  const unitsCol = cols.find((c) => /units\s*ordered/i.test(c) && !/b2b/i.test(c)) || cols.find((c) => /units\s*ordered/i.test(c));
  const salesCol = cols.find((c) => /ordered\s*product\s*sales/i.test(c) && !/b2b/i.test(c));

  if (!childCol || !unitsCol) return new Map();

  const map = new Map();
  for (const row of rows) {
    const asin = String(row[childCol] || "").trim().toUpperCase();
    if (!asin) continue;
    const units = parseInt(String(row[unitsCol]).replace(/[^\d-]/g, ""), 10);
    const salesRaw = salesCol ? String(row[salesCol]).replace(/[^\d.-]/g, "") : "";
    const sales = salesRaw ? parseFloat(salesRaw) : null;
    if (map.has(asin)) {
      const prev = map.get(asin);
      map.set(asin, {
        units: (prev.units || 0) + (isNaN(units) ? 0 : units),
        sales: (prev.sales != null || sales != null) ? (prev.sales || 0) + (sales || 0) : null,
      });
    } else {
      map.set(asin, { units: isNaN(units) ? 0 : units, sales });
    }
  }
  return map;
}

export default function AnalyzePage() {
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState("");
  const [dragOver, setDragOver] = useState(false);

  // Amazon report uploads (all optional).
  // Maps are keyed by ASIN (uppercased). Empty Map = report not uploaded.
  const [invMap, setInvMap] = useState(new Map());
  const [invFileName, setInvFileName] = useState("");
  const [salesMap, setSalesMap] = useState(new Map());
  const [salesFileName, setSalesFileName] = useState("");
  const [salesWindowDays, setSalesWindowDays] = useState(90);
  const invInputRef = useRef(null);
  const salesInputRef = useRef(null);

  const [threshold, setThreshold] = useState(50);
  const [minRoi, setMinRoi] = useState(30);
  const [minProfit, setMinProfit] = useState(2.0);
  const [overhead, setOverhead] = useState(15);

  const [priceBasis, setPriceBasis] = useState("min_selected");
  const [pbCurrent, setPbCurrent] = useState(true);
  const [pbAvg30, setPbAvg30] = useState(true);
  const [pbAvg90, setPbAvg90] = useState(true);
  const [pbAvg180, setPbAvg180] = useState(true);
  const [pbAvg365, setPbAvg365] = useState(false);

  const [monthFilters, setMonthFilters] = useState(
    Object.fromEntries(MONTH_NAMES.map(m => [m, true]))
  );

  const [orderBasis, setOrderBasis] = useState("avg");
  const [orderPct, setOrderPct] = useState(50);

  const phOptions = phMonthOptions();
  const [phSelected, setPhSelected] = useState(Object.fromEntries(phOptions.map(o => [o.key, false])));
  const [useMonthlyLow, setUseMonthlyLow] = useState(false);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [logs, setLogs] = useState([]);
  const [results, setResults] = useState([]);
  const [monthKeys, setMonthKeys] = useState([]);
  const [view, setView] = useState("landing");
  const [resultFilter, setResultFilter] = useState("all");

  const logRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const handleFile = useCallback((f) => { setFile(f); setFileName(f.name); }, []);

  const handleInvFile = useCallback(async (f) => {
    setInvFileName(f.name);
    try {
      const m = await parseInventoryReport(f);
      setInvMap(m);
      if (m.size === 0) alert("Couldn't parse inventory report — make sure it's the FBA Inventory CSV with an 'asin' and 'afn-fulfillable-quantity' column.");
    } catch (e) {
      alert(`Failed to parse inventory report: ${e.message}`);
      setInvMap(new Map());
    }
  }, []);

  const handleSalesFile = useCallback(async (f) => {
    setSalesFileName(f.name);
    try {
      const m = await parseSalesReport(f);
      setSalesMap(m);
      if (m.size === 0) alert("Couldn't parse sales report — make sure it's the Business Report (Sales and Traffic by Child Item) with a '(Child) ASIN' and 'Units Ordered' column.");
    } catch (e) {
      alert(`Failed to parse sales report: ${e.message}`);
      setSalesMap(new Map());
    }
  }, []);

  const clearInv = () => { setInvMap(new Map()); setInvFileName(""); };
  const clearSales = () => { setSalesMap(new Map()); setSalesFileName(""); };

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const setAllMonths = () => setMonthFilters(Object.fromEntries(MONTH_NAMES.map(m => [m, true])));
  const setQ4 = () => setMonthFilters(Object.fromEntries(MONTH_NAMES.map(m => [m, ["Oct","Nov","Dec"].includes(m)])));
  const setLast6 = () => {
    const now = new Date();
    const last6 = new Set();
    for (let i = 0; i < 6; i++) { let m = now.getMonth() - i; while (m < 0) m += 12; last6.add(MONTH_NAMES[m]); }
    setMonthFilters(Object.fromEntries(MONTH_NAMES.map(m => [m, last6.has(m)])));
  };

  const runAnalysis = async () => {
    if (!file) { alert("Please upload your linesheet file."); return; }

    setRunning(true); setResults([]); setLogs([]); setProgress(0); setView("analysis");

    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

    if (!rows.length) { setLogs(prev => [...prev, { message: "No data rows found in file.", type: "error" }]); setRunning(false); return; }

    const columns = Object.keys(rows[0]);
    const upcCol = autoCol(columns, ["upc","barcode","ean","gtin","code"]);
    const costCol = autoCol(columns, ["cost","price","unit cost","wholesale","buy"]);
    const nameCol = autoCol(columns, ["name","title","product","description","item"]);
    const skuCol = autoCol(columns, ["sku","item #","part","model","item no"]);

    if (!upcCol) { alert("Can't find UPC column in your file."); setRunning(false); return; }
    if (!costCol) { alert("Can't find cost column in your file."); setRunning(false); return; }

    setLogs(prev => [...prev,
      { message: `Loaded: ${fileName} - ${rows.length} rows`, type: "info" },
      { message: `UPC: ${upcCol} | Cost: ${costCol} | Name: ${nameCol || "(none)"} | SKU: ${skuCol || "(none)"}` },
    ]);

    const items = [];
    for (const row of rows) {
      const rawUpc = String(row[upcCol]).trim();
      const variants = cleanUpc(rawUpc);
      const cost = cleanCost(row[costCol]);
      if (!variants.length || cost <= 0) continue;
      const primary = variants[0];
      if (!primary || ["nan","none",""].includes(primary.toLowerCase())) continue;
      items.push({ upc: primary, variants, cost, name: nameCol ? String(row[nameCol]).trim() : "", sku: skuCol ? String(row[skuCol]).trim() : "" });
    }

    if (!items.length) { setLogs(prev => [...prev, { message: "No valid rows found.", type: "error" }]); setRunning(false); return; }
    setLogs(prev => [...prev, { message: `Valid items: ${items.length}`, type: "success" }]);

    const activeMonths = MONTH_NAMES.map((m, i) => monthFilters[m] ? i + 1 : null).filter(Boolean);
    const phTargetMonths = phOptions.filter(o => phSelected[o.key]).map(o => [o.year, o.month]);

    try {
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          settings: {
            threshold, minRoi, overhead, minProfit, priceBasis,
            pbMap: { current: pbCurrent, avg30: pbAvg30, avg90: pbAvg90, avg180: pbAvg180, avg365: pbAvg365 },
            activeMonths, orderBasis, orderPct, phTargetMonths, useMonthlyLow,
          },
        }),
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const p = JSON.parse(line.slice(6));
            if (p.event === "log") setLogs(prev => [...prev, { message: p.message, type: p.type || "default" }]);
            else if (p.event === "progress") { setProgress(p.pct); setProgressMsg(p.message); }
            else if (p.event === "stream-start") { setResults([]); setMonthKeys(p.monthKeys); setView("results"); }
            else if (p.event === "results-chunk") setResults(prev => [...prev, ...p.results]);
            else if (p.event === "done") { setProgress(100); setProgressMsg("Done"); }
            else if (p.event === "error") setLogs(prev => [...prev, { message: p.message, type: "error" }]);
          } catch {}
        }
      }
    } catch (e) {
      setLogs(prev => [...prev, { message: `Network error: ${e.message}`, type: "error" }]);
    }
    setRunning(false);
  };

  const exportExcel = async () => {
    if (!results.length) return;
    const mk = monthKeys.length ? monthKeys : last12Months();

    const phKeysSet = new Set();
    for (const r of results) for (const k of Object.keys(r.monthlyPh || {})) phKeysSet.add(k);
    const phKeys = [...phKeysSet].sort();

    const wb = new ExcelJS.Workbook();
    wb.creator = "Ottrd";
    wb.created = new Date();

    const C = {
      headerFill: "FF1E3A8A",
      headerText: "FFFFFFFF",
      bandFill:   "FFF8FAFC",
      border:     "FFE2E8F0",
      roiHigh:    "FFD1FAE5",
      roiMid:     "FFFEF3C7",
      roiLow:     "FFFEE2E2",
      decBuy:     "FF86EFAC",
      decReview:  "FFFDE68A",
      decPass:    "FFE5E7EB",
      decNotFound:"FFFCA5A5",
      onTarget:   "FFD1FAE5",
      offTarget:  "FFFEE2E2",
    };

    function styleHeader(row) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.headerFill } };
        cell.font = { bold: true, color: { argb: C.headerText }, size: 11 };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      });
      row.height = 32;
    }

    const FMT = {
      money:  '"$"#,##0.00;[Red]"-$"#,##0.00;"—"',
      pct:    '0.0%;[Red]-0.0%;"—"',
      int:    '#,##0;[Red]-#,##0;"—"',
      intRaw: '#,##0',
      text:   "@",
    };

    const pctVal = (v) => (v == null ? null : v / 100);

    // ─── Sheet 1: Deal Analysis ───────────────────────────────────────────
    const ws1 = wb.addWorksheet("Deal Analysis", {
      views: [{ state: "frozen", xSplit: 4, ySplit: 1 }],
    });

    const phHeader = [];
    for (const k of phKeys) phHeader.push(`${k} Avg`, `${k} Low`, `${k} Days@Low`);
    if (phKeys.length) phHeader.push("Monthly Low");

    const baseHeaders = [
      "SKU", "UPC", "ASIN", "Product Name",
      "Invoice Cost", "True Cost (w/ OH%)",
      "Current BB", "30d Avg BB", "90d Avg BB", "180d Avg BB", "365d Avg BB",
      "Price Used for ROI",
      "Ref %", "Ref $", "P&P Fee", "Fee Source", "Total FBA",
      "Net Sale", "Net Profit", "ROI",
      `Ever ${threshold}+ in 12mo`, "Peak (All)", "Peak (Sel)", "Avg (Sel)",
      "Sug Qty", "Qty Basis",
      "Target Buy", "Gap", "% Off Needed",
      "Sellers (Avg Sel)", "Current Sellers", "FBA", "FBM",
      "Amz On Listing 180d", "Amz BB Win %", "Top 3P BB Win %",
      "Days to Sell Out",
    ];
    // Amazon report columns (only included when relevant report was uploaded).
    if (invMap.size > 0) {
      baseHeaders.push("In Stock", "Inbound", "Reserved");
    }
    if (salesMap.size > 0) baseHeaders.push(`Velocity / mo (${salesWindowDays}d)`);
    if (invMap.size > 0 && salesMap.size > 0) baseHeaders.push("Days of Supply");
    baseHeaders.push("Decision");

    ws1.addRow([...baseHeaders, ...phHeader, ...mk]);
    styleHeader(ws1.getRow(1));

    const colSpecs = [
      { width: 14, fmt: FMT.text },
      { width: 14, fmt: FMT.text },
      { width: 12, fmt: FMT.text },
      { width: 42, fmt: FMT.text },
      { width: 12, fmt: FMT.money },
      { width: 12, fmt: FMT.money },
      { width: 11, fmt: FMT.money },
      { width: 11, fmt: FMT.money },
      { width: 11, fmt: FMT.money },
      { width: 11, fmt: FMT.money },
      { width: 11, fmt: FMT.money },
      { width: 12, fmt: FMT.money },
      { width: 8,  fmt: FMT.pct  },
      { width: 9,  fmt: FMT.money },
      { width: 9,  fmt: FMT.money },
      { width: 10, fmt: FMT.text },
      { width: 10, fmt: FMT.money },
      { width: 10, fmt: FMT.money },
      { width: 11, fmt: FMT.money },
      { width: 9,  fmt: FMT.pct  },
      { width: 12, fmt: FMT.text },
      { width: 9,  fmt: FMT.intRaw },
      { width: 9,  fmt: FMT.intRaw },
      { width: 9,  fmt: FMT.int    },
      { width: 9,  fmt: FMT.intRaw },
      { width: 16, fmt: FMT.text   },
      { width: 11, fmt: FMT.money  },
      { width: 16, fmt: FMT.text   },
      { width: 16, fmt: FMT.text   },
      { width: 10, fmt: FMT.int    },
      { width: 10, fmt: FMT.intRaw },
      { width: 7,  fmt: FMT.intRaw },
      { width: 7,  fmt: FMT.intRaw },
      { width: 12, fmt: FMT.text   },
      { width: 11, fmt: FMT.pct    },
      { width: 11, fmt: FMT.pct    },
      { width: 11, fmt: '0"d";"—"' },
    ];
    // Amazon report column specs match the conditional headers above
    if (invMap.size > 0) {
      colSpecs.push({ width: 10, fmt: '#,##0;"—"' });   // In Stock
      colSpecs.push({ width: 10, fmt: '#,##0;"—"' });   // Inbound
      colSpecs.push({ width: 10, fmt: '#,##0;"—"' });   // Reserved
    }
    if (salesMap.size > 0) colSpecs.push({ width: 14, fmt: '0.0"/mo";"—"' });
    if (invMap.size > 0 && salesMap.size > 0) colSpecs.push({ width: 11, fmt: '0"d";"—"' });
    colSpecs.push({ width: 11, fmt: FMT.text });  // Decision
    for (let i = 0; i < phKeys.length; i++) {
      colSpecs.push({ width: 11, fmt: FMT.money });
      colSpecs.push({ width: 11, fmt: FMT.money });
      colSpecs.push({ width: 10, fmt: FMT.intRaw });
    }
    if (phKeys.length) colSpecs.push({ width: 11, fmt: FMT.money });
    for (const _ of mk) colSpecs.push({ width: 8, fmt: FMT.intRaw });

    colSpecs.forEach((spec, i) => {
      const col = ws1.getColumn(i + 1);
      col.width = spec.width;
      col.numFmt = spec.fmt;
    });

    // Number of extra Amazon-report columns inserted between Days-to-Sell-Out and Decision
    const extraAmzCols = (invMap.size > 0 ? 3 : 0) + (salesMap.size > 0 ? 1 : 0) + (invMap.size > 0 && salesMap.size > 0 ? 1 : 0);

    for (const r of results) {
      const eH = Object.values(r.monthly || {}).some((v) => v >= threshold);
      const gap = r.priceGap;
      const gapStr = gap != null ? (gap <= 0 ? "On target" : `Need $${gap.toFixed(2)} lower`) : "—";
      const pctStr = r.pctOffNeeded != null ? (r.pctOffNeeded <= 0 ? "On target" : `${r.pctOffNeeded.toFixed(1)}% off needed`) : "—";

      // Re-derive Amazon report values for this ASIN
      const asinKey = (r.asin || "").toUpperCase();
      const invHit = invMap.size > 0 ? (asinKey ? invMap.get(asinKey) : null) : null;
      const salesHit = salesMap.size > 0 ? (asinKey ? salesMap.get(asinKey) : null) : null;
      const inStockVal = invMap.size > 0 ? (invHit ? invHit.qty : null) : null;
      const inboundVal = invMap.size > 0 ? (invHit ? (invHit.inbound || 0) : null) : null;
      const reservedVal = invMap.size > 0 ? (invHit ? (invHit.reserved || 0) : null) : null;
      const velPerMo = (salesMap.size > 0 && salesHit && salesWindowDays > 0)
        ? Math.round((salesHit.units / salesWindowDays) * 30 * 10) / 10
        : null;
      const daysSupply = (invHit && velPerMo && velPerMo > 0)
        ? Math.round((invHit.qty / velPerMo) * 30)
        : null;

      const baseVals = [
        r.sku || "", r.upc || "", r.asin || "", r.title || "",
        r.cost ?? null, r.trueCost ?? null,
        r.priceCurrent ?? null, r.priceAvg30 ?? null, r.priceAvg90 ?? null, r.priceAvg180 ?? null, r.priceAvg365 ?? null,
        r.amzPrice ?? null,
        pctVal(r.referralPct), r.referralFee ?? null, r.ppFee ?? null, r.feeSource || "—", r.fbaFee ?? null,
        r.netSale ?? null, r.netProfit ?? null, pctVal(r.roi),
        eH ? "YES" : "NO", r.peakAll || null, r.peakFiltered || null, r.avgFiltered || null,
        r.suggestedQty || null, r.qtyBasis || "—",
        r.targetSupplier ?? null, gapStr, pctStr,
        r.avgSellersFiltered ?? null, r.currentSellers ?? null, r.fbaCount ?? null, r.fbmCount ?? null,
        r.amazonOnListing180d == null ? "—" : (r.amazonOnListing180d ? "YES" : "NO"),
        pctVal(r.amazonBbWinPct), pctVal(r.topThirdPartyBbWinPct),
        r.daysToSellOut ?? null,
      ];
      if (invMap.size > 0) baseVals.push(inStockVal, inboundVal, reservedVal);
      if (salesMap.size > 0) baseVals.push(velPerMo);
      if (invMap.size > 0 && salesMap.size > 0) baseVals.push(daysSupply);
      baseVals.push(r.decision);

      const phVals = [];
      for (const k of phKeys) {
        const d = (r.monthlyPh || {})[k];
        phVals.push(d ? d.avg : null, d ? d.low : null, d ? d.days_at_low : null);
      }
      if (phKeys.length) phVals.push(r.monthlyLowPrice ?? null);

      const monthVals = mk.map((m) => (r.monthly || {})[m] ?? null);

      const row = ws1.addRow([...baseVals, ...phVals, ...monthVals]);

      // ROI cell
      const roiCell = row.getCell(20);
      if (r.roi != null) {
        let fillColor = null;
        if (r.roi >= 30) fillColor = C.roiHigh;
        else if (r.roi >= 15) fillColor = C.roiMid;
        else fillColor = C.roiLow;
        roiCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
        roiCell.font = { bold: true };
      }

      // Sell-Out cell (column 37): green <60d, amber 60-120d, red >120d
      if (r.daysToSellOut != null) {
        const soCell = row.getCell(37);
        let soFill = C.roiLow;
        if (r.daysToSellOut < 60) soFill = C.roiHigh;
        else if (r.daysToSellOut <= 120) soFill = C.roiMid;
        soCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: soFill } };
        soCell.font = { bold: true };
        soCell.alignment = { horizontal: "right" };
      }

      // Days of Supply coloring (last Amazon column when both reports uploaded)
      if (invMap.size > 0 && salesMap.size > 0 && daysSupply != null) {
        const dosColIdx = 37 + extraAmzCols; // sits right before Decision
        const dosCell = row.getCell(dosColIdx);
        const dosFill = daysSupply >= 60 ? C.roiHigh : daysSupply >= 30 ? C.roiMid : C.roiLow;
        dosCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: dosFill } };
        dosCell.font = { bold: true };
      }

      // Decision cell (column index shifts based on how many Amazon cols were added)
      const decColIdx = 38 + extraAmzCols;
      const decCell = row.getCell(decColIdx);
      let decColor = C.decPass;
      if (r.decision === "Buy") decColor = C.decBuy;
      else if (r.decision === "Review") decColor = C.decReview;
      else if (!r.found) decColor = C.decNotFound;
      decCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: decColor } };
      decCell.font = { bold: true };
      decCell.alignment = { horizontal: "center" };

      row.getCell(21).alignment = { horizontal: "center" };
      row.getCell(34).alignment = { horizontal: "center" };
      row.getCell(16).alignment = { horizontal: "center" };

      const everCell = row.getCell(21);
      everCell.font = { bold: true, color: { argb: eH ? "FF15803D" : "FF991B1B" } };

      const amzCell = row.getCell(34);
      if (r.amazonOnListing180d) {
        amzCell.font = { bold: true, color: { argb: "FF991B1B" } };
      } else if (r.amazonOnListing180d === false) {
        amzCell.font = { color: { argb: "FF15803D" } };
      }

      if (gap != null) {
        const gapCell = row.getCell(28);
        gapCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: gap <= 0 ? C.onTarget : C.offTarget } };
      }
    }

    ws1.autoFilter = {
      from: { row: 1, column: 1 },
      to:   { row: 1, column: ws1.columnCount },
    };

    // ─── Sheet 2: Buy List ────────────────────────────────────────────────
    const ws2 = wb.addWorksheet("Buy List", {
      views: [{ state: "frozen", xSplit: 4, ySplit: 1 }],
    });
    const buyHeaders = [
      "SKU", "UPC", "ASIN", "Product Name",
      "Invoice Cost", "True Cost", "Amz Price",
      "Net Profit", "ROI",
      "Target Buy", "Gap", "% Off",
      "Peak (Sel)", "Avg (Sel)", "Sug Qty", "Qty Basis",
      "Days to Sell Out",
      "Decision",
    ];
    ws2.addRow(buyHeaders);
    styleHeader(ws2.getRow(1));
    const ws2Specs = [14, 14, 12, 42, 12, 12, 11, 11, 9, 11, 16, 14, 9, 9, 9, 16, 13, 11];
    const ws2Fmts = [
      FMT.text, FMT.text, FMT.text, FMT.text,
      FMT.money, FMT.money, FMT.money,
      FMT.money, FMT.pct,
      FMT.money, FMT.text, FMT.text,
      FMT.intRaw, FMT.int, FMT.intRaw, FMT.text,
      '0"d";"—"',
      FMT.text,
    ];
    ws2Specs.forEach((w, i) => { ws2.getColumn(i + 1).width = w; ws2.getColumn(i + 1).numFmt = ws2Fmts[i]; });

    const buyResults = results.filter(r => r.decision === "Buy" || r.decision === "Review");
    for (const r of buyResults) {
      const gap = r.priceGap;
      const gapStr = gap != null ? (gap <= 0 ? "On target" : `Need $${gap.toFixed(2)} lower`) : "—";
      const pctStr = r.pctOffNeeded != null ? (r.pctOffNeeded <= 0 ? "On target" : `${r.pctOffNeeded.toFixed(1)}%`) : "—";
      const row = ws2.addRow([
        r.sku || "", r.upc || "", r.asin || "", r.title || "",
        r.cost ?? null, r.trueCost ?? null, r.amzPrice ?? null,
        r.netProfit ?? null, pctVal(r.roi),
        r.targetSupplier ?? null, gapStr, pctStr,
        r.peakFiltered || null, r.avgFiltered || null, r.suggestedQty || null, r.qtyBasis || "—",
        r.daysToSellOut ?? null,
        r.decision,
      ]);
      const roiCell = row.getCell(9);
      if (r.roi != null) {
        const fillColor = r.roi >= 30 ? C.roiHigh : r.roi >= 15 ? C.roiMid : C.roiLow;
        roiCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
        roiCell.font = { bold: true };
      }
      // Sell-Out cell (col 17) coloring
      if (r.daysToSellOut != null) {
        const soCell = row.getCell(17);
        let soFill = C.roiLow;
        if (r.daysToSellOut < 60) soFill = C.roiHigh;
        else if (r.daysToSellOut <= 120) soFill = C.roiMid;
        soCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: soFill } };
        soCell.font = { bold: true };
      }
      const decCell = row.getCell(18);
      decCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r.decision === "Buy" ? C.decBuy : C.decReview } };
      decCell.font = { bold: true };
      decCell.alignment = { horizontal: "center" };
    }
    ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws2.columnCount } };

    // ─── Sheet 3: Summary ─────────────────────────────────────────────────
    const ws3 = wb.addWorksheet("Summary");
    ws3.getColumn(1).width = 32;
    ws3.getColumn(2).width = 20;

    const nB = results.filter(r => r.decision === "Buy").length;
    const nR = results.filter(r => r.decision === "Review").length;
    const nP = results.filter(r => r.decision === "Pass").length;
    const nN = results.filter(r => !r.found).length;
    const eC = results.filter(r => Object.values(r.monthly || {}).some(v => v >= threshold)).length;
    const po = results.filter(r => r.decision === "Buy" || r.decision === "Review");
    const tC = po.reduce((s, r) => s + (r.cost || 0) * (r.suggestedQty || 0), 0);
    const tP = po.reduce((s, r) => s + (r.netProfit || 0) * (r.suggestedQty || 0), 0);
    const rs = po.filter(r => r.roi != null).map(r => r.roi);
    const aR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;

    const titleRow = ws3.addRow(["DEAL SUMMARY", ""]);
    titleRow.font = { bold: true, size: 16, color: { argb: C.headerFill } };
    ws3.addRow(["Generated", new Date().toISOString().split("T")[0]]);
    ws3.addRow(["Threshold", `${threshold}+ sales in any month`]);
    ws3.addRow(["", ""]);
    ws3.addRow(["Total SKUs analyzed", results.length]).getCell(2).numFmt = FMT.intRaw;
    ws3.addRow([`Ever hit ${threshold}+ in 12 months`, eC]).getCell(2).numFmt = FMT.intRaw;
    ws3.addRow(["", ""]);

    const buyRow = ws3.addRow(["Buy decisions", nB]);
    buyRow.getCell(2).numFmt = FMT.intRaw;
    buyRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.decBuy } };
    buyRow.getCell(2).font = { bold: true };

    const revRow = ws3.addRow(["Review decisions", nR]);
    revRow.getCell(2).numFmt = FMT.intRaw;
    revRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.decReview } };
    revRow.getCell(2).font = { bold: true };

    const passRow = ws3.addRow(["Pass decisions", nP]);
    passRow.getCell(2).numFmt = FMT.intRaw;
    passRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.decPass } };

    const nfRow = ws3.addRow(["Not found in Keepa", nN]);
    nfRow.getCell(2).numFmt = FMT.intRaw;
    nfRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.decNotFound } };

    ws3.addRow(["", ""]);
    ws3.addRow(["Estimated total PO cost", tC]).getCell(2).numFmt = FMT.money;
    ws3.addRow(["Estimated total profit", tP]).getCell(2).numFmt = FMT.money;
    ws3.addRow(["Average ROI on buy items", aR / 100]).getCell(2).numFmt = FMT.pct;

    // ─── Sheet 4: Target PO ───────────────────────────────────────────────
    const ws4 = wb.addWorksheet("Target PO", {
      views: [{ state: "frozen", xSplit: 0, ySplit: 1 }],
    });
    const tHdr = ["Product Name", "UPC", "ASIN", "Quantity", "Target Buy Price", "% Off Needed", "Min Profit Flag"];
    ws4.addRow(tHdr);
    styleHeader(ws4.getRow(1));
    const ws4Widths = [42, 14, 12, 10, 14, 14, 14];
    ws4Widths.forEach((w, i) => { ws4.getColumn(i + 1).width = w; });
    ws4.getColumn(4).numFmt = FMT.intRaw;
    ws4.getColumn(5).numFmt = FMT.money;
    ws4.getColumn(6).numFmt = FMT.pct;

    const targetRows = results.filter(r => (r.decision === "Buy" || r.decision === "Review") && (r.suggestedQty || 0) > 0);
    for (const r of targetRows) {
      const g = r.priceGap;
      let pN = null;
      if (r.targetSupplier != null && r.cost > 0) {
        pN = (g != null && g <= 0) ? 0 : Math.round(((r.cost - r.targetSupplier) / r.cost) * 1000) / 10;
      }
      const row = ws4.addRow([r.title, r.upc, r.asin, r.suggestedQty, r.targetSupplier, pctVal(pN), r.lowProfit ? "Below min $" : "OK"]);
      if (r.lowProfit) {
        row.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.roiLow } };
        row.getCell(7).font = { bold: true, color: { argb: "FF991B1B" } };
      }
    }
    ws4.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws4.columnCount } };

    // ─── Sheet 5: Price History (only if data) ────────────────────────────
    if (phKeys.length) {
      const ws5 = wb.addWorksheet("Price History", {
        views: [{ state: "frozen", xSplit: 4, ySplit: 1 }],
      });
      const phH = ["SKU", "UPC", "ASIN", "Product Name"];
      for (const k of phKeys) phH.push(`${k} Avg`, `${k} Low`, `${k} Days@Low`);
      phH.push("Overall Low");
      ws5.addRow(phH);
      styleHeader(ws5.getRow(1));

      ws5.getColumn(1).width = 14;
      ws5.getColumn(2).width = 14;
      ws5.getColumn(3).width = 12;
      ws5.getColumn(4).width = 42;
      let cIdx = 5;
      for (let i = 0; i < phKeys.length; i++) {
        ws5.getColumn(cIdx).width = 11; ws5.getColumn(cIdx).numFmt = FMT.money; cIdx++;
        ws5.getColumn(cIdx).width = 11; ws5.getColumn(cIdx).numFmt = FMT.money; cIdx++;
        ws5.getColumn(cIdx).width = 10; ws5.getColumn(cIdx).numFmt = FMT.intRaw; cIdx++;
      }
      ws5.getColumn(cIdx).width = 11; ws5.getColumn(cIdx).numFmt = FMT.money;

      for (const r of results) {
        const row = [r.sku || "", r.upc || "", r.asin || "", r.title || ""];
        const aL = [];
        for (const k of phKeys) {
          const d = (r.monthlyPh || {})[k];
          if (d) {
            row.push(d.avg, d.low, d.days_at_low);
            if (d.low) aL.push(d.low);
          } else {
            row.push(null, null, null);
          }
        }
        row.push(aL.length ? Math.min(...aL) : null);
        ws5.addRow(row);
      }
      ws5.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws5.columnCount } };
    }

    // ─── Write the file ───────────────────────────────────────────────────
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ottrd_analysis_${new Date().toISOString().split("T")[0]}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Enrich raw results with Amazon report data, joined by ASIN.
  // - inStock: number from inventory map, or "never_sold" if SKU not present
  // - velocityPerMo: from sales map (units / window × 30), or "never_sold"
  // - daysOfSupply: inStock / (velocity/30), only when both reports present
  const enrichedResults = results.map((r) => {
    const asin = (r.asin || "").toUpperCase();
    let inStock = undefined;
    let inbound = undefined;
    let reserved = undefined;
    let velocityPerMo = undefined;
    let velocityRaw = undefined;
    let daysOfSupply = undefined;

    if (invMap.size > 0) {
      const inv = asin ? invMap.get(asin) : null;
      if (inv) {
        inStock = inv.qty;
        inbound = inv.inbound || 0;
        reserved = inv.reserved || 0;
      } else {
        inStock = "never_sold";
        inbound = "never_sold";
        reserved = "never_sold";
      }
    }
    if (salesMap.size > 0) {
      const s = asin ? salesMap.get(asin) : null;
      if (s) {
        velocityRaw = s.units;
        velocityPerMo = salesWindowDays > 0 ? Math.round((s.units / salesWindowDays) * 30 * 10) / 10 : 0;
      } else {
        velocityRaw = "never_sold";
        velocityPerMo = "never_sold";
      }
    }
    if (typeof inStock === "number" && typeof velocityPerMo === "number" && velocityPerMo > 0) {
      daysOfSupply = Math.round((inStock / velocityPerMo) * 30);
    }
    return { ...r, inStock, inbound, reserved, velocityPerMo, velocityRaw, daysOfSupply };
  });

  const filteredResults = enrichedResults.filter(r => {
    if (resultFilter === "buy") return r.decision === "Buy" || r.decision === "Review";
    if (resultFilter === "pass") return r.decision === "Pass";
    return true;
  });

  const stats = {
    total: results.length,
    buys: results.filter(r => r.decision === "Buy").length,
    reviews: results.filter(r => r.decision === "Review").length,
    passes: results.filter(r => r.decision === "Pass").length,
    notFound: results.filter(r => !r.found).length,
    everHit: results.filter(r => Object.values(r.monthly || {}).some(v => v >= threshold)).length,
  };

  const mk = monthKeys.length ? monthKeys : last12Months();

  return (
    <div className="min-h-screen">
      <header className="border-b border-ottrd-border bg-ottrd-surface/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-bold text-sm font-display">O</div>
            <span className="font-display text-xl text-ottrd-text">Ottrd</span>
          </div>
          {view !== "landing" && (
            <button onClick={() => { setView("landing"); setResults([]); setLogs([]); setProgress(0); }}
              className="text-sm text-ottrd-muted hover:text-ottrd-text transition-colors">New Analysis</button>
          )}
          <a href="/dashboard" className="text-sm text-ottrd-muted hover:text-ottrd-text transition-colors">Dashboard</a>
        </div>
      </header>

      {view === "landing" && (
        <main className="max-w-4xl mx-auto px-6 py-16 animate-fade-in">
          <div className="text-center mb-16">
            <h1 className="font-display text-5xl md:text-6xl text-ottrd-text mb-4 leading-tight">Amazon Deal<br/>Underwriting</h1>
            <p className="text-ottrd-muted text-lg max-w-xl mx-auto leading-relaxed">Upload your supplier linesheet. We pull 12 months of Keepa data, calculate true ROI, and generate your purchase order.</p>
          </div>

          <Sec title="Step 1 - Upload linesheet" d="0s">
            <div className={`drop-zone border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all ${dragOver?"drag-over border-ottrd-accent":"border-ottrd-border hover:border-ottrd-muted"}`}
              onClick={()=>fileInputRef.current?.click()} onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={onDrop}>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e=>e.target.files[0]&&handleFile(e.target.files[0])}/>
              {fileName ? (<div><div className="text-3xl mb-2">{"📄"}</div><div className="text-ottrd-text font-medium">{fileName}</div><div className="text-ottrd-muted text-sm mt-1">Click or drop to replace</div></div>)
              : (<div><div className="text-3xl mb-2">{"📄"}</div><div className="text-ottrd-muted">Drop your CSV or Excel file here</div><div className="text-ottrd-muted/50 text-sm mt-1">or click to browse</div></div>)}
            </div>
            <p className="text-ottrd-muted/60 text-xs mt-3">Needs a UPC column and a cost/price column at minimum.</p>
          </Sec>

          <Sec title="Step 2 - Amazon reports (optional)" d="0.1s">
            <p className="text-ottrd-muted text-sm mb-4">Upload your FBA inventory and/or sales reports to see your in-stock counts, velocity, and days of supply per SKU. Both are optional — Ottrd works without them.</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Inventory upload */}
              <div>
                <label className="block text-sm text-ottrd-muted mb-2">FBA Inventory Report</label>
                <div className="drop-zone border-2 border-dashed rounded-xl p-5 text-center cursor-pointer border-ottrd-border hover:border-ottrd-muted transition-all"
                  onClick={() => invInputRef.current?.click()}>
                  <input ref={invInputRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" className="hidden" onChange={e => e.target.files[0] && handleInvFile(e.target.files[0])}/>
                  {invFileName ? (
                    <div>
                      <div className="text-ottrd-text font-medium text-sm">{invFileName}</div>
                      <div className="text-green-400 text-xs mt-1">{invMap.size} SKUs loaded</div>
                      <button onClick={(e) => { e.stopPropagation(); clearInv(); }} className="text-xs text-ottrd-muted hover:text-red-400 mt-2">Remove</button>
                    </div>
                  ) : (
                    <div>
                      <div className="text-ottrd-muted text-sm">Drop FBA inventory CSV</div>
                      <div className="text-ottrd-muted/50 text-xs mt-1">or click to browse</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Sales upload */}
              <div>
                <label className="block text-sm text-ottrd-muted mb-2">Sales Report (Business Reports)</label>
                <div className="drop-zone border-2 border-dashed rounded-xl p-5 text-center cursor-pointer border-ottrd-border hover:border-ottrd-muted transition-all"
                  onClick={() => salesInputRef.current?.click()}>
                  <input ref={salesInputRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" className="hidden" onChange={e => e.target.files[0] && handleSalesFile(e.target.files[0])}/>
                  {salesFileName ? (
                    <div>
                      <div className="text-ottrd-text font-medium text-sm">{salesFileName}</div>
                      <div className="text-green-400 text-xs mt-1">{salesMap.size} SKUs loaded</div>
                      <button onClick={(e) => { e.stopPropagation(); clearSales(); }} className="text-xs text-ottrd-muted hover:text-red-400 mt-2">Remove</button>
                    </div>
                  ) : (
                    <div>
                      <div className="text-ottrd-muted text-sm">Drop sales CSV</div>
                      <div className="text-ottrd-muted/50 text-xs mt-1">or click to browse</div>
                    </div>
                  )}
                </div>

                {salesMap.size > 0 && (
                  <div className="mt-3">
                    <label className="block text-xs text-ottrd-muted mb-1.5">Days covered by this report:</label>
                    <div className="flex gap-2">
                      {[30, 60, 90, 120].map((d) => (
                        <button key={d} onClick={() => setSalesWindowDays(d)}
                          className={`flex-1 py-1.5 rounded text-xs font-medium border transition-all ${salesWindowDays === d ? "bg-ottrd-accent/20 border-ottrd-accent text-ottrd-accent" : "border-ottrd-border text-ottrd-muted hover:text-ottrd-text"}`}>
                          {d}d
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Sec>

          <Sec title="Step 3 - Deal thresholds" d="0.2s">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <SI label="Sales threshold" value={threshold} onChange={setThreshold} suffix="/mo"/>
              <SI label="Min ROI %" value={minRoi} onChange={setMinRoi} suffix="%"/>
              <SI label="Min profit $" value={minProfit} onChange={setMinProfit} prefix="$" step={0.5}/>
              <SI label="Overhead %" value={overhead} onChange={setOverhead} suffix="%"/>
            </div>
            <p className="text-ottrd-muted/50 text-xs mt-3">SKUs below min profit $ but above min ROI% are flagged orange. Overhead adds a % to cost for freight, prep, supplies.</p>
          </Sec>

          <Sec title="Step 4 - Price basis for ROI" d="0.3s">
            <div className="flex flex-wrap gap-2 mb-4">
              {[["min_selected","Min of selected"],["current","Today's BB"],["avg30","30-day avg"],["avg90","90-day avg"],["avg180","180-day avg"],["avg365","365-day avg"],["monthly_low","Monthly low (Step 6)"]].map(([v,l])=>(
                <button key={v} onClick={()=>setPriceBasis(v)} className={`px-3 py-2 rounded-lg text-sm border transition-all ${priceBasis===v?"bg-ottrd-accent/20 border-ottrd-accent text-ottrd-accent":"border-ottrd-border text-ottrd-muted hover:text-ottrd-text"}`}>{l}</button>
              ))}
            </div>
            {priceBasis==="min_selected"&&(
              <div className="flex flex-wrap gap-3 mt-3 pl-1">
                <span className="text-ottrd-muted text-sm">Include:</span>
                {[["Current",pbCurrent,setPbCurrent],["30-day",pbAvg30,setPbAvg30],["90-day",pbAvg90,setPbAvg90],["180-day",pbAvg180,setPbAvg180],["365-day",pbAvg365,setPbAvg365]].map(([l,v,s])=>(
                  <label key={l} className="flex items-center gap-1.5 text-sm text-ottrd-muted cursor-pointer"><input type="checkbox" checked={v} onChange={e=>s(e.target.checked)} className="accent-blue-500"/>{l}</label>
                ))}
              </div>
            )}
            <p className="text-ottrd-muted/50 text-xs mt-3">Tip: "Min of selected" is the most conservative - uses the lowest price across your chosen windows.</p>
          </Sec>

          <Sec title="Step 5 - Peak sales months and order qty" d="0.4s">
            <p className="text-ottrd-muted text-sm mb-3">Include only these months when calculating peak sales and suggested order qty:</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {MONTH_NAMES.map(m=>(<button key={m} onClick={()=>setMonthFilters(prev=>({...prev,[m]:!prev[m]}))} className={`w-12 py-2 rounded-lg text-xs font-medium border transition-all ${monthFilters[m]?"bg-ottrd-accent/20 border-ottrd-accent text-ottrd-accent":"border-ottrd-border text-ottrd-muted hover:text-ottrd-text"}`}>{m}</button>))}
            </div>
            <div className="flex gap-2 mb-6">
              <PB label="All" onClick={setAllMonths}/><PB label="Q4 only" onClick={setQ4}/><PB label="Last 6 months" onClick={setLast6}/>
            </div>
            <div className="pt-4 border-t border-ottrd-border">
              <h3 className="text-sm font-medium text-ottrd-text mb-3">Order quantity basis</h3>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-ottrd-muted cursor-pointer"><input type="radio" name="ob" checked={orderBasis==="peak"} onChange={()=>setOrderBasis("peak")} className="accent-blue-500"/>Peak of selected</label>
                <label className="flex items-center gap-2 text-sm text-ottrd-muted cursor-pointer"><input type="radio" name="ob" checked={orderBasis==="avg"} onChange={()=>setOrderBasis("avg")} className="accent-blue-500"/>{"Average x"}</label>
                <div className="flex items-center gap-1">
                  <input type="number" value={orderPct} onChange={e=>setOrderPct(Number(e.target.value))} disabled={orderBasis!=="avg"} className="w-16 bg-ottrd-bg border border-ottrd-border rounded px-2 py-1 text-sm text-ottrd-text text-center disabled:opacity-40"/>
                  <span className="text-ottrd-muted text-sm">%</span>
                </div>
              </div>
              <div className="flex gap-1.5 mt-3">
                {[25,35,50,75,90,100].map(p=>(<button key={p} onClick={()=>{setOrderBasis("avg");setOrderPct(p);}} className={`px-2.5 py-1 rounded text-xs border transition-all ${orderPct===p&&orderBasis==="avg"?"bg-ottrd-accent/20 border-ottrd-accent text-ottrd-accent":"border-ottrd-border text-ottrd-muted hover:text-ottrd-text"}`}>{p}%</button>))}
              </div>
              <p className="text-ottrd-muted/50 text-xs mt-3">e.g. 50% of avg = conservative reorder. 90% = near-full replenishment.</p>
            </div>
          </Sec>

          <Sec title="Step 6 - Monthly price history (optional)" d="0.5s">
            <p className="text-ottrd-muted text-sm mb-3">Select months to analyse: avg price, lowest price, and days at lowest price.</p>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
              {phOptions.map(o=>(<button key={o.key} onClick={()=>setPhSelected(prev=>({...prev,[o.key]:!prev[o.key]}))} className={`py-2 rounded-lg text-xs font-medium border transition-all ${phSelected[o.key]?"bg-ottrd-accent/20 border-ottrd-accent text-ottrd-accent":"border-ottrd-border text-ottrd-muted hover:text-ottrd-text"}`}>{o.label}</button>))}
            </div>
            <div className="flex gap-2 mb-4">
              <PB label="Select all" onClick={()=>setPhSelected(Object.fromEntries(phOptions.map(o=>[o.key,true])))}/>
              <PB label="Clear all" onClick={()=>setPhSelected(Object.fromEntries(phOptions.map(o=>[o.key,false])))}/>
              <PB label="Last 6" onClick={()=>{const ks=phOptions.slice(-6).map(o=>o.key);setPhSelected(Object.fromEntries(phOptions.map(o=>[o.key,ks.includes(o.key)])));}}/>
            </div>
            <div className="pt-4 border-t border-ottrd-border">
              <label className="flex items-center gap-2 text-sm text-ottrd-muted cursor-pointer">
                <input type="checkbox" checked={useMonthlyLow} onChange={e=>setUseMonthlyLow(e.target.checked)} className="accent-blue-500"/>
                Also use lowest price across selected months as an additional ROI price basis option
              </label>
              <p className="text-ottrd-muted/50 text-xs mt-2 pl-5">When checked, "Monthly Low" will appear as a price basis choice and can be included in min-of-selected calculation.</p>
            </div>
          </Sec>

          <div className="text-center mt-4">
            <button onClick={runAnalysis} disabled={running} className="px-12 py-4 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white font-display text-lg rounded-xl shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-blue-500/30 hover:scale-[1.02] active:scale-[0.98]">
              {running ? "Analyzing..." : "Run Analysis"}
            </button>
          </div>
        </main>
      )}

      {view === "analysis" && (
        <main className="max-w-5xl mx-auto px-6 py-10 animate-fade-in">
          <h2 className="font-display text-2xl text-ottrd-text mb-6">Analysis Running</h2>
          <div className="mb-6">
            <div className="flex justify-between text-sm text-ottrd-muted mb-2"><span>{progressMsg}</span><span>{Math.round(progress)}%</span></div>
            <div className="h-2 bg-ottrd-bg rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full transition-all duration-300" style={{width:`${progress}%`}}/></div>
          </div>
          <div ref={logRef} className="log-console rounded-xl border border-ottrd-border p-4 h-96 overflow-y-auto">
            {logs.map((l,i)=>(<div key={i} className={`log-line-${l.type||"default"}`}>{l.message}</div>))}
            {running&&<div className="animate-pulse-soft text-ottrd-accent mt-2">Processing...</div>}
          </div>
        </main>
      )}

      {view === "results" && (
        <main className="max-w-[110rem] mx-auto px-6 py-10 animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <h2 className="font-display text-2xl text-ottrd-text">Analysis Results</h2>
            <button onClick={exportExcel} className="px-6 py-2.5 bg-ottrd-green/20 text-ottrd-green border border-ottrd-green/30 rounded-lg text-sm font-medium hover:bg-ottrd-green/30 transition-colors">Export Excel</button>
          </div>

          <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
            <SC label="Total" value={stats.total}/><SC label={`Ever ${threshold}+`} value={stats.everHit} color="blue"/><SC label="Buy" value={stats.buys} color="green"/><SC label="Review" value={stats.reviews} color="amber"/><SC label="Pass" value={stats.passes} color="gray"/><SC label="Not Found" value={stats.notFound} color="gray"/>
          </div>

          <div className="flex gap-2 mb-4">
            {[["all","All"],["buy","Buy / Review"],["pass","Pass"]].map(([k,l])=>(<button key={k} onClick={()=>setResultFilter(k)} className={`px-4 py-2 rounded-lg text-sm border transition-all ${resultFilter===k?"bg-ottrd-accent/20 border-ottrd-accent text-ottrd-accent":"border-ottrd-border text-ottrd-muted hover:text-ottrd-text"}`}>{l}</button>))}
          </div>

          <details className="mb-4">
            <summary className="text-ottrd-muted text-sm cursor-pointer hover:text-ottrd-text">Show analysis log ({logs.length} entries)</summary>
            <div className="log-console rounded-xl border border-ottrd-border p-4 h-48 overflow-y-auto mt-2">
              {logs.map((l,i)=>(<div key={i} className={`log-line-${l.type||"default"}`}>{l.message}</div>))}
            </div>
          </details>

          <div className="border border-ottrd-border rounded-xl overflow-auto max-h-[70vh]">
            <table className="results-table w-full text-left">
              <thead>
                <tr className="text-xs text-blue-200 uppercase tracking-wider">
                  <th className="px-3 py-3 whitespace-nowrap">Product</th>
                  <th className="px-3 py-3">UPC</th>
                  <th className="px-3 py-3">ASIN</th>
                  <th className="px-3 py-3 text-right">Cost</th>
                  <th className="px-3 py-3 text-right">True Cost</th>
                  <th className="px-3 py-3 text-right">Amz Price</th>
                  <th className="px-3 py-3 text-right">Ref %</th>
                  <th className="px-3 py-3 text-right">FBA Fee</th>
                  <th className="px-3 py-3 text-center">Fee Src</th>
                  <th className="px-3 py-3 text-right">Net Profit</th>
                  <th className="px-3 py-3 text-right">ROI %</th>
                  <th className="px-3 py-3 text-center">{`Ever ${threshold}+`}</th>
                  <th className="px-3 py-3 text-right">Peak</th>
                  <th className="px-3 py-3 text-right">Avg</th>
                  <th className="px-3 py-3 text-right">Sug. Qty</th>
                  <th className="px-3 py-3 text-right">Target Buy</th>
                  <th className="px-3 py-3">Gap</th>
                  <th className="px-3 py-3">% Off</th>
                  <th className="px-3 py-3 text-right">Sellers (Avg)</th>
                  <th className="px-3 py-3 text-center">FBA / FBM</th>
                  <th className="px-3 py-3 text-center">Amz 180d</th>
                  <th className="px-3 py-3 text-right">Amz BB%</th>
                  <th className="px-3 py-3 text-right">3P BB%</th>
                  <th className="px-3 py-3 text-right">Sell-Out</th>
                  {invMap.size > 0 && <th className="px-3 py-3 text-right">In Stock</th>}
                  {invMap.size > 0 && <th className="px-3 py-3 text-right">Inbound</th>}
                  {invMap.size > 0 && <th className="px-3 py-3 text-right">Reserved</th>}
                  {salesMap.size > 0 && <th className="px-3 py-3 text-right">Your Velocity</th>}
                  {invMap.size > 0 && salesMap.size > 0 && <th className="px-3 py-3 text-right">Days of Supply</th>}
                  <th className="px-3 py-3 text-center">Decision</th>
                  {mk.map(m=>(<th key={m} className="px-2 py-3 text-center text-[10px]">{m}</th>))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ottrd-border/50">
                {filteredResults.map((r,i)=>{
                  const eH=Object.values(r.monthly||{}).some(v=>v>=threshold);
                  return (
                    <tr key={i} className={`text-sm ${r.lowProfit?"bg-orange-900/15":r.decision==="Buy"?"bg-green-900/10":r.decision==="Review"?"bg-yellow-900/5":""}`}>
                      <td className="px-3 py-2.5 max-w-[250px] truncate text-ottrd-text" title={r.title}>{r.title}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-ottrd-muted">{r.upc}</td>
                      <td className="px-3 py-2.5 font-mono text-xs">{r.asin?<a href={`https://amazon.com/dp/${r.asin}`} target="_blank" rel="noopener" className="text-ottrd-accent hover:underline">{r.asin}</a>:"—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-blue-400">{fmtDollars(r.cost)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-amber-700">{fmtDollars(r.trueCost)}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{fmtDollars(r.amzPrice)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-ottrd-muted text-xs">{fmtPct(r.referralPct)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-ottrd-muted text-xs">{fmtDollars(r.fbaFee)}</td>
                      <td className="px-3 py-2.5 text-center text-xs"><span className={r.feeSource==="Keepa"?"text-green-400":"text-amber-500"}>{r.feeSource}</span></td>
                      <td className={`px-3 py-2.5 text-right font-mono font-semibold ${r.netProfit!=null?(r.netProfit>0?"text-green-400":"text-red-400"):"text-ottrd-muted"}`}>{fmtDollars(r.netProfit)}</td>
                      <td className={`px-3 py-2.5 text-right font-mono font-semibold ${r.roi!=null?(r.roi>=30?"text-green-400":r.roi>=15?"text-amber-400":"text-red-400"):"text-ottrd-muted"}`}>{fmtPct(r.roi)}</td>
                      <td className="px-3 py-2.5 text-center"><span className={`text-xs font-bold ${eH?"text-green-400":"text-red-400"}`}>{eH?"YES":"NO"}</span></td>
                      <td className="px-3 py-2.5 text-right font-mono text-ottrd-muted">{r.peakFiltered||"—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-ottrd-muted">{r.avgFiltered?r.avgFiltered.toFixed(1):"—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono font-semibold text-green-400">{r.suggestedQty||"—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-blue-400">{fmtDollars(r.targetSupplier)}</td>
                      <td className={`px-3 py-2.5 text-xs whitespace-nowrap ${r.priceGap!=null?(r.priceGap<=0?"text-green-400":"text-amber-400"):"text-ottrd-muted"}`}>{r.priceGap!=null?(r.priceGap<=0?"On target":`$${r.priceGap.toFixed(2)} off`):"—"}</td>
                      <td className={`px-3 py-2.5 text-xs whitespace-nowrap ${r.pctOffNeeded!=null?(r.pctOffNeeded<=0?"text-green-400":r.pctOffNeeded<=10?"text-amber-400":"text-red-400"):"text-ottrd-muted"}`}>{r.pctOffNeeded!=null?(r.pctOffNeeded<=0?"On target":`${r.pctOffNeeded.toFixed(1)}%`):"—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-ottrd-muted text-xs">{r.avgSellersFiltered != null ? r.avgSellersFiltered.toFixed(1) : (r.currentSellers != null ? r.currentSellers : "—")}</td>
                      <td className="px-3 py-2.5 text-center font-mono text-xs text-ottrd-muted">{r.fbaCount != null ? `${r.fbaCount} / ${r.fbmCount}` : "—"}</td>
                      <td className="px-3 py-2.5 text-center text-xs"><span className={r.amazonOnListing180d ? "text-red-400 font-bold" : "text-green-400"}>{r.amazonOnListing180d == null ? "—" : (r.amazonOnListing180d ? "YES" : "NO")}</span></td>
                      <td className={`px-3 py-2.5 text-right font-mono text-xs ${r.amazonBbWinPct != null ? (r.amazonBbWinPct >= 20 ? "text-red-400" : r.amazonBbWinPct >= 5 ? "text-amber-400" : "text-green-400") : "text-ottrd-muted"}`}>{r.amazonBbWinPct != null ? `${r.amazonBbWinPct.toFixed(1)}%` : "—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-ottrd-muted">{r.topThirdPartyBbWinPct != null ? `${r.topThirdPartyBbWinPct.toFixed(1)}%` : "—"}</td>
                      <td className={`px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap ${r.daysToSellOut != null ? (r.daysToSellOut < 60 ? "text-green-400 font-bold" : r.daysToSellOut <= 120 ? "text-amber-400" : "text-red-400") : "text-ottrd-muted"}`}>{r.daysToSellOut != null ? `${r.daysToSellOut}d` : "—"}</td>
                      {invMap.size > 0 && (
                        <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">
                          {r.inStock === "never_sold" ? <span className="text-ottrd-muted/50 italic">Never sold</span>
                            : typeof r.inStock === "number" ? <span className={r.inStock > 0 ? "text-green-400 font-bold" : "text-amber-500"}>{r.inStock}</span>
                            : "—"}
                        </td>
                      )}
                      {invMap.size > 0 && (
                        <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">
                          {r.inbound === "never_sold" ? <span className="text-ottrd-muted/50">—</span>
                            : typeof r.inbound === "number" ? <span className={r.inbound > 0 ? "text-blue-400" : "text-ottrd-muted"}>{r.inbound}</span>
                            : "—"}
                        </td>
                      )}
                      {invMap.size > 0 && (
                        <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">
                          {r.reserved === "never_sold" ? <span className="text-ottrd-muted/50">—</span>
                            : typeof r.reserved === "number" ? <span className={r.reserved > 0 ? "text-amber-400" : "text-ottrd-muted"}>{r.reserved}</span>
                            : "—"}
                        </td>
                      )}
                      {salesMap.size > 0 && (
                        <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">
                          {r.velocityPerMo === "never_sold" ? <span className="text-ottrd-muted/50 italic">Never sold</span>
                            : typeof r.velocityPerMo === "number" ? (
                              <span className={r.velocityPerMo > 0 ? "text-green-400" : "text-ottrd-muted"}>
                                {r.velocityPerMo.toFixed(1)}/mo
                                <span className="text-ottrd-muted/60 ml-1">({r.velocityRaw} in {salesWindowDays}d)</span>
                              </span>
                            ) : "—"}
                        </td>
                      )}
                      {invMap.size > 0 && salesMap.size > 0 && (
                        <td className={`px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap ${r.daysOfSupply != null ? (r.daysOfSupply >= 60 ? "text-green-400" : r.daysOfSupply >= 30 ? "text-amber-400" : "text-red-400 font-bold") : "text-ottrd-muted"}`}>
                          {r.daysOfSupply != null ? `${r.daysOfSupply}d` : "—"}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-center"><span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium badge-${r.decision.toLowerCase()}`}>{r.decision}</span></td>
                      {mk.map(m=>{const v=(r.monthly||{})[m];return(<td key={m} className={`px-2 py-2.5 text-center font-mono text-xs ${v!=null&&v>=threshold?"text-green-400 font-bold bg-green-900/20":v!=null&&v>0?"text-yellow-300":"text-ottrd-muted/30"}`}>{v!=null?v:""}</td>);})}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </main>
      )}

      <footer className="border-t border-ottrd-border mt-20 py-6 text-center text-ottrd-muted/40 text-xs">Ottrd - Amazon Deal Underwriting</footer>
    </div>
  );
}

function Sec({title,d,children}){return(<section className="mb-8 bg-ottrd-surface border border-ottrd-border rounded-xl p-6 animate-slide-up" style={{animationDelay:d}}><h2 className="font-display text-lg text-ottrd-text mb-4">{title}</h2>{children}</section>);}

function SI({label,value,onChange,prefix,suffix,step=1}){return(<div><label className="block text-sm text-ottrd-muted mb-1.5">{label}</label><div className="flex items-center bg-ottrd-bg border border-ottrd-border rounded-lg overflow-hidden">{prefix&&<span className="px-2 text-ottrd-muted text-sm">{prefix}</span>}<input type="number" value={value} step={step} onChange={e=>onChange(Number(e.target.value))} className="flex-1 bg-transparent px-3 py-2.5 text-ottrd-text text-sm focus:outline-none w-full"/>{suffix&&<span className="px-2 text-ottrd-muted text-sm">{suffix}</span>}</div></div>);}

function PB({label,onClick}){return(<button onClick={onClick} className="px-3 py-1.5 border border-ottrd-border rounded-lg text-xs text-ottrd-muted hover:text-ottrd-text hover:border-ottrd-muted transition-colors">{label}</button>);}

function SC({label,value,color}){const c={green:"text-green-400 bg-green-900/20 border-green-800/30",amber:"text-amber-400 bg-amber-900/20 border-amber-800/30",blue:"text-blue-400 bg-blue-900/20 border-blue-800/30",gray:"text-ottrd-muted bg-ottrd-surface border-ottrd-border"};return(<div className={`rounded-xl border p-4 ${c[color]||"text-ottrd-text bg-ottrd-surface border-ottrd-border"}`}><div className="text-2xl font-display font-bold">{value}</div><div className="text-xs opacity-70 mt-1">{label}</div></div>);}
