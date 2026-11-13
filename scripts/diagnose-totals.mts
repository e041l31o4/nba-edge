import { readFile } from 'node:fs/promises'
import { analyzeMatch, totalProbability, decimalExpectedValue, type TeamFormData, type InjuryData, type TeamMetricsData, type ProbabilityCalibrator } from '../src/model'

const read = async <T>(p:string):Promise<T> => JSON.parse(await readFile(p,'utf8')) as T
const [form,injuries,metrics,backtest,odds] = await Promise.all([
  read<TeamFormData>('public/data/team-form.json'),
  read<InjuryData>('public/data/injuries.json'),
  read<TeamMetricsData>('public/data/team-metrics.json'),
  read<{seasonResults?:{calibrator?:ProbabilityCalibrator|null}[]}>('public/data/backtest.json'),
  read<any>('public/data/odds.json')
])
const calibrator=backtest.seasonResults?.slice().reverse().find(x=>x.calibrator)?.calibrator??null
const date='20261113'
const res=await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`)
if(!res.ok) throw new Error(`ESPN scoreboard HTTP ${res.status}`)
const board=await res.json() as any
const games=(board.events??[]).map((e:any)=>{
 const c=e.competitions?.[0], teams=c?.competitors??[], h=teams.find((x:any)=>x.homeAway==='home'), a=teams.find((x:any)=>x.homeAway==='away')
 return {id:String(e.id),date:e.date,home:{id:String(h?.team?.id??''),name:h?.team?.name,abbreviation:h?.team?.abbreviation},away:{id:String(a?.team?.id??''),name:a?.team?.name,abbreviation:a?.team?.abbreviation}}
})
const output=[]
for(const game of games){
 const report=analyzeMatch(game,form,injuries,calibrator,metrics)
 const market=odds.games?.find((g:any)=>g.home_team.toLowerCase()===game.home.name.toLowerCase()&&g.away_team.toLowerCase()===game.away.name.toLowerCase())
 const pairs=(market?.bookmakers??[]).flatMap((book:any)=>{
  const rows=book.markets?.filter((m:any)=>m.key==='totals').flatMap((m:any)=>m.outcomes.map((o:any)=>({...o,book:book.title})))??[]
  const grouped=new Map<string,any[]>()
  for(const x of rows){if(typeof x.point!=='number'||!(x.price>1))continue;const k=String(x.point);grouped.set(k,[...(grouped.get(k)??[]),x])}
  return [...grouped.entries()].flatMap(([line,pair])=>{
   const over=pair.find(x=>/over|大/i.test(x.name)),under=pair.find(x=>/under|小/i.test(x.name))
   if(!over||!under)return []
   return [over,under].map(x=>{const isOver=x===over;const p=totalProbability(report.projectedTotal,Number(line),isOver,report.totalStdDev);return {book:book.title,line:Number(line),side:isOver?'大':'小',price:x.price,probability:p,ev:decimalExpectedValue(p,x.price)}})
  })
 })
 const sorted=pairs.sort((a:any,b:any)=>b.ev-a.ev||b.probability-a.probability)
 const homeForm=form.teams[game.home.id],awayForm=form.teams[game.away.id]
 output.push({
  matchup:`${game.away.abbreviation}@${game.home.abbreviation}`,available:report.available,confidence:report.confidence,injuryRisk:report.injuryRisk,
  homeLast10:{n:homeForm?.last10?.length,ppg:report.homePpg,opp:report.homeOppPpg,record:report.homeRecord},
  awayLast10:{n:awayForm?.last10?.length,ppg:report.awayPpg,opp:report.awayOppPpg,record:report.awayRecord},
  predictedScore:{away:Number(report.projectedAway.toFixed(1)),home:Number(report.projectedHome.toFixed(1))},
  projectedTotal:Number(report.projectedTotal.toFixed(2)),lineAndPicks:sorted.map((x:any)=>({...x,probability:Number((x.probability*100).toFixed(1)),ev:Number((x.ev*100).toFixed(1))})),
  selected:sorted[0]?{side:sorted[0].side,line:sorted[0].line,book:sorted[0].book,probability:Number((sorted[0].probability*100).toFixed(1)),ev:Number((sorted[0].ev*100).toFixed(1))}:null,
  totalTrend:report.totalTrend===null?null:Number(report.totalTrend.toFixed(2)),stdDev:Number(report.totalStdDev.toFixed(2)),paceAdj:Number(report.paceAdjustment.toFixed(2)),
  injuryImpact:{
   home:Number(report.homeInjuryImpact.toFixed(2)),away:Number(report.awayInjuryImpact.toFixed(2)),
   homePlayers:(injuries.players??[]).filter((x:any)=>x.team===game.home.abbreviation).map((x:any)=>({player:x.player,status:x.status,ppg:x.pointsPerGame??null,mpg:x.minutesPerGame??null,athleteId:x.athleteId??null})),
   awayPlayers:(injuries.players??[]).filter((x:any)=>x.team===game.away.abbreviation).map((x:any)=>({player:x.player,status:x.status,ppg:x.pointsPerGame??null,mpg:x.minutesPerGame??null,athleteId:x.athleteId??null}))
  }
 })
}
console.log('NBA_EDGE_TOTALS_DIAGNOSTIC '+JSON.stringify({date:'2026-11-14 Taiwan',oddsSource:odds.source,formUpdatedAt:form.updatedAt,injuriesUpdatedAt:injuries.updatedAt,injurySource:injuries.source,teamMetricsUpdatedAt:metrics.updatedAt,teamMetricsWithValidPace:Object.values(metrics.teams??{}).filter((x:any)=>!x.stale&&typeof x.pace==='number'&&x.pace>=80&&x.pace<=110).length,games:output},null,2))
