import { useEffect, useState } from 'react'
import type { InjuryRow } from './model'

type PlayerAverages={points?:string;minutes?:string;rebounds?:string;assists?:string}
export default function PlayerInjuryRow({player}:{player:InjuryRow}){
 const [averages,setAverages]=useState<PlayerAverages|null>(()=>player.pointsPerGame!==undefined?{points:String(player.pointsPerGame),minutes:player.minutesPerGame!==undefined?String(player.minutesPerGame):undefined}:null)
 const [loading,setLoading]=useState(false)
 useEffect(()=>{
  if(!player.athleteId)return
  let active=true
  setLoading(true)
  fetch(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${player.athleteId}/overview`)
   .then(r=>r.ok?r.json():Promise.reject(new Error('stats unavailable')))
   .then(data=>{
    const stats=data.statistics??data.stats??{}
    const labels:string[]=stats.labels??stats.names??[]
    const values:(string|number)[]=stats.displayValues??stats.values??[]
    const pick=(pattern:RegExp)=>{const index=labels.findIndex(x=>pattern.test(x));return index>=0&&values[index]!==undefined?String(values[index]):undefined}
    const next={points:pick(/PTS|avgPoints|points/i),minutes:pick(/MIN|avgMinutes|minutes/i),rebounds:pick(/REB|avgRebounds|rebounds/i),assists:pick(/AST|avgAssists|assists/i)}
    if(active&&Object.values(next).some(Boolean))setAverages(next)
   })
   .catch(()=>{/* Keep the scheduled data-feed averages when the live overview endpoint is unavailable. */})
   .finally(()=>{if(active)setLoading(false)})
  return()=>{active=false}
 },[player.athleteId])
 return <div className="injury-row"><div><strong>{player.player}{player.position&&<small className="injury-position">{player.position}</small>}</strong>{player.detail&&<small>{player.detail}</small>}<small className="injury-averages">{averages?[`場均 ${averages.points??'—'} 分`,averages.minutes?`${averages.minutes} 分鐘`:null,averages.rebounds?`${averages.rebounds} 籃板`:null,averages.assists?`${averages.assists} 助攻`:null].filter(Boolean).join(' · '):loading?'球員數據讀取中':'球員場均資料暫不可用'}</small></div><span>{player.status}</span></div>
}
