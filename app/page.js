"use client";

import { useSession, signIn } from "next-auth/react";

export default function LandingPage() {
  const { data: session } = useSession();

  return (
    <div className="min-h-screen">
      <header className="border-b border-ottrd-border bg-ottrd-surface/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-bold text-sm font-display">O</div>
            <span className="font-display text-xl text-ottrd-text">Ottrd</span>
          </div>
          <nav className="flex items-center gap-6">
            <a href="/analyze" className="text-sm text-ottrd-muted hover:text-ottrd-text transition-colors">Analyze</a>
            <a href="/pricing" className="text-sm text-ottrd-muted hover:text-ottrd-text transition-colors">Pricing</a>
            {session ? (
              <a href="/dashboard" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 transition-colors">Dashboard</a>
            ) : (
              <button onClick={() => signIn("google", { callbackUrl: "/dashboard" })} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 transition-colors">
                Get Started
              </button>
            )}
          </nav>
        </div>
      </header>

      <section className="max-w-5xl mx-auto px-6 py-24 text-center animate-fade-in">
        <div className="inline-block px-3 py-1 rounded-full bg-blue-900/30 border border-blue-800/30 text-blue-400 text-xs font-medium mb-6">
          Powered by 12 months of Keepa data
        </div>
        <h1 className="font-display text-5xl md:text-7xl text-ottrd-text mb-6 leading-tight">
          Underwrite Amazon<br/>deals in minutes
        </h1>
        <p className="text-ottrd-muted text-lg md:text-xl max-w-2xl mx-auto mb-10 leading-relaxed">
          Upload your supplier linesheet. We analyze every SKU against real Keepa sales data, calculate true ROI with fees and overhead, and tell you exactly what to buy.
        </p>
        <div className="flex items-center justify-center gap-4">
          <a href="/analyze" className="px-8 py-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white font-display text-lg rounded-xl shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all">
            Start Analyzing
          </a>
          <a href="/pricing" className="px-8 py-4 border border-ottrd-border text-ottrd-text font-display text-lg rounded-xl hover:border-ottrd-muted transition-colors">
            View Pricing
          </a>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-6 py-16">
        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: "1", title: "Upload your linesheet", desc: "Drop in your supplier CSV or Excel file with UPCs and costs. We handle the rest." },
            { icon: "2", title: "We crunch the data", desc: "12 months of Keepa sales history, real FBA fees, Buy Box prices, and monthly trends for every SKU." },
            { icon: "3", title: "Get your buy list", desc: "Buy, Review, or Pass decisions with target buy prices, suggested quantities, and a ready-to-go purchase order." },
          ].map((f, i) => (
            <div key={i} className="bg-ottrd-surface border border-ottrd-border rounded-xl p-6 animate-slide-up" style={{ animationDelay: `${i * 0.1}s` }}>
              <div className="w-10 h-10 rounded-lg bg-blue-900/30 border border-blue-800/30 flex items-center justify-center text-blue-400 font-display text-lg mb-4">{f.icon}</div>
              <h3 className="font-display text-lg text-ottrd-text mb-2">{f.title}</h3>
              <p className="text-ottrd-muted text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="font-display text-3xl text-ottrd-text text-center mb-12">Everything you need to buy smarter</h2>
        <div className="grid md:grid-cols-2 gap-6">
          {[
            { title: "True ROI calculation", desc: "Factors in referral fees, FBA pick and pack, and your custom overhead percentage." },
            { title: "Target buy price", desc: "Know the exact max you can pay to hit your ROI target. Never overpay for inventory." },
            { title: "Monthly sales history", desc: "See which months each product actually sells. Filter by Q4, last 6 months, or custom." },
            { title: "Price history analysis", desc: "Track Buy Box avg, low, and days-at-low across any months you choose." },
            { title: "Smart order quantities", desc: "Suggested order qty based on average or peak sales with customizable percentages." },
            { title: "5-sheet Excel export", desc: "Deal Analysis, Buy List, Summary, Target PO, and Price History - ready to act on." },
          ].map((f, i) => (
            <div key={i} className="flex gap-4 p-4">
              <div className="text-green-400 mt-1 shrink-0">+</div>
              <div>
                <h3 className="text-ottrd-text font-medium mb-1">{f.title}</h3>
                <p className="text-ottrd-muted text-sm">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-6 py-20 text-center">
        <h2 className="font-display text-3xl text-ottrd-text mb-4">Ready to find your next deal?</h2>
        <p className="text-ottrd-muted text-lg mb-8">Start analyzing in under 2 minutes.</p>
        <a href="/analyze" className="px-8 py-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white font-display text-lg rounded-xl shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all inline-block">
          Go to Analyzer
        </a>
      </section>

      <footer className="border-t border-ottrd-border py-8 text-center text-ottrd-muted/40 text-xs">
        Ottrd - Amazon Deal Underwriting
      </footer>
    </div>
  );
}
