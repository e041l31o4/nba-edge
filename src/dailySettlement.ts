import type { PredictionRecord } from './predictionLedger'

export type DailyReportGame = {
  id: string
  date: string
  status: string
  home: { abbreviation: string; score?: string }
  away: { abbreviation: string; score?: string }
}

export type MarketTally = {
  wins: number
  losses: number
  pushes: number
  noDirection: number
  unavailable: number
  hitRate: number | null
}

export type DailySettlementReport = {
  date: string
  gameCount: number
  finalGameCount: number
  settledRecordCount: number
  pendingCount: number
  complete: boolean
  moneyline: MarketTally
  spread: MarketTally
  totals: MarketTally
  recommendations: {
    moneyline: MarketTally
    spread: MarketTally
    totals: MarketTally
  }
}

type Pick = {
  side?: string
  teamSide?: 'home' | 'away'
  line?: number
}

function taiwanDateKey(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date).replace(/-/g, '')
}

function tally(): MarketTally {
  return { wins: 0, losses: 0, pushes: 0, noDirection: 0, unavailable: 0, hitRate: null }
}

function finishTally(value: MarketTally) {
  const decided = value.wins + value.losses
  value.hitRate = decided ? value.wins / decided : null
  return value
}

function grade(pick: Pick | null | undefined, market: 'moneyline' | 'spread' | 'totals', home: number, away: number) {
  if (!pick || !pick.teamSide && market !== 'totals' || typeof pick.line !== 'number' && market !== 'moneyline') return null
  if (market === 'moneyline') {
    const won = pick.teamSide === 'home' ? home > away : away > home
    return won ? 'win' : 'loss'
  }
  if (market === 'spread') {
    const margin = pick.teamSide === 'away' ? away - home + Number(pick.line) : home - away + Number(pick.line)
    return Math.abs(margin) < 1e-9 ? 'push' : margin > 0 ? 'win' : 'loss'
  }
  const diff = home + away - Number(pick.line)
  return Math.abs(diff) < 1e-9 ? 'push' : ((pick.side === 'over' && diff > 0) || (pick.side === 'under' && diff < 0)) ? 'win' : 'loss'
}

function addOutcome(target: MarketTally, result: string | null) {
  if (result === 'win') target.wins++
  else if (result === 'loss') target.losses++
  else if (result === 'push') target.pushes++
  else target.noDirection++
}

export function buildDailySettlementReport(
  records: PredictionRecord[],
  games: DailyReportGame[],
  date: string
): DailySettlementReport {
  const dayGames = games.filter(game => taiwanDateKey(game.date) === date)
  const allFinal = dayGames.length > 0 && dayGames.every(game => game.status.toLowerCase().includes('final') && Number.isFinite(Number(game.home.score)) && Number.isFinite(Number(game.away.score)))
  const byId = new Map(records.map(record => [record.gameId, record]))
  const moneyline = tally(), spread = tally(), totals = tally()
  const moneylinePicks = tally(), spreadPicks = tally(), totalPicks = tally()
  let settledRecordCount = 0, pendingCount = 0

  for (const game of dayGames) {
    const record = byId.get(game.id)
    if (!record || record.stage !== 'official' || !record.settledAt ||
      !Number.isFinite(record.actualHome) || !Number.isFinite(record.actualAway)) {
      pendingCount++
      moneyline.unavailable++; spread.unavailable++; totals.unavailable++
      continue
    }
    settledRecordCount++
    const home = Number(record.actualHome), away = Number(record.actualAway)
    const frozen = (record.finalSnapshot ?? {}) as Record<string, unknown>
    const lean = (key: string, fallback?: unknown) => (frozen[key] ?? fallback ?? null) as Pick | null
    const moneylineLean = lean('moneylineLean', record.moneylineLean) ??
      (typeof record.homeWin === 'number' ? { teamSide: record.homeWin >= 0.5 ? 'home' : 'away', line: 0 } : null)
    const spreadLean = lean('spreadLean', record.spreadLean ?? record.spreadPick)
    const totalLean = lean('totalLean', record.totalLean ?? record.totalPick)
    addOutcome(moneyline, grade(moneylineLean, 'moneyline', home, away))
    addOutcome(spread, grade(spreadLean, 'spread', home, away))
    addOutcome(totals, grade(totalLean, 'totals', home, away))

    addOutcome(moneylinePicks, grade(lean('moneylinePick', record.moneylinePick), 'moneyline', home, away))
    addOutcome(spreadPicks, grade(lean('spreadPick', record.spreadPick), 'spread', home, away))
    addOutcome(totalPicks, grade(lean('totalPick', record.totalPick), 'totals', home, away))
  }

  const complete = allFinal && pendingCount === 0
  return {
    date, gameCount: dayGames.length, finalGameCount: allFinal ? dayGames.length : dayGames.filter(g => g.status.toLowerCase().includes('final')).length,
    settledRecordCount, pendingCount, complete,
    moneyline: finishTally(moneyline), spread: finishTally(spread), totals: finishTally(totals),
    recommendations: {
      moneyline: finishTally(moneylinePicks), spread: finishTally(spreadPicks), totals: finishTally(totalPicks)
    }
  }
}
