import { useEffect, useState } from 'react'
import type { InjuryRow } from './model'

type PlayerAverages={points?:string;minutes?:string;rebounds?:string;assists?:string;steals?:string;blocks?:string;turnovers?:string;usage?:string;games?:string}
export default function PlayerInjuryRow({player}:{player:InjuryRow}){
 const [averages,setAverages]=useState<PlayerAverages|null>(()=>player.pointsPerGame!==undefined?{points:String(player.pointsPerGame),minutes:player.minutesPerGame!==undefined?String(player.minutesPerGame):undefined,rebounds:player.reboundsPerGame!==undefined?String(player.reboundsPerGame):undefined,assists:player.assistsPerGame!==undefined?String(player.assistsPerGame):undefined,steals:player.stealsPerGame!==undefined?String(player.stealsPerGame):undefined,blocks:player.blocksPerGame!==undefined?String(player.blocksPerGame):undefined,turnovers:player.turnoversPerGame!==undefined?String(player.turnoversPerGame):undefined,usage:player.usageRate!==undefined?String(player.usageRate):undefined,games:player.gamesPlayed!==undefined?String(player.gamesPlayed):undefined}:null)
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
    const next={points:pick(/^PTS$|avgPoints|pointsPerGame/i),minutes:pick(/^MIN$|avgMinutes|minutesPerGame/i),rebounds:pick(/^REB$|^TRB$|avgRebounds|reboundsPerGame/i),assists:pick(/^AST$|avgAssists|assistsPerGame/i),steals:pick(/^STL$|avgSteals|stealsPerGame/i),blocks:pick(/^BLK$|avgBlocks|blocksPerGame/i),turnovers:pick(/^TO$|^TOV$|avgTurnovers|turnoversPerGame/i),usage:pick(/^USG%?$|usageRate|usage/i),games:pick(/^GP$|gamesPlayed/i)}
    if(active&&Object.values(next).some(Boolean))setAverages(previous=>({...previous,...Object.fromEntries(Object.entries(next).filter(([,value])=>Boolean(value)))}))
   })
   .catch(()=>{/* Keep the scheduled data-feed averages when the live overview endpoint is unavailable. */})
   .finally(()=>{if(active)setLoading(false)})
  return()=>{active=false}
 },[player.athleteId])
 return <div className="injury-row"><div><strong>{player.player}{player.position&&<small className="injury-position">{player.position}</small>}</strong>{player.detail&&<small>{player.detail}</small>}<small className="injury-averages">{averages?[`場均 ${averages.points??'—'} 分`,averages.minutes?`${averages.minutes} 分鐘`:null,averages.rebounds?`${averages.rebounds} 籃板`:null,averages.assists?`${averages.assists} 助攻`:null,averages.steals?`${averages.steals} 抄截`:null,averages.blocks?`${averages.blocks} 阻攻`:null,averages.turnovers?`${averages.turnovers} 失誤`:null,averages.usage?`USG ${averages.usage}%`:null,averages.games?`${averages.games} 場`:null].filter(Boolean).join(' · '):loading?'球員數據讀取中':'球員場均資料暫不可用'}</small></div><span>{player.status}</span></div>
}
