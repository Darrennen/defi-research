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
}

export default nextConfig
