import { NextResponse } from 'next/server'

const GAMMA  = 'https://gamma-api.polymarket.com'
const CLOB   = 'https://clob.polymarket.com'

// ── ELO Ratings (FIFA, May 2026) ──────────────────────────────────────────────
const ELO: Record<string, number> = {
  'france': 1855, 'spain': 1845, 'england': 1805, 'portugal': 1785,
  'brazil': 1775, 'argentina': 1765, 'germany': 1735, 'netherlands': 1725,
  'belgium': 1705, 'norway': 1675, 'japan': 1665, 'colombia': 1655,
  'morocco': 1645, 'uruguay': 1635, 'croatia': 1625, 'switzerland': 1605,
  'austria': 1595, 'sweden': 1585, 'turkiye': 1575, 'turkey': 1575,
  'usa': 1565, 'united states': 1565, 'mexico': 1555, 'canada': 1535,
  'senegal': 1525, 'ghana': 1515, 'iran': 1505, 'ir iran': 1505,
  'australia': 1495, 'korea republic': 1485, 'south korea': 1485,
  'ecuador': 1475, 'czechia': 1470, 'scotland': 1435, 'egypt': 1425,
  'saudi arabia': 1430, "côte d'ivoire": 1425, 'cote d ivoire': 1425,
  'ivory coast': 1425, 'bosnia-herzegovina': 1420, 'paraguay': 1375,
  'algeria': 1405, 'south africa': 1405, 'panama': 1365, 'iraq': 1365,
  'qatar': 1345, 'new zealand': 1315, 'jordan': 1325, 'cape verde': 1360,
  'cabo verde': 1360, 'haiti': 1295, 'dr congo': 1385, 'congo dr': 1385,
  'uzbekistan': 1395, 'curaçao': 1295, 'curacao': 1295, 'tunisia': 1415,
}

const HOME_NATIONS = new Set(['usa', 'united states', 'mexico', 'canada'])

function winProb(eloA: number, eloB: number, homeA = false): [number, number, number] {
  const adj = eloA + (homeA ? 65 : 0)
  const exp = 1 / (1 + Math.pow(10, (eloB - adj) / 400))
  const competitiveness = 1 - Math.abs(exp - 0.5) * 2
  const pDraw  = Math.max(0.05, 0.28 * competitiveness)
  const pWinA  = Math.max(0.02, exp - pDraw / 2)
  const pLoss  = Math.max(0.02, 1 - pWinA - pDraw)
  const total  = pWinA + pDraw + pLoss
  return [pWinA / total, pDraw / total, pLoss / total]
}

function kellyStake(pModel: number, priceC: number, bankroll: number): number {
  const q = priceC / 100
  const b = (1 - q) / q
  const k = (pModel * b - (1 - pModel)) / b
  return Math.min(Math.max(0, k * 0.25 * bankroll), 30)
}

function parseTeams(question: string): [string, string] | null {
  const q = question.toLowerCase()
  for (const sep of [' vs ', ' vs. ', ' v ']) {
    if (q.includes(sep)) {
      const [rawA, rawB] = q.split(sep, 2)
      const a = rawA.replace(/^will /, '').trim()
      const b = rawB.replace(/[?].*$/, '').trim()
      if (a && b) return [a, b]
    }
  }
  return null
}

async function fetchMarkets(): Promise<any[]> {
  const res = await fetch(
    `${GAMMA}/markets?active=true&tag_slug=2026-fifa-world-cup&limit=200`,
    { next: { revalidate: 60 } }
  )
  if (!res.ok) return []
  const json = await res.json()
  return Array.isArray(json) ? json : json.data ?? []
}

