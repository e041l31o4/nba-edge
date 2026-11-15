import { readFile, writeFile } from 'node:fs/promises'
import { analyzeMatch, coverProbability, totalProbability, decimalExpectedValue, type TeamFormData, type InjuryData, type TeamMetricsData, type ProbabilityCalibrator } from '../src/model'

type MarketPick = { side:string; teamSide?:'home'|'away'; line:number; price?:number; probability?:number; ev?:number; result?:'win'|'loss'|'push'|'ungraded' }
type Row = { gameId:string; date:string; home:string; away:string; homeWin:number; awayWin:number; projectedMargin:number; projectedTotal:number; spreadPick?:MarketPick; totalPick?:MarketPick; latestMarketReview?:{spreadPick?:MarketPick;totalPick?:MarketPick;updatedAt:string}; marketChangeHistory?:Array<{at:string;market:'spread'|'total';from?:MarketPick;to?:MarketPick;reason:string}>; analysisChangeHistory?:Array<{at:string;changedFields:string[];from:Record<string,unknown>;to:Record<string,unknown>;reason:string}>; paceAdjustment?:number; totalTrend?:number|null; totalStdDev?:number; homeInjuryImpact?:number; awayInjuryImpact?:number; injuryRisk?:string; modelVersion?:string; stage?:'draft'|'official'; capturedAt:string; lockedAt?:string; actualHome?:number; actualAway?:number; settledAt?:string; recoverySource?:string }
const base = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const readJson = async <T>(path:string):Promise<T|null> => { try { return JSON.parse(await readFile(path,'utf8')) as T } catch { return null } }
const now = new Date()
const tw = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
const twNoDash = tw.replace(/-/g,'')
const taiwanDateKey=(value:string|Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))
const isEightPmCutoffReached=(gameDate:string)=>{const localDate=taiwanDateKey(gameDate);const previous=new Date(`${localDate}T00:00:00+08:00`);previous.setUTCDate(previous.getUTCDate()-1);const cutoffDate=previous.toISOString().slice(0,10);return now.getTime()>=new Date(`${cutoffDate}T20:00:00+08:00`).getTime()}
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
  .filter(row => !row.settledAt && Number.isFinite(new Date(row.date).getTime()))
  .map(row => row.date.slice(0,10).replace(/-/g,'')))]
  .filter(date => /^\d{8}$/.test(date) && date < twNoDash)
  .sort()
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

// User-confirmed recovery: restore the original pregame Pelicans home-underdog spread.
let manuallyRecovered=0
let denNopRestored=false
console.log('DEN_NOP_LEDGER_MATCH_DIAGNOSTIC:',JSON.stringify(rows.filter(row=>row.date.startsWith('2026-11-15') && (/DEN|NOP|NO|NUGGETS|PELICANS/i.test(row.home+' '+row.away))).map(row=>({gameId:row.gameId,date:row.date,home:row.home,away:row.away,stage:row.stage,settled:!!row.settledAt}))))
const denNop=rows.find(row=>row.date.slice(0,10)>='2026-11-14' && row.date.slice(0,10)<='2026-11-16' && /^(NO|NOP|PELICANS|NEW ORLEANS PELICANS)$/i.test(row.home.trim()) && /^(DEN|NUGGETS|DENVER NUGGETS)$/i.test(row.away.trim()))
if(denNop && (denNop.spreadPick?.side!=='Pelicans' || denNop.spreadPick?.teamSide!=='home' || denNop.spreadPick?.line!==12.5)){
  const margin=Number(denNop.actualHome)-Number(denNop.actualAway)+12.5
  const result=denNop.settledAt && Number.isFinite(denNop.actualHome) && Number.isFinite(denNop.actualAway)
    ? (Math.abs(margin)<1e-9?'push':margin>0?'win':'loss')
    : undefined
  denNop.spreadPick={side:'Pelicans',teamSide:'home',line:12.5,...(result?{result}:{})}
  denNop.recoverySource='user-confirmed-original-pick; original price/probability unavailable'
  denNopRestored=true
  manuallyRecovered++
}

