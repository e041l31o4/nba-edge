export type RecentGame = { date?: string; pointsFor: number; pointsAgainst: number; win: boolean; opponent?: string; opponentId?: string; homeAway?: string }
export type TeamFormRow = { teamId: string; team: string; abbreviation: string; last10: RecentGame[] }
export type TeamFormData = { updatedAt: string; source: string; teams: Record<string, TeamFormRow> }
export type InjuryRow = { team: string; player: string; status: string; detail?: string; position?: string; athleteId?: string; sourceUrl?: string; pointsPerGame?: number; minutesPerGame?: number; reboundsPerGame?: number; assistsPerGame?: number; stealsPerGame?: number; blocksPerGame?: number; turnoversPerGame?: number; usageRate?: number; gamesPlayed?: number }
export type InjuryData = { updatedAt: string; source: string; sourceUrl: string; players: InjuryRow[]; status: string }
export type RosterPlayer = { team: string; player: string; athleteId: string; position?: string; jersey?: string }
export type RosterData = { updatedAt: string; source: string; teams: Record<string, RosterPlayer[]>; status: string }
export type TeamMetricRow = { teamId: string; abbreviation: string; updatedAt: string; stale?: boolean; offensiveRating?: number; defensiveRating?: number; netRating?: number; pace?: number; trueShootingPct?: number; turnoverPct?: number; reboundPct?: number; gamesPlayed?: number }
export type TeamMetricsData = { updatedAt: string; season: string; source: string; status: string; teams: Record<string, TeamMetricRow> }
export type ProbabilityCalibrator = { a: number; b: number; trainingSamples: number }
export type ModelResult = {
  available: boolean; reason?: string; homeRecord: string; awayRecord: string;
  homePpg: number; homeOppPpg: number; awayPpg: number; awayOppPpg: number;
  homeLast5: string; awayLast5: string; homeNet: number; awayNet: number;
  projectedHome: number; projectedAway: number; projectedMargin: number; projectedTotal: number;
  homeWin: number; awayWin: number; homeInjuries: InjuryRow[]; awayInjuries: InjuryRow[];
  confidence: '低'|'中'|'高'; sample: number; homeRestDays:number|null; awayRestDays:number|null;
  homeGamesLast3Days:number; awayGamesLast3Days:number; homeGamesLast5Days:number; awayGamesLast5Days:number; homeGamesLast7Days:number; awayGamesLast7Days:number; homeRoadStreak:number; awayRoadStreak:number;
  homeBackToBack:boolean; awayBackToBack:boolean; injuryRisk:'待確認'|'偏高'|'中等'|'低'; homeSOS:number|null; awaySOS:number|null;
  homeInjuryImpact:number; awayInjuryImpact:number; homeImpactPlayers:number; awayImpactPlayers:number; homeInjuryCap:number; awayInjuryCap:number;
  totalTrend:number|null; totalStdDev:number; paceAdjustment:number;
}
const clamp=(n:number,min=0.01,max=0.99)=>Math.max(min,Math.min(max,n))
export function calibrateProbability(probability:number, calibrator?:ProbabilityCalibrator|null){if(!calibrator||!Number.isFinite(calibrator.a)||!Number.isFinite(calibrator.b))return clamp(probability);const p=Math.max(0.001,Math.min(0.999,probability));const logit=Math.log(p/(1-p));const z=calibrator.a*logit+calibrator.b;return clamp(z>=0?1/(1+Math.exp(-Math.min(z,40))):Math.exp(Math.max(z,-40))/(1+Math.exp(Math.max(z,-40))))}
function cdf(z:number){const sign=z<0?-1:1,x=Math.abs(z)/Math.sqrt(2),t=1/(1+0.3275911*x);const erf=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return clamp(0.5*(1+sign*erf))}
const avg=(a:number[])=>a.reduce((s,n)=>s+n,0)/Math.max(a.length,1)
const record=(rows:RecentGame[])=>{const wins=rows.filter(x=>x.win).length;return `${wins}-${rows.length-wins}`}
const net=(rows:RecentGame[])=>avg(rows.map(x=>x.pointsFor-x.pointsAgainst))
const scheduleStrength=(rows:RecentGame[],form:TeamFormData)=>{const values=rows.map(x=>x.opponentId?form.teams[String(x.opponentId)]?.last10:null).filter((x):x is RecentGame[]=>!!x&&x.length>=5).map(net);return values.length>=3?avg(values):null}
function absenceProbability(status:string){const s=status.toLowerCase();if(/out|inactive|suspended/.test(s))return 1;if(/doubtful/.test(s))return 0.8;if(/questionable|game.time|day.to.day/.test(s))return 0.5;if(/probable/.test(s))return 0.15;if(/available|active/.test(s))return 0;return 0}
function normalizeInjuryTeamAbbreviation(value:string){
 const key=(value??'').toUpperCase().trim()
 const aliases:Record<string,string>={GS:'GSW',SA:'SAS',NO:'NOP',NY:'NYK',UTAH:'UTA',PHO:'PHX'}
 return aliases[key]??key
}
function injuryRiskLevel(injuries:InjuryData|null, rows:InjuryRow[]):ModelResult['injuryRisk']{
 if(!injuries||injuries.status!=='available'||!injuries.source?.includes('NBA Official Injury Report'))return '待確認'
 const keyPlayers=[...new Map(rows.filter(isMajorUnavailable).map(x=>[x.athleteId?String(x.athleteId):x.player.trim().toLowerCase(),x])).values()]
 return keyPlayers.length>=3?'偏高':keyPlayers.length>=1?'中等':'低'
}
function replacementGap(minutesPerGame?:number){if(typeof minutesPerGame!=='number'||!Number.isFinite(minutesPerGame)||minutesPerGame<=0)return 0.35;return 0.25+0.20*Math.max(0,Math.min(1,minutesPerGame/36))}
function isMajorUnavailable(x:InjuryRow){return !/g league|two-way|on assignment/i.test(x.detail??'')&&(Number(x.pointsPerGame??0)>=10||Number(x.minutesPerGame??0)>=24)&&absenceProbability(x.status)>=0.5}
function dynamicInjuryCap(rows:InjuryRow[]){
 const unique=new Map<string,InjuryRow>()
 for(const row of rows)if(isMajorUnavailable(row)){const key=row.athleteId?String(row.athleteId):row.player.trim().toLowerCase();if(!unique.has(key))unique.set(key,row)}
 const keyPlayers=[...unique.values()]
 const starBonus=keyPlayers.some(x=>Number(x.pointsPerGame??0)>=25)?2:0
 return Math.min(20,10+Math.max(0,keyPlayers.length-1)*2+starBonus)
}
function injuryImpact(rows:InjuryRow[]){const quantified=rows.filter(x=>!/g league|two-way|on assignment/i.test(x.detail??'')&&typeof x.pointsPerGame==='number'&&Number.isFinite(x.pointsPerGame)&&x.pointsPerGame!>0);const loss=quantified.reduce((sum,x)=>sum+(x.pointsPerGame??0)*absenceProbability(x.status)*replacementGap(x.minutesPerGame),0);const cap=dynamicInjuryCap(rows);return {points:Math.min(cap,loss),players:quantified.filter(x=>absenceProbability(x.status)>0).length,cap}}
export function analyzeMatch(game:{date:string;home:{id:string;abbreviation:string};away:{id:string;abbreviation:string}},form:TeamFormData|null,injuries:InjuryData|null,calibrator?:ProbabilityCalibrator|null,teamMetrics?:TeamMetricsData|null):ModelResult{
 const resolveTeam=(id:string,abbr:string)=>form?.teams?.[String(id)] ?? Object.values(form?.teams??{}).find(row=>row.abbreviation?.toUpperCase()===abbr?.toUpperCase())
 const h=resolveTeam(game.home.id,game.home.abbreviation),a=resolveTeam(game.away.id,game.away.abbreviation)
 const hi=(injuries?.players??[]).filter(x=>normalizeInjuryTeamAbbreviation(x.team)===normalizeInjuryTeamAbbreviation(game.home.abbreviation)), ai=(injuries?.players??[]).filter(x=>normalizeInjuryTeamAbbreviation(x.team)===normalizeInjuryTeamAbbreviation(game.away.abbreviation))
 const empty={homeRecord:'—',awayRecord:'—',homePpg:0,homeOppPpg:0,awayPpg:0,awayOppPpg:0,homeLast5:'—',awayLast5:'—',homeNet:0,awayNet:0,projectedHome:0,projectedAway:0,projectedMargin:0,projectedTotal:0,homeWin:0.5,awayWin:0.5,homeInjuries:hi,awayInjuries:ai,confidence:'低' as const,sample:0,homeRestDays:null,awayRestDays:null,homeGamesLast3Days:0,awayGamesLast3Days:0,homeGamesLast5Days:0,awayGamesLast5Days:0,homeGamesLast7Days:0,awayGamesLast7Days:0,homeRoadStreak:0,awayRoadStreak:0,homeBackToBack:false,awayBackToBack:false,injuryRisk:'待確認' as const,homeSOS:null,awaySOS:null,homeInjuryImpact:0,awayInjuryImpact:0,homeImpactPlayers:0,awayImpactPlayers:0,homeInjuryCap:10,awayInjuryCap:10,totalTrend:null,totalStdDev:14.2,paceAdjustment:0}
 if(!h?.last10||!a?.last10||h.last10.length<3||a.last10.length<3){
  const hm=teamMetrics?.teams?.[game.home.abbreviation],am=teamMetrics?.teams?.[game.away.abbreviation]
  const valid=(row?:TeamMetricRow)=>!!row&&!row.stale&&Number.isFinite(row.offensiveRating)&&Number.isFinite(row.defensiveRating)
  if(!valid(hm)||!valid(am))return {...empty,available:false,reason:'近期賽事不足，且本季攻防效率資料未同時取得；請檢查 team-form.json 與 team-metrics.json。'}
  const paceValues=[hm?.pace,am?.pace].filter((v):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0)
  const pace=paceValues.length?avg(paceValues):99
  const rawHome=((hm!.offensiveRating!+am!.defensiveRating!)/2)*pace/100+2.0
  const rawAway=((am!.offensiveRating!+hm!.defensiveRating!)/2)*pace/100
  const hiImpact=injuryImpact(injuries?.source?.includes('NBA Official Injury Report')?hi:[]),aiImpact=injuryImpact(injuries?.source?.includes('NBA Official Injury Report')?ai:[])
  const projectedHome=Math.max(70,rawHome-hiImpact.points),projectedAway=Math.max(70,rawAway-aiImpact.points)
  const projectedMargin=projectedHome-projectedAway,projectedTotal=projectedHome+projectedAway
  const games=Math.min(hm!.gamesPlayed??0,am!.gamesPlayed??0)
  const injuryRisk=injuryRiskLevel(injuries,[...hi,...ai])
  const confidence:ModelResult['confidence']=games>=15&&injuries?.status==='available'&&injuryRisk!=='偏高'?'中':'低'
  const p=calibrateProbability(cdf(projectedMargin/13),calibrator)
  return {...empty,available:true,reason:'近期樣本不足，已改用本季球隊攻防效率與節奏估算；此場信心等級下調。',homeRecord:'本季效率模型',awayRecord:'本季效率模型',homePpg:hm!.offensiveRating!*pace/100,homeOppPpg:hm!.defensiveRating!*pace/100,awayPpg:am!.offensiveRating!*pace/100,awayOppPpg:am!.defensiveRating!*pace/100,projectedHome,projectedAway,projectedMargin,projectedTotal,homeWin:p,awayWin:1-p,confidence,sample:games,injuryRisk,homeInjuryImpact:hiImpact.points,awayInjuryImpact:aiImpact.points,homeImpactPlayers:hiImpact.players,awayImpactPlayers:aiImpact.players,homeInjuryCap:hiImpact.cap,awayInjuryCap:aiImpact.cap,totalTrend:projectedTotal,totalStdDev:18.6,paceAdjustment:0}
 }
 const hs=h.last10.slice(0,10),as=a.last10.slice(0,10),h5=hs.slice(0,5),a5=as.slice(0,5)
 const hpf=avg(hs.map(x=>x.pointsFor)),hpa=avg(hs.map(x=>x.pointsAgainst)),apf=avg(as.map(x=>x.pointsFor)),apa=avg(as.map(x=>x.pointsAgainst))
 const h5pf=avg(h5.map(x=>x.pointsFor)),h5pa=avg(h5.map(x=>x.pointsAgainst)),a5pf=avg(a5.map(x=>x.pointsFor)),a5pa=avg(a5.map(x=>x.pointsAgainst))
 // Odds-blind baseline: 60% last-10 efficiency, 40% last-5 momentum.
 const homeAttack=0.6*hpf+0.4*h5pf,homeDefense=0.6*hpa+0.4*h5pa
 const awayAttack=0.6*apf+0.4*a5pf,awayDefense=0.6*apa+0.4*a5pa
 const rawHome=(homeAttack+awayDefense)/2+2.2,rawAway=(awayAttack+homeDefense)/2
 const gameDay=new Date(game.date).getTime()
 const rest=(rows:RecentGame[])=>{const last=rows.find(x=>x.date);if(!last?.date||!Number.isFinite(gameDay))return null;const diff=Math.floor((gameDay-new Date(last.date).getTime())/86400000);return Number.isFinite(diff)?Math.max(0,diff-1):null}
 const homeRestDays=rest(hs),awayRestDays=rest(as),homeBackToBack=homeRestDays===0,awayBackToBack=awayRestDays===0
 const gamesInWindow=(rows:RecentGame[],hours:number)=>rows.filter(row=>{const t=row.date?new Date(row.date).getTime():NaN;const elapsed=gameDay-t;return Number.isFinite(t)&&elapsed>=0&&elapsed<=hours*3600000}).length
 const homeGamesLast3Days=gamesInWindow(hs,72),awayGamesLast3Days=gamesInWindow(as,72),homeGamesLast5Days=gamesInWindow(hs,120),awayGamesLast5Days=gamesInWindow(as,120),homeGamesLast7Days=gamesInWindow(hs,168),awayGamesLast7Days=gamesInWindow(as,168)
 const roadStreak=(rows:RecentGame[])=>{let count=0;for(const row of rows){const venue=(row.homeAway||'').toLowerCase();if(venue==='away')count++;else break}return count}
 const homeRoadStreak=roadStreak(hs),awayRoadStreak=roadStreak(as)
 const restAdjustment=homeRestDays===null||awayRestDays===null?0:Math.max(-2,Math.min(2,homeRestDays-awayRestDays))*0.45
 const b2bAdjustment=(homeBackToBack?-1.3:0)+(awayBackToBack?1.3:0)
 const homeSOS=scheduleStrength(hs,form!),awaySOS=scheduleStrength(as,form!)
 const sosAdjustment=homeSOS===null||awaySOS===null?0:(homeSOS-awaySOS)*0.18
 const hImpact=injuryImpact(injuries?.source?.includes('NBA Official Injury Report')?hi:[]),aImpact=injuryImpact(injuries?.source?.includes('NBA Official Injury Report')?ai:[])
 // Estimate only the un-replaced share of missing production. Replacement gap scales from 25% to 45%; a dynamic 10–20 point cap rises with distinct major absences and a 25+ PPG star.
 const homeInjuryImpact=hImpact.points,awayInjuryImpact=aImpact.points
 const projectedMargin=(rawHome-rawAway)*0.78+restAdjustment+b2bAdjustment+sosAdjustment-homeInjuryImpact+awayInjuryImpact
 const scoreBasedTotal=rawHome+rawAway-(homeBackToBack?1.3:0)-(awayBackToBack?1.3:0)-homeInjuryImpact-awayInjuryImpact
 const teamTotalTrend=(rows:RecentGame[])=>{const totals=rows.map(x=>x.pointsFor+x.pointsAgainst);const recent=totals.slice(0,5);return recent.length?0.6*avg(recent)+0.4*avg(totals):scoreBasedTotal}
 const totalTrend=avg([teamTotalTrend(hs),teamTotalTrend(as)])
 const paceRows=[teamMetrics?.teams?.[game.home.abbreviation],teamMetrics?.teams?.[game.away.abbreviation]]
 const usablePaces=paceRows.filter(x=>!!x&&!x.stale&&typeof x.pace==='number'&&Number.isFinite(x.pace)&&x.pace>=80&&x.pace<=110).map(x=>x!.pace!)
 const paceAdjustment=usablePaces.length===2?Math.max(-6,Math.min(6,(avg(usablePaces)-99)*1.7)):0
 // Totals use their own trend and uncertainty estimate; this is not a simple copy of the score sum.
 // Independent totals signal: blend the matchup score projection with both teams' recent game-total environment.
 const projectedTotal=scoreBasedTotal*0.75+totalTrend*0.25+paceAdjustment
 const totalStdDev=18.6 // Historical settled forecast-residual baseline; not recent game-total dispersion.
 const projectedHome=(projectedTotal+projectedMargin)/2,projectedAway=(projectedTotal-projectedMargin)/2
 const sample=Math.min(hs.length,as.length)
 const allInjuries=[...hi,...ai]
 const injuryRisk=injuryRiskLevel(injuries,allInjuries)
 const confidence:ModelResult['confidence']=sample>=8&&injuries?.status==='available'&&injuryRisk!=='偏高'?'高':sample>=5&&injuries?.status==='available'?'中':'低'
 return {available:true,...empty,homeRecord:record(hs),awayRecord:record(as),homePpg:hpf,homeOppPpg:hpa,awayPpg:apf,awayOppPpg:apa,homeLast5:record(h5),awayLast5:record(a5),homeNet:net(hs),awayNet:net(as),projectedHome,projectedAway,projectedMargin,projectedTotal,homeWin:calibrateProbability(cdf(projectedMargin/12.2),calibrator),awayWin:1-calibrateProbability(cdf(projectedMargin/12.2),calibrator),confidence,sample,homeRestDays,awayRestDays,homeGamesLast3Days,awayGamesLast3Days,homeGamesLast5Days,awayGamesLast5Days,homeGamesLast7Days,awayGamesLast7Days,homeRoadStreak,awayRoadStreak,homeBackToBack,awayBackToBack,injuryRisk,homeSOS,awaySOS,homeInjuryImpact,awayInjuryImpact,homeImpactPlayers:hImpact.players,awayImpactPlayers:aImpact.players,homeInjuryCap:hImpact.cap,awayInjuryCap:aImpact.cap,totalTrend,totalStdDev,paceAdjustment}
}
export function coverProbability(projectedMargin:number,point:number,isHome:boolean){const margin=isHome?projectedMargin:-projectedMargin;return cdf((margin+point)/11.8)}
export function totalProbability(projectedTotal:number,point:number,isOver:boolean,stdDev=18.6){const sigma=Math.max(10,Math.min(22,Number.isFinite(stdDev)?stdDev:14.2));return isOver?cdf((projectedTotal-point)/sigma):cdf((point-projectedTotal)/sigma)}
export function americanToDecimal(price:number){return price>0?1+price/100:1+100/Math.abs(price)}
export function impliedProbability(price:number){const d=americanToDecimal(price);return 1/d}
export function expectedValue(probability:number,price:number){return probability*americanToDecimal(price)-1}
// Taiwan Sports Lottery displays decimal odds (e.g. 1.75), not American odds.
export function decimalImpliedProbability(price:number){return Number.isFinite(price)&&price>1?1/price:NaN}
export function decimalExpectedValue(probability:number,price:number){return Number.isFinite(price)&&price>1?probability*price-1:NaN}
