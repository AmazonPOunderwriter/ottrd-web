import { fetchKeepaBatch, fetchKeepaBatchByAsin, analyzeItem, notFoundResult, last12Months } from "../../../lib/keepa";

export const maxDuration = 300;

const MAX_CODES_PER_BATCH = 95; // Keepa max is 100 codes; leave headroom for UPC variants
const MAX_ASINS_PER_BATCH = 100; // ASINs are exact (no variants) — can hit the full cap
const CONCURRENCY = 5;          // 5 batches in flight at once
const TOKEN_FLOOR = 50;         // Pause if Keepa tokens drop below this
const TOKEN_PAUSE_MS = 8000;    // Wait 8s before resuming when tokens are low

export async function POST(request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      function send(event, data) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`));
        } catch {
          closed = true;
        }
      }

      try {
        const body = await request.json();
        const { items, apiKey: userApiKey, settings } = body;

        const apiKey = process.env.KEEPA_API_KEY || userApiKey;
        if (!apiKey) {
          send("error", { message: "Missing Keepa API key" });
          controller.close();
          return;
        }
        if (!items || !items.length) {
          send("error", { message: "No items to analyze" });
          controller.close();
          return;
        }

        const {
          threshold = 50, minRoi = 30, overhead = 15, minProfit = 2,
          overheadMin = 0, prepFee = 0,
          priceBasis = "min_selected",
          pbMap = { current: true, avg30: true, avg90: true, avg180: true, avg365: false },
          activeMonths = [1,2,3,4,5,6,7,8,9,10,11,12],
          orderBasis = "avg", orderPct = 50,
          phTargetMonths = [], useMonthlyLow = false,
          includeRating = false,
        } = settings;

        const analysisSettings = {
          threshold, minRoi, overhead: overhead / 100,
          overheadMin: overheadMin || 0,
          prepFee: prepFee || 0,
          priceBasis, pbMap,
          activeMonths, orderBasis, orderPct: orderPct / 100,
          minProfit, phTargetMonths, useMonthlyLow,
        };

        const total = items.length;
        // Split items by lookup type. ASIN beats UPC when both are present
        // (more reliable + no variant resolution needed).
        const asinItems = [];
        const codeItems = [];
        for (const item of items) {
          if (item.asin && typeof item.asin === "string" && item.asin.trim()) {
            asinItems.push(item);
          } else {
            codeItems.push(item);
          }
        }

        // Build batches separately per type. Each batch is tagged with its
        // `kind` so processBatch knows which Keepa endpoint to call.
        const batches = [];
        // ASIN batches — simple fixed-size chunking since ASINs are exact.
        for (let i = 0; i < asinItems.length; i += MAX_ASINS_PER_BATCH) {
          batches.push({
            idx: batches.length,
            kind: "asin",
            items: asinItems.slice(i, i + MAX_ASINS_PER_BATCH),
          });
        }
        // UPC batches — pack by variant count since each item may expand to 1-2 codes.
        {
          let cur = [];
          let curCodes = 0;
          for (const item of codeItems) {
            const variantCount = (item.variants && item.variants.length) || 1;
            if (cur.length && curCodes + variantCount > MAX_CODES_PER_BATCH) {
              batches.push({ idx: batches.length, kind: "code", items: cur });
              cur = [];
              curCodes = 0;
            }
            cur.push(item);
            curCodes += variantCount;
          }
          if (cur.length) batches.push({ idx: batches.length, kind: "code", items: cur });
        }

        send("log", {
          message: `${total} SKUs (${asinItems.length} by ASIN, ${codeItems.length} by UPC/EAN) split into ${batches.length} batches (${CONCURRENCY} concurrent)`,
          type: "info",
        });
        send("progress", { pct: 2, message: `Starting analysis of ${total} SKUs...` });
        // Tell the client we're using streaming results so it can prep the table early
        send("stream-start", { total, monthKeys: last12Months() });

        let doneItems = 0;
        let lastTokensLeft = null;

        // Process a single batch: fetch from Keepa, analyze, emit chunk.
        async function processBatch(batch) {
          const tag = `B${batch.idx + 1}/${batches.length}[${batch.kind}]`;

          // Backpressure: if we're near the token floor, hold off briefly.
          if (lastTokensLeft != null && lastTokensLeft < TOKEN_FLOOR) {
            send("log", { message: `   ${tag} waiting for Keepa tokens to refill (${lastTokensLeft} left)...`, type: "warning" });
            await new Promise(r => setTimeout(r, TOKEN_PAUSE_MS));
          }

          let keepaData = {};
          try {
            let resp;
            if (batch.kind === "asin") {
              const asinList = [...new Set(batch.items.map(it => String(it.asin).trim().toUpperCase()).filter(Boolean))];
              resp = await fetchKeepaBatchByAsin(asinList, apiKey, 1, 3, includeRating);
            } else {
              const allCodes = [];
              for (const item of batch.items) {
                allCodes.push(...(item.variants || [item.upc]));
              }
              const uniqueCodes = [...new Set(allCodes)];
              resp = await fetchKeepaBatch(uniqueCodes, apiKey, 1, 3, includeRating);
            }
            keepaData = resp.data;
            if (resp.tokensLeft !== undefined) {
              lastTokensLeft = resp.tokensLeft;
              send("log", { message: `   ${tag} done — Keepa tokens left: ${resp.tokensLeft}`, type: "info" });
            }
          } catch (e) {
            send("log", { message: `   ${tag} failed: ${e.message}`, type: "error" });
            const notFound = batch.items.map(it => notFoundResult(it, analysisSettings.overhead, analysisSettings.overheadMin, analysisSettings.prepFee));
            send("results-chunk", { results: notFound });
            doneItems += batch.items.length;
            const pct = Math.min(98, Math.round((doneItems / total) * 95) + 2);
            send("progress", { pct, message: `Analyzed ${doneItems} of ${total} SKUs...` });
            return;
          }

          const chunkResults = [];
          let foundInBatch = 0;
          for (const item of batch.items) {
            const seenAsins = new Set();
            const allProds = [];

            if (batch.kind === "asin") {
              // Direct ASIN lookup — keepaData is keyed by uppercase ASIN.
              const asinKey = String(item.asin).trim().toUpperCase();
              for (const p of (keepaData[asinKey] || [])) {
                const k = p.asin || "";
                if (k && !seenAsins.has(k)) {
                  seenAsins.add(k);
                  allProds.push(p);
                }
              }
            } else {
              // UPC/EAN lookup — walk every variant and dedupe by ASIN.
              for (const v of (item.variants || [item.upc])) {
                for (const p of (keepaData[v] || [])) {
                  const asinKey = p.asin || "";
                  if (asinKey && !seenAsins.has(asinKey)) {
                    seenAsins.add(asinKey);
                    allProds.push(p);
                  }
                }
              }
            }

            if (!allProds.length) {
              chunkResults.push(notFoundResult(item, analysisSettings.overhead, analysisSettings.overheadMin, analysisSettings.prepFee));
              continue;
            }
            for (const prod of allProds) {
              const result = analyzeItem(item, prod, analysisSettings);
              chunkResults.push(result);
              foundInBatch++;
            }
          }

          send("results-chunk", { results: chunkResults });

          doneItems += batch.items.length;
          const pct = Math.min(98, Math.round((doneItems / total) * 95) + 2);
          send("progress", { pct, message: `Analyzed ${doneItems} of ${total} SKUs...` });
          send("log", {
            message: `   ${tag} ${foundInBatch}/${batch.items.length} found`,
            type: "success",
          });
        }

        // Run batches with bounded concurrency (worker-pool pattern).
        let cursor = 0;
        async function worker() {
          while (true) {
            const myIdx = cursor++;
            if (myIdx >= batches.length) return;
            await processBatch(batches[myIdx]);
          }
        }
        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, batches.length); i++) {
          workers.push(worker());
        }
        await Promise.all(workers);

        send("log", { message: "—".repeat(40) });
        send("log", { message: `  Analysis complete — ${total} SKUs processed`, type: "success" });
        send("progress", { pct: 100, message: "Analysis complete!" });
        send("done", {});

      } catch (e) {
        send("error", { message: e.message });
      } finally {
        closed = true;
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
