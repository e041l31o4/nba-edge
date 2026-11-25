import { readFile, writeFile } from 'node:fs/promises'
import { buildFootballModel, getUclMatches, isFinalStatus } from '../src/football'
import type { FootballMatch } from '../src/football'

type FootballRecord = {
  gameId:string; date:string; home:string; away:string
  homeWin:number; draw:number; awayWin:number; homeXg:number; awayXg:number
  moneylinePick:{side:'home'|'draw'|'away';probability:number}
  totalPick:{side:'over'|'under';line:number;probability:number}
  correctScores:Array<{score:string;probability:number}>
  sampleHome:number;sampleAway:number;stage:'official';analysisStatus:'final'
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
const matchMap=new Map<string,FootballMatch>()
const resultsByDate=new Map<string,Awaited<ReturnType<typeof getUclMatches>>>()
for(const day of dueDates){
  const result=await getUclMatches(day)
  resultsByDate.set(day,result)
  for(const match of [...result.matches,...result.history])matchMap.set(match.id,match)
}
let added=0,settled=0,regraded=0
const byId=new Map(records.map(record=>[record.gameId,record]))
for(const day of dueDates){
  if(now.getTime()<lockFor(day).getTime())continue
  const result=resultsByDate.get(day)!
  for(const match of result.matches){
    if(byId.get(match.id)?.stage==='official')continue
    // For already-finished fixtures missing a frozen record, reconstruct a clearly-labelled
    // retrospective baseline using only matches completed before this kickoff.
    const retrospective=isFinalStatus(match.status)||new Date(match.date).getTime()<=now.getTime()
    const preKickoffHistory=result.history.filter(game=>new Date(game.date).getTime()<new Date(match.date).getTime())
    const model=buildFootballModel(match,preKickoffHistory,2.5)
    const winner=[{side:'home' as const,probability:model.homeWin},{side:'draw' as const,probability:model.draw},{side:'away' as const,probability:model.awayWin}].sort((a,b)=>b.probability-a.probability)[0]
    const record:FootballRecord={
      gameId:match.id,date:match.date,home:match.home.name,away:match.away.name,
      homeWin:model.homeWin,draw:model.draw,awayWin:model.awayWin,homeXg:model.homeXg,awayXg:model.awayXg,
      moneylinePick:winner,totalPick:{side:model.over>=model.under?'over':'under',line:2.5,probability:Math.max(model.over,model.under)},
      correctScores:model.topScores,sampleHome:model.sampleHome,sampleAway:model.sampleAway,
      stage:'official',analysisStatus:'final',lockedAt:lockFor(day).toISOString(),publishedAt:now.toISOString(),capturedAt:now.toISOString(),
      source:retrospective?'retrospective_backfill':'automatic_21_00_taiwan_snapshot',confidence:model.confidence,dataWarnings:retrospective?[...model.dataWarnings,'歷史補算：非賽前原始封存，使用開賽前可取得的歷史賽事資料重建。']:model.dataWarnings
    }
    byId.set(match.id,record);added++
  }
}
for(const record of byId.values()){
  const match=matchMap.get(record.gameId)
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
console.log('FOOTBALL_LEDGER:',JSON.stringify({taiwanDate:today,checkedDates:dueDates,added,settled,regraded,total:next.length,finalToday:next.filter(x=>twDate(new Date(x.date))===today&&x.settledAt).length}))
if(added)console.log('FOOTBALL_FROZEN_PICKS:',JSON.stringify(next.filter(x=>x.publishedAt===now.toISOString()).map(x=>({gameId:x.gameId,home:x.home,away:x.away,winner:x.moneylinePick.side,total:x.totalPick.side+' '+x.totalPick.line,scores:x.correctScores.map(y=>y.score)}))))
