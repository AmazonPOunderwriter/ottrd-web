"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import * as XLSX from "xlsx";

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

export default function AnalyzePage() {
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === "unauthenticated") redirect("/auth");
  }, [status]);

  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState("");
  const [dragOver, setDragOver] = useState(false);

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
            else if (p.event === "results") { setResults(p.results); setMonthKeys(p.monthKeys); setView("results"); }
            else if (p.event === "error") setLogs(prev => [...prev, { message: p.message, type: "error" }]);
          } catch {}
        }
      }
    } catch (e) {
      setLogs(prev => [...prev, { message: `Network error: ${e.message}`, type: "error" }]);
    }
    setRunning(false);
  };

  const exportExcel = () => {
    if (!results.length) return;
    const mk = monthKeys.length ? monthKeys : last12Months();

    const phKeysSet = new Set();
    for (const r of results) for (const k of Object.keys(r.monthlyPh || {})) phKeysSet.add(k);
    const phKeys = [...phKeysSet].sort();

    const phH = []; for (const k of phKeys) phH.push(`${k} Avg $`, `${k} Low $`, `${k} Days@Low`);
    if (phKeys.length) phH.push("Monthly Low $");
    const fH = ["SKU","UPC","ASIN","Product Name","Invoice Cost","True Cost (w/ OH%)","Current BB","30d Avg BB","90d Avg BB","180d Avg BB","365d Avg BB","Price Used for ROI","Ref Fee %","Ref $","P&P Fee","Fee Source","Total FBA","Net Sale","Net Profit","ROI %",`Ever ${threshold}+ in 12mo`,"Peak (All)","Peak (Selected)","Avg (Selected)","Sug Qty","Qty Basis","Target Buy","Gap to Target","% Off Needed","Decision"];
    const s1 = [[...fH, ...phH, ...mk]];
    for (const r of results) {
      const gap = r.priceGap;
      const gS = gap != null ? (gap <= 0 ? "On target" : `Need $${gap.toFixed(2)} lower`) : "—";
      const pS = r.pctOffNeeded != null ? (r.pctOffNeeded <= 0 ? "On target" : `${r.pctOffNeeded.toFixed(1)}% off needed`) : "—";
      const eH = Object.values(r.monthly||{}).some(v => v >= threshold);
      const fV = [r.sku,r.upc,r.asin,r.title,r.cost,r.trueCost,r.priceCurrent,r.priceAvg30,r.priceAvg90,r.priceAvg180,r.priceAvg365,r.amzPrice,r.referralPct,r.referralFee,r.ppFee,r.feeSource,r.fbaFee,r.netSale,r.netProfit,r.roi,eH?"YES":"NO",r.peakAll||"",r.peakFiltered||"",r.avgFiltered||"",r.suggestedQty||"",r.qtyBasis,r.targetSupplier,gS,pS,r.decision];
      const pV = []; for (const k of phKeys) { const d=(r.monthlyPh||{})[k]; pV.push(d?d.avg:null,d?d.low:null,d?d.days_at_low:null); }
      if (phKeys.length) pV.push(r.monthlyLowPrice||null);
      s1.push([...fV,...pV,...mk.map(m=>(r.monthly||{})[m]??"")]);
    }
    const ws1 = XLSX.utils.aoa_to_sheet(s1);

    const bR = results.filter(r => r.decision==="Buy"||r.decision==="Review");
    const bH = ["SKU","UPC","ASIN","Product Name","Invoice Cost","True Cost","Amz Price","Net Profit","ROI %","Target Buy","Gap","% Off","Peak (Sel)","Avg (Sel)","Sug Qty","Qty Basis","Decision"];
    const s2 = [bH,...bR.map(r => { const g=r.priceGap; return [r.sku,r.upc,r.asin,r.title,r.cost,r.trueCost,r.amzPrice,r.netProfit,r.roi,r.targetSupplier,g!=null?(g<=0?"On target":`Need $${g.toFixed(2)} lower`):"—",r.pctOffNeeded!=null?(r.pctOffNeeded<=0?"On target":`${r.pctOffNeeded.toFixed(1)}%`):"—",r.peakFiltered,r.avgFiltered,r.suggestedQty,r.qtyBasis,r.decision]; })];
    const ws2 = XLSX.utils.aoa_to_sheet(s2);

    const nB=results.filter(r=>r.decision==="Buy").length, nR=results.filter(r=>r.decision==="Review").length, nP=results.filter(r=>r.decision==="Pass").length, nN=results.filter(r=>!r.found).length;
    const eC=results.filter(r=>Object.values(r.monthly||{}).some(v=>v>=threshold)).length;
    const po=results.filter(r=>r.decision==="Buy"||r.decision==="Review");
    const tC=po.reduce((s,r)=>s+(r.cost||0)*(r.suggestedQty||0),0);
    const tP=po.reduce((s,r)=>s+(r.netProfit||0)*(r.suggestedQty||0),0);
    const rs=po.filter(r=>r.roi!=null).map(r=>r.roi);
    const aR=rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:0;
    const ws3 = XLSX.utils.aoa_to_sheet([["DEAL SUMMARY",""],["Generated",new Date().toISOString().split("T")[0]],["Threshold",`${threshold}+ sales in any month`],["",""],["Total SKUs analyzed",results.length],[`Ever hit ${threshold}+ in 12 months`,eC],["",""],["Buy decisions",nB],["Review decisions",nR],["Pass decisions",nP],["Not found in Keepa",nN],["",""],["Estimated total PO cost",`$${tC.toFixed(2)}`],["Estimated total profit",`$${tP.toFixed(2)}`],["Average ROI on buy items",`${aR.toFixed(1)}%`]]);

    const tH = ["Product Name","UPC","ASIN","Quantity","Target Buy Price","% Off Needed","Min Profit Flag"];
    const tR = results.filter(r=>(r.decision==="Buy"||r.decision==="Review")&&(r.suggestedQty||0)>0);
    const s4 = [tH,...tR.map(r => { const g=r.priceGap; let pN=null; if(r.targetSupplier!=null&&r.cost>0) pN=g!=null&&g<=0?0:Math.round(((r.cost-r.targetSupplier)/r.cost)*1000)/10; return [r.title,r.upc,r.asin,r.suggestedQty,r.targetSupplier,pN,r.lowProfit?"Below min $":"OK"]; })];
    const ws4 = XLSX.utils.aoa_to_sheet(s4);

    let ws5 = null;
    if (phKeys.length) {
      const pH = ["SKU","UPC","ASIN","Product Name"]; for (const k of phKeys) pH.push(`${k} Avg $`,`${k} Low $`,`${k} Days@Low`); pH.push("Overall Low $");
      const s5 = [pH,...results.map(r => { const row=[r.sku,r.upc,r.asin,r.title]; const aL=[]; for(const k of phKeys){const d=(r.monthlyPh||{})[k];if(d){row.push(d.avg,d.low,d.days_at_low);if(d.low)aL.push(d.low);}else row.push(null,null,null);} row.push(aL.length?Math.round(Math.min(...aL)*100)/100:null); return row; })];
      ws5 = XLSX.utils.aoa_to_sheet(s5);
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, ws1, "Deal Analysis");
    XLSX.utils.book_append_sheet(workbook, ws2, "Buy List");
    XLSX.utils.book_append_sheet(workbook, ws3, "Summary");
    XLSX.utils.book_append_sheet(workbook, ws4, "Target PO");
    if (ws5) XLSX.utils.book_append_sheet(workbook, ws5, "Price History");
    XLSX.writeFile(workbook, `keepa_analysis_${new Date().toISOString().split("T")[0]}.xlsx`);
  };

  const filteredResults = results.filter(r => {
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

          <Sec title="Step 2 - Deal thresholds" d="0.1s">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <SI label="Sales threshold" value={threshold} onChange={setThreshold} suffix="/mo"/>
              <SI label="Min ROI %" value={minRoi} onChange={setMinRoi} suffix="%"/>
              <SI label="Min profit $" value={minProfit} onChange={setMinProfit} prefix="$" step={0.5}/>
              <SI label="Overhead %" value={overhead} onChange={setOverhead} suffix="%"/>
            </div>
            <p className="text-ottrd-muted/50 text-xs mt-3">SKUs below min profit $ but above min ROI% are flagged orange. Overhead adds a % to cost for freight, prep, supplies.</p>
          </Sec>

          <Sec title="Step 3 - Price basis for ROI" d="0.2s">
            <div className="flex flex-wrap gap-2 mb-4">
              {[["min_selected","Min of selected"],["current","Today's BB"],["avg30","30-day avg"],["avg90","90-day avg"],["avg180","180-day avg"],["avg365","365-day avg"],["monthly_low","Monthly low (Step 5)"]].map(([v,l])=>(
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

          <Sec title="Step 4 - Peak sales months and order qty" d="0.3s">
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

          <Sec title="Step 5 - Monthly price history (optional)" d="0.4s">
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
