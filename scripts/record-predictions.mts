import { readFile, writeFile } from 'node:fs/promises'
import { analyzeMatch, type TeamFormData, type InjuryData, type ProbabilityCalibrator } from '../src/model'

type Row = { gameId:string; date:string; home:string; away:string; homeWin:number; awayWin:number; projectedMargin:number; projectedTotal:number; capturedAt:string; actualHome?:number; actualAway?:number; settledAt?:string }
const base = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const readJson = async <T>(path:string):Promise<T|null> => { try { return JSON.parse(await readFile(path,'utf8')) as T } catch { return null } }
const now = new Date()
const tw = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
const twNoDash = tw.replace(/-/g,'')
const twDate = new Date(tw+'T12:00:00+08:00')
twDate.setDate(twDate.getDate()-1)
const espnDate = twDate.toISOString().slice(0,10).replace(/-/g,'')
const priorDate = new Date(twDate.getTime()-86400000).toISOString().slice(0,10).replace(/-/g,'')
const [form, injuries, backtest, previousPayload, scoreboardRes] = await Promise.all([
  readJson<TeamFormData>('public/data/team-form.json'),
  readJson<InjuryData>('public/data/injuries.json'),
  readJson<{seasonResults?:{calibrator?:ProbabilityCalibrator|null}[]}>('public/data/backtest.json'),
  readJson<{records:Row[]}>('public/data/prediction-ledger.json'),
  Promise.all([fetch(`${base}/scoreboard?dates=${espnDate}`),fetch(`${base}/scoreboard?dates=${priorDate}`)])
])
if (!form || scoreboardRes.some(r=>!r.ok)) throw new Error('Missing team-form data or ESPN scoreboard unavailable; keep existing ledger unchanged.')
const scoreboards = await Promise.all(scoreboardRes.map(r=>r.json())) as any[]
const calibrator = backtest?.seasonResults?.slice().reverse().find(x=>x.calibrator)?.calibrator ?? null
const rows:Row[] = Array.isArray(previousPayload?.records) ? previousPayload.records : []
const byId = new Map(rows.map(x=>[x.gameId,x]))
let added=0, settled=0
for (const event of scoreboards.flatMap(s=>s.events ?? [])) {
  const comp=event.competitions?.[0], competitors=comp?.competitors ?? []
  const h=competitors.find((x:any)=>x.homeAway==='home'), a=competitors.find((x:any)=>x.homeAway==='away')
  if (!h || !a || !event.id) continue
  const id=String(event.id), existing=byId.get(id)
  const status=String(event.status?.type?.name ?? '').toLowerCase()
  if (existing) {
    if (!existing.settledAt && status.includes('final')) {
      const hs=Number(h.score), as=Number(a.score)
      if (Number.isFinite(hs)&&Number.isFinite(as)) {
        existing.actualHome=hs; existing.actualAway=as; existing.settledAt=now.toISOString(); settled++
      }
    }
    continue
  }
  const tipoff=new Date(event.date).getTime()
  if (!Number.isFinite(tipoff)||tipoff<=now.getTime()||status.includes('final')) continue
  const game={date:event.date,home:{id:String(h.team?.id??''),abbreviation:String(h.team?.abbreviation??'—')},away:{id:String(a.team?.id??''),abbreviation:String(a.team?.abbreviation??'—')}}
  const prediction=analyzeMatch(game,form,injuries,calibrator)
  if (!prediction.available) continue
  const row:Row={gameId:id,date:event.date,home:game.home.abbreviation,away:game.away.abbreviation,homeWin:prediction.homeWin,awayWin:prediction.awayWin,projectedMargin:prediction.projectedMargin,projectedTotal:prediction.projectedTotal,capturedAt:now.toISOString()}
  rows.push(row); byId.set(id,row); added++
}
const output=rows.slice(-1500)
await writeFile('public/data/prediction-ledger.json',JSON.stringify({updatedAt:now.toISOString(),source:'NBA EDGE pregame model + ESPN final scores',records:output},null,2)+'\n')
console.log(`Taiwan date ${twNoDash}; ESPN date ${espnDate}; captured ${added}; settled ${settled}; total ${output.length}`)
