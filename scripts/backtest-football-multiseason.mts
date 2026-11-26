import {
  FOOTBALL_COMPETITIONS,
  buildFootballModel,
  getFootballDomesticLeagueIds,
  getFootballHistoricalMatches,
  getFootballLeagueHistory,
  isFinalStatus,
  type FootballCompetition,
  type FootballMatch
} from '../src/football'

const years = [2023, 2024, 2025, 2026]
const mean = (values:number[]) => values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null
const unique = (games:FootballMatch[]) => [...new Map(games.map(game=>[game.id,game])).values()]
const reports:Record<string,unknown>[]=[]
let domesticPool:FootballMatch[]|null=null

async function loadDomesticPool(){
  if(domesticPool)return domesticPool
  const ids=getFootballDomesticLeagueIds()
  const loaded:FootballMatch[]=[]
  for(let i=0;i<ids.length;i+=8){
    const batch=ids.slice(i,i+8)
    const results=await Promise.allSettled(batch.map(id=>getFootballLeagueHistory(id,years)))
    for(const result of results)if(result.status==='fulfilled')loaded.push(...result.value)
  }
  domesticPool=unique(loaded).filter(game=>isFinalStatus(game.status))
  return domesticPool
}

for(const competition of Object.keys(FOOTBALL_COMPETITIONS) as FootballCompetition[]){
  const leagueHistory=unique(await getFootballHistoricalMatches(competition,years)).filter(game=>
    isFinalStatus(game.status)&&Number.isFinite(game.home.score)&&Number.isFinite(game.away.score)
  )
  const domestic=FOOTBALL_COMPETITIONS[competition].kind==='cup'?await loadDomesticPool():[]
  const allHistory=unique([...leagueHistory,...domestic])
  const ordered=[...leagueHistory].sort((a,b)=>new Date(a.date).getTime()-new Date(b.date).getTime())
  const eloRatings=new Map<string,number>()
  let currentSeasonKey=''
  const eloBlendWeight=0.4
  const rows:Array<{
    year:number;homeWin:number;draw:number;awayWin:number;over:number;
    eloHomeWin:number;eloDraw:number;eloAwayWin:number;
    actualHome:number;actualAway:number;homeXg:number;awayXg:number;
    baselineHome:number;baselineDraw:number;baselineAway:number;baselineOver:number;
    top3Hit:boolean;sampleHome:number;sampleAway:number
  }>=[]
  let skipped=0
  for(const game of ordered){
    const kickoff=new Date(game.date).getTime()
    const date=new Date(game.date)
    const seasonKey=String(date.getUTCFullYear()-(date.getUTCMonth()<7?1:0))
    if(currentSeasonKey&&seasonKey!==currentSeasonKey){for(const [id,rating] of eloRatings)eloRatings.set(id,1500+(rating-1500)*0.75)}
    currentSeasonKey=seasonKey
    const priorLeague=leagueHistory.filter(row=>new Date(row.date).getTime()<kickoff)
    const priorHistory=allHistory.filter(row=>new Date(row.date).getTime()<kickoff)
    const model=buildFootballModel(game,priorHistory,2.5,priorLeague)
    const home=Number(game.home.score),away=Number(game.away.score)
    const homeElo=eloRatings.get(game.home.id)??1500,awayElo=eloRatings.get(game.away.id)??1500
    const expectedHome=1/(1+10**(-((homeElo+65)-awayElo)/400))
    const priorDraws=priorLeague.filter(row=>Number(row.home.score)===Number(row.away.score)).length
    const eloDraw=(priorDraws+1)/(priorLeague.length+3)
    const eloHomeWin=(1-eloDraw)*expectedHome,eloAwayWin=(1-eloDraw)*(1-expectedHome)
    const blendedHome=(1-eloBlendWeight)*model.homeWin+eloBlendWeight*eloHomeWin
    const blendedDraw=(1-eloBlendWeight)*model.draw+eloBlendWeight*eloDraw
    const blendedAway=(1-eloBlendWeight)*model.awayWin+eloBlendWeight*eloAwayWin
    const blendSum=blendedHome+blendedDraw+blendedAway
    const eloBlendHomeWin=blendedHome/blendSum,eloBlendDraw=blendedDraw/blendSum,eloBlendAwayWin=blendedAway/blendSum
    const h=priorLeague.filter(row=>Number(row.home.score)>Number(row.away.score)).length
    const d=priorLeague.filter(row=>Number(row.home.score)===Number(row.away.score)).length
    const a=priorLeague.filter(row=>Number(row.home.score)<Number(row.away.score)).length
    const o=priorLeague.filter(row=>Number(row.home.score)+Number(row.away.score)>2.5).length
    const n=priorLeague.length
    if(!model.dataReady)skipped++
    else rows.push({
      year:new Date(game.date).getUTCFullYear(),
      homeWin:model.poissonHomeWin,draw:model.poissonDraw,awayWin:model.poissonAwayWin,over:model.over,
      eloHomeWin:model.homeWin,eloDraw:model.draw,eloAwayWin:model.awayWin,
      actualHome:home,actualAway:away,homeXg:model.homeXg,awayXg:model.awayXg,
      baselineHome:(h+1)/(n+3),baselineDraw:(d+1)/(n+3),baselineAway:(a+1)/(n+3),baselineOver:(o+1)/(n+2),
      top3Hit:model.topScores.some(item=>item.score===`${home}:${away}`),
      sampleHome:model.sampleHome,sampleAway:model.sampleAway
    })
    const actualEloHome=home>away?1:home===away?0.5:0
    const margin=Math.abs(home-away)
    const mov=margin?Math.log(margin+1)*(2.2/(2.2+0.001*Math.abs(homeElo-awayElo))):1
    const delta=20*mov*(actualEloHome-expectedHome)
    eloRatings.set(game.home.id,homeElo+delta)
    eloRatings.set(game.away.id,awayElo-delta)
  }
  const brier1=(r:typeof rows[number],baseline=false)=>{
    const ph=baseline?r.baselineHome:r.homeWin,pd=baseline?r.baselineDraw:r.draw,pa=baseline?r.baselineAway:r.awayWin
    return (ph-(r.actualHome>r.actualAway?1:0))**2+(pd-(r.actualHome===r.actualAway?1:0))**2+(pa-(r.actualHome<r.actualAway?1:0))**2
  }
  const brierEloBlend=(r:typeof rows[number])=>(r.eloHomeWin-(r.actualHome>r.actualAway?1:0))**2+(r.eloDraw-(r.actualHome===r.actualAway?1:0))**2+(r.eloAwayWin-(r.actualHome<r.actualAway?1:0))**2
  const brierOver=(r:typeof rows[number],baseline=false)=>{
    const p=baseline?r.baselineOver:r.over
    return (p-(r.actualHome+r.actualAway>2.5?1:0))**2
  }
  const seasonBreakdown=years.map(year=>{
    const subset=rows.filter(row=>row.year===year)
    const modelBrier=mean(subset.map(row=>brier1(row)))
    const baselineBrier=mean(subset.map(row=>brier1(row,true)))
    const modelOver=mean(subset.map(row=>brierOver(row)))
    const baselineOver=mean(subset.map(row=>brierOver(row,true)))
    return {year,readyPredictions:subset.length,oneX2Brier:modelBrier,leagueBaselineBrier:baselineBrier,oneX2Skill:modelBrier!==null&&baselineBrier?Number((1-modelBrier/baselineBrier).toFixed(4)):null,over25Brier:modelOver,leagueBaselineOver25Brier:baselineOver}
  })
  const modelBrier=mean(rows.map(row=>brier1(row)))
  const eloBlendBrier=mean(rows.map(row=>brierEloBlend(row)))
  const modelAccuracy=rows.length?rows.filter(row=>{const probs=[row.homeWin,row.draw,row.awayWin],pick=probs.indexOf(Math.max(...probs));const actual=row.actualHome>row.actualAway?0:row.actualHome===row.actualAway?1:2;return pick===actual}).length/rows.length:null
  const eloBlendAccuracy=rows.length?rows.filter(row=>{const probs=[row.eloHomeWin,row.eloDraw,row.eloAwayWin],pick=probs.indexOf(Math.max(...probs));const actual=row.actualHome>row.actualAway?0:row.actualHome===row.actualAway?1:2;return pick===actual}).length/rows.length:null
  const baselineBrier=mean(rows.map(row=>brier1(row,true)))
  const modelOver=mean(rows.map(row=>brierOver(row)))
  const baselineOver=mean(rows.map(row=>brierOver(row,true)))
  reports.push({
    competition,label:FOOTBALL_COMPETITIONS[competition].short,years,
    completedLeagueMatches:leagueHistory.length,
    domesticHistoryMatches:domestic.length,
    readyPredictions:rows.length,skippedForDataQuality:skipped,
    readyCoverage:leagueHistory.length?Number((rows.length/leagueHistory.length).toFixed(3)):null,
    oneX2Brier:modelBrier,leagueBaselineOneX2Brier:baselineBrier,
    eloBlendOneX2Brier:eloBlendBrier,eloBlendOneX2BrierSkill:eloBlendBrier!==null&&baselineBrier?Number((1-eloBlendBrier/baselineBrier).toFixed(4)):null,
    currentModelWinnerAccuracy:modelAccuracy,eloBlendWinnerAccuracy:eloBlendAccuracy,
    oneX2BrierSkill:modelBrier!==null&&baselineBrier?Number((1-modelBrier/baselineBrier).toFixed(4)):null,
    over25Brier:modelOver,leagueBaselineOver25Brier:baselineOver,
    over25BrierSkill:modelOver!==null&&baselineOver?Number((1-modelOver/baselineOver).toFixed(4)):null,
    correctScoreTop3HitRate:rows.length?Number((rows.filter(row=>row.top3Hit).length/rows.length).toFixed(4)):null,
    expectedGoalsMAE:mean(rows.map(row=>Math.abs(row.homeXg+row.awayXg-row.actualHome-row.actualAway))),
    averageTeamSamples:{home:mean(rows.map(row=>row.sampleHome)),away:mean(rows.map(row=>row.sampleAway))},
    seasonBreakdown
  })
}

console.log('SPORT_EDGE_FOOTBALL_MULTISEASON_WALK_FORWARD:',JSON.stringify({
  years,
  model:'Current score-based Poisson model, chronological walk-forward by match; cup form augmented with supported domestic league score histories',
  evaluation:'Per-competition 1X2 Brier and Over 2.5 Brier compared against expanding historical league-rate baseline; exact-score top-3 hit rate and expected-goals MAE',
  limitations:[
    'Score-only inputs: no true xG, lineups, suspensions, injuries, or bookmaker closing odds.',
    'Cup domestic histories are limited to domestic leagues exposed by ESPN and mapped club names.',
    'This validates forecast quality, not positive betting ROI.'
  ],
  competitions:reports
},null,2))
if(reports.filter(row=>Number(row.readyPredictions)>=100).length<3)throw new Error('Multi-season audit did not reach 100 ready predictions in at least three competitions.')
