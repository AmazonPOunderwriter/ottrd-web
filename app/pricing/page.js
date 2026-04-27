"use client";

import { useState } from "react";
import { useSession, signIn } from "next-auth/react";

const PLANS = [
  {
    key: "starter",
    name: "Starter",
    desc: "For small sellers testing the waters",
    monthlyPrice: 49,
    annualPrice: 529,
    skuLimit: "2,500",
    features: ["2,500 SKUs per month", "Full 12-month analysis", "6-step deal underwriting", "Excel export (5 sheets)", "Email support"],
  },
  {
    key: "professional",
    name: "Professional",
    desc: "For active wholesale sellers",
    monthlyPrice: 129,
    annualPrice: 1393,
    skuLimit: "15,000",
    popular: true,
    features: ["15,000 SKUs per month", "Full 12-month analysis", "6-step deal underwriting", "Excel export (5 sheets)", "Priority support", "Analysis history"],
  },
  {
    key: "enterprise",
    name: "Enterprise",
    desc: "For teams and large catalogs",
    monthlyPrice: 299,
    annualPrice: 3229,
    skuLimit: "50,000",
    features: ["50,000 SKUs per month", "Full 12-month analysis", "6-step deal underwriting", "Excel export (5 sheets)", "Dedicated support", "Analysis history", "Team accounts (coming soon)"],
  },
];

export default function PricingPage() {
  const [annual, setAnnual] = useState(false);
  const [loading, setLoading] = useState(null);
  const { data: session } = useSession();

  const handleCheckout = async (planKey) => {
    if (!session) {
      signIn("google", { callbackUrl: `/pricing` });
      return;
    }

    setLoading(planKey);
    try {
      const res = await fetch("/api/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planKey, interval: annual ? "annual" : "monthly" }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert(data.error || "Something went wrong");
      }
    } catch (err) {
      alert("Error creating checkout session");
    }
    setLoading(null);
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-ottrd-border bg-ottrd-surface/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-bold text-sm font-display">O</div>
            <span className="font-display text-xl text-ottrd-text">Ottrd</span>
          </a>
          <div className="flex gap-4 items-center">
            {session ? (
              <a href="/dashboard" className="text-sm text-ottrd-muted hover:text-ottrd-text transition-colors">Dashboard</a>
            ) : (
              <button onClick={() => signIn("google")} className="text-sm text-ottrd-muted hover:text-ottrd-text transition-colors">Sign in</button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-20 animate-fade-in">
        <div className="text-center mb-12">
          <h1 className="font-display text-4xl md:text-5xl text-ottrd-text mb-4">Simple, transparent pricing</h1>
          <p className="text-ottrd-muted text-lg max-w-xl mx-auto">No Keepa subscription needed. We handle the data - you focus on deals.</p>
        </div>

        {/* Billing toggle */}
        <div className="flex items-center justify-center gap-3 mb-12">
          <span className={`text-sm ${!annual ? "text-ottrd-text" : "text-ottrd-muted"}`}>Monthly</span>
          <button
            onClick={() => setAnnual(!annual)}
            className={`relative w-14 h-7 rounded-full transition-colors ${annual ? "bg-blue-600" : "bg-ottrd-border"}`}
          >
            <div className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-transform ${annual ? "translate-x-8" : "translate-x-1"}`} />
          </button>
          <span className={`text-sm ${annual ? "text-ottrd-text" : "text-ottrd-muted"}`}>Annual</span>
          {annual && <span className="text-xs bg-green-900/30 text-green-400 px-2 py-0.5 rounded-full border border-green-800/30">Save 10%</span>}
        </div>

        {/* Plan cards */}
        <div className="grid md:grid-cols-3 gap-6">
          {PLANS.map(plan => {
            const price = annual ? Math.round(plan.annualPrice / 12) : plan.monthlyPrice;
            return (
              <div key={plan.key} className={`bg-ottrd-surface rounded-xl p-6 relative ${plan.popular ? "border-2 border-blue-500 ring-1 ring-blue-500/20" : "border border-ottrd-border"}`}>
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs px-3 py-1 rounded-full">Most popular</div>
                )}
                <div className="mb-6">
                  <h3 className="font-display text-lg text-ottrd-text mb-1">{plan.name}</h3>
                  <p className="text-ottrd-muted text-sm">{plan.desc}</p>
                </div>
                <div className="mb-6">
                  <span className="font-display text-4xl text-ottrd-text">${price}</span>
                  <span className="text-ottrd-muted text-sm">/mo</span>
                  {annual && <div className="text-xs text-ottrd-muted mt-1">Billed ${plan.annualPrice}/year</div>}
                </div>
                <button
                  onClick={() => handleCheckout(plan.key)}
                  disabled={loading === plan.key}
                  className={`w-full py-3 rounded-lg text-sm font-medium transition-all mb-6 ${
                    plan.popular
                      ? "bg-blue-600 text-white hover:bg-blue-500"
                      : "bg-ottrd-bg border border-ottrd-border text-ottrd-text hover:border-ottrd-muted"
                  } disabled:opacity-50`}
                >
                  {loading === plan.key ? "Loading..." : session ? "Get started" : "Sign in to subscribe"}
                </button>
                <div className="space-y-3">
                  {plan.features.map((f, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm text-ottrd-muted">
                      <span className="text-green-400 mt-0.5 shrink-0">{"✓"}</span>
                      {f}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="text-center mt-12 text-ottrd-muted text-sm">
          <p>All plans include the full Keepa-powered analysis engine. No Keepa API key needed.</p>
          <p className="mt-1">Cancel anytime. Questions? Email support@ottrd.com</p>
        </div>
      </main>
    </div>
  );
}
