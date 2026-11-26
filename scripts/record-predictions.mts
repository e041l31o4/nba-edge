// Trigger a fresh verified scoreboard settlement pass.
import { readFile, writeFile } from 'node:fs/promises'
import { analyzeMatch, coverProbability, totalProbability, decimalExpectedValue, type TeamFormData, type InjuryData, type TeamMetricsData, type ProbabilityCalibrator, type MarketErrorCalibration } from '../src/model'

type MarketPick = { side:string; teamSide?:'home'|'away'; line:number; price?:number; probability?:number; ev?:number; result?:'win'|'loss'|'push'|'ungraded' }
type Row = { gameId:string; date:string; home:string; away:string; homeWin:number; awayWin:number; projectedMargin:number; projectedTotal:number; moneylineLean?:MarketPick; moneylinePick?:MarketPick; spreadLean?:MarketPick; totalLean?:MarketPick; spreadPick?:MarketPick; totalPick?:MarketPick; latestMarketReview?:{moneylinePick?:MarketPick;spreadPick?:MarketPick;totalPick?:MarketPick;updatedAt:string}; marketChangeHistory?:Array<{at:string;market:'moneyline'|'spread'|'total';from?:MarketPick;to?:MarketPick;reason:string}>; analysisChangeHistory?:Array<{at:string;changedFields:string[];from:Record<string,unknown>;to:Record<string,unknown>;reason:string}>; paceAdjustment?:number; totalTrend?:number|null; totalStdDev?:number; homeInjuryImpact?:number; awayInjuryImpact?:number; injuryRisk?:string; modelVersion?:string; stage?:'draft'|'official'; analysisStatus?:'draft'|'preliminary'|'final'; preliminaryAt?:string; finalAt?:string; openingSnapshot?:Record<string,unknown>; finalSnapshot?:Record<string,unknown>; capturedAt:string; lockedAt?:string; actualHome?:number; actualAway?:number; settledAt?:string; recoverySource?:string }
const base = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const readJson = async <T>(path:string):Promise<T|null> => { try { return JSON.parse(await readFile(path,'utf8')) as T } catch { return null } }
const now = new Date()
const tw = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
const twNoDash = tw.replace(/-/g,'')
const taiwanDateKey=(value:string|Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))
const isFinalReviewReached=(gameDate:string)=>{
  // Lock every game's complete prediction set at 21:00 Taiwan time on the
  // calendar day before the game. This gives tomorrow's slate one stable cutoff.
  const localDate=taiwanDateKey(gameDate)
  if(!localDate) return false
  const [y,m,d]=localDate.split('-').map(Number)
  const previousDay=new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10)
  const cutoff=new Date(`${previousDay}T21:00:00+08:00`).getTime()
  return Number.isFinite(cutoff) && now.getTime()>=cutoff
}
const [year, month, day] = tw.split('-').map(Number)
const dateKeys = Array.from({length:9},(_,i)=>new Date(Date.UTC(year,month-1,day+i-1)).toISOString().slice(0,10).replace(/-/g,''))
const [form, injuries, teamMetrics, backtest, previousPayload, oddsPayload] = await Promise.all([
  readJson<TeamFormData>('public/data/team-form.json'),
  readJson<InjuryData>('public/data/injuries.json'),
  readJson<TeamMetricsData>('public/data/team-metrics.json'),
  readJson<{currentSeason?:{calibrator?:ProbabilityCalibrator|null;marketErrorCalibration?:MarketErrorCalibration|null};seasonResults?:{calibrator?:ProbabilityCalibrator|null;candidateV2Calibrator?:ProbabilityCalibrator|null}[]}>('public/data/backtest.json'),
  readJson<{records:Row[];footballRecords?:Record<string,unknown>[]}>('public/data/prediction-ledger.json'),
  readJson<{games:Array<{home_team:string;away_team:string;bookmakers?:{title:string;markets:{key:string;outcomes:{name:string;point?:number;price:number}[]}[]}[]}>}>('public/data/odds.json')
])
const oddsRefreshSucceeded = process.env.NBA_EDGE_ODDS_REFRESH_SUCCESS !== 'false'
const analysisRefreshSucceeded = process.env.NBA_EDGE_ANALYSIS_REFRESH_SUCCESS !== 'false'
const canGeneratePredictions = oddsRefreshSucceeded && analysisRefreshSucceeded && !!form
if (!oddsRefreshSucceeded) console.warn('PlaySport odds refresh failed: settlement-only mode enabled; no new predictions or pregame market refreshes will be generated from retained odds.')
if (!analysisRefreshSucceeded || !form) console.warn('Team-form/injury refresh unavailable: settlement-only mode enabled; existing completed games will still be graded, but no pregame predictions will be generated.')

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
const calibrator = backtest?.currentSeason?.calibrator ?? backtest?.seasonResults?.slice().reverse().find(x=>x.candidateV2Calibrator)?.candidateV2Calibrator ?? backtest?.seasonResults?.slice().reverse().find(x=>x.calibrator)?.calibrator ?? null
const marketErrorCalibration:MarketErrorCalibration|null=backtest?.currentSeason?.marketErrorCalibration??null
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
// Repair records that were prematurely locked by the previous UTC-date rollover bug.
let reopenedPrematureLocks=0
for(const row of rows){
  const localDate=taiwanDateKey(row.date)
  if(row.stage==='official' && !row.settledAt && localDate>tw && !isFinalReviewReached(row.date)){
    const previousLock={stage:row.stage,lockedAt:row.lockedAt??null,finalizedAt:(row as any).finalizedAt??null}
    row.stage='draft'
    delete row.lockedAt
    delete (row as any).finalizedAt
    row.analysisChangeHistory=[...(row.analysisChangeHistory??[]),{
      at:now.toISOString(),
      changedFields:['stage','lockedAt','finalizedAt'],
      from:previousLock,
      to:{stage:'draft',lockedAt:null,finalizedAt:null},
      reason:'調整封存規則：正式分析改為台灣時間賽前一日 21:00 鎖定；尚未到鎖定時間的未結算紀錄重新開放'
    }].slice(-200)
    reopenedPrematureLocks++
  }
}
console.log('PREMATURE_LOCK_RECOVERY:',JSON.stringify({reopened:reopenedPrematureLocks,targetTaiwanDate:tw}))
const byId = new Map(rows.map(x=>[x.gameId,x]))

