import { readFile, writeFile } from 'node:fs/promises'
import { analyzeMatch, coverProbability, totalProbability, decimalExpectedValue, type TeamFormData, type InjuryData, type TeamMetricsData, type ProbabilityCalibrator } from '../src/model'

type MarketPick = { side:string; teamSide?:'home'|'away'; line:number; price?:number; probability?:number; ev?:number; result?:'win'|'loss'|'push'|'ungraded' }
type Row = { gameId:string; date:string; home:string; away:string; homeWin:number; awayWin:number; projectedMargin:number; projectedTotal:number; spreadPick?:MarketPick; totalPick?:MarketPick; paceAdjustment?:number; totalTrend?:number|null; totalStdDev?:number; homeInjuryImpact?:number; awayInjuryImpact?:number; injuryRisk?:string; modelVersion?:string; stage?:'draft'|'official'; capturedAt:string; lockedAt?:string; actualHome?:number; actualAway?:number; settledAt?:string; recoverySource?:string }
const base = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const readJson = async <T>(path:string):Promise<T|null> => { try { return JSON.parse(await readFile(path,'utf8')) as T } catch { return null } }
const now = new Date()
const tw = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
const twNoDash = tw.replace(/-/g,'')
const [year, month, day] = tw.split('-').map(Number)
const dateKeys = Array.from({length:9},(_,i)=>new Date(Date.UTC(year,month-1,day+i-1)).toISOString().slice(0,10).replace(/-/g,''))
const [form, injuries, teamMetrics, backtest, previousPayload, oddsPayload] = await Promise.all([
  readJson<TeamFormData>('public/data/team-form.json'),
  readJson<InjuryData>('public/data/injuries.json'),
  readJson<TeamMetricsData>('public/data/team-metrics.json'),
  readJson<{seasonResults?:{calibrator?:ProbabilityCalibrator|null}[]}>('public/data/backtest.json'),
  readJson<{records:Row[]}>('public/data/prediction-ledger.json'),
  readJson<{games:Array<{home_team:string;away_team:string;bookmakers?:{title:string;markets:{key:string;outcomes:{name:string;point?:number;price:number}[]}[]}[]}>}>('public/data/odds.json')
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
const calibrator = backtest?.seasonResults?.slice().reverse().find(x=>x.calibrator)?.calibrator ?? null
const rows:Row[] = Array.isArray(previousPayload?.records) ? previousPayload.records : []
// Revisit unresolved official records outside the rolling 9-day capture window.
const unresolvedHistoricalDates = [...new Set(rows
  .filter(row => row.stage === 'official' && !row.settledAt && Number.isFinite(new Date(row.date).getTime()))
  .map(row => row.date.slice(0,10).replace(/-/g,'')))]
  .filter(date => /^\d{8}$/.test(date) && date < twNoDash)
  .sort()
  .slice(-30)
const allDateKeys = [...new Set([...dateKeys, ...unresolvedHistoricalDates])].sort()
const scoreboardResults=await Promise.all(allDateKeys.map(fetchScoreboard))
const successfulDates=scoreboardResults.filter(x=>x.ok).length
if (successfulDates===0) throw new Error('All ESPN scoreboard dates failed after retries; existing ledger preserved.')
const scoreboards=scoreboardResults.filter(x=>x.ok).map(x=>({events:x.events}))
console.log(`ESPN scoreboard dates available: ${successfulDates}/${allDateKeys.length} (rolling ${dateKeys.length}; unresolved historical ${unresolvedHistoricalDates.length})`)
const byId = new Map(rows.map(x=>[x.gameId,x]))

// Pregame picks are restored from the private Supabase prediction ledger.
// Do not hard-code or print member-only picks in this public repository.
let added=0, settled=0, refreshed=0
const settledGames:Array<{gameId:string;home:string;away:string;actualHome:number;actualAway:number}> = []
const makeMarketPicks=(event:any,prediction:any)=>{
  const competitors=event.competitions?.[0]?.competitors??[]
  const h=competitors.find((x:any)=>x.homeAway==='home'),a=competitors.find((x:any)=>x.homeAway==='away')
  const homeName=String(h?.team?.name??h?.team?.displayName??'').toLowerCase()
  const awayName=String(a?.team?.name??a?.team?.displayName??'').toLowerCase()
  const oddsGame=oddsPayload?.games?.find(g=>g.home_team.toLowerCase()===homeName&&g.away_team.toLowerCase()===awayName)
  const books=oddsGame?.bookmakers??[]
  const matches=(name:string,target:string)=>{const n=name.toLowerCase().replace(/[^a-z]/g,''),t=target.toLowerCase().replace(/[^a-z]/g,'');return n===t||n.includes(t)||t.includes(n)}
  const spreadRows=books.flatMap(b=>b.markets.filter(m=>m.key==='spreads').flatMap(m=>m.outcomes.map(o=>({...o,book:b.title}))))
  const spreadGroups=new Map<string,typeof spreadRows>()
  for(const x of spreadRows)if(typeof x.point==='number'&&Number.isFinite(x.price)&&x.price>1){const k=x.book+'|'+Math.abs(x.point);spreadGroups.set(k,[...(spreadGroups.get(k)??[]),x])}
  const spreadCandidates=[...spreadGroups.values()].flatMap(pair=>{
    const home=pair.find(x=>matches(x.name,homeName)),away=pair.find(x=>matches(x.name,awayName));if(!home||!away)return []
    return [home,away].map(x=>{const isHome=x===home;const probability=coverProbability(prediction.projectedMargin,x.point!,isHome);return {side:x.name,teamSide:isHome?'home' as const:'away' as const,line:x.point!,price:x.price,probability,ev:decimalExpectedValue(probability,x.price)}})
  }).sort((x,y)=>y.ev-x.ev)
  const totalRows=books.flatMap(b=>b.markets.filter(m=>m.key==='totals').flatMap(m=>m.outcomes.map(o=>({...o,book:b.title}))))
  const totalGroups=new Map<string,typeof totalRows>()
  for(const x of totalRows)if(typeof x.point==='number'&&Number.isFinite(x.price)&&x.price>1){const k=x.book+'|'+x.point;totalGroups.set(k,[...(totalGroups.get(k)??[]),x])}
  const totalCandidates=[...totalGroups.values()].flatMap(pair=>{
    const over=pair.find(x=>/over|大/i.test(x.name)),under=pair.find(x=>/under|小/i.test(x.name));if(!over||!under)return []
    return [over,under].map(x=>{const isOver=x===over;const probability=totalProbability(prediction.projectedTotal,x.point!,isOver,prediction.totalStdDev);return {side:isOver?'over':'under',line:x.point!,price:x.price,probability,ev:decimalExpectedValue(probability,x.price)}})
  }).sort((x,y)=>y.ev-x.ev)
  return {...(spreadCandidates[0]?{spreadPick:spreadCandidates[0]}:{}),...(totalCandidates[0]?{totalPick:totalCandidates[0]}:{})}
}
const settleMarkets=(row:Row,home:number,away:number)=>{
  if(row.spreadPick){const margin=row.spreadPick.teamSide==='away'?away-home+row.spreadPick.line:home-away+row.spreadPick.line;row.spreadPick.result=Math.abs(margin)<1e-9?'push':margin>0?'win':'loss'}
  if(row.totalPick){const diff=home+away-row.totalPick.line;row.totalPick.result=Math.abs(diff)<1e-9?'push':((row.totalPick.side==='over'&&diff>0)||(row.totalPick.side==='under'&&diff<0))?'win':'loss'}
}

// User-confirmed recovery: the original pregame spread direction for MEM@NOP
// was Pelicans +3.5. The diagnostic candidate row was not the original locked pick.
// Do not fabricate the original odds or model probability when the source snapshot is missing.
let manuallyRecovered=0
const memNop=byId.get('401909300')
if(memNop && memNop.home==='NO' && memNop.away==='MEM') {
  const current=memNop.spreadPick
  if(current?.side!=='Pelicans' || current?.teamSide!=='home' || current?.line!==3.5 || current.price!==undefined || current.probability!==undefined || current.ev!==undefined) {
    const result = memNop.settledAt && Number.isFinite(memNop.actualHome) && Number.isFinite(memNop.actualAway)
      ? ((Number(memNop.actualHome)-Number(memNop.actualAway)+3.5)===0 ? 'push' : (Number(memNop.actualHome)-Number(memNop.actualAway)+3.5)>0 ? 'win' : 'loss')
      : undefined
    memNop.spreadPick={side:'Pelicans',teamSide:'home',line:3.5,...(result?{result}:{})}
    memNop.recoverySource='user-confirmed-original-pick; original price/probability unavailable'
    manuallyRecovered++
  }
}

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
        existing.actualHome=hs; existing.actualAway=as; settleMarkets(existing,hs,as); existing.settledAt=now.toISOString(); settled++; settledGames.push({gameId:id,home:existing.home,away:existing.away,actualHome:hs,actualAway:as})
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
      added++
      if (status.includes('final')) {
        const hs=Number(h.score), as=Number(a.score)
        if (Number.isFinite(hs)&&Number.isFinite(as)) {
          existing.actualHome=hs
          existing.actualAway=as
          settleMarkets(existing,hs,as)
          existing.settledAt=now.toISOString()
          settled++
          settledGames.push({gameId:id,home:existing.home,away:existing.away,actualHome:hs,actualAway:as})
        }
      }
      continue
    }
    // Recovered historical pregame snapshots are immutable even while a game
    // remains upcoming; do not overwrite them with a later rolling draft.
    if (existing.recoverySource) continue
    const rolling=analyzeMatch({date:event.date,home:{id:String(h.team?.id??''),abbreviation:String(h.team?.abbreviation??'—')},away:{id:String(a.team?.id??''),abbreviation:String(a.team?.abbreviation??'—')}},form,injuries,calibrator,teamMetrics)
    if (rolling.available) {
      existing.homeWin=rolling.homeWin; existing.awayWin=rolling.awayWin
      existing.projectedMargin=rolling.projectedMargin; existing.projectedTotal=rolling.projectedTotal
      existing.paceAdjustment=rolling.paceAdjustment; existing.totalTrend=rolling.totalTrend; existing.totalStdDev=rolling.totalStdDev
      existing.homeInjuryImpact=rolling.homeInjuryImpact; existing.awayInjuryImpact=rolling.awayInjuryImpact; existing.injuryRisk=rolling.injuryRisk
      Object.assign(existing,makeMarketPicks(event,rolling))
      existing.modelVersion='recent-form-pace-v1'
      existing.capturedAt=now.toISOString(); refreshed++
    }
    continue
  }
  if (status.includes('final') || tipoff<=now.getTime()) continue
  const game={date:event.date,home:{id:String(h.team?.id??''),abbreviation:String(h.team?.abbreviation??'—')},away:{id:String(a.team?.id??''),abbreviation:String(a.team?.abbreviation??'—')}}
  const prediction=analyzeMatch(game,form,injuries,calibrator,teamMetrics)
  if (!prediction.available) continue
  const stage:Row['stage']=tipoff-now.getTime()<=60*60*1000?'official':'draft'
  const markets=makeMarketPicks(event,prediction)
  const row:Row={gameId:id,date:event.date,home:game.home.abbreviation,away:game.away.abbreviation,homeWin:prediction.homeWin,awayWin:prediction.awayWin,projectedMargin:prediction.projectedMargin,projectedTotal:prediction.projectedTotal,...markets,paceAdjustment:prediction.paceAdjustment,totalTrend:prediction.totalTrend,totalStdDev:prediction.totalStdDev,homeInjuryImpact:prediction.homeInjuryImpact,awayInjuryImpact:prediction.awayInjuryImpact,injuryRisk:prediction.injuryRisk,modelVersion:'recent-form-pace-v1',stage,capturedAt:now.toISOString(),...(stage==='official'?{lockedAt:now.toISOString()}:{})}
  if (existing) {
    Object.assign(existing,row)
    if (stage==='official') added++
  } else {
    rows.push(row); byId.set(id,row); added++
  }
}
// Backfill market outcomes whenever a final score already exists.
// This is essential when a pregame pick is recovered after the game was previously settled.
let regraded=0
for (const row of rows) {
  if (row.settledAt && Number.isFinite(row.actualHome) && Number.isFinite(row.actualAway) && (row.spreadPick?.result===undefined || row.totalPick?.result===undefined)) {
    settleMarkets(row,row.actualHome as number,row.actualAway as number)
    regraded++
  }
}
// Keep the complete ledger; do not silently discard historical predictions.
const output=rows
// Keep per-game predictions and market picks out of public Actions logs.
if (added || settled || refreshed || regraded || manuallyRecovered || !previousPayload) {
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
if (manuallyRecovered) console.log(`User-confirmed original spread restored: MEM@NOP Pelicans +3.5 (${manuallyRecovered} row)`)
console.log(`Taiwan date ${twNoDash}; ESPN dates ${allDateKeys[0]}-${allDateKeys[allDateKeys.length-1]}; successful dates ${successfulDates}/${allDateKeys.length}; new/locked ${added}; rolling refreshed ${refreshed}; settled ${settled}; upcoming drafts ${upcoming}; official records ${official}; total ${output.length}`)
