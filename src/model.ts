export type RecentGame = { date?: string; pointsFor: number; pointsAgainst: number; win: boolean; opponent?: string }
export type TeamFormRow = { teamId: string; team: string; abbreviation: string; last10: RecentGame[] }
export type TeamFormData = { updatedAt: string; source: string; teams: Record<string, TeamFormRow> }
export type InjuryRow = { team: string; player: string; status: string; detail?: string; position?: string; athleteId?: string; sourceUrl?: string }
export type InjuryData = { updatedAt: string; source: string; sourceUrl: string; players: InjuryRow[]; status: string }
export type ModelResult = {
  available: boolean; reason?: string; homeRecord: string; awayRecord: string;
  homePpg: number; homeOppPpg: number; awayPpg: number; awayOppPpg: number;
  homeLast5: string; awayLast5: string; homeNet: number; awayNet: number;
  projectedHome: number; projectedAway: number; projectedMargin: number; projectedTotal: number;
  homeWin: number; awayWin: number; homeInjuries: InjuryRow[]; awayInjuries: InjuryRow[];
  confidence: '低'|'中'|'高'; sample: number; homeRestDays:number|null; awayRestDays:number|null;
  homeBackToBack:boolean; awayBackToBack:boolean; injuryRisk:'待確認'|'偏高'|'一般';
}
const clamp=(n:number,min=0.01,max=0.99)=>Math.max(min,Math.min(max,n))
function cdf(z:number){const sign=z<0?-1:1,x=Math.abs(z)/Math.sqrt(2),t=1/(1+0.3275911*x);const erf=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return clamp(0.5*(1+sign*erf))}
const avg=(a:number[])=>a.reduce((s,n)=>s+n,0)/Math.max(a.length,1)
const record=(rows:RecentGame[])=>{const wins=rows.filter(x=>x.win).length;return `${wins}-${rows.length-wins}`}
const net=(rows:RecentGame[])=>avg(rows.map(x=>x.pointsFor-x.pointsAgainst))
export function analyzeMatch(game:{date:string;home:{id:string;abbreviation:string};away:{id:string;abbreviation:string}},form:TeamFormData|null,injuries:InjuryData|null):ModelResult{
 const h=form?.teams?.[String(game.home.id)],a=form?.teams?.[String(game.away.id)]
 const hi=(injuries?.players??[]).filter(x=>x.team===game.home.abbreviation), ai=(injuries?.players??[]).filter(x=>x.team===game.away.abbreviation)
 const empty={homeRecord:'—',awayRecord:'—',homePpg:0,homeOppPpg:0,awayPpg:0,awayOppPpg:0,homeLast5:'—',awayLast5:'—',homeNet:0,awayNet:0,projectedHome:0,projectedAway:0,projectedMargin:0,projectedTotal:0,homeWin:0.5,awayWin:0.5,homeInjuries:hi,awayInjuries:ai,confidence:'低' as const,sample:0,homeRestDays:null,awayRestDays:null,homeBackToBack:false,awayBackToBack:false,injuryRisk:'待確認' as const}
 if(!h?.last10||!a?.last10||h.last10.length<3||a.last10.length<3)return {...empty,available:false,reason:'每隊至少需要 3 場已完賽數據；樣本不足時暫不產生勝率。'}
 const hs=h.last10.slice(0,10),as=a.last10.slice(0,10),h5=hs.slice(0,5),a5=as.slice(0,5)
 const hpf=avg(hs.map(x=>x.pointsFor)),hpa=avg(hs.map(x=>x.pointsAgainst)),apf=avg(as.map(x=>x.pointsFor)),apa=avg(as.map(x=>x.pointsAgainst))
 const h5pf=avg(h5.map(x=>x.pointsFor)),h5pa=avg(h5.map(x=>x.pointsAgainst)),a5pf=avg(a5.map(x=>x.pointsFor)),a5pa=avg(a5.map(x=>x.pointsAgainst))
 // Odds-blind estimate: 60% last-10 matchup efficiency, 40% last-5 momentum; no spread or price input.
 const homeAttack=0.6*hpf+0.4*h5pf,homeDefense=0.6*hpa+0.4*h5pa
 const awayAttack=0.6*apf+0.4*a5pf,awayDefense=0.6*apa+0.4*a5pa
 const rawHome=(homeAttack+awayDefense)/2+2.2,rawAway=(awayAttack+homeDefense)/2
 const gameDay=new Date(game.date).getTime()
 const rest=(rows:RecentGame[])=>{const last=rows.find(x=>x.date);if(!last?.date||!Number.isFinite(gameDay))return null;const diff=Math.floor((gameDay-new Date(last.date).getTime())/86400000);return Number.isFinite(diff)?Math.max(0,diff-1):null}
 const homeRestDays=rest(hs),awayRestDays=rest(as),homeBackToBack=homeRestDays===0,awayBackToBack=awayRestDays===0
 const restAdjustment=homeRestDays===null||awayRestDays===null?0:Math.max(-2,Math.min(2,homeRestDays-awayRestDays))*0.45
 const b2bAdjustment=(homeBackToBack?-1.3:0)+(awayBackToBack?1.3:0)
 const projectedMargin=(rawHome-rawAway)*0.78+restAdjustment+b2bAdjustment
 const projectedTotal=rawHome+rawAway-(homeBackToBack?1.3:0)-(awayBackToBack?1.3:0)
 const projectedHome=(projectedTotal+projectedMargin)/2,projectedAway=(projectedTotal-projectedMargin)/2
 const sample=Math.min(hs.length,as.length),injuryCount=hi.length+ai.length
 const injuryRisk=injuries?.status!=='available'?'待確認':injuryCount>=4?'偏高':injuryCount>0?'一般':'一般'
 // Confidence is intentionally capped at medium until historical calibration is complete.
 const confidence:ModelResult['confidence']=sample>=9&&injuries?.status==='available'&&injuryCount===0&&!homeBackToBack&&!awayBackToBack?'中':'低'
 return {available:true,...empty,homeRecord:record(hs),awayRecord:record(as),homePpg:hpf,homeOppPpg:hpa,awayPpg:apf,awayOppPpg:apa,homeLast5:record(h5),awayLast5:record(a5),homeNet:net(hs),awayNet:net(as),projectedHome,projectedAway,projectedMargin,projectedTotal,homeWin:cdf(projectedMargin/12.2),awayWin:1-cdf(projectedMargin/12.2),confidence,sample,homeRestDays,awayRestDays,homeBackToBack,awayBackToBack,injuryRisk}
}
export function coverProbability(projectedMargin:number,point:number,isHome:boolean){const margin=isHome?projectedMargin:-projectedMargin;return cdf((margin+point)/11.8)}
export function totalProbability(projectedTotal:number,point:number,isOver:boolean){return isOver?cdf((projectedTotal-point)/14.2):cdf((point-projectedTotal)/14.2)}
export function americanToDecimal(price:number){return price>0?1+price/100:1+100/Math.abs(price)}
export function impliedProbability(price:number){const d=americanToDecimal(price);return 1/d}
export function expectedValue(probability:number,price:number){return probability*americanToDecimal(price)-1}
