import { readFile, writeFile } from 'node:fs/promises'
import { analyzeMatch, coverProbability, totalProbability, decimalExpectedValue, type TeamFormData, type InjuryData, type TeamMetricsData, type ProbabilityCalibrator } from '../src/model'

type MarketPick = { side:string; teamSide?:'home'|'away'; line:number; price:number; probability:number; ev:number; result?:'win'|'loss'|'push'|'ungraded' }
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

// Restore the exact pregame market directions captured in the 2026-11-13
// NBA_EDGE_TOTALS_DIAGNOSTIC run (Taiwan time 2026-11-14 07:48).
const recoveredMarkets:Record<string,{total:{side:'over'|'under';line:number;price:number;probability:number;ev:number};spread:{side:string;teamSide:'home'|'away';line:number;price:number;probability:number;ev:number}}> = {
  'NYK@IND':{total:{side:'over',line:219.5,price:1.70,probability:52.0,ev:-11.6},spread:{side:'Pacers',teamSide:'home',line:7.5,price:1.88,probability:57.7,ev:8.4}},
  'MIL@ORL':{total:{side:'under',line:223.5,price:1.72,probability:54.8,ev:-5.8},spread:{side:'Bucks',teamSide:'away',line:10.5,price:1.63,probability:76.7,ev:25.0}},
  'CLE@MIA':{total:{side:'under',line:235.5,price:1.73,probability:52.2,ev:-9.7},spread:{side:'Heat',teamSide:'home',line:-3.5,price:1.82,probability:52.2,ev:-5.1}},
  'ATL@CHI':{total:{side:'under',line:246.5,price:1.70,probability:58.7,ev:-0.2},spread:{side:'Bulls',teamSide:'home',line:5.5,price:1.88,probability:64.7,ev:21.6}},
  'MEM@NOP':{total:{side:'under',line:235.5,price:1.70,probability:61.6,ev:4.8},spread:{side:'Grizzlies',teamSide:'away',line:-3.5,price:1.72,probability:67.9,ev:16.8}},
  'UTA@HOU':{total:{side:'under',line:221.5,price:1.70,probability:68.6,ev:16.6},spread:{side:'Rockets',teamSide:'home',line:-16.5,price:1.85,probability:69.3,ev:28.2}},
  'GSW@SAS':{total:{side:'under',line:219.5,price:1.73,probability:65.1,ev:12.6},spread:{side:'Warriors',teamSide:'away',line:13.5,price:1.66,probability:70.5,ev:17.0}},
  'POR@SAC':{total:{side:'over',line:229.5,price:1.70,probability:54.3,ev:-7.7},spread:{side:'Kings',teamSide:'home',line:9.5,price:1.78,probability:90.2,ev:60.5}},
  'OKC@LAC':{total:{side:'over',line:222.5,price:1.70,probability:58.9,ev:0.1},spread:{side:'Thunder',teamSide:'away',line:-6.5,price:1.58,probability:74.3,ev:17.3}}
}
const canonicalTeam=(value:string)=>({NY:'NYK',NO:'NOP',GS:'GSW',SA:'SAS',UTAH:'UTA'} as Record<string,string>)[value]??value
const recoveredAt='2026-11-13T23:48:08.744Z'
let recoveredMarketRows=0
const missingRecoveredMatchups:string[]=[]
for(const row of rows){
  const key=canonicalTeam(row.away)+'@'+canonicalTeam(row.home)
  const pick=recoveredMarkets[key]
  if(!pick || row.date?.slice(0,10)!=='2026-11-14') continue
  if(row.recoverySource!=='NBA_EDGE_TOTALS_DIAGNOSTIC 2026-11-13T23:48:08.744Z') recoveredMarketRows++
  row.totalPick={...pick.total}
  row.spreadPick={...pick.spread}
  row.capturedAt=recoveredAt
  row.stage=new Date(row.date).getTime()<=now.getTime()?'official':'draft'
  if(row.stage==='official') row.lockedAt=recoveredAt
  else delete row.lockedAt
  row.recoverySource='NBA_EDGE_TOTALS_DIAGNOSTIC 2026-11-13T23:48:08.744Z'
}
for(const key of Object.keys(recoveredMarkets)){
  const found=rows.some(row=>canonicalTeam(row.away)+'@'+canonicalTeam(row.home)===key && row.date?.slice(0,10)==='2026-11-14')
  if(!found) missingRecoveredMatchups.push(key)
}
console.log('RECOVERED_PREGAME_MARKETS_20261114:',JSON.stringify({recoveredMarketRows,missingRecoveredMatchups}))
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
// Keep the complete ledger; do not silently discard historical predictions.
const output=rows
const recoveredSummary=output.filter(row=>row.recoverySource==='NBA_EDGE_TOTALS_DIAGNOSTIC 2026-11-13T23:48:08.744Z').map(row=>({gameId:row.gameId,home:row.home,away:row.away,stage:row.stage,spreadPick:row.spreadPick,totalPick:row.totalPick,actualHome:row.actualHome,actualAway:row.actualAway,spreadResult:row.spreadPick?.result,totalResult:row.totalPick?.result,settledAt:row.settledAt}))
console.log('RECOVERED_MARKET_SETTLEMENTS_20261114:',JSON.stringify(recoveredSummary))
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
console.log(`Taiwan date ${twNoDash}; ESPN dates ${allDateKeys[0]}-${allDateKeys[allDateKeys.length-1]}; successful dates ${successfulDates}/${allDateKeys.length}; new/locked ${added}; rolling refreshed ${refreshed}; settled ${settled}; upcoming drafts ${upcoming}; official records ${official}; total ${output.length}`)
