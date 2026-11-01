import { useEffect, useMemo, useState } from 'react'
import { Activity, CalendarDays, ChevronLeft, ChevronRight, CircleAlert, RefreshCw, ShieldCheck, Target, TrendingUp, Trophy } from 'lucide-react'
import { dateLabel, getOdds, getScoreboard, marketFor, taiwanDate, type Game, type OddsRecord } from './lib'
import ParlayLab from './ParlayLab'
import MatchAnalysis from './MatchAnalysis'
import { analyzeMatch, type TeamFormData, type InjuryData, type RosterData, type TeamMetricsData, type ProbabilityCalibrator } from './model'
import { getPredictionRecords, summarizePredictions, type PredictionRecord } from './predictionLedger'

type Tab = 'games' | 'analysis' | 'performance' | 'parlay'
type BacktestData = { updatedAt: string; season?: string; seasons?: string[]; method?: string; sampleSize: number; metrics: { winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number }; seasonResults?: { season: string; completedGames: number; metrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number }; calibrationTrainingSamples?: number; calibrator?: { a: number; b: number; trainingSamples: number } | null; calibratedMetrics?: { sampleSize: number; winnerAccuracy: number; brierScore: number; logLoss: number } | null }[]; calibration?: { range: string; sampleSize: number; predictedHomeWin: number; actualHomeWin: number }[]; calibrationEvaluation?: { method: string; trainingPolicy: string; sampleSize: number; rawMetrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; logLoss: number } | null; calibratedMetrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; logLoss: number } | null; improvedBrier: boolean | null }; limitations: string[] }
function App() {
  const [date, setDate] = useState(taiwanDate())
  const [games, setGames] = useState<Game[]>([])
  const [odds, setOdds] = useState<OddsRecord | null>(null)
  const [teamForm, setTeamForm] = useState<TeamFormData | null>(null)
  const [injuryData, setInjuryData] = useState<InjuryData | null>(null)
  const [rosterData, setRosterData] = useState<RosterData | null>(null)
  const [teamMetrics, setTeamMetrics] = useState<TeamMetricsData | null>(null)
  const [tab, setTab] = useState<Tab>('games')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [predictionRecords, setPredictionRecords] = useState<PredictionRecord[]>([])
  const [backtest, setBacktest] = useState<BacktestData | null>(null)
  const load = async () => {
    setLoading(true); setError('')
    try { const [g, o, tf, inj, roster, metrics, bt] = await Promise.all([getScoreboard(date), getOdds(), fetch(`${import.meta.env.BASE_URL}data/team-form.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null), fetch(`${import.meta.env.BASE_URL}data/injuries.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null), fetch(`${import.meta.env.BASE_URL}data/rosters.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null), fetch(`${import.meta.env.BASE_URL}data/team-metrics.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null), fetch(`${import.meta.env.BASE_URL}data/backtest.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null)]); setGames(g); setOdds(o); setTeamForm(tf); setInjuryData(inj); setRosterData(roster); setTeamMetrics(metrics); setBacktest(bt); setUpdated(new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })) }
    catch (e) { setError(e instanceof Error ? e.message : '讀取失敗') }
    finally { setLoading(false) }
  }
  const probabilityCalibrator: ProbabilityCalibrator | null = backtest?.seasonResults?.slice().reverse().find(row => row.calibrator)?.calibrator ?? null
  useEffect(() => { void load() }, [date])
  useEffect(() => {
    let active = true
    void getPredictionRecords().then(records => { if (active) setPredictionRecords(records) })
    return () => { active = false }
  }, [games, date])
  const predictionStats = summarizePredictions(predictionRecords)
  const upcoming = useMemo(() => games.filter(g => !g.status.toLowerCase().includes('final')), [games])
  const completed = games.filter(g => g.status.toLowerCase().includes('final'))
  const moveDate = (delta: number) => { const d = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00'); d.setDate(d.getDate()+delta); setDate(taiwanDate(d)) }
  const active = games.find(g => g.id === selected)
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">E</span><span>NBA <b>EDGE</b><small>DATA · MATCHUP · INSIGHT</small></span></a><div className="top-right"><span className="live-dot"/> <span>台灣時間 UTC+8</span><button className="icon-btn" onClick={() => void load()} aria-label="重新整理"><RefreshCw size={16}/></button></div></header>
    <main>
      <section className="hero"><div><div className="eyebrow"><span/> NBA ANALYTICS PLATFORM</div><h1>看懂數據，<em>掌握比賽節奏。</em></h1><p>以賽程、球隊表現、盤口與賽前資訊，建立可追蹤、可驗證的 NBA 分析。</p></div><div className="hero-stat"><span>今日賽事</span><strong>{loading ? '—' : games.length.toString().padStart(2,'0')}</strong><small>GAMES SCHEDULED</small></div></section>
      <section className="ticker"><div className="ticker-label"><Activity size={15}/> DATA STATUS</div><span className="status-ok"><i/> 賽程來源連線</span><span className={odds ? 'status-ok' : 'status-warn'}><i/> {odds ? '盤口資料已載入' : '官方盤口來源未接通'}</span><span className="ticker-time">最後更新 {updated || '—'}</span></section>
      <section className="toolbar"><div className="date-nav"><button className="icon-btn" onClick={() => moveDate(-1)}><ChevronLeft size={18}/></button><div><CalendarDays size={17}/><b>{date.slice(0,4)}/{date.slice(4,6)}/{date.slice(6,8)}</b><small>{dateLabel(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00')}</small></div><button className="icon-btn" onClick={() => moveDate(1)}><ChevronRight size={18}/></button><button className="today-btn" onClick={() => setDate(taiwanDate())}>今天</button></div><div className="tabs"><button className={tab==='games'?'active':''} onClick={()=>setTab('games')}>賽事總覽</button><button className={tab==='analysis'?'active':''} onClick={()=>setTab('analysis')}>賽前分析</button><button className={tab==='performance'?'active':''} onClick={()=>setTab('performance')}>模型績效</button><button className={tab==='parlay'?'active':''} onClick={()=>setTab('parlay')}>串關研究</button></div></section>
      {error && <div className="notice error"><CircleAlert size={17}/>{error}</div>}
      {tab==='games' && <><section className="section-heading"><div><span className="eyebrow">MATCH CENTER</span><h2>賽事總覽 <small>{date.slice(4,6)}/{date.slice(6,8)}</small></h2></div><div className="legend"><span><i className="green"/>進行中／未開賽</span><span><i className="gray"/>已完賽</span></div></section>
        {loading ? <div className="empty"><RefreshCw className="spin" size={22}/>正在同步 NBA 賽程…</div> : games.length===0 ? <div className="empty"><CalendarDays size={25}/><b>當日沒有賽事</b><span>可切換日期查看其他比賽。</span></div> : <div className="game-grid">{games.map(g => <GameCard key={g.id} game={g} odds={odds} teamForm={teamForm} injuryData={injuryData} calibrator={probabilityCalibrator} savedPrediction={predictionRecords.find(p=>p.gameId===g.id)} onClick={()=>{setSelected(g.id);setTab('analysis')}}/> )}</div>}</>}
      {tab==='analysis' && <><section className="section-heading"><div><span className="eyebrow">PRE-GAME INTELLIGENCE</span><h2>賽前分析</h2></div><span className="muted">{upcoming.length} 場未完賽</span></section>{active ? <MatchAnalysis game={active} odds={odds} teamForm={teamForm} injuryData={injuryData} rosterData={rosterData} teamMetrics={teamMetrics} calibrator={probabilityCalibrator} onBack={()=>setSelected(null)}/> : <div className="analysis-list">{upcoming.map(g=><button className="analysis-row" key={g.id} onClick={()=>setSelected(g.id)}><span>{g.away.abbreviation} @ {g.home.abbreviation}</span><b>{g.away.displayName} 對 {g.home.displayName}</b><span>{g.detail || '待開賽'} <ChevronRight size={15}/></span></button>)}</div>}{!active && upcoming.length===0 && <div className="empty">目前沒有可分析的未完賽賽事，請切換日期。</div>}</>}
      {tab==='parlay' && <><section className="section-heading"><div><span className="eyebrow">PARLAY & VERIFICATION</span><h2>串關研究與驗證</h2></div><span className="muted">分析工具，不保證結果</span></section><ParlayLab/></>}
      {tab==='performance' && <><section className="section-heading"><div><span className="eyebrow">MODEL TRACK RECORD</span><h2>模型績效</h2></div><span className="muted">真實紀錄優先</span></section><section className="analysis-panel"><div className="panel-title">歷史 Walk-Forward 回測｜{(backtest?.seasons?.join(' / ') || backtest?.season)??'尚未完成'}</div><div className="performance-grid"><div className="perf-card"><Target/><span>歷史回測樣本</span><strong>{backtest?.sampleSize??'—'}</strong><small>{backtest?(backtest.seasons?.length ? '三季逐場賽前資料回放' : '逐場賽前資料回放'):'等待首次回測完成'}</small></div><div className="perf-card"><Trophy/><span>勝負方向命中率</span><strong>{backtest?(backtest.metrics.winnerAccuracy*100).toFixed(1)+'%':'—'}</strong><small>歷史單季回測，不代表未來</small></div><div className="perf-card"><TrendingUp/><span>Brier Score</span><strong>{backtest?backtest.metrics.brierScore.toFixed(3):'—'}</strong><small>越低越好</small></div><div className="perf-card"><Activity/><span>預測分差 MAE</span><strong>{backtest?backtest.metrics.marginMAE.toFixed(1):'—'}</strong><small>平均分差絕對誤差</small></div><div className="perf-card"><Activity/><span>預測總分 MAE</span><strong>{backtest?backtest.metrics.totalMAE.toFixed(1):'—'}</strong><small>平均總分絕對誤差</small></div></div><p className="method-note">{backtest?.method??'回測使用前一完整例行賽季；每場預測只使用該場開賽前已完成的賽事資料。'}</p><small className="muted">資料更新：{backtest?.updatedAt?new Date(backtest.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'尚無'}｜不含歷史傷兵與台灣運彩盤口，因此不計 ATS／大小分／ROI。</small></section>{backtest?.seasonResults?.length ? <section className="analysis-panel multi-season-panel"><div className="panel-title">三季分季回測｜觀察跨年度穩定度</div><div className="season-results">{backtest.seasonResults.map(row=><div className="season-result" key={row.season}><b>{row.season}</b><span>{row.metrics.sampleSize.toLocaleString()} 場預測</span><strong>{(row.metrics.winnerAccuracy*100).toFixed(1)}%</strong><small>命中率</small><span>Brier {row.metrics.brierScore.toFixed(3)} · 分差 MAE {row.metrics.marginMAE.toFixed(1)}</span></div>)}</div>{backtest.calibration?.length ? <><div className="panel-title calibration-title">勝率機率校準｜預測區間 vs 實際主勝率</div><div className="calibration-list">{backtest.calibration.map(row=><div className="calibration-row" key={row.range}><span>{row.range}</span><div className="calibration-track"><i style={{width:(row.predictedHomeWin*100)+'%'}}/><b style={{left:(row.actualHomeWin*100)+'%'}}/></div><small>預測 {(row.predictedHomeWin*100).toFixed(1)}% / 實際 {(row.actualHomeWin*100).toFixed(1)}% · {row.sampleSize} 場</small></div>)}</div></> : null}<p className="method-note">校準越接近「預測 60% 就實際約 60%」，代表機率越可信；樣本數較少的區間需審慎解讀。</p></section> : null}{backtest?.calibrationEvaluation && <section className="analysis-panel calibration-evaluation"><div className="panel-title">跨季機率校準｜只用過去訓練、未來驗證</div><p className="method-note">{backtest.calibrationEvaluation.method} {backtest.calibrationEvaluation.trainingPolicy}</p>{backtest.calibrationEvaluation.rawMetrics && backtest.calibrationEvaluation.calibratedMetrics ? <><div className="calibration-compare"><div><small>原始模型 Brier</small><strong>{backtest.calibrationEvaluation.rawMetrics.brierScore.toFixed(4)}</strong><span>Log Loss {backtest.calibrationEvaluation.rawMetrics.logLoss.toFixed(4)}</span></div><div><small>校準後 Brier</small><strong>{backtest.calibrationEvaluation.calibratedMetrics.brierScore.toFixed(4)}</strong><span>Log Loss {backtest.calibrationEvaluation.calibratedMetrics.logLoss.toFixed(4)}</span></div><div><small>測試樣本</small><strong>{backtest.calibrationEvaluation.sampleSize.toLocaleString()}</strong><span>僅計入有前季訓練資料的賽季</span></div></div><p className="method-note">{backtest.calibrationEvaluation.improvedBrier ? '目前跨季測試中，校準後 Brier Score 有改善；仍需持續觀察新賽季。' : '目前跨季測試未證明校準能改善 Brier Score，因此不應自動取代原始模型勝率。'}</p></> : <div className="empty">尚無足夠的前季資料建立校準器。</div>}</section>}<div className="performance-grid"><div className="perf-card"><Target/><span>賽前預測紀錄</span><strong>{predictionStats.total}</strong><small>只保存開賽前已產生的預測</small></div><div className="perf-card"><Trophy/><span>已結算場次</span><strong>{predictionStats.settled}</strong><small>需先有賽前預測紀錄</small></div><div className="perf-card"><TrendingUp/><span>勝負方向命中率</span><strong>{predictionStats.accuracy===null?'—':(predictionStats.accuracy*100).toFixed(1)+'%'}</strong><small>僅計入已結算預測</small></div><div className="perf-card"><ShieldCheck/><span>Brier Score</span><strong>{predictionStats.brier===null?'—':predictionStats.brier.toFixed(3)}</strong><small>越低越好；0 為完美機率預測</small></div><div className="perf-card"><Activity/><span>平均分差誤差</span><strong>{predictionStats.marginError===null?'—':predictionStats.marginError.toFixed(1)}</strong><small>預測主隊分差與實際分差差距</small></div><div className="perf-card"><CircleAlert/><span>ATS／大小分／ROI</span><strong>—</strong><small>待接通可追溯官方盤口與結算</small></div></div><div className="notice"><CircleAlert size={17}/>預測紀錄目前保存在這台裝置的瀏覽器；只會在網站被開啟且取得賽前資料時建立紀錄。換裝置、清除瀏覽器資料或未曾於開賽前開啟網站，均不會補造歷史預測。Brier Score 評估機率品質，不能單獨代表投注獲利。</div></>}
      <footer><div className="footer-brand">NBA <b>EDGE</b></div><span>數據研究工具，不構成投注建議。預測不保證結果，請理性評估風險。</span><span>DATA-DRIVEN · ALWAYS VERIFY</span></footer>
    </main>
    {completed.length>0 && <div className="completed-count">已完賽 {completed.length} 場</div>}
  </div>
}
function GameCard({game, odds, teamForm, injuryData, calibrator, savedPrediction, onClick}:{game:Game;odds:OddsRecord|null;teamForm:TeamFormData|null;injuryData:InjuryData|null;calibrator:ProbabilityCalibrator|null;savedPrediction?:PredictionRecord;onClick:()=>void}) {
 const m=marketFor(game,odds), done=game.status.toLowerCase().includes('final')
 const report=teamForm ? analyzeMatch(game,teamForm,injuryData,calibrator) : null
 const available=!!report?.available
 const useSaved=!!savedPrediction
 const homeWin=useSaved?savedPrediction.homeWin:available?report!.homeWin:undefined
 const awayWin=useSaved?savedPrediction.awayWin:available?report!.awayWin:undefined
 const projectedTotal=useSaved?savedPrediction.projectedTotal:available?report!.projectedTotal:undefined
 const projectedMargin=useSaved?savedPrediction.projectedMargin:available?report!.projectedMargin:undefined
 const projectedHome=useSaved?(projectedTotal!==undefined&&projectedMargin!==undefined?(projectedTotal+projectedMargin)/2:undefined):available?report!.projectedHome:undefined
 const projectedAway=useSaved?(projectedTotal!==undefined&&projectedMargin!==undefined?(projectedTotal-projectedMargin)/2:undefined):available?report!.projectedAway:undefined
 const hasPrediction=homeWin!==undefined
 const pickedTeam=hasPrediction?(homeWin!>=0.5?game.home:game.away):null
 const actualWinner=done?((Number(game.home.score)>Number(game.away.score))?game.home:(Number(game.away.score)>Number(game.home.score)?game.away:null)):null
 const pickCorrect=done&&useSaved&&actualWinner? pickedTeam?.id===actualWinner.id : null
 const recordedLine=useSaved?savedPrediction?.totalLine:undefined
 const gradingLine=recordedLine
 const actualTotal=done?Number(game.home.score)+Number(game.away.score):undefined
 const totalCorrect=done&&useSaved&&gradingLine!==undefined&&actualTotal!==undefined&&actualTotal!==gradingLine ? ((savedPrediction?.totalPick==='OVER'&&actualTotal>gradingLine)||(savedPrediction.totalPick==='UNDER'&&actualTotal<gradingLine)) : null
 const pickProbability=hasPrediction?Math.max(homeWin!,awayWin!):undefined
 const totalLine=m?.total.find(x=>x.point!==undefined)
 const isBig=projectedTotal!==undefined && totalLine?.point!==undefined ? projectedTotal>totalLine.point : null
 const time = new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}).format(new Date(game.date))
 return <button className="game-card" onClick={onClick}>
  <div className="game-top"><span className={done?'game-state done':'game-state'}>{done?'FINAL':game.detail || '即將開賽'}</span><span>{done?'完賽':time+' 台灣時間'}</span></div>
  <div className="teams"><TeamLine team={game.away}/><div className="versus">{done?<div className="final-score"><b>{game.away.score}</b><small>:</small><b>{game.home.score}</b></div>:'VS'}</div><TeamLine team={game.home}/></div>
  <div className={'game-prediction-summary'+(!hasPrediction?' prediction-pending':'')+(pickCorrect===true?' pick-correct':pickCorrect===false?' pick-wrong':'')}>
   <div><small>不讓分</small><b>{hasPrediction?pickedTeam!.displayName:'資料不足'}</b><strong>{hasPrediction?(pickProbability!*100).toFixed(1)+'%':'—'}</strong></div>
   <div className={totalCorrect===true?'total-correct':totalCorrect===false?'total-wrong':''}><small>大小分</small><b>{projectedTotal===undefined?'尚無預測':(recordedLine!==undefined?(savedPrediction.totalPick==='OVER'?'大分':'小分')+' '+recordedLine:totalLine?.point!==undefined?(isBig?'大分':'小分')+' '+totalLine.point:'模型 '+projectedTotal.toFixed(1))}</b><em>{totalCorrect===true?'命中':totalCorrect===false?'未命中':projectedTotal!==undefined&&recordedLine!==undefined?'模型 '+projectedTotal.toFixed(1)+' 分':projectedTotal!==undefined&&totalLine?.point!==undefined?'模型 '+projectedTotal.toFixed(1)+' 分': '等待有效盤口'}</em></div>
   <div><small>預估比分</small><b>{projectedAway!==undefined&&projectedHome!==undefined?projectedAway.toFixed(0)+' : '+projectedHome.toFixed(0):'—'}</b><em>{useSaved?'賽前封存':'模型預測'}</em></div>
  </div>
 </button>
}
function TeamLine({team}:{team:Game['home']}) { return <div className="team-line">{team.logo?<img src={team.logo} alt="" />:<span className="team-placeholder">{team.abbreviation}</span>}<div><b>{team.abbreviation}</b><small>{team.displayName}</small></div></div> }
export default App