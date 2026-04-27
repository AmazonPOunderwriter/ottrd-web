# Ottrd — Amazon Deal Underwriting (Web Version)

Upload your supplier linesheet. We pull 12 months of Keepa data, calculate true ROI, and generate your purchase order — in minutes.

## Features

- **Real Keepa sales data** — 12 months of monthly sold history
- **True cost with overhead** — adds your % markup for freight, prep, supplies
- **Target buy price calculator** — shows the max you can pay to hit your ROI
- **Multi-ASIN per UPC** — finds all ASINs linked to each barcode
- **Buy/Review/Pass decisions** — color-coded recommendations
- **Excel export** — full analysis, buy list, and summary sheets
- **Runs in your browser** — no desktop app needed

## Deploy to Vercel

### Option 1: One-click deploy

1. Push this folder to a new GitHub repo
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import your repo
4. Click **Deploy** — that's it!

### Option 2: Vercel CLI

```bash
npm install -g vercel
cd ottrd
vercel
```

### Important: Vercel Plan

The free Vercel plan limits serverless functions to **10 seconds**.
For large linesheets, you'll need **Vercel Pro** ($20/mo) which allows up to **300 seconds**.

## Run Locally

```bash
cd ottrd
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## How It Works

1. You upload a CSV or Excel file with UPC and Cost columns
2. The app parses your file in the browser
3. UPCs are sent to a serverless API route that calls the Keepa API
4. Results stream back in real-time (server-sent events)
5. You see live logs, progress, and results in the browser
6. Export to Excel when done

## Tech Stack

- **Next.js 14** (App Router)
- **Tailwind CSS** for styling
- **Vercel Serverless Functions** for Keepa API calls
- **SheetJS (xlsx)** for file parsing and Excel export
