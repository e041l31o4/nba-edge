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

export async function getPredictionRecords(): Promise<PredictionRecord[]> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}data/prediction-ledger.json?t=${Date.now()}`)
    if (!response.ok) return []
    const payload = await response.json()
    return Array.isArray(payload.records) ? payload.records.filter((x:PredictionRecord)=>x && typeof x.gameId==='string') : []
  } catch { return [] }
}

export function summarizePredictions(records: PredictionRecord[]) {
  const settled = records.filter(x => x.settledAt && Number.isFinite(x.actualHome) && Number.isFinite(x.actualAway))
  if (!settled.length) return { total: records.length, settled: 0, accuracy: null as number | null, brier: null as number | null, marginError: null as number | null }
  const correct = settled.filter(x => (x.homeWin >= 0.5) === ((x.actualHome as number) > (x.actualAway as number))).length
  const brier = settled.reduce((sum, x) => sum + ((x.homeWin - ((x.actualHome as number) > (x.actualAway as number) ? 1 : 0)) ** 2 + (x.awayWin - ((x.actualAway as number) > (x.actualHome as number) ? 1 : 0)) ** 2) / 2, 0) / settled.length
  const marginError = settled.reduce((sum, x) => sum + Math.abs(x.projectedMargin - ((x.actualHome as number) - (x.actualAway as number))), 0) / settled.length
  return { total: records.length, settled: settled.length, accuracy: correct / settled.length, brier, marginError }
}
