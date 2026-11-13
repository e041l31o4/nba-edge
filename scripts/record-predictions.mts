import { readFile, writeFile } from 'node:fs/promises'
import { analyzeMatch, type TeamFormData, type InjuryData, type ProbabilityCalibrator } from '../src/model'

type Row = { gameId:string; date:string; home:string; away:string; homeWin:number; awayWin:number; projectedMargin:number; projectedTotal:number; stage?:'draft'|'official'; capturedAt:string; lockedAt?:string; actualHome?:number; actualAway?:number; settledAt?:string }
const base = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const readJson = async <T>(path:string):Promise<T|null> => { try { return JSON.parse(await readFile(path,'utf8')) as T } catch { return null } }
const now = new Date()
const tw = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
const twNoDash = tw.replace(/-/g,'')
const [year, month, day] = tw.split('-').map(Number)
const dateKeys = Array.from({length:9},(_,i)=>new Date(Date.UTC(year,month-1,day+i-1)).toISOString().slice(0,10).replace(/-/g,''))
const [form, injuries, backtest, previousPayload] = await Promise.all([
  readJson<TeamFormData>('public/data/team-form.json'),
  readJson<InjuryData>('public/data/injuries.json'),
  readJson<{seasonResults?:{calibrator?:ProbabilityCalibrator|null}[]}>('public/data/backtest.json'),
  readJson<{records:Row[]}>('public/data/prediction-ledger.json')
])
if (!form) throw new Error('Missing team-form data; keep existing ledger unchanged.')