// User-confirmed recovery: restore the original Miami Heat +2.5 spread vs Detroit (Taiwan date 2026-11-15).
let heatDetRestored=false
const heatDet=rows.find(row=>row.date.slice(0,10)==='2026-11-15' && /^(MIA|HEAT|MIAMI)$/i.test(row.home.trim()) && /^(DET|PISTONS|DETROIT)$/i.test(row.away.trim()))
if(heatDet && (heatDet.spreadPick?.side!=='Heat' || heatDet.spreadPick?.teamSide!=='home' || heatDet.spreadPick?.line!==2.5)){
  const previous=heatDet.spreadPick
  const margin=Number(heatDet.actualHome)-Number(heatDet.actualAway)+2.5
  const result=heatDet.settledAt && Number.isFinite(heatDet.actualHome) && Number.isFinite(heatDet.actualAway)
    ? (Math.abs(margin)<1e-9?'push':margin>0?'win':'loss')
    : undefined
  heatDet.marketChangeHistory=[...(heatDet.marketChangeHistory??[]),{at:now.toISOString(),market:'spread',from:previous,to:{side:'Heat',teamSide:'home',line:2.5,...(result?{result}:{})},reason:'依使用者確認的原始推薦恢復：熱火受讓 +2.5（對活塞）'}].slice(-200)
  heatDet.spreadPick={side:'Heat',teamSide:'home',line:2.5,...(result?{result}:{})}
  heatDet.recoverySource='user-confirmed-original-pick; Heat +2.5 vs Pistons; original price/probability unavailable'
  heatDetRestored=true
  manuallyRecovered++
}
const memNop=byId.get('401909300')
if(memNop && memNop.home==='NO' && memNop.away==='MEM') {
  const current=memNop.spreadPick
  if(current?.side!=='Grizzlies' || current?.teamSide!=='away' || current?.line!==3.5 || current.price!==undefined || current.probability!==undefined || current.ev!==undefined) {
    const margin=Number(memNop.actualAway)-Number(memNop.actualHome)-3.5
    const result=memNop.settledAt && Number.isFinite(memNop.actualHome) && Number.isFinite(memNop.actualAway)
      ? (Math.abs(margin)<1e-9?'push':margin>0?'win':'loss')
      : undefined
    memNop.spreadPick={side:'Grizzlies',teamSide:'away',line:3.5,...(result?{result}:{})}
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
  const isFinal=status.includes('final')
  if (existing && isFinal) {
    const hs=Number(h.score), as=Number(a.score)
    if (Number.isFinite(hs)&&Number.isFinite(as)) {
      const wasSettled=!!existing.settledAt
      existing.stage='official'
      existing.lockedAt=existing.lockedAt??existing.capturedAt
      existing.actualHome=hs
      existing.actualAway=as
      settleMarkets(existing,hs,as)
      existing.settledAt=existing.settledAt??now.toISOString()
      if (!wasSettled) {
        settled++
        settledGames.push({gameId:id,home:existing.home,away:existing.away,actualHome:hs,actualAway:as})
      }
    }
    continue
  }
  if (existing && existing.stage==='official') continue
  if (existing?.stage==='draft') {
    if (existing.recoverySource) continue
    const game={date:event.date,home:{id:String(h.team?.id??''),abbreviation:String(h.team?.abbreviation??'—')},away:{id:String(a.team?.id??''),abbreviation:String(a.team?.abbreviation??'—')}}
    const rolling=analyzeMatch(game,form,injuries,calibrator,teamMetrics)
    if (rolling.available) {
      const reviewedMarkets=makeMarketPicks(event,rolling)
      const before={homeWin:existing.homeWin,awayWin:existing.awayWin,projectedMargin:existing.projectedMargin,projectedTotal:existing.projectedTotal,spreadPick:existing.spreadPick??null,totalPick:existing.totalPick??null,paceAdjustment:existing.paceAdjustment??null,totalTrend:existing.totalTrend??null,totalStdDev:existing.totalStdDev??null,homeInjuryImpact:existing.homeInjuryImpact??null,awayInjuryImpact:existing.awayInjuryImpact??null,injuryRisk:existing.injuryRisk??null}
      const after={homeWin:rolling.homeWin,awayWin:rolling.awayWin,projectedMargin:rolling.projectedMargin,projectedTotal:rolling.projectedTotal,spreadPick:reviewedMarkets.spreadPick??null,totalPick:reviewedMarkets.totalPick??null,paceAdjustment:rolling.paceAdjustment,totalTrend:rolling.totalTrend,totalStdDev:rolling.totalStdDev,homeInjuryImpact:rolling.homeInjuryImpact,awayInjuryImpact:rolling.awayInjuryImpact,injuryRisk:rolling.injuryRisk}
      const changedKeys=Object.keys(after).filter(key=>JSON.stringify((before as any)[key])!==JSON.stringify((after as any)[key]))
      if(changedKeys.length){
        const history=existing.analysisChangeHistory??[]
        history.push({at:now.toISOString(),changedFields:changedKeys,from:before,to:after,reason:'賽前滾動更新：模型或盤口資料變動；此紀錄不代表單一因素造成'})
        existing.analysisChangeHistory=history.slice(-200)
      }
      const changed=(a:MarketPick|undefined,b:MarketPick|undefined)=>!!a&&!!b&&(a.side!==b.side||a.teamSide!==b.teamSide||a.line!==b.line)
      const marketHistory=existing.marketChangeHistory??[]
      if(JSON.stringify(existing.spreadPick??null)!==JSON.stringify(reviewedMarkets.spreadPick??null)) marketHistory.push({at:now.toISOString(),market:'spread',from:existing.spreadPick,to:reviewedMarkets.spreadPick,reason:'盤口或模型重新計算；原方向與新方向均保留'})
      if(JSON.stringify(existing.totalPick??null)!==JSON.stringify(reviewedMarkets.totalPick??null)) marketHistory.push({at:now.toISOString(),market:'total',from:existing.totalPick,to:reviewedMarkets.totalPick,reason:'盤口或模型重新計算；原方向與新方向均保留'})
      existing.marketChangeHistory=marketHistory.slice(-200)
      existing.homeWin=rolling.homeWin; existing.awayWin=rolling.awayWin
      existing.projectedMargin=rolling.projectedMargin; existing.projectedTotal=rolling.projectedTotal
      existing.spreadPick=reviewedMarkets.spreadPick; existing.totalPick=reviewedMarkets.totalPick
      existing.paceAdjustment=rolling.paceAdjustment; existing.totalTrend=rolling.totalTrend; existing.totalStdDev=rolling.totalStdDev
      existing.homeInjuryImpact=rolling.homeInjuryImpact; existing.awayInjuryImpact=rolling.awayInjuryImpact; existing.injuryRisk=rolling.injuryRisk
      existing.latestMarketReview={...reviewedMarkets,updatedAt:now.toISOString()}
      existing.modelVersion='recent-form-pace-v1'
      existing.refreshedAt=now.toISOString(); refreshed++
    }
    if(isEightPmCutoffReached(event.date)){
      existing.stage='official'
      existing.lockedAt=existing.lockedAt??now.toISOString()
      existing.finalizedAt=existing.lockedAt
      added++
    } else if(tipoff<=now.getTime()){
      existing.stage='official'
      existing.lockedAt=existing.lockedAt??now.toISOString()
      existing.finalizedAt=existing.lockedAt
      added++
    }
    continue
  }
  if (isFinal || tipoff<=now.getTime()) continue
  const game={date:event.date,home:{id:String(h.team?.id??''),abbreviation:String(h.team?.abbreviation??'—')},away:{id:String(a.team?.id??''),abbreviation:String(a.team?.abbreviation??'—')}}
  const prediction=analyzeMatch(game,form,injuries,calibrator,teamMetrics)
  if (!prediction.available) continue
  const stage:Row['stage']=isEightPmCutoffReached(event.date)||tipoff<=now.getTime()?'official':'draft'
  const markets=makeMarketPicks(event,prediction)
  const row:Row={gameId:id,date:event.date,home:game.home.abbreviation,away:game.away.abbreviation,homeWin:prediction.homeWin,awayWin:prediction.awayWin,projectedMargin:prediction.projectedMargin,projectedTotal:prediction.projectedTotal,...markets,paceAdjustment:prediction.paceAdjustment,totalTrend:prediction.totalTrend,totalStdDev:prediction.totalStdDev,homeInjuryImpact:prediction.homeInjuryImpact,awayInjuryImpact:prediction.awayInjuryImpact,injuryRisk:prediction.injuryRisk,modelVersion:'recent-form-pace-v1',stage,capturedAt:now.toISOString(),...(stage==='official'?{lockedAt:now.toISOString(),finalizedAt:now.toISOString()}:{})}
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
  if (!row.settledAt || !Number.isFinite(row.actualHome) || !Number.isFinite(row.actualAway)) continue
  const needsSpreadGrade = !!row.spreadPick && !['win','loss','push'].includes(String(row.spreadPick.result))
  const needsTotalGrade = !!row.totalPick && !['win','loss','push'].includes(String(row.totalPick.result))
  if (needsSpreadGrade || needsTotalGrade) {
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
const pendingOfficial = output.filter(row => row.stage==='official' && !row.settledAt).map(row => ({gameId:row.gameId,date:row.date,home:row.home,away:row.away}))
if (pendingOfficial.length) console.log('Official records still awaiting final score:', JSON.stringify(pendingOfficial))
const houstonScoreboardEvents = scoreboards.flatMap(s=>s.events ?? []).filter((event:any)=>{const names=(event.competitions?.[0]?.competitors??[]).map((x:any)=>String(x.team?.abbreviation??'').toUpperCase());return names.includes('HOU')})
if (houstonScoreboardEvents.length) console.log('Houston scoreboard settlement diagnostic:', JSON.stringify(houstonScoreboardEvents.map((event:any)=>({gameId:String(event.id),status:event.status?.type?.name,home:event.competitions?.[0]?.competitors?.find((x:any)=>x.homeAway==='home')?.team?.abbreviation,away:event.competitions?.[0]?.competitors?.find((x:any)=>x.homeAway==='away')?.team?.abbreviation,homeScore:event.competitions?.[0]?.competitors?.find((x:any)=>x.homeAway==='home')?.score,awayScore:event.competitions?.[0]?.competitors?.find((x:any)=>x.homeAway==='away')?.score,ledgerMatch:byId.has(String(event.id))}))))
if (recentlySettled.length) console.log('Recently settled games (persisted):', JSON.stringify(recentlySettled))
const recentMarketChanges=output.flatMap(row=>(row.marketChangeHistory??[]).filter(change=>now.getTime()-new Date(change.at).getTime()<6*60*1000).map(change=>({date:row.date,game:row.away+' @ '+row.home,market:change.market,from:change.from,to:change.to,at:change.at})))
if (recentMarketChanges.length) console.log('NBA_EDGE_MARKET_DIRECTION_CHANGES:',JSON.stringify(recentMarketChanges.map(({date,game,market,at})=>({date,game,market,at}))))
const recentAnalysisChanges=output.flatMap(row=>(row.analysisChangeHistory??[]).filter(change=>now.getTime()-new Date(change.at).getTime()<6*60*1000).map(change=>({date:row.date,game:row.away+' @ '+row.home,at:change.at})))
if (recentAnalysisChanges.length) console.log('NBA_EDGE_ANALYSIS_CHANGE_AUDIT_COUNT:',recentAnalysisChanges.length)
console.log('DEN_NOP_SPREAD_RESTORE_APPLIED:',denNopRestored)
console.log(`Taiwan date ${twNoDash}; ESPN dates ${allDateKeys[0]}-${allDateKeys[allDateKeys.length-1]}; successful dates ${successfulDates}/${allDateKeys.length}; new/locked ${added}; rolling refreshed ${refreshed}; settled ${settled}; market regraded ${regraded}; upcoming drafts ${upcoming}; official records ${official}; total ${output.length}`)