// ESPN's shortName is the authoritative away @ home label. Resolve by
// abbreviation first so a malformed homeAway flag cannot reverse every market.
const getHomeAway=(event:any)=>{
  const competitors=event.competitions?.[0]?.competitors??[]
  const matchup=String(event.shortName??'').toUpperCase().match(/\b([A-Z]{2,3})\s*(?:@|AT)\s*([A-Z]{2,3})\b/)
  if(matchup){
    const away=competitors.find((x:any)=>String(x.team?.abbreviation??'').toUpperCase()===matchup[1])
    const home=competitors.find((x:any)=>String(x.team?.abbreviation??'').toUpperCase()===matchup[2])
    if(home&&away)return {home,away,source:'shortName'}
  }
  return {
    home:competitors.find((x:any)=>x.homeAway==='home'),
    away:competitors.find((x:any)=>x.homeAway==='away'),
    source:'homeAway'
  }
}

// Pregame picks are restored from the private Supabase prediction ledger.
// Do not hard-code or print member-only picks in this public repository.
let added=0, settled=0, refreshed=0
const settledGames:Array<{gameId:string;home:string;away:string;actualHome:number;actualAway:number}> = []
const stableValue=(value:unknown):unknown=>Array.isArray(value)?value.map(stableValue):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stableValue(v)])):value
const sameValue=(a:unknown,b:unknown)=>JSON.stringify(stableValue(a??null))===JSON.stringify(stableValue(b??null))
const samePick=(a:MarketPick|undefined,b:MarketPick|undefined)=>{
  if(!a||!b)return !a&&!b
  return a.side===b.side&&a.teamSide===b.teamSide&&a.line===b.line&&a.price===b.price&&
    (a.probability===undefined&&b.probability===undefined||typeof a.probability==='number'&&typeof b.probability==='number'&&Math.abs(a.probability-b.probability)<0.0005)&&
    (a.ev===undefined&&b.ev===undefined||typeof a.ev==='number'&&typeof b.ev==='number'&&Math.abs(a.ev-b.ev)<0.0005)
}
const makeMarketPicks=(event:any,prediction:any)=>{
  const {home:h,away:a}=getHomeAway(event)
  const homeName=String(h?.team?.name??h?.team?.displayName??'').toLowerCase()
  const awayName=String(a?.team?.name??a?.team?.displayName??'').toLowerCase()
  const oddsGame=oddsPayload?.games?.find(g=>g.home_team.toLowerCase()===homeName&&g.away_team.toLowerCase()===awayName)
  // Only use the Taiwan Sports Lottery "運彩盤" market; never mix foreign books.
  const books=(oddsGame?.bookmakers??[]).filter(b=>b.title==='台灣運彩（玩運彩「運彩盤」欄位；第三方資料呈現）')
  const matches=(name:string,target:string)=>{const n=name.toLowerCase().replace(/[^a-z]/g,''),t=target.toLowerCase().replace(/[^a-z]/g,'');return n===t||n.includes(t)||t.includes(n)}
  const h2hRows=books.flatMap(b=>b.markets.filter(m=>m.key==='h2h').flatMap(m=>m.outcomes.map(o=>({...o,book:b.title}))))
  const h2hCandidates=h2hRows.flatMap(x=>{
    const isHome=matches(x.name,homeName),isAway=matches(x.name,awayName)
    if(!isHome&&!isAway||!Number.isFinite(x.price)||x.price<=1)return []
    const probability=isHome?prediction.homeWin:prediction.awayWin
    return [{side:x.name,teamSide:isHome?'home' as const:'away' as const,line:0,price:x.price,probability,ev:decimalExpectedValue(probability,x.price)}]
  }).sort((x,y)=>y.ev-x.ev)
  const spreadRows=books.flatMap(b=>b.markets.filter(m=>m.key==='spreads').flatMap(m=>m.outcomes.map(o=>({...o,book:b.title}))))
  const spreadGroups=new Map<string,typeof spreadRows>()
  for(const x of spreadRows)if(typeof x.point==='number'&&Number.isFinite(x.price)&&x.price>1){const k=x.book+'|'+Math.abs(x.point);spreadGroups.set(k,[...(spreadGroups.get(k)??[]),x])}
  const spreadCandidates=([...spreadGroups.values()].flatMap(pair=>{
    const home=pair.find(x=>matches(x.name,homeName)),away=pair.find(x=>matches(x.name,awayName));if(!home||!away)return []
    return [home,away].map(x=>{const isHome=x===home;const probability=coverProbability(prediction.projectedMargin,x.point!,isHome,marketErrorCalibration?.spreadValidated?marketErrorCalibration.marginStdDev:11.8,marketErrorCalibration?.spreadValidated?marketErrorCalibration.marginMean:0);return {side:x.name,teamSide:isHome?'home' as const:'away' as const,line:x.point!,price:x.price,probability,ev:decimalExpectedValue(probability,x.price)}})
  })).sort((x,y)=>y.ev-x.ev)
  const totalRows=books.flatMap(b=>b.markets.filter(m=>m.key==='totals').flatMap(m=>m.outcomes.map(o=>({...o,book:b.title}))))
  const totalGroups=new Map<string,typeof totalRows>()
  for(const x of totalRows)if(typeof x.point==='number'&&Number.isFinite(x.price)&&x.price>1){const k=x.book+'|'+x.point;totalGroups.set(k,[...(totalGroups.get(k)??[]),x])}
  const totalCandidates=([...totalGroups.values()].flatMap(pair=>{
    const over=pair.find(x=>/over|大/i.test(x.name)),under=pair.find(x=>/under|小/i.test(x.name));if(!over||!under)return []
    return [over,under].map(x=>{const isOver=x===over;const probability=totalProbability(prediction.projectedTotal,x.point!,isOver,marketErrorCalibration?.totalsValidated?marketErrorCalibration.totalStdDev:prediction.totalStdDev,marketErrorCalibration?.totalsValidated?marketErrorCalibration.totalMean:0);return {side:isOver?'over':'under',line:x.point!,price:x.price,probability,ev:decimalExpectedValue(probability,x.price)}})
  })).sort((x,y)=>y.ev-x.ev)
  // Keep a model direction for all three markets, but only mark a formal recommendation
  // when probability, EV, confidence and injury-risk gates are all satisfied.
  const qualifies=(candidate:{probability:number;ev:number}|undefined)=>!!candidate&&candidate.probability>=0.54&&candidate.ev>=0.025&&prediction.confidence!=='低'&&prediction.injuryRisk!=='偏高'&&prediction.injuryRisk!=='待確認'
  const moneylineLean:MarketPick={side:prediction.homeWin>=0.5?homeName:awayName,teamSide:prediction.homeWin>=0.5?'home':'away',line:0,probability:Math.max(prediction.homeWin,prediction.awayWin)}
  const moneylinePick=marketErrorCalibration?.moneylineRecommendationReady?h2hCandidates.find(qualifies):undefined
  const spreadLean=spreadCandidates[0]
  const totalLean=totalCandidates[0]
  const spreadPick=marketErrorCalibration?.spreadRecommendationReady?spreadCandidates.find(qualifies):undefined
  const totalPick=marketErrorCalibration?.totalsRecommendationReady?totalCandidates.find(qualifies):undefined
  return {
    moneylineLean,
    ...(moneylinePick?{moneylinePick}:{}),
    ...(spreadLean?{spreadLean}:{}),
    ...(totalLean?{totalLean}:{}),
    ...(spreadPick?{spreadPick}:{}),
    ...(totalPick?{totalPick}:{})
  }
}
const freezePredictionSnapshot=(row:Row)=>{
  const analysisHistory=[...(row.analysisChangeHistory??[])].reverse()
  const marketHistory=[...(row.marketChangeHistory??[])].reverse()
  const historyValue=(field:string)=>analysisHistory.flatMap(change=>[change.to?.[field],change.from?.[field]]).find(value=>value!==undefined&&value!==null)
  const marketValue=(market:'moneyline'|'spread'|'total')=>marketHistory.filter(change=>change.market===market).flatMap(change=>[change.to,change.from]).find(Boolean)
  const moneylinePick=row.moneylinePick??row.openingSnapshot?.moneylinePick as MarketPick|undefined??historyValue('moneylinePick') as MarketPick|undefined??marketValue('moneyline')
  const spreadPick=row.spreadPick??row.latestMarketReview?.spreadPick??row.openingSnapshot?.spreadPick as MarketPick|undefined??historyValue('spreadPick') as MarketPick|undefined??marketValue('spread')
  const totalPick=row.totalPick??row.latestMarketReview?.totalPick??row.openingSnapshot?.totalPick as MarketPick|undefined??historyValue('totalPick') as MarketPick|undefined??marketValue('total')
  const moneylineLean=row.moneylineLean??row.openingSnapshot?.moneylineLean as MarketPick|undefined??historyValue('moneylineLean') as MarketPick|undefined
  const spreadLean=row.spreadLean??spreadPick??row.openingSnapshot?.spreadLean as MarketPick|undefined??historyValue('spreadLean') as MarketPick|undefined
  const totalLean=row.totalLean??totalPick??row.openingSnapshot?.totalLean as MarketPick|undefined??historyValue('totalLean') as MarketPick|undefined
  return {homeWin:row.homeWin,awayWin:row.awayWin,projectedMargin:row.projectedMargin,projectedTotal:row.projectedTotal,moneylineLean:moneylineLean??null,moneylinePick:moneylinePick??null,spreadLean:spreadLean??null,totalLean:totalLean??null,spreadPick:spreadPick??null,totalPick:totalPick??null,paceAdjustment:row.paceAdjustment??null,totalTrend:row.totalTrend??null,totalStdDev:row.totalStdDev??null,homeInjuryImpact:row.homeInjuryImpact??null,awayInjuryImpact:row.awayInjuryImpact??null,injuryRisk:row.injuryRisk??null,confirmedAt:row.lockedAt??now.toISOString()}
}
const ensureFinalSnapshot=(row:Row)=>{
  const recovered=freezePredictionSnapshot(row)
  const current=(row.finalSnapshot??{}) as Record<string,unknown>
  row.finalSnapshot={
    ...recovered,...current,
    moneylineLean:current.moneylineLean??recovered.moneylineLean,
    moneylinePick:current.moneylinePick??recovered.moneylinePick,
    spreadLean:current.spreadLean??recovered.spreadLean,
    spreadPick:current.spreadPick??recovered.spreadPick,
    totalLean:current.totalLean??recovered.totalLean,
    totalPick:current.totalPick??recovered.totalPick,
    confirmedAt:current.confirmedAt??current.lockedAt??recovered.confirmedAt
  }
}
const settleMarkets=(row:Row,home:number,away:number)=>{
  const frozen=(row.finalSnapshot??{}) as any
  const moneyline=(frozen.moneylinePick??row.moneylinePick) as MarketPick|undefined
  const spread=(frozen.spreadPick??row.spreadPick) as MarketPick|undefined
  const total=(frozen.totalPick??row.totalPick) as MarketPick|undefined
  if(moneyline){
    const correct=moneyline.teamSide==='home'?home>away:away>home
    row.moneylinePick={...moneyline,result:correct?'win':'loss'}
  }
  if(spread){
    const margin=spread.teamSide==='away'?away-home+spread.line:home-away+spread.line
    row.spreadPick={...spread,result:Math.abs(margin)<1e-9?'push':margin>0?'win':'loss'}
  }
  if(total){
    const diff=home+away-total.line
    row.totalPick={...total,result:Math.abs(diff)<1e-9?'push':((total.side==='over'&&diff>0)||(total.side==='under'&&diff<0))?'win':'loss'}
  }
}

