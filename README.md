# Ottrd - Amazon Deal Underwriting (SaaS)

Upload your supplier linesheet. We pull 12 months of Keepa data, calculate true ROI, and generate your purchase order.

## Architecture

- **Next.js 14** - App Router, server-side API routes
- **NextAuth.js** - Google OAuth authentication
- **Supabase** - PostgreSQL database (users, usage tracking, analysis history)
- **Stripe** - Subscription billing ($49 / $129 / $299 per month)
- **Keepa API** - Server-side, single API key for all users
- **Vercel** - Hosting with serverless functions

## Setup Guide

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run the contents of `lib/schema.sql`
3. Copy your Project URL and Service Role Key from Settings > API

### 2. Google OAuth

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project, enable Google+ API
3. Go to APIs & Services > Credentials > Create OAuth 2.0 Client ID
4. Set authorized redirect URI to: `https://ottrd-web.vercel.app/api/auth/callback/google`
5. Copy Client ID and Client Secret

### 3. Stripe

1. Create an account at [stripe.com](https://stripe.com)
2. Create 3 Products with 2 prices each (monthly + annual):
   - Starter: $49/mo, $529/yr
   - Professional: $129/mo, $1393/yr
   - Enterprise: $299/mo, $3229/yr
3. Copy each Price ID (starts with `price_`)
4. Set up webhook endpoint: `https://ottrd-web.vercel.app/api/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

### 4. Environment Variables

Copy `.env.example` to `.env.local` and fill in all values. On Vercel, add these in Settings > Environment Variables.

### 5. Deploy

```bash
git add -A
git commit -m "Add subscription system"
git push
```

Vercel auto-deploys from GitHub.

## Pages

- `/` - Landing page (marketing)
- `/pricing` - Plan comparison with Stripe checkout
- `/auth` - Google sign-in
- `/dashboard` - Usage stats, plan info, analysis history
- `/analyze` - The analyzer tool (requires auth + active plan)

## Pricing Tiers

| Plan | Monthly | Annual (10% off) | SKU Limit |
|------|---------|-------------------|-----------|
| Starter | $49/mo | $529/yr | 2,500/mo |
| Professional | $129/mo | $1,393/yr | 15,000/mo |
| Enterprise | $299/mo | $3,229/yr | 50,000/mo |
