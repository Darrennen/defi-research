import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Nav from '@/components/Nav'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'DeFi Research',
  description: 'Evidence-led analysis on tokenized real-world assets, stablecoins, and DeFi lending markets.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'DeFi Research',
  },
  icons: {
    apple: '/apple-touch-icon.png',
    icon: '/icon-192.png',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Nav />
        <main className="max-w-5xl mx-auto px-6 pb-16">
          {children}
        </main>
        <footer className="border-t border-gray-100 mt-16">
          <div className="max-w-5xl mx-auto px-6 py-6 flex items-center justify-between">
            <p className="text-xs text-gray-400">DeFi Research — independent analysis</p>
            <p className="text-xs text-gray-400">Data: DeFiLlama public APIs</p>
          </div>
        </footer>
      </body>
    </html>
  )
}
