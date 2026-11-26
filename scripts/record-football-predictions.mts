import { readFile, writeFile } from 'node:fs/promises'
import { buildFootballModel, getFootballMatches, isFinalStatus, FOOTBALL_COMPETITIONS, type FootballCompetition } from '../src/football'
import type { FootballMatch } from '../src/football'

type FootballRecord = {
  gameId:string; competition?:FootballCompetition; date:string; home:string; away:string
  homeWin:number; draw:number; awayWin:number; homeXg:number; awayXg:number
  moneylinePick:{side:'home'|'draw'|'away';probability:number}
  totalPick:{side:'over'|'under';line:number;probability:number}
  correctScores:Array<{score:string;probability:number}>
  sampleHome:number;sampleAway:number;modelVersion:string;stage:'official';analysisStatus:'final'
  lockedAt:string;publishedAt:string;capturedAt:string;source:string
  confidence:'低'|'中'|'高';dataWarnings:string[]
  actualHome?:number;actualAway?:number;settledAt?:string
  settlement?:{moneyline:'win'|'loss';total:'win'|'loss'|'push';correctScore:'win'|'loss'}
}
type Ledger={records:unknown[];footballRecords?:FootballRecord[];[key:string]:unknown}
const path='public/data/prediction-ledger.json'
const raw=await readFile(path,'utf8')
const ledger=JSON.parse(raw) as Ledger
const records:Array<FootballRecord>=Array.isArray(ledger.footballRecords)?ledger.footballRecords:[]
const now=new Date()
const twDate=(d:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)
const shift=(value:string,days:number)=>{const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
const today=twDate(now)
const tomorrow=shift(today,1)
const lockFor=(day:string)=>new Date(`${shift(day,-1)}T21:00:00+08:00`)
const dueDates=[today,...(now.getTime()>=lockFor(tomorrow).getTime()?[tomorrow]:[])]
const competitions=Object.keys(FOOTBALL_COMPETITIONS) as FootballCompetition[]
const matchMap=new Map<string,FootballMatch>()
const resultsByDate=new Map<string,Awaited<ReturnType<typeof getFootballMatches>>>()
const ledgerKey=(competition:FootballCompetition,id:string)=>`${competition}:${id}`
for(const day of dueDates){
 for(const competition of competitions){
  const result=await getFootballMatches(day,competition)
  resultsByDate.set(`${day}:${competition}`,result)
  for(const match of [...result.matches,...result.history])matchMap.set(ledgerKey(competition,match.id),match)
 }
}
let added=0,settled=0,regraded=0,skippedForDataQuality=0
const byId=new Map(records.map(record=>[ledgerKey(record.competition??'ucl',record.gameId),record]))
for(const day of dueDates){
 if(now.getTime()<lockFor(day).getTime())continue
 for(const competition of competitions){
  const result=resultsByDate.get(`${day}:${competition}`)!
  for(const match of result.matches){
   const key=ledgerKey(competition,match.id)
   if(byId.get(key)?.stage==='official')continue
   const retrospective=isFinalStatus(match.status)||new Date(match.date).getTime()<=now.getTime()
   const preKickoffHistory=result.history.filter(game=>new Date(game.date).getTime()<new Date(match.date).getTime())
   const preKickoffLeague=result.leagueHistory.filter(game=>new Date(game.date).getTime()<new Date(match.date).getTime())
   const model=buildFootballModel(match,preKickoffHistory,2.5,preKickoffLeague)
   if(!model.dataReady){skippedForDataQuality++;continue}
   const winner=[{side:'home' as const,probability:model.homeWin},{side:'draw' as const,probability:model.draw},{side:'away' as const,probability:model.awayWin}].sort((a,b)=>b.probability-a.probability)[0]
   const record:FootballRecord={
    gameId:match.id,competition,date:match.date,home:match.home.name,away:match.away.name,
    homeWin:model.homeWin,draw:model.draw,awayWin:model.awayWin,homeXg:model.homeXg,awayXg:model.awayXg,
    moneylinePick:winner,totalPick:{side:model.over>=model.under?'over':'under',line:2.5,probability:Math.max(model.over,model.under)},
    correctScores:model.topScores,sampleHome:model.sampleHome,sampleAway:model.sampleAway,homeEloRating:model.homeEloRating,awayEloRating:model.awayEloRating,eloMargin:model.eloMargin,modelVersion:'football-poisson-elo40-v3.0',
    stage:'official',analysisStatus:'final',lockedAt:lockFor(day).toISOString(),publishedAt:now.toISOString(),capturedAt:now.toISOString(),
    source:retrospective?'retrospective_backfill':'automatic_21_00_taiwan_snapshot',confidence:model.confidence,dataWarnings:retrospective?[...model.dataWarnings,'歷史補算：非賽前原始封存，使用開賽前可取得的歷史賽事資料重建。']:model.dataWarnings
   }
   byId.set(key,record);added++
  }
 }
}
for(const [key,record] of byId){
 const match=matchMap.get(key)
 if(!match||!isFinalStatus(match.status)||match.home.score===undefined||match.away.score===undefined)continue
 const home=match.home.score,away=match.away.score,total=home+away
 const winner=home>away?'home':home<away?'away':'draw'
 const correct=record.correctScores.some(item=>item.score.replace(':','-')===`${home}-${away}`)
 const line=record.totalPick.line
 const settlement:NonNullable<FootballRecord['settlement']>={
  moneyline:record.moneylinePick.side===winner?'win':'loss',
  total:total===line?'push':((record.totalPick.side==='over'&&total>line)||(record.totalPick.side==='under'&&total<line))?'win':'loss',
  correctScore:correct?'win':'loss'
 }
 const changed=record.actualHome!==home||record.actualAway!==away||JSON.stringify(record.settlement)!==JSON.stringify(settlement)
 if(changed){
  if(record.settledAt)regraded++;else settled++
  record.actualHome=home;record.actualAway=away;record.settledAt=now.toISOString();record.settlement=settlement
 }
}
const next=[...byId.values()].sort((a,b)=>b.date.localeCompare(a.date))
if(added||settled||regraded||!Array.isArray(ledger.footballRecords)){
 ledger.footballRecords=next
 ledger.footballUpdatedAt=now.toISOString()
 await writeFile(path,JSON.stringify(ledger,null,2)+'\n')
}
console.log('FOOTBALL_LEDGER:',JSON.stringify({taiwanDate:today,competitions,checkedDates:dueDates,added,settled,regraded,skippedForDataQuality,total:next.length,byCompetition:Object.fromEntries(competitions.map(c=>[c,next.filter(x=>(x.competition??'ucl')===c).length]))}))
if(added)console.log('FOOTBALL_FROZEN_PICKS:',JSON.stringify(next.filter(x=>x.publishedAt===now.toISOString()).map(x=>({competition:x.competition,gameId:x.gameId,home:x.home,away:x.away,winner:x.moneylinePick.side,total:x.totalPick.side+' '+x.totalPick.line,scores:x.correctScores.map(y=>y.score)}))))
