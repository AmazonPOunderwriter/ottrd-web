import './globals.css'

export const metadata = {
  title: 'Ottrd — Amazon Deal Underwriting',
  description: 'Upload your supplier linesheet. We pull 12 months of Keepa data, calculate true ROI, and generate your purchase order.',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