// Roll back the 2026-11-24 06:42:49 Asia/Taipei refresh for the current day's slate.
// The exact prior picks are preserved in each row's marketChangeHistory.from value.
// Restore those values (including odds/probability/EV) and keep the official slate immutable.
const rollbackAt='2026-11-23T22:42:49.124Z'
const rollbackTag='rollback-2026-11-24-064249-to-pre-refresh'
let restoredMarketCount=0
let restoredRowCount=0
for(const row of rows){
  if(taiwanDateKey(row.date)!=='2026-11-24' || String(row.recoverySource??'').includes(rollbackTag)) continue
  const changes=(row.marketChangeHistory??[]).filter(change=>change.at===rollbackAt && change.from && ['moneyline','spread','total'].includes(change.market))
  if(!changes.length) continue
  for(const change of changes){
    const field=change.market==='moneyline'?'moneylinePick':change.market==='spread'?'spreadPick':'totalPick'
    const current=(row as any)[field] as MarketPick|undefined
    const restored={...(change.from as MarketPick)}
    if(current?.result) restored.result=current.result
    ;(row as any)[field]=restored
    if(row.latestMarketReview) (row.latestMarketReview as any)[field]=restored
    if(row.finalSnapshot) (row.finalSnapshot as any)[field]=restored
    row.marketChangeHistory=[...(row.marketChangeHistory??[]),{
      at:now.toISOString(),market:change.market,from:current??change.to,to:restored,
      reason:'依使用者要求，撤銷 2026-11-24 06:42:49 自動更新，恢復更新前原始推薦與燈號'
    }].slice(-200)
    restoredMarketCount++
  }
  const [y,m,d]=taiwanDateKey(row.date).split('-').map(Number)
  const previousDay=new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10)
  const cutoffAt=new Date(previousDay+'T21:00:00+08:00').toISOString()
  row.stage='official'
  row.lockedAt=row.lockedAt??cutoffAt
  row.finalizedAt=row.finalizedAt??row.lockedAt
  row.finalAt=row.finalAt??row.lockedAt
  row.analysisStatus='final'
  ensureFinalSnapshot(row)
  row.recoverySource=[row.recoverySource,rollbackTag].filter(Boolean).join(';')
  restoredRowCount++
}
// The website's moneyline card reads homeWin/awayWin, not only moneylinePick.
// Restore those display-driving probabilities as well as the saved market lean/pick fields.
let restoredDisplayProbabilities=0
for(const row of rows){
  if(taiwanDateKey(row.date)!=='2026-11-24' || !String(row.recoverySource??'').includes(rollbackTag)) continue
  const moneylineChange=(row.marketChangeHistory??[]).find(change=>change.at===rollbackAt && change.market==='moneyline' && change.from && typeof change.from.probability==='number')
  if(moneylineChange?.from){
    const oldPick={...(moneylineChange.from as MarketPick)}
    const homeProbability=oldPick.teamSide==='home'?oldPick.probability!:1-oldPick.probability!
    row.homeWin=homeProbability
    row.awayWin=1-homeProbability
    row.moneylinePick=oldPick
    row.moneylineLean=oldPick
    if(row.latestMarketReview) row.latestMarketReview.moneylinePick=oldPick
    if(row.finalSnapshot){
      row.finalSnapshot.homeWin=homeProbability
      row.finalSnapshot.awayWin=1-homeProbability
      row.finalSnapshot.moneylinePick=oldPick
      row.finalSnapshot.moneylineLean=oldPick
    }
    restoredDisplayProbabilities++
  }
  for(const market of ['spread','total'] as const){
    const change=(row.marketChangeHistory??[]).find(item=>item.at===rollbackAt && item.market===market && item.from)
    if(!change?.from) continue
    const oldPick={...(change.from as MarketPick)}
    const pickField=market==='spread'?'spreadPick':'totalPick'
    const leanField=market==='spread'?'spreadLean':'totalLean'
    ;(row as any)[pickField]=oldPick
    ;(row as any)[leanField]=oldPick
    if(row.latestMarketReview) (row.latestMarketReview as any)[pickField]=oldPick
    if(row.finalSnapshot){
      ;(row.finalSnapshot as any)[pickField]=oldPick
      ;(row.finalSnapshot as any)[leanField]=oldPick
    }
  }
}
console.log('NBA_EDGE_2026_11_24_DISPLAY_FIELDS_RESTORED:',JSON.stringify({restoredDisplayProbabilities,websiteMoneylineSource:'homeWin/awayWin',allThreeMarkets:true}))

