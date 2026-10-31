export type RecentGame = { date?: string; pointsFor: number; pointsAgainst: number; win: boolean; opponent?: string }
export type TeamFormRow = { teamId: string; team: string; abbreviation: string; last10: RecentGame[] }
export type TeamFormData = { updatedAt: string; source: string; teams: Record<string, TeamFormRow> }
export type InjuryRow = { team: string; player: string; status: string; detail?: string; sourceUrl?: string }
export type InjuryData = { updatedAt: string; source: string; sourceUrl: string; players: InjuryRow[]; status: string }
export type ModelResult = {
  available: boolean; reason?: string; homeRecord: string; awayRecord: string;
  homePpg: number; homeOppPpg: number; awayPpg: number; awayOppPpg: number;
  projectedHome: number; projectedAway: number; projectedMargin: number; projectedTotal: number;
  homeWin: number; awayWin: number; homeInjuries: InjuryRow[]; awayInjuries: InjuryRow[];
  confidence: '低'|'中'|'高'; sample: number; homeRestDays:number|null; awayRestDays:number|null;
}
const clamp=(n:number,min=0.01,max=0.99)=>Math.max(min,Math.min(max,n))
function cdf(z:number){const sign=z<0?-1:1,x=Math.abs(z)/Math.sqrt(2),t=1/(1+0.3275911*x);const erf=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return clamp(0.5*(1+sign*erf))}
const avg=(a:number[])=>a.reduce((s,n)=>s+n,0)/Math.max(a.length,1)
export function analyzeMatch(game:{date:string;home:{id:string;abbreviation:string};away:{id:string;abbreviation:string}},form:TeamFormData|null,injuries:InjuryData|null):ModelResult{
 const h=form?.teams?.[String(game.home.id)],a=form?.teams?.[String(game.away.id)]
 const hi=(injuries?.players??[]).filter(x=>x.team===game.home.abbreviation), ai=(injuries?.players??[]).filter(x=>x.team===game.away.abbreviation)
 const empty={homeRecord:'—',awayRecord:'—',homePpg:0,homeOppPpg:0,awayPpg:0,awayOppPpg:0,projectedHome:0,projectedAway:0,projectedMargin:0,projectedTotal:0,homeWin:0.5,awayWin:0.5,homeInjuries:hi,awayInjuries:ai,confidence:'低' as const,sample:0,homeRestDays:null,awayRestDays:null}
 if(!h?.last10?.length||!a?.last10?.length)return {...empty,available:false,reason:'尚未取得兩隊足夠的近期賽事數據，暫不產生勝率。'}
 const hs=h.last10.slice(0,10),as=a.last10.slice(0,10),hw=hs.filter(x=>x.win).length,aw=as.filter(x=>x.win).length
 const hpf=avg(hs.map(x=>x.pointsFor)),hpa=avg(hs.map(x=>x.pointsAgainst)),apf=avg(as.map(x=>x.pointsFor)),apa=avg(as.map(x=>x.pointsAgainst))
 // Blend each team's recent scoring and opponent concession; apply modest home-court edge.
 const rawHome=(hpf+apa)/2+2.2,rawAway=(apf+hpa)/2
 const gameDay=new Date(game.date).getTime(); const rest=(rows:RecentGame[])=>{const last=rows.find(x=>x.date);if(!last?.date||!Number.isFinite(gameDay))return null;const diff=Math.floor((gameDay-new Date(last.date).getTime())/86400000);return Number.isFinite(diff)?Math.max(0,diff-1):null}; const homeRestDays=rest(hs),awayRestDays=rest(as); const restAdjustment=homeRestDays===null||awayRestDays===null?0:Math.max(-2,Math.min(2,homeRestDays-awayRestDays))*0.45; const projectedMargin=(rawHome-rawAway)*0.78+restAdjustment
 const projectedTotal=rawHome+rawAway
 const projectedHome=(projectedTotal+projectedMargin)/2,projectedAway=(projectedTotal-projectedMargin)/2
 const sample=Math.min(hs.length,as.length)
 const confidence:ModelResult['confidence']=sample>=9&&injuries?.status==='available'&&hi.length+ai.length===0?'中':'低'
 return {available:true,...empty,homeRecord:`${hw}-${hs.length-hw}`,awayRecord:`${aw}-${as.length-aw}`,homePpg:hpf,homeOppPpg:hpa,awayPpg:apf,awayOppPpg:apa,projectedHome,projectedAway,projectedMargin,projectedTotal,homeWin:cdf(projectedMargin/12.2),awayWin:1-cdf(projectedMargin/12.2),confidence,sample,homeRestDays,awayRestDays}
}
export function coverProbability(projectedMargin:number,point:number,isHome:boolean){const margin=isHome?projectedMargin:-projectedMargin;return cdf((margin+point)/11.8)}
export function totalProbability(projectedTotal:number,point:number,isOver:boolean){return isOver?cdf((projectedTotal-point)/14.2):cdf((point-projectedTotal)/14.2)}
export function americanToDecimal(price:number){return price>0?1+price/100:1+100/Math.abs(price)}
export function impliedProbability(price:number){const d=americanToDecimal(price);return 1/d}
export function expectedValue(probability:number,price:number){return probability*americanToDecimal(price)-1}
