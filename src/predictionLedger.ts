import { loadDataset } from './lib/memberData'

export type PredictionRecord = {
  gameId: string
  date: string
  home: string
  away: string
  homeWin: number
  awayWin: number
  projectedMargin: number
  projectedTotal: number
  stage?: 'draft' | 'official'
  capturedAt: string
  actualHome?: number
  actualAway?: number
  settledAt?: string
}

export async function getPredictionRecords(): Promise<PredictionRecord[]> {
  const payload = await loadDataset<{ records: PredictionRecord[] }>('prediction-ledger', 'prediction-ledger.json')
  if (!payload) throw new Error('Prediction ledger is unavailable')
  if (!payload || !Array.isArray(payload.records)) throw new Error('Prediction ledger response is invalid')
  return payload.records.filter((x:PredictionRecord)=>x && typeof x.gameId==='string')
}

export function summarizePredictions(records: PredictionRecord[]) {
  const official = records.filter(x => x.stage === 'official')
  const settled = official.filter(x => x.settledAt && Number.isFinite(x.actualHome) && Number.isFinite(x.actualAway))
  if (!settled.length) return { total: official.length, settled: 0, accuracy: null as number | null, brier: null as number | null, marginError: null as number | null }
  const correct = settled.filter(x => (x.homeWin >= 0.5) === ((x.actualHome as number) > (x.actualAway as number))).length
  const brier = settled.reduce((sum, x) => sum + ((x.homeWin - ((x.actualHome as number) > (x.actualAway as number) ? 1 : 0)) ** 2 + (x.awayWin - ((x.actualAway as number) > (x.actualHome as number) ? 1 : 0)) ** 2) / 2, 0) / settled.length
  const marginError = settled.reduce((sum, x) => sum + Math.abs(x.projectedMargin - ((x.actualHome as number) - (x.actualAway as number))), 0) / settled.length
  return { total: official.length, settled: settled.length, accuracy: correct / settled.length, brier, marginError }
}
