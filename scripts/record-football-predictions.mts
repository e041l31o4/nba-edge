import { buildFootballModel, getUclMatches, UCL_MATCH_DAYS } from '../src/football'

type FrozenRecord = {
  gameId:string; date:string; home:string; away:string
  homeWin:number; draw:number; awayWin:number; homeXg:number; awayXg:number
  moneylinePick:{side:'home'|'draw'|'away';probability:number}
  totalPick:{side:'over'|'under';line:number;probability:number}
  correctScores:Array<{score:string;probability:number}>
  sampleHome:number;sampleAway:number;stage:'official';analysisStatus:'final'
  lockedAt:string;publishedAt:string;capturedAt:string;source:string
  confidence:'低'|'中'|'高';dataWarnings:string[]
}
const base=(process.env.SUPABASE_URL??'').replace(/\/$/,'')
const key=(process.env.SUPABASE_SERVICE_ROLE_KEY??'').replace(/\s/g,'')
if(!base||!key) throw new Error('Missing Supabase service credentials; football snapshots were not written.')
const now=new Date()
const twDate=(d:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)
const shift=(value:string,days:number)=>{const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
const today=twDate(now)
const targets=[today,shift(today,1)].filter(day=>UCL_MATCH_DAYS.includes(day))
const lockFor=(day:string)=>new Date(`${shift(day,-1)}T21:00:00+08:00`)
const dueTargets=targets.filter(day=>now.getTime()>=lockFor(day).getTime())
const headers={apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'}
const read=await fetch(base+'/rest/v1/member_datasets?select=payload&dataset_key=eq.football-prediction-ledger',{headers})
if(!read.ok) throw new Error(`Cannot read football prediction ledger (HTTP ${read.status}); apply migration 202611240001 first.`)
const existingRows=await read.json() as Array<{payload?:{records?:FrozenRecord[]}}>
const records:FrozenRecord[]=Array.isArray(existingRows[0]?.payload?.records)?existingRows[0].payload!.records!:[]
const known=new Set(records.filter(x=>x.stage==='official').map(x=>x.gameId))
const additions:FrozenRecord[]=[]
for(const day of dueTargets){
  const {matches,history}=await getUclMatches(day)
  for(const match of matches){
    if(new Date(match.date).getTime()<=now.getTime()||known.has(match.id)) continue
    const model=buildFootballModel(match,history,2.5)
    const winner=[{side:'home' as const,probability:model.homeWin},{side:'draw' as const,probability:model.draw},{side:'away' as const,probability:model.awayWin}].sort((a,b)=>b.probability-a.probability)[0]
    const record:FrozenRecord={
      gameId:match.id,date:match.date,home:match.home.name,away:match.away.name,
      homeWin:model.homeWin,draw:model.draw,awayWin:model.awayWin,homeXg:model.homeXg,awayXg:model.awayXg,
      moneylinePick:winner,totalPick:{side:model.over>=model.under?'over':'under',line:2.5,probability:Math.max(model.over,model.under)},
      correctScores:model.topScores,sampleHome:model.sampleHome,sampleAway:model.sampleAway,
      stage:'official',analysisStatus:'final',lockedAt:lockFor(day).toISOString(),publishedAt:now.toISOString(),capturedAt:now.toISOString(),
      source:'automatic_21_00_taiwan_snapshot',confidence:model.confidence,dataWarnings:model.dataWarnings
    }
    additions.push(record);known.add(match.id)
  }
}
if(!additions.length){console.log('FOOTBALL_SNAPSHOT: no new UCL fixtures due for 21:00 Taiwan lock.');process.exit(0)}
const nextRecords=[...records,...additions]
const write=await fetch(base+'/rest/v1/member_datasets?on_conflict=dataset_key',{
  method:'POST',headers:{...headers,Prefer:'resolution=merge-duplicates,return=representation'},
  body:JSON.stringify({dataset_key:'football-prediction-ledger',payload:{records:nextRecords},updated_at:now.toISOString()})
})
if(!write.ok) throw new Error(`Could not save frozen football predictions (HTTP ${write.status}): ${await write.text()}`)
console.log('FOOTBALL_SNAPSHOT_SAVED:',JSON.stringify(additions.map(x=>({date:twDate(new Date(x.date)),home:x.home,away:x.away,win:x.moneylinePick.side,total:x.totalPick.side+' '+x.totalPick.line,correctScores:x.correctScores.map(s=>s.score),lockedAt:x.lockedAt}))))
