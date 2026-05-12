import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export async function GET() {
  const html = readFileSync(join(process.cwd(), 'yield_tracker/index.html'), 'utf-8')
  const patched = html.replace(/\/api\/data/g, '/api/yield-data')
  return new NextResponse(patched, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