// Fetch each local-date scoreboard independently. A single transient ESPN error
// must not cancel capture for every other date in the 9-day window.
const fetchScoreboard = async (date:string) => {
  let lastError:unknown
  for (let attempt=1; attempt<=3; attempt++) {
    try {
      const response=await fetch(`${base}/scoreboard?dates=${date}`,{headers:{'accept':'application/json'}})
      if (!response.ok) throw new Error(`ESPN HTTP ${response.status}`)
      const payload=await response.json() as any
      if (!payload || !Array.isArray(payload.events)) throw new Error('ESPN scoreboard response has no events[]')
      return {date,events:payload.events as any[],ok:true as const}
    } catch(error) {
      lastError=error
      if (attempt<3) await new Promise(resolve=>setTimeout(resolve,attempt*1200))
    }
  }
  console.warn(`Scoreboard date ${date} unavailable after 3 attempts:`,String(lastError))
  return {date,events:[] as any[],ok:false as const}
}
const scoreboardResults=await Promise.all(dateKeys.map(fetchScoreboard))
const successfulDates=scoreboardResults.filter(x=>x.ok).length
if (successfulDates===0) throw new Error('All ESPN scoreboard dates failed after retries; existing ledger preserved.')
const scoreboards=scoreboardResults.filter(x=>x.ok).map(x=>({events:x.events}))
console.log(`ESPN scoreboard dates available: ${successfulDates}/${dateKeys.length}`)
const calibrator = backtest?.seasonResults?.slice().reverse().find(x=>x.calibrator)?.calibrator ?? null
const rows:Row[] = Array.isArray(previousPayload?.records) ? previousPayload.records : []
const byId = new Map(rows.map(x=>[x.gameId,x]))
let added=0, settled=0, refreshed=0
const settledGames:Array<{gameId:string;home:string;away:string;actualHome:number;actualAway:number}> = []
for (const event of scoreboards.flatMap(s=>s.events ?? [])) {
  const comp=event.competitions?.[0], competitors=comp?.competitors ?? []
  const h=competitors.find((x:any)=>x.homeAway==='home'), a=competitors.find((x:any)=>x.homeAway==='away')
  if (!h || !a || !event.id) continue
  const id=String(event.id), existing=byId.get(id)
  const status=String(event.status?.type?.name ?? '').toLowerCase()
  const tipoff=new Date(event.date).getTime()
  if (!Number.isFinite(tipoff)) continue
  if (existing && existing.stage==='official') {
    if (!existing.settledAt && status.includes('final')) {
      const hs=Number(h.score), as=Number(a.score)
      if (Number.isFinite(hs)&&Number.isFinite(as)) {
        existing.actualHome=hs; existing.actualAway=as; existing.settledAt=now.toISOString(); settled++; settledGames.push({gameId:id,home:existing.home,away:existing.away,actualHome:hs,actualAway:as})
      }
    }
    continue
  }
  if (existing?.stage==='draft') {
    // Any already-captured pregame draft becomes official once tipoff is reached.
    // Preserve its original probabilities and projected score; never recalculate
    // a prediction after the game has started. If the game is already final,
    // settle it in this same pass instead of skipping it forever.
    if (tipoff<=now.getTime() || status.includes('final')) {
      existing.stage='official'
      existing.lockedAt=existing.capturedAt
      delete (existing as any).totalLine
      delete (existing as any).totalPick
      added++
      if (status.includes('final')) {
        const hs=Number(h.score), as=Number(a.score)
        if (Number.isFinite(hs)&&Number.isFinite(as)) {
          existing.actualHome=hs
          existing.actualAway=as
          existing.settledAt=now.toISOString()
          settled++
          settledGames.push({gameId:id,home:existing.home,away:existing.away,actualHome:hs,actualAway:as})
        }
      }
      continue
    }
    const rolling=analyzeMatch({date:event.date,home:{id:String(h.team?.id??''),abbreviation:String(h.team?.abbreviation??'—')},away:{id:String(a.team?.id??''),abbreviation:String(a.team?.abbreviation??'—')}},form,injuries,calibrator)
    if (rolling.available) {
      existing.homeWin=rolling.homeWin; existing.awayWin=rolling.awayWin
      existing.projectedMargin=rolling.projectedMargin; existing.projectedTotal=rolling.projectedTotal
      existing.capturedAt=now.toISOString(); refreshed++
    }
    continue
  }
  if (status.includes('final') || tipoff<=now.getTime()) continue
  const game={date:event.date,home:{id:String(h.team?.id??''),abbreviation:String(h.team?.abbreviation??'—')},away:{id:String(a.team?.id??''),abbreviation:String(a.team?.abbreviation??'—')}}
  const prediction=analyzeMatch(game,form,injuries,calibrator)
  if (!prediction.available) continue
  const stage:Row['stage']=tipoff-now.getTime()<=60*60*1000?'official':'draft'
  const row:Row={gameId:id,date:event.date,home:game.home.abbreviation,away:game.away.abbreviation,homeWin:prediction.homeWin,awayWin:prediction.awayWin,projectedMargin:prediction.projectedMargin,projectedTotal:prediction.projectedTotal,stage,capturedAt:now.toISOString(),...(stage==='official'?{lockedAt:now.toISOString()}:{})}
  if (existing) {
    Object.assign(existing,row)
    delete (existing as any).totalLine; delete (existing as any).totalPick
    if (stage==='official') added++
  } else {
    rows.push(row); byId.set(id,row); added++
  }
}
for (const row of rows) { delete (row as any).totalLine; delete (row as any).totalPick }
// Keep the complete ledger; do not silently discard historical predictions.
const output=rows
if (added || settled || refreshed || !previousPayload) {
  const target='public/data/prediction-ledger.json'
  const temp=target+'.tmp'
  await writeFile(temp,JSON.stringify({updatedAt:now.toISOString(),source:'NBA EDGE pregame model + ESPN final scores',records:output},null,2)+'\n')
  const { rename } = await import('node:fs/promises')
  await rename(temp,target)
}
const upcoming=output.filter(row=>new Date(row.date).getTime()>now.getTime() && row.stage==='draft').length
const official=output.filter(row=>row.stage==='official').length
if (settledGames.length) console.log('Newly settled games:', JSON.stringify(settledGames))
const recentlySettled = output.filter(row => row.settledAt && now.getTime() - new Date(row.settledAt).getTime() < 30*60*1000).map(row => ({gameId:row.gameId, date:row.date, home:row.home, away:row.away, actualHome:row.actualHome, actualAway:row.actualAway, settledAt:row.settledAt}))
if (recentlySettled.length) console.log('Recently settled games (persisted):', JSON.stringify(recentlySettled))
console.log(`Taiwan date ${twNoDash}; ESPN dates ${dateKeys[0]}-${dateKeys[dateKeys.length-1]}; successful dates ${successfulDates}/${dateKeys.length}; new/locked ${added}; rolling refreshed ${refreshed}; settled ${settled}; upcoming drafts ${upcoming}; official records ${official}; total ${output.length}`)
