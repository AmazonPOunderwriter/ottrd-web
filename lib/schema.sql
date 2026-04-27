-- Run this in the Supabase SQL Editor to set up your database

-- Users table
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  image TEXT,
  plan TEXT DEFAULT 'none', -- 'none', 'starter', 'professional', 'enterprise'
  billing_interval TEXT DEFAULT 'monthly', -- 'monthly' or 'annual'
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'inactive', -- 'active', 'inactive', 'past_due', 'canceled'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Usage tracking
CREATE TABLE usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  skus_analyzed INTEGER NOT NULL DEFAULT 0,
  analysis_name TEXT, -- optional: file name or label
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast usage queries
CREATE INDEX idx_usage_user_date ON usage(user_id, created_at DESC);

-- Analysis history (optional: store past results metadata)
CREATE TABLE analyses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT,
  total_skus INTEGER,
  buy_count INTEGER,
  review_count INTEGER,
  pass_count INTEGER,
  settings JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_analyses_user ON analyses(user_id, created_at DESC);

-- Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (our API routes use service role key)
CREATE POLICY "Service role full access" ON users FOR ALL USING (true);
CREATE POLICY "Service role full access" ON usage FOR ALL USING (true);
CREATE POLICY "Service role full access" ON analyses FOR ALL USING (true);