const alreadyRestoredRows=rows.filter(row=>taiwanDateKey(row.date)==='2026-11-24' && String(row.recoverySource??'').includes(rollbackTag))
const alreadyRestoredMarkets=alreadyRestoredRows.reduce((count,row)=>count+(row.marketChangeHistory??[]).filter(change=>change.reason==='依使用者要求，撤銷 2026-11-24 06:42:49 自動更新，恢復更新前原始推薦與燈號').length,0)
const totalRestoredRows=restoredRowCount+alreadyRestoredRows.length
const totalRestoredMarkets=restoredMarketCount+alreadyRestoredMarkets
if(totalRestoredMarkets!==25 || totalRestoredRows!==10){
  throw new Error('Rollback safety check failed: expected 25 original market picks across 10 games; verified '+totalRestoredMarkets+' picks across '+totalRestoredRows+' games. No partial rollback will be published.')
}
console.log('NBA_EDGE_2026_11_24_064249_ROLLBACK:',JSON.stringify({restoredRows:totalRestoredRows,restoredMarkets:totalRestoredMarkets,alreadyRestoredRows:alreadyRestoredRows.length,sourceTimestamp:rollbackAt,trafficLightPicksRestored:true}))

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
// ESPN's home/away order is Pistons (home) / Heat (away); derive the side from the actual row.
let heatDetRestored=false
const isHeat=(team:string)=>/^(MIA|HEAT|MIAMI)$/i.test(team.trim())
const isDetroit=(team:string)=>/^(DET|PISTONS|DETROIT)$/i.test(team.trim())
const heatDet=rows.find(row=>row.date.slice(0,10)==='2026-11-15' &&
  ((isHeat(row.home)&&isDetroit(row.away)) || (isDetroit(row.home)&&isHeat(row.away))))
