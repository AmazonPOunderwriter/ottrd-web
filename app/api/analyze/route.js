import { fetchKeepaBatch, analyzeItem, notFoundResult } from "../../../lib/keepa";
import { getServerSession } from "next-auth";
import { supabase, canRunAnalysis, recordUsage, getUserPlan } from "../../../lib/db";

export const maxDuration = 300; // 5 min max for Vercel Pro

export async function POST(request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event, data) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`));
      }

      try {
        // Auth check
        const session = await getServerSession();
        if (!session?.user?.email) {
          send("error", { message: "Please sign in to run an analysis." });
          controller.close();
          return;
        }

        // Get user from DB
        let userId = null;
        if (supabase) {
          const { data: dbUser } = await supabase
            .from("users")
            .select("id")
            .eq("email", session.user.email)
            .single();
          userId = dbUser?.id;
        }

        const body = await request.json();
        const { items, settings } = body;

        // Use server-side Keepa key
        const apiKey = process.env.KEEPA_API_KEY;
        if (!apiKey) {
          send("error", { message: "Keepa API key not configured on server." });
          controller.close();
          return;
        }

        if (!items || !items.length) {
          send("error", { message: "No items to analyze" });
          controller.close();
          return;
        }

        // Check usage limits
        if (userId && supabase) {
          const check = await canRunAnalysis(userId, items.length);
          if (!check.allowed) {
            send("error", { message: check.reason });
            controller.close();
            return;
          }
        }

        const {
          threshold = 50, minRoi = 30, overhead = 15, minProfit = 2,
          priceBasis = "min_selected",
          pbMap = { current: true, avg30: true, avg90: true, avg180: true, avg365: false },
          activeMonths = [1,2,3,4,5,6,7,8,9,10,11,12],
          orderBasis = "avg", orderPct = 50,
          phTargetMonths = [], useMonthlyLow = false,
        } = settings;

        const analysisSettings = {
          threshold, minRoi, overhead: overhead / 100,
          priceBasis, pbMap,
          activeMonths, orderBasis, orderPct: orderPct / 100,
          minProfit, phTargetMonths, useMonthlyLow,
        };

        const BATCH = 50;
        const total = items.length;
        const batches = [];
        for (let i = 0; i < total; i += BATCH) {
          batches.push(items.slice(i, i + BATCH));
        }

        send("log", { message: `🚀 ${total} SKUs split into ${batches.length} batches of ${BATCH}`, type: "info" });
        send("progress", { pct: 5, message: `Starting analysis of ${total} SKUs...` });

        const allResults = [];
        let doneCount = 0;

        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
          const batch = batches[batchIdx];

          try {
            // Collect all UPC variants
            const allCodes = [];
            for (const item of batch) {
              allCodes.push(...(item.variants || [item.upc]));
            }
            const uniqueCodes = [...new Set(allCodes)];

            send("log", { message: `   📡 Batch ${batchIdx + 1}/${batches.length}: querying ${uniqueCodes.length} codes...` });

            const { data: keepaData, tokensLeft } = await fetchKeepaBatch(uniqueCodes, apiKey);

            if (tokensLeft !== undefined) {
              send("log", { message: `   🔑 Keepa tokens remaining: ${tokensLeft}`, type: "info" });
            }

            let batchFound = 0;
            for (const item of batch) {
              // Find matching products across all variants
              const allProds = [];
              const seenAsins = new Set();
              for (const v of (item.variants || [item.upc])) {
                for (const p of (keepaData[v] || [])) {
                  const asinKey = p.asin || "";
                  if (asinKey && !seenAsins.has(asinKey)) {
                    seenAsins.add(asinKey);
                    allProds.push(p);
                  }
                }
              }

              if (!allProds.length) {
                allResults.push(notFoundResult(item, analysisSettings.overhead));
                continue;
              }

              for (const prod of allProds) {
                const result = analyzeItem(item, prod, analysisSettings);
                allResults.push(result);
                batchFound++;

                const emoji = result.decision === "Buy" ? "✅" : result.decision === "Review" ? "🟡" : "✗ ";
                const roiStr = result.roi != null ? `${result.roi.toFixed(1)}%` : "—";
                send("log", {
                  message: `   ${emoji} [${result.decision.padEnd(6)}]  ${result.title.slice(0, 35).padEnd(35)}  Avg:${result.avgFiltered.toFixed(0).padStart(5)}  Peak:${String(result.peakFiltered).padStart(4)}  ROI:${roiStr}`,
                  type: result.decision === "Buy" ? "success" : result.decision === "Review" ? "warning" : "default",
                });
              }
            }

            doneCount += batch.length;
            const pct = Math.round((doneCount / total) * 90) + 5;
            send("progress", { pct, message: `Analyzed ${doneCount} of ${total} SKUs...` });
            send("log", {
              message: `   ✓  Batch ${batchIdx + 1}/${batches.length} done — ${batchFound}/${batch.length} found`,
              type: "success",
            });

          } catch (e) {
            send("log", { message: `   ⚠  Batch ${batchIdx + 1} failed: ${e.message}`, type: "error" });
            for (const item of batch) {
              allResults.push(notFoundResult(item, analysisSettings.overhead));
            }
            doneCount += batch.length;
          }
        }

        // Summary
        const buys = allResults.filter(r => r.decision === "Buy").length;
        const reviews = allResults.filter(r => r.decision === "Review").length;
        const passes = allResults.filter(r => r.decision === "Pass").length;
        const notFound = allResults.filter(r => !r.found).length;
        const everHit = allResults.filter(r => Object.values(r.monthly || {}).some(v => v >= threshold)).length;

        send("log", { message: "\n" + "─".repeat(60) });
        send("log", { message: "  ANALYSIS COMPLETE", type: "info" });
        send("log", { message: "─".repeat(60) });
        send("log", { message: `  Total SKUs          : ${allResults.length}` });
        send("log", { message: `  Ever hit ${threshold}+/month  : ${everHit}`, type: "success" });
        send("log", { message: `  Buy                 : ${buys}`, type: "success" });
        send("log", { message: `  Review              : ${reviews}`, type: "warning" });
        send("log", { message: `  Pass                : ${passes}` });
        send("log", { message: `  Not found in Keepa  : ${notFound}` });
        send("log", { message: "─".repeat(60) });

        send("progress", { pct: 100, message: "Analysis complete!" });
        send("results", { results: allResults, monthKeys: (await import("../../../lib/keepa.js")).last12Months() });

        // Record usage
        if (userId && supabase) {
          await recordUsage(userId, total);
          // Save analysis metadata
          await supabase.from("analyses").insert({
            user_id: userId,
            file_name: settings.fileName || "Untitled",
            total_skus: allResults.length,
            buy_count: buys,
            review_count: reviews,
            pass_count: passes,
            settings: { threshold, minRoi: settings.minRoi, overhead: settings.overhead },
          });
        }

        send("done", {});

      } catch (e) {
        send("error", { message: e.message });
      } finally {
        controller.close();
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
