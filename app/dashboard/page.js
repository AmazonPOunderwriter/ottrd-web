"use client";

import { useSession, signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import { redirect } from "next/navigation";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") {
      redirect("/auth");
    }
    if (status === "authenticated") {
      fetch("/api/usage")
        .then(r => r.json())
        .then(data => { setUsage(data); setLoading(false); })
        .catch(() => setLoading(false));
    }
  }, [status]);

  if (status === "loading" || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-ottrd-muted animate-pulse-soft">Loading dashboard...</p>
      </div>
    );
  }

  const hasPlan = usage?.plan && usage.plan !== "none" && usage?.subscriptionStatus === "active";
  const usagePct = usage?.skuLimit ? Math.round((usage.skusUsed / usage.skuLimit) * 100) : 0;

  return (
    <div className="min-h-screen">
      <header className="border-b border-ottrd-border bg-ottrd-surface/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-bold text-sm font-display">O</div>
            <span className="font-display text-xl text-ottrd-text">Ottrd</span>
          </a>
          <div className="flex items-center gap-4">
            {hasPlan && (
              <a href="/analyze" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 transition-colors">
                New Analysis
              </a>
            )}
            <div className="flex items-center gap-3">
              {session?.user?.image && (
                <img src={session.user.image} alt="" className="w-8 h-8 rounded-full" />
              )}
              <div className="text-right">
                <div className="text-sm text-ottrd-text">{session?.user?.name}</div>
                <button onClick={() => signOut({ callbackUrl: "/" })} className="text-xs text-ottrd-muted hover:text-ottrd-text">
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10 animate-fade-in">
        <h1 className="font-display text-3xl text-ottrd-text mb-8">Dashboard</h1>

        {/* Plan status */}
        {!hasPlan ? (
          <div className="bg-ottrd-surface border border-ottrd-border rounded-xl p-8 text-center mb-8">
            <h2 className="font-display text-xl text-ottrd-text mb-2">No active plan</h2>
            <p className="text-ottrd-muted mb-6">Subscribe to start analyzing deals with Keepa data.</p>
            <a href="/pricing" className="px-8 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 transition-colors inline-block">
              View Plans
            </a>
          </div>
        ) : (
          <>
            {/* Usage cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              <div className="bg-ottrd-surface border border-ottrd-border rounded-xl p-4">
                <div className="text-xs text-ottrd-muted mb-1">Current Plan</div>
                <div className="text-xl font-display text-ottrd-text">{usage?.planName}</div>
                <div className="text-xs text-ottrd-muted mt-1">{usage?.billingInterval === "annual" ? "Annual billing" : "Monthly billing"}</div>
              </div>
              <div className="bg-ottrd-surface border border-ottrd-border rounded-xl p-4">
                <div className="text-xs text-ottrd-muted mb-1">SKUs Used</div>
                <div className="text-xl font-display text-ottrd-text">{(usage?.skusUsed || 0).toLocaleString()}</div>
                <div className="text-xs text-ottrd-muted mt-1">of {(usage?.skuLimit || 0).toLocaleString()} this month</div>
              </div>
              <div className="bg-ottrd-surface border border-ottrd-border rounded-xl p-4">
                <div className="text-xs text-ottrd-muted mb-1">SKUs Remaining</div>
                <div className="text-xl font-display text-green-400">{(usage?.skusRemaining || 0).toLocaleString()}</div>
              </div>
              <div className="bg-ottrd-surface border border-ottrd-border rounded-xl p-4">
                <div className="text-xs text-ottrd-muted mb-1">Status</div>
                <div className={`text-xl font-display ${usage?.subscriptionStatus === "active" ? "text-green-400" : "text-red-400"}`}>
                  {usage?.subscriptionStatus === "active" ? "Active" : usage?.subscriptionStatus || "Inactive"}
                </div>
              </div>
            </div>

            {/* Usage bar */}
            <div className="bg-ottrd-surface border border-ottrd-border rounded-xl p-6 mb-8">
              <div className="flex justify-between text-sm text-ottrd-muted mb-2">
                <span>Monthly usage</span>
                <span>{usagePct}%</span>
              </div>
              <div className="h-3 bg-ottrd-bg rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${usagePct > 90 ? "bg-red-500" : usagePct > 70 ? "bg-amber-500" : "bg-blue-500"}`}
                  style={{ width: `${Math.min(usagePct, 100)}%` }}
                />
              </div>
              {usagePct > 80 && (
                <p className="text-xs text-amber-400 mt-2">
                  Running low on SKUs. <a href="/pricing" className="underline">Upgrade your plan</a> for more.
                </p>
              )}
            </div>

            {/* Recent analyses */}
            <div className="bg-ottrd-surface border border-ottrd-border rounded-xl p-6">
              <h2 className="font-display text-lg text-ottrd-text mb-4">Recent Analyses</h2>
              {usage?.recentAnalyses?.length > 0 ? (
                <div className="space-y-3">
                  {usage.recentAnalyses.map((a, i) => (
                    <div key={i} className="flex items-center justify-between py-3 border-b border-ottrd-border/50 last:border-0">
                      <div>
                        <div className="text-sm text-ottrd-text">{a.file_name}</div>
                        <div className="text-xs text-ottrd-muted">
                          {new Date(a.created_at).toLocaleDateString()} - {a.total_skus} SKUs
                        </div>
                      </div>
                      <div className="flex gap-3 text-xs">
                        <span className="text-green-400">{a.buy_count} Buy</span>
                        <span className="text-amber-400">{a.review_count} Review</span>
                        <span className="text-ottrd-muted">{a.pass_count} Pass</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-ottrd-muted text-sm">No analyses yet. Run your first one!</p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