if(heatDet){
  const heatIsHome=isHeat(heatDet.home)
  const correctSide=heatIsHome?'home' as const:'away' as const
  if(heatDet.spreadPick?.side!=='Heat' || heatDet.spreadPick?.teamSide!==correctSide || heatDet.spreadPick?.line!==2.5){
    const previous=heatDet.spreadPick
    const margin=heatIsHome
      ? Number(heatDet.actualHome)-Number(heatDet.actualAway)+2.5
      : Number(heatDet.actualAway)-Number(heatDet.actualHome)+2.5
    const result=heatDet.settledAt && Number.isFinite(heatDet.actualHome) && Number.isFinite(heatDet.actualAway)
      ? (Math.abs(margin)<1e-9?'push':margin>0?'win':'loss')
      : undefined
    const recovered={side:'Heat',teamSide:correctSide,line:2.5,...(result?{result}:{})}
    heatDet.marketChangeHistory=[...(heatDet.marketChangeHistory??[]),{at:now.toISOString(),market:'spread',from:previous,to:recovered,reason:'依使用者確認的原始推薦恢復：熱火受讓 +2.5（對活塞）'}].slice(-200)
    heatDet.spreadPick=recovered
    heatDet.recoverySource='user-confirmed-original-pick; Heat +2.5 vs Pistons; original price/probability unavailable'
    heatDetRestored=true
    manuallyRecovered++
  }
}
console.log('HEAT_DET_RECOVERY:',JSON.stringify({found:!!heatDet,gameId:heatDet?.gameId,home:heatDet?.home,away:heatDet?.away,restored:heatDetRestored,side:heatDet?.spreadPick?.side,teamSide:heatDet?.spreadPick?.teamSide,line:heatDet?.spreadPick?.line}))
// User-confirmed recovery: Chicago Bulls vs Minnesota Timberwolves, UNDER 236.5 (Taiwan date 2026-11-15).
const isBulls=(team:string)=>/^(CHI|BULLS|CHICAGO)$/i.test(team.trim())
const isWolves=(team:string)=>/^(MIN|TIMBERWOLVES|TIMBERWOLVES|MINNESOTA)$/i.test(team.trim())
const bullsWolves=rows.find(row=>row.date.slice(0,10)==='2026-11-15' &&
  ((isBulls(row.home)&&isWolves(row.away)) || (isWolves(row.home)&&isBulls(row.away))))
