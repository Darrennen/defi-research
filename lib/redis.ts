import { Redis } from '@upstash/redis'

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

const env = process.env.VERCEL_ENV ?? 'dev'
export const WHALE_ALERTS_KEY = env === 'production' ? 'whale:alerts' : `whale:alerts:${env}`
export const MAX_ALERTS = 5000
