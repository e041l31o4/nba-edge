import type { Game } from './lib'
import { analyzeMatch, type TeamFormData, type InjuryData } from './model'

export type PredictionRecord = {
  gameId: string
  date: string
  home: string
  away: string
  homeWin: number
  awayWin: number
  projectedMargin: number
  projectedTotal: number
  capturedAt: string
  actualHome?: number
  actualAway?: number
  settledAt?: string
}
const KEY = 'nba-edge-prediction-ledger-v1'

export function getPredictionRecords(): PredictionRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(value) ? value.filter(x => x && typeof x.gameId === 'string') : []
  } catch {
    return []
  }
}
function save(records: PredictionRecord[]) {
  try { localStorage.setItem(KEY, JSON.stringify(records.slice(-1500))) } catch { /* browser storage may be unavailable */ }
}

/** Save the first available odds-blind forecast before tipoff. Never overwrite it later. */
export function capturePregamePredictions(games: Game[], form: TeamFormData | null, injuries: InjuryData | null) {
  if (!form || typeof localStorage === 'undefined') return
  const records = getPredictionRecords()
  const known = new Set(records.map(x => x.gameId))
  let changed = false
  for (const game of games) {
    if (known.has(game.id) || game.status.toLowerCase().includes('final')) continue
    const tipoff = new Date(game.date).getTime()
    if (!Number.isFinite(tipoff) || tipoff <= Date.now()) continue
    const report = analyzeMatch(game, form, injuries)
    if (!report.available) continue
    records.push({
      gameId: game.id,
      date: game.date,
      home: game.home.abbreviation,
      away: game.away.abbreviation,
      homeWin: report.homeWin,
      awayWin: report.awayWin,
      projectedMargin: report.projectedMargin,
      projectedTotal: report.projectedTotal,
      capturedAt: new Date().toISOString()
    })
    known.add(game.id)
    changed = true
  }
  if (changed) save(records)
}

/** Settle only a previously captured forecast; never create a prediction after the result. */
export function settleCompletedPredictions(games: Game[]) {
  if (typeof localStorage === 'undefined') return
  const records = getPredictionRecords()
  let changed = false
  const byId = new Map(games.map(g => [g.id, g]))
  const next = records.map(record => {
    if (record.settledAt) return record
    const game = byId.get(record.gameId)
    if (!game || !game.status.toLowerCase().includes('final')) return record
    const home = Number(game.home.score), away = Number(game.away.score)
    if (!Number.isFinite(home) || !Number.isFinite(away)) return record
    changed = true
    return { ...record, actualHome: home, actualAway: away, settledAt: new Date().toISOString() }
  })
  if (changed) save(next)
}

export function summarizePredictions(records: PredictionRecord[]) {
  const settled = records.filter(x => x.settledAt && Number.isFinite(x.actualHome) && Number.isFinite(x.actualAway))
  if (!settled.length) return { total: records.length, settled: 0, accuracy: null as number | null, brier: null as number | null, marginError: null as number | null }
  const correct = settled.filter(x => (x.homeWin >= 0.5) === ((x.actualHome as number) > (x.actualAway as number))).length
  const brier = settled.reduce((sum, x) => sum + ((x.homeWin - ((x.actualHome as number) > (x.actualAway as number) ? 1 : 0)) ** 2 + (x.awayWin - ((x.actualAway as number) > (x.actualHome as number) ? 1 : 0)) ** 2) / 2, 0) / settled.length
  const marginError = settled.reduce((sum, x) => sum + Math.abs(x.projectedMargin - ((x.actualHome as number) - (x.actualAway as number))), 0) / settled.length
  return { total: records.length, settled: settled.length, accuracy: correct / settled.length, brier, marginError }
}