let bullsWolvesRestored=false
if(bullsWolves && (bullsWolves.totalPick?.side?.toLowerCase()!=='under' || bullsWolves.totalPick?.line!==236.5)){
  const previous=bullsWolves.totalPick
  const actualTotal=Number(bullsWolves.actualHome)+Number(bullsWolves.actualAway)
  const result=bullsWolves.settledAt && Number.isFinite(bullsWolves.actualHome) && Number.isFinite(bullsWolves.actualAway)
    ? (Math.abs(actualTotal-236.5)<1e-9?'push':actualTotal<236.5?'win':'loss')
    : undefined
  const recovered={...previous,side:'under',line:236.5,...(result?{result}:{})}
  bullsWolves.marketChangeHistory=[...(bullsWolves.marketChangeHistory??[]),{at:now.toISOString(),market:'total',from:previous,to:recovered,reason:'依使用者確認的原始推薦恢復：公牛 vs 灰狼 小 236.5'}].slice(-200)
  bullsWolves.totalPick=recovered
  bullsWolves.recoverySource='user-confirmed-original-pick; Under 236.5 Bulls vs Timberwolves; original price/probability unavailable'
  bullsWolvesRestored=true
  manuallyRecovered++
}
console.log('BULLS_WOLVES_TOTAL_RECOVERY:',JSON.stringify({found:!!bullsWolves,gameId:bullsWolves?.gameId,home:bullsWolves?.home,away:bullsWolves?.away,restored:bullsWolvesRestored,side:bullsWolves?.totalPick?.side,line:bullsWolves?.totalPick?.line}))
// Restore the original Nov 21 totals picks from the private ledger's own snapshots/history.
// This reads only existing historical values; it does not recalculate or invent a direction.
const nov21OriginalTotalTargets = new Set(['401909305','401909307','401909310','401909312'])
const asHistoricalTotal = (value:unknown):MarketPick|undefined => {
  if (!value || typeof value!=='object') return undefined
  const pick=value as Record<string,unknown>
  const side=String(pick.side??'').toLowerCase()
  const line=Number(pick.line)
  if (!['over','under'].includes(side) || !Number.isFinite(line) || line<=0) return undefined
  return {
    side,
    line,
    ...(Number.isFinite(Number(pick.price))?{price:Number(pick.price)}:{}),
    ...(Number.isFinite(Number(pick.probability))?{probability:Number(pick.probability)}:{}),
    ...(Number.isFinite(Number(pick.ev))?{ev:Number(pick.ev)}:{}),
  }
}
let nov21OriginalTotalsRestored=0
for (const row of rows) {
  if (!nov21OriginalTotalTargets.has(row.gameId) || asHistoricalTotal(row.totalPick)) continue
  const marketHistory=(row.marketChangeHistory??[]).filter(change=>change.market==='total').slice().sort((a,b)=>a.at.localeCompare(b.at))
  const analysisHistory=(row.analysisChangeHistory??[]).slice().sort((a,b)=>a.at.localeCompare(b.at))
  const candidates:unknown[]=[
    (row.openingSnapshot as any)?.totalPick,
    ...marketHistory.flatMap(change=>[change.from,change.to]),
    ...analysisHistory.flatMap(change=>[change.from?.totalPick,change.to?.totalPick]),
    (row.finalSnapshot as any)?.totalPick,
    row.latestMarketReview?.totalPick,
  ]
  const original=candidates.map(asHistoricalTotal).find(Boolean)
  if (!original) continue
  const previous=row.totalPick
  row.totalPick=original
  row.recoverySource='restored-from-original-private-ledger-snapshot-and-history; no new prediction generated'
  row.marketChangeHistory=[...(row.marketChangeHistory??[]),{
    at:now.toISOString(),
    market:'total',
    ...(previous?{from:previous}:{}),
    to:original,
    reason:'恢復 2026-11-21 原始大小分推薦：取自封存前的私人預測快照／方向歷程，非重新計算'
  }].slice(-200)
  nov21OriginalTotalsRestored++
}
console.log('NOV21_ORIGINAL_TOTALS_RESTORED_COUNT:',nov21OriginalTotalsRestored)

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
  const {home:h,away:a,source:homeAwaySource}=getHomeAway(event)
  if (!h || !a || !event.id) continue
  if(String(event.shortName??'').includes('@')) console.log('NBA_EDGE_HOME_AWAY_CHECK:',JSON.stringify({matchup:event.shortName,home:h.team?.abbreviation,away:a.team?.abbreviation,source:homeAwaySource}))
  const id=String(event.id), existing=byId.get(id)
  const status=String(event.status?.type?.name ?? event.status?.name ?? '').toLowerCase()
  const statusState=String(event.status?.type?.state ?? event.status?.state ?? '').toLowerCase()
  const tipoff=new Date(event.date).getTime()
  if (!Number.isFinite(tipoff)) continue
  // ESPN may expose completed games through the state/completed fields even when
  // the display name is not STATUS_FINAL. Require valid final scores before grading.
  const hasFinalScores=Number.isFinite(Number(h.score)) && Number.isFinite(Number(a.score))
  const isFinal=hasFinalScores && (status.includes('final') || statusState==='post' || event.status?.type?.completed===true || event.status?.completed===true)
  if (existing && isFinal) {
    const hs=Number(h.score), as=Number(a.score)
    if (Number.isFinite(hs)&&Number.isFinite(as)) {
      const wasSettled=!!existing.settledAt
      existing.stage='official'
      existing.lockedAt=existing.lockedAt??existing.capturedAt
      existing.finalAt=existing.finalAt??existing.lockedAt
      existing.finalizedAt=existing.finalizedAt??existing.lockedAt
      ensureFinalSnapshot(existing)
      existing.analysisStatus='final'
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
  // If the Taiwan Sports Lottery refresh failed, continue grading completed games above,
  // but never create or refresh pregame recommendations from retained/stale odds.
  if (!canGeneratePredictions) continue
  // Freeze at exactly 21:00 Taiwan time on the previous calendar day.
  // Do not run one last rolling refresh after the agreed cutoff.
  if(existing?.stage==='draft' && isFinalReviewReached(event.date)){
    const localDate=taiwanDateKey(event.date)
    const [y,m,d]=localDate.split('-').map(Number)
    const previousDay=new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10)
    const cutoffAt=new Date(previousDay+'T21:00:00+08:00').toISOString()
    existing.stage='official'
    existing.lockedAt=existing.lockedAt??cutoffAt
    existing.finalizedAt=existing.finalizedAt??existing.lockedAt
    existing.finalAt=existing.finalAt??existing.lockedAt
    existing.analysisStatus='final'
    ensureFinalSnapshot(existing)
    added++
    continue
  }
  if (existing?.stage==='draft') {
    if (existing.recoverySource) continue
    const game={date:event.date,home:{id:String(h.team?.id??''),abbreviation:String(h.team?.abbreviation??'—')},away:{id:String(a.team?.id??''),abbreviation:String(a.team?.abbreviation??'—')}}
    const rolling=analyzeMatch(game,form,injuries,calibrator,teamMetrics)
    if (rolling.available) {
      const reviewedMarkets=makeMarketPicks(event,rolling)
      const before={homeWin:existing.homeWin,awayWin:existing.awayWin,projectedMargin:existing.projectedMargin,projectedTotal:existing.projectedTotal,moneylineLean:existing.moneylineLean??null,moneylinePick:existing.moneylinePick??null,spreadLean:existing.spreadLean??null,totalLean:existing.totalLean??null,spreadPick:existing.spreadPick??null,totalPick:existing.totalPick??null,paceAdjustment:existing.paceAdjustment??null,totalTrend:existing.totalTrend??null,totalStdDev:existing.totalStdDev??null,homeInjuryImpact:existing.homeInjuryImpact??null,awayInjuryImpact:existing.awayInjuryImpact??null,injuryRisk:existing.injuryRisk??null}
      const after={homeWin:rolling.homeWin,awayWin:rolling.awayWin,projectedMargin:rolling.projectedMargin,projectedTotal:rolling.projectedTotal,moneylineLean:reviewedMarkets.moneylineLean??null,moneylinePick:reviewedMarkets.moneylinePick??null,spreadLean:reviewedMarkets.spreadLean??null,totalLean:reviewedMarkets.totalLean??null,spreadPick:reviewedMarkets.spreadPick??null,totalPick:reviewedMarkets.totalPick??null,paceAdjustment:rolling.paceAdjustment,totalTrend:rolling.totalTrend,totalStdDev:rolling.totalStdDev,homeInjuryImpact:rolling.homeInjuryImpact,awayInjuryImpact:rolling.awayInjuryImpact,injuryRisk:rolling.injuryRisk}
      const changedKeys=Object.keys(after).filter(key=>!sameValue((before as any)[key],(after as any)[key]))
      if(changedKeys.length){
        const history=existing.analysisChangeHistory??[]
        history.push({at:now.toISOString(),changedFields:changedKeys,from:before,to:after,reason:'賽前滾動更新：模型或盤口資料變動；此紀錄不代表單一因素造成'})
        existing.analysisChangeHistory=history.slice(-200)
      }
      const changed=(a:MarketPick|undefined,b:MarketPick|undefined)=>!!a&&!!b&&(a.side!==b.side||a.teamSide!==b.teamSide||a.line!==b.line)
      const marketHistory=existing.marketChangeHistory??[]
      if(!samePick(existing.moneylinePick,reviewedMarkets.moneylinePick)) marketHistory.push({at:now.toISOString(),market:'moneyline',from:existing.moneylinePick,to:reviewedMarkets.moneylinePick,reason:'不讓分方向、盤口或模型機率有實質差異；保留前後值供核對'})
      if(!samePick(existing.spreadPick,reviewedMarkets.spreadPick)) marketHistory.push({at:now.toISOString(),market:'spread',from:existing.spreadPick,to:reviewedMarkets.spreadPick,reason:'讓分方向、盤口或模型機率有實質差異；保留前後值供核對'})
      if(!samePick(existing.totalPick,reviewedMarkets.totalPick)) marketHistory.push({at:now.toISOString(),market:'total',from:existing.totalPick,to:reviewedMarkets.totalPick,reason:'大小分方向、盤口或模型機率有實質差異；保留前後值供核對'})
      existing.marketChangeHistory=marketHistory.slice(-200)
      existing.homeWin=rolling.homeWin; existing.awayWin=rolling.awayWin
      existing.projectedMargin=rolling.projectedMargin; existing.projectedTotal=rolling.projectedTotal
      existing.moneylineLean=reviewedMarkets.moneylineLean; existing.moneylinePick=reviewedMarkets.moneylinePick
      existing.spreadLean=reviewedMarkets.spreadLean; existing.totalLean=reviewedMarkets.totalLean
      existing.spreadPick=reviewedMarkets.spreadPick; existing.totalPick=reviewedMarkets.totalPick
      existing.paceAdjustment=rolling.paceAdjustment; existing.totalTrend=rolling.totalTrend; existing.totalStdDev=rolling.totalStdDev
      existing.homeInjuryImpact=rolling.homeInjuryImpact; existing.awayInjuryImpact=rolling.awayInjuryImpact; existing.injuryRisk=rolling.injuryRisk
      existing.latestMarketReview={...reviewedMarkets,updatedAt:now.toISOString()}
       const openingMarketAvailable=(oddsPayload?.games??[]).some(g=>g.home_team.toLowerCase()===String(h.team?.name??h.team?.displayName??'').toLowerCase()&&g.away_team.toLowerCase()===String(a.team?.name??a.team?.displayName??'').toLowerCase()&&(g.bookmakers??[]).some(b=>(b.markets??[]).some(m=>(m.outcomes??[]).length>0)))
       if(!existing.preliminaryAt && openingMarketAvailable){existing.preliminaryAt=now.toISOString();existing.analysisStatus='preliminary';existing.openingSnapshot={homeWin:rolling.homeWin,awayWin:rolling.awayWin,projectedMargin:rolling.projectedMargin,projectedTotal:rolling.projectedTotal,spreadPick:reviewedMarkets.spreadPick??null,totalPick:reviewedMarkets.totalPick??null,capturedAt:now.toISOString()}}
      existing.modelVersion='recent-form-pace-v2.2-backtest-aligned-total-uncertainty-qualified-picks'
      existing.refreshedAt=now.toISOString(); refreshed++
    }
    if(isFinalReviewReached(event.date)){
      existing.stage='official'
      existing.lockedAt=existing.lockedAt??now.toISOString()
      existing.finalizedAt=existing.lockedAt
      existing.finalAt=existing.finalAt??existing.lockedAt
      existing.analysisStatus='final'
      ensureFinalSnapshot(existing)
      added++
    } else if(tipoff<=now.getTime()){
      existing.stage='official'
      existing.lockedAt=existing.lockedAt??now.toISOString()
      existing.finalizedAt=existing.lockedAt
      existing.finalAt=existing.finalAt??existing.lockedAt
      existing.analysisStatus='final'
      ensureFinalSnapshot(existing)
      added++
    }
    continue
  }
  if (isFinal || tipoff<=now.getTime()) continue
  const game={date:event.date,home:{id:String(h.team?.id??''),abbreviation:String(h.team?.abbreviation??'—')},away:{id:String(a.team?.id??''),abbreviation:String(a.team?.abbreviation??'—')}}
  const prediction=analyzeMatch(game,form,injuries,calibrator,teamMetrics)
  if (!prediction.available) continue
  const stage:Row['stage']=isFinalReviewReached(event.date)||tipoff<=now.getTime()?'official':'draft'
  const markets=makeMarketPicks(event,prediction)
  const hasOpeningMarket=(oddsPayload?.games??[]).some(g=>g.home_team.toLowerCase()===String(h.team?.name??h.team?.displayName??'').toLowerCase()&&g.away_team.toLowerCase()===String(a.team?.name??a.team?.displayName??'').toLowerCase()&&(g.bookmakers??[]).some(b=>(b.markets??[]).some(m=>(m.outcomes??[]).length>0)))
   if(!hasOpeningMarket) continue
   const row:Row={gameId:id,date:event.date,home:game.home.abbreviation,away:game.away.abbreviation,analysisStatus:stage==='official'?'final':'preliminary',preliminaryAt:now.toISOString(),openingSnapshot:{homeWin:prediction.homeWin,awayWin:prediction.awayWin,projectedMargin:prediction.projectedMargin,projectedTotal:prediction.projectedTotal,moneylineLean:markets.moneylineLean??null,moneylinePick:markets.moneylinePick??null,spreadLean:markets.spreadLean??null,totalLean:markets.totalLean??null,spreadPick:markets.spreadPick??null,totalPick:markets.totalPick??null,capturedAt:now.toISOString()},...(stage==='official'?{finalAt:now.toISOString(),finalSnapshot:{homeWin:prediction.homeWin,awayWin:prediction.awayWin,projectedMargin:prediction.projectedMargin,projectedTotal:prediction.projectedTotal,moneylineLean:markets.moneylineLean??null,moneylinePick:markets.moneylinePick??null,spreadLean:markets.spreadLean??null,totalLean:markets.totalLean??null,spreadPick:markets.spreadPick??null,totalPick:markets.totalPick??null,confirmedAt:now.toISOString()}}:{}),homeWin:prediction.homeWin,awayWin:prediction.awayWin,projectedMargin:prediction.projectedMargin,projectedTotal:prediction.projectedTotal,...markets,paceAdjustment:prediction.paceAdjustment,totalTrend:prediction.totalTrend,totalStdDev:prediction.totalStdDev,homeInjuryImpact:prediction.homeInjuryImpact,awayInjuryImpact:prediction.awayInjuryImpact,injuryRisk:prediction.injuryRisk,moneylineLean:markets.moneylineLean,moneylinePick:markets.moneylinePick,spreadLean:markets.spreadLean,totalLean:markets.totalLean,modelVersion:'recent-form-elo-v2.4-market-residual-calibration-qualified-picks',stage,capturedAt:now.toISOString(),...(stage==='official'?{lockedAt:now.toISOString(),finalizedAt:now.toISOString()}:{})}
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
// Read-only audit of the frozen ledger: compare market directions with formal qualified picks.
// This prints historical hit rates without changing any prediction or settlement.
const summarizeMarket=(items:Row[],market:'moneyline'|'spread'|'total',field:'lean'|'pick')=>{
  const tally={wins:0,losses:0,pushes:0,noDirection:0}
  for(const row of items){
    const frozen=(row.finalSnapshot??{}) as Record<string,unknown>
    const key=market==='moneyline'?(field==='lean'?'moneylineLean':'moneylinePick'):market==='spread'?(field==='lean'?'spreadLean':'spreadPick'):(field==='lean'?'totalLean':'totalPick')
    let raw=Object.prototype.hasOwnProperty.call(frozen,key)?frozen[key]:row[key as keyof Row]
    const frozenHomeWin=Number(frozen.homeWin??row.homeWin),frozenAwayWin=Number(frozen.awayWin??row.awayWin)
    if(!raw&&field==='lean'&&market==='moneyline'&&Number.isFinite(frozenHomeWin)&&Number.isFinite(frozenAwayWin)){const teamSide=frozenHomeWin>=frozenAwayWin?'home':'away';raw={teamSide,side:teamSide==='home'?row.home:row.away,probability:Math.max(frozenHomeWin,frozenAwayWin)}}
    if(!raw&&field==='lean'&&market==='spread')raw=frozen.spreadPick??row.spreadPick
    if(!raw&&field==='lean'&&market==='total')raw=frozen.totalPick??row.totalPick
    const pick=raw&&typeof raw==='object'?raw as MarketPick:undefined
    if(!pick || (market!=='total'&&!pick.teamSide) || (market!=='moneyline'&&typeof pick.line!=='number') || (market==='total'&&!['over','under'].includes(String(pick.side)))){tally.noDirection++;continue}
    let result:'win'|'loss'|'push'
    if(market==='moneyline') result=(pick.teamSide==='home'?Number(row.actualHome)>Number(row.actualAway):Number(row.actualAway)>Number(row.actualHome))?'win':'loss'
    else if(market==='spread'){
      const margin=pick.teamSide==='away'?Number(row.actualAway)-Number(row.actualHome)+Number(pick.line):Number(row.actualHome)-Number(row.actualAway)+Number(pick.line)
      result=Math.abs(margin)<1e-9?'push':margin>0?'win':'loss'
    } else {
      const diff=Number(row.actualHome)+Number(row.actualAway)-Number(pick.line)
      result=Math.abs(diff)<1e-9?'push':((pick.side==='over'&&diff>0)||(pick.side==='under'&&diff<0))?'win':'loss'
    }
    tally[result]++
  }
  const decided=tally.wins+tally.losses
  return {...tally,hitRate:decided?Number((tally.wins/decided*100).toFixed(1)):null}
}
const auditDates=Array.from({length:7},(_,i)=>new Date(Date.UTC(year,month-1,day-i)).toISOString().slice(0,10).replace(/-/g,'')).reverse()
for(const date of auditDates){
  const dayRows=rows.filter(row=>taiwanDateKey(row.date).replace(/-/g,'')===date)
  const scored=dayRows.filter(row=>row.stage==='official'&&Number.isFinite(row.actualHome)&&Number.isFinite(row.actualAway))
  const settled= scored.filter(row=>!!row.settledAt)
  console.log('NBA_EDGE_FROZEN_DAILY_AUDIT:',JSON.stringify({date,gameRecords:dayRows.length,officialScoredGames:scored.length,settledGames:settled.length,pendingScores:dayRows.length-scored.length,directions:{moneyline:summarizeMarket(scored,'moneyline','lean'),spread:summarizeMarket(scored,'spread','lean'),total:summarizeMarket(scored,'total','lean')},qualifiedRecommendations:{moneyline:summarizeMarket(scored,'moneyline','pick'),spread:summarizeMarket(scored,'spread','pick'),total:summarizeMarket(scored,'total','pick')}}))
}

// Keep the complete ledger; do not silently discard historical predictions.
const output=rows
// Keep per-game predictions and market picks out of public Actions logs.
if (added || settled || refreshed || regraded || manuallyRecovered || restoredMarketCount || !previousPayload) {
  const target='public/data/prediction-ledger.json'
  const temp=target+'.tmp'
  await writeFile(temp,JSON.stringify({updatedAt:now.toISOString(),source:'NBA EDGE pregame model + ESPN final scores',records:output,footballRecords:previousPayload?.footballRecords??[]},null,2)+'\n')
  const { rename } = await import('node:fs/promises')
  await rename(temp,target)
}
const preliminary=output.filter(row=>row.analysisStatus==='preliminary').length
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
if (recentMarketChanges.length) console.log('NBA_EDGE_MARKET_DIRECTION_CHANGES:',JSON.stringify(recentMarketChanges.map(({date,game,market,from,to,reason,at})=>({date,game,market,from:from??null,to:to??null,reason,at}))))
const recentAnalysisChanges=output.flatMap(row=>(row.analysisChangeHistory??[]).filter(change=>now.getTime()-new Date(change.at).getTime()<6*60*1000).map(change=>({date:row.date,game:row.away+' @ '+row.home,at:change.at})))
if (recentAnalysisChanges.length) console.log('NBA_EDGE_ANALYSIS_CHANGE_AUDIT_COUNT:',recentAnalysisChanges.length)
console.log('DEN_NOP_SPREAD_RESTORE_APPLIED:',denNopRestored)
console.log(`Taiwan date ${twNoDash}; ESPN dates ${allDateKeys[0]}-${allDateKeys[allDateKeys.length-1]}; successful dates ${successfulDates}/${allDateKeys.length}; reopened premature locks ${reopenedPrematureLocks}; preliminary ${preliminary}; new/locked ${added}; rolling refreshed ${refreshed}; settled ${settled}; market regraded ${regraded}; upcoming drafts ${upcoming}; official records ${official}; total ${output.length}`)