async function fetchMidpoint(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB}/midpoint?token_id=${tokenId}`, {
      next: { revalidate: 30 },
    })
    if (!res.ok) return null
    const j = await res.json()
    const mid = j.mid ?? j.price
    return mid != null ? parseFloat(mid) * 100 : null
  } catch {
    return null
  }
}

export interface Opportunity {
  match:    string
  outcome:  string
  tokenId:  string
  teamA:    string
  teamB:    string
  eloA:     number
  eloB:     number
  pModel:   number
  pMarket:  number
  edge:     number
  price:    number
  stake:    number
  signal:   'trade' | 'watch' | 'skip'
}

export interface PolymarketData {
  opportunities: Opportunity[]
  summary: {
    total:      number
    actionable: number
    bestEdge:   number
    avgEdge:    number
  }
  fetchedAt:   string
  dryRun:      boolean
  configured:  boolean
  error?: string
}

export async function GET(): Promise<NextResponse<PolymarketData>> {
  const bankroll   = 140
  const minEdge    = 0.07
  const isDryRun   = process.env.POLYMARKET_DRY_RUN !== 'false'
  const configured = !!(process.env.POLYMARKET_PRIVATE_KEY && process.env.POLYMARKET_API_KEY)

  try {
    const markets = await fetchMarkets()

    const opps: Opportunity[] = []
    const seen = new Set<string>()

    for (const m of markets) {
      const tokens: any[] = m.tokens ?? []
      const question: string = m.question ?? ''

      const parsed = parseTeams(question)
      if (!parsed) continue
      const [teamA, teamB] = parsed

      for (const tok of tokens) {
        const outcome: string  = (tok.outcome ?? '').toLowerCase()
        if (outcome.includes('draw') || outcome.includes('tie')) continue

        let betTeam: string, oppTeam: string
        if (teamA && outcome.includes(teamA)) {
          betTeam = teamA; oppTeam = teamB
        } else if (teamB && outcome.includes(teamB)) {
          betTeam = teamB; oppTeam = teamA
        } else {
          continue
        }

        const eloA = ELO[betTeam]
        const eloB = ELO[oppTeam]
        if (!eloA || !eloB) continue

        const tokenId = tok.token_id ?? tok.tokenId ?? ''
        if (!tokenId) continue

        const key = `${question}|${betTeam}`
        if (seen.has(key)) continue
        seen.add(key)

        // Use Gamma price first, fetch live if missing
        let price = tok.price != null ? parseFloat(tok.price) * 100 : 0
        if (!price || price <= 0) {
          price = await fetchMidpoint(tokenId) ?? 0
        }
        if (price <= 0 || price >= 99) continue

        const homeA = HOME_NATIONS.has(betTeam)
        const [pWin] = winProb(eloA, eloB, homeA)
        const edge   = pWin - price / 100
        const stake  = kellyStake(pWin, price, bankroll)

        opps.push({
          match:   `${betTeam.charAt(0).toUpperCase() + betTeam.slice(1)} vs ${oppTeam.charAt(0).toUpperCase() + oppTeam.slice(1)}`,
          outcome: tok.outcome ?? '',
          tokenId,
          teamA:   betTeam,
          teamB:   oppTeam,
          eloA,
          eloB,
          pModel:  Math.round(pWin * 1000) / 10,
          pMarket: Math.round((price / 100) * 1000) / 10,
          edge:    Math.round(edge * 1000) / 10,
          price:   Math.round(price * 10) / 10,
          stake:   Math.round(stake * 100) / 100,
          signal:  edge >= minEdge ? 'trade' : edge >= 0.03 ? 'watch' : 'skip',
        })
      }
    }

    opps.sort((a, b) => b.edge - a.edge)

    const actionable = opps.filter(o => o.signal === 'trade')
    const edges      = opps.map(o => o.edge)

    return NextResponse.json({
      opportunities: opps,
      summary: {
        total:      opps.length,
        actionable: actionable.length,
        bestEdge:   edges.length ? Math.max(...edges) : 0,
        avgEdge:    edges.length ? Math.round(edges.reduce((a, b) => a + b, 0) / edges.length * 10) / 10 : 0,
      },
      fetchedAt:   new Date().toISOString(),
      dryRun:      isDryRun,
      configured,
    })
  } catch (err: any) {
    return NextResponse.json({
      opportunities: [],
      summary: { total: 0, actionable: 0, bestEdge: 0, avgEdge: 0 },
      fetchedAt:   new Date().toISOString(),
      dryRun:      isDryRun,
      configured,
      error: err?.message ?? 'Unknown error',
    })
  }
}
