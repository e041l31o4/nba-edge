// Keep the postgame report grading test in the ledger workflow before each sync.
import { strict as assert } from 'node:assert'
import { buildDailySettlementReport } from '../src/dailySettlement'
import { summarizeTotalDirections, type PredictionRecord } from '../src/predictionLedger'

const date='20261121'
const games=[
  {id:'g1',date:'2026-11-20T16:00:00Z',status:'STATUS_FINAL',home:{abbreviation:'H1',score:'110'},away:{abbreviation:'A1',score:'100'}},
  {id:'g2',date:'2026-11-20T17:00:00Z',status:'STATUS_FINAL',home:{abbreviation:'H2',score:'99'},away:{abbreviation:'A2',score:'101'}},
  {id:'g3',date:'2026-11-20T18:00:00Z',status:'STATUS_FINAL',home:{abbreviation:'H3',score:'98'},away:{abbreviation:'A3',score:'100'}},
  {id:'g4',date:'2026-11-20T19:00:00Z',status:'STATUS_FINAL',home:{abbreviation:'H4',score:'100'},away:{abbreviation:'A4',score:'95'}}
]
const makeRecord=(gameId:string,home:number,away:number,finalSnapshot:Record<string,unknown>)=>({
  gameId,date:'2026-11-20T16:00:00Z',home:'H',away:'A',homeWin:home>away?0.6:0.4,awayWin:home>away?0.4:0.6,
  projectedMargin:home-away,projectedTotal:home+away,stage:'official',settledAt:'2026-11-21T08:00:00Z',
  actualHome:home,actualAway:away,finalSnapshot
} as unknown as PredictionRecord)
const records=[
  makeRecord('g1',110,100,{moneylineLean:{teamSide:'home',line:0},spreadLean:{teamSide:'home',line:-3.5},totalLean:{side:'over',line:205},moneylinePick:{teamSide:'home',line:0},spreadPick:{teamSide:'home',line:-3.5},totalPick:{side:'over',line:205}}),
  makeRecord('g2',99,101,{moneylineLean:{teamSide:'away',line:0},spreadLean:{teamSide:'home',line:-2.5},totalLean:{side:'under',line:205}}),
  makeRecord('g3',98,100,{moneylineLean:{teamSide:'away',line:0},spreadLean:{teamSide:'away',line:2.5},totalLean:{side:'under',line:205}}),
  makeRecord('g4',100,95,{moneylineLean:{teamSide:'home',line:0},spreadLean:{teamSide:'home',line:-5},totalLean:{side:'over',line:195}})
]
const report=buildDailySettlementReport(records,games,date)
assert.equal(report.complete,true)
assert.equal(report.gameCount,4)
assert.deepEqual([report.moneyline.wins,report.moneyline.losses,report.moneyline.pushes],[4,0,0])
assert.deepEqual([report.spread.wins,report.spread.losses,report.spread.pushes],[2,1,1])
assert.deepEqual([report.totals.wins,report.totals.losses,report.totals.pushes],[3,0,1])
assert.equal(report.recommendations.moneyline.wins,1)
assert.equal(report.recommendations.moneyline.noDirection,3)
const nov22Games = Array.from({length:6},(_,i)=>({id:'n'+i,date:'2026-11-21T16:00:00Z',status:'STATUS_FINAL',home:{abbreviation:'H'+i,score:String(110+i)},away:{abbreviation:'A'+i,score:String(100+i)}}))
const nov22Records = Array.from({length:6},(_,i)=>makeRecord('n'+i,110+i,100+i,{moneylineLean:{teamSide:'home',line:0},totalLean:{side:i===0?'under':'over',line:200}}))
const nov22Report = buildDailySettlementReport(nov22Records,nov22Games,'20261122')
assert.deepEqual([nov22Report.totals.wins,nov22Report.totals.losses,nov22Report.totals.pushes],[6,1,0])
const nov22CumulativeRecords = nov22Records.map(record=>({...record,date:'2026-11-21T16:00:00Z'})) as PredictionRecord[]
const nov22Cumulative = summarizeTotalDirections(nov22CumulativeRecords)
assert.deepEqual([nov22Cumulative.total,nov22Cumulative.wins,nov22Cumulative.losses,nov22Cumulative.pushes],[7,6,1,0])
const incomplete=buildDailySettlementReport(records.slice(0,3),games,date)
assert.equal(incomplete.complete,false)
assert.equal(incomplete.pendingCount,1)

// Overall totals accuracy must include every frozen analysis lean, even when no formal totalPick exists.
const directionRecords = [
  {...makeRecord('t1',110,100,{totalLean:{side:'over',line:205},totalPick:{side:'over',line:205}}),totalLean:{side:'over',line:205},totalPick:{side:'over',line:205}},
  {...makeRecord('t2',99,101,{totalLean:{side:'under',line:205}}),totalLean:{side:'under',line:205}},
  {...makeRecord('t3',98,100,{totalLean:{side:'under',line:205}}),totalLean:{side:'under',line:205}},
  {...makeRecord('t4',100,95,{totalLean:{side:'over',line:195}}),totalLean:{side:'over',line:195}}
] as unknown as PredictionRecord[]
const totalsDirections = summarizeTotalDirections(directionRecords)
assert.deepEqual([totalsDirections.wins,totalsDirections.losses,totalsDirections.pushes],[3,0,1])
assert.equal(totalsDirections.decided,3)

console.log('Daily settlement report tests passed.')
