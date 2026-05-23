/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    '/yield-tracker': ['./yield_tracker/**/*'],
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'icons.llamao.fi' },
      { protocol: 'https', hostname: 'token-icons.llamao.fi' },
      { protocol: 'https', hostname: 'icons.llama.fi' },
      { protocol: 'https', hostname: 'cdn.llama.fi' },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",  // unsafe-inline needed for theme script in layout.tsx
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https://icons.llamao.fi https://token-icons.llamao.fi https://icons.llama.fi https://cdn.llama.fi https://coin-images.coingecko.com",
              "connect-src 'self' https://*.upstash.io https://blue-api.morpho.org https://yields.llama.fi https://api.llama.fi",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ]
  },
}

export default nextConfig
