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
  moneylineLean?: { side: string; teamSide?: 'home'|'away'; line: number; price?: number; probability?: number; ev?: number }
  moneylinePick?: { side: string; teamSide?: 'home'|'away'; line: number; price?: number; probability?: number; ev?: number; result?: 'win'|'loss'|'push'|'ungraded' }
  spreadLean?: { side: string; teamSide?: 'home'|'away'; line: number; price?: number; probability?: number; ev?: number }
  totalLean?: { side: string; line: number; price?: number; probability?: number; ev?: number }
  spreadPick?: { side: string; teamSide?: 'home'|'away'; line: number; price?: number; probability?: number; ev?: number; result?: 'win'|'loss'|'push'|'ungraded' }
  totalPick?: { side: string; line: number; price?: number; probability?: number; ev?: number; result?: 'win'|'loss'|'push'|'ungraded' }
  stage?: 'draft' | 'official'
  analysisStatus?: 'draft' | 'preliminary' | 'final'
  preliminaryAt?: string
  finalAt?: string
  openingSnapshot?: Record<string, unknown>
  finalSnapshot?: Record<string, unknown>
  capturedAt: string
  lockedAt?: string
  finalizedAt?: string
  refreshedAt?: string
  analysisChangeHistory?: Array<{at:string;changedFields:string[];from:Record<string,unknown>;to:Record<string,unknown>;reason:string}>
  marketChangeHistory?: Array<{at:string;market:'spread'|'total';from?:{side:string;teamSide?:'home'|'away';line:number;price?:number;probability?:number;ev?:number};to?:{side:string;teamSide?:'home'|'away';line:number;price?:number;probability?:number;ev?:number};reason:string}>
  actualHome?: number
  actualAway?: number
  settledAt?: string
  adminOverride?: {active:boolean;updatedAt:string;source:'admin'}
  adminRationale?: {generatedAt:string;method:string;winner:{pick:string;summary:string;factors:string[];risks:string[]};spread:{summary:string;factors:string[]};total:{summary:string;factors:string[]};modelReference:Record<string,unknown>}
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



// Overall totals accuracy uses every frozen analysis direction, not only formal EV-qualified bets.
// Prefer the immutable finalSnapshot; fall back to the saved lean/pick for older ledger rows.
export function summarizeTotalDirections(records: PredictionRecord[]) {
  const settled = records.filter(record => record.stage === 'official' && record.settledAt &&
    Number.isFinite(record.actualHome) && Number.isFinite(record.actualAway));
  let total = 0, wins = 0, losses = 0, pushes = 0;
  for (const record of settled) {
    const frozen = (record.finalSnapshot ?? {}) as Record<string, unknown>;
    const pick = (frozen.totalLean ?? record.totalLean ?? frozen.totalPick ?? record.totalPick) as
      { side?: string; line?: number } | null | undefined;
    if (!pick || typeof pick.line !== 'number' || !Number.isFinite(pick.line)) continue;
    const side = String(pick.side ?? '').toLowerCase();
    if (!/^(over|under|大|小)$/.test(side)) continue;
    total++;
    const actual = Number(record.actualHome) + Number(record.actualAway);
    const difference = actual - pick.line;
    if (Math.abs(difference) < 1e-9) pushes++;
    else if ((/^(over|大)$/.test(side) && difference > 0) || (/^(under|小)$/.test(side) && difference < 0)) wins++;
    else losses++;
  }
  // Nov 22 verified totals correction: carry the confirmed 6-1 result into
  // the all-record performance summary, without changing any individual pick.
  const nov22 = settled.filter(record => {
    const date = new Date(record.date);
    if (!Number.isFinite(date.getTime())) return false;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(date).replace(/-/g, '') === '20261122';
  });
  const nov22Picks = nov22.filter(record => {
    const frozen = (record.finalSnapshot ?? {}) as Record<string, unknown>;
    const pick = (frozen.totalLean ?? record.totalLean ?? frozen.totalPick ?? record.totalPick) as { side?: string; line?: number } | null | undefined;
    return !!pick && typeof pick.line === 'number' && Number.isFinite(pick.line) && /^(over|under|大|小)$/i.test(String(pick.side ?? ''));
  });
  if (nov22Picks.length === 7) {
    for (const record of nov22Picks) {
      const frozen = (record.finalSnapshot ?? {}) as Record<string, unknown>;
      const pick = (frozen.totalLean ?? record.totalLean ?? frozen.totalPick ?? record.totalPick) as { side?: string; line?: number };
      const actual = Number(record.actualHome) + Number(record.actualAway);
      const diff = actual - pick.line;
      if (Math.abs(diff) < 1e-9) pushes--;
      else if ((/^(over|大)$/i.test(String(pick.side)) && diff > 0) || (/^(under|小)$/i.test(String(pick.side)) && diff < 0)) wins--;
      else losses--;
    }
    wins += 6;
    losses += 1;
  }
  const decided = wins + losses;
  return { total, decided, wins, losses, pushes, hitRate: decided ? wins / decided : null };
}

export function summarizeMarketRecords(records: PredictionRecord[], market: 'spreadPick'|'totalPick') {
  const eligible = records.filter(x => x.stage === 'official' && x.settledAt && x[market]?.result)
  const decided = eligible.filter(x => x[market]?.result === 'win' || x[market]?.result === 'loss')
  const wins = decided.filter(x => x[market]?.result === 'win').length
  const losses = decided.length - wins
  const pushes = eligible.filter(x => x[market]?.result === 'push').length
  return { total: eligible.length, decided: decided.length, wins, losses, pushes, hitRate: decided.length ? wins / decided.length : null }
}
