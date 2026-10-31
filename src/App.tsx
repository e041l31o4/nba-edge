import { useEffect, useMemo, useState } from 'react'
import { Activity, CalendarDays, ChevronLeft, ChevronRight, CircleAlert, RefreshCw, ShieldCheck, Target, TrendingUp, Trophy } from 'lucide-react'
import { dateLabel, getOdds, getScoreboard, marketFor, taiwanDate, type Game, type OddsRecord } from './lib'
import ParlayLab from './ParlayLab'
import MatchAnalysis from './MatchAnalysis'
import { analyzeMatch, type TeamFormData, type InjuryData } from './model'
import { capturePregamePredictions, getPredictionRecords, settleCompletedPredictions, summarizePredictions, type PredictionRecord } from './predictionLedger'

type Tab = 'games' | 'analysis' | 'performance' | 'parlay'
type BacktestData = { updatedAt: string; season?: string; seasons?: string[]; method?: string; sampleSize: number; metrics: { winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number }; seasonResults?: { season: string; completedGames: number; metrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number } }[]; calibration?: { range: string; sampleSize: number; predictedHomeWin: number; actualHomeWin: number }[]; limitations: string[] }
function App() {
  const [date, setDate] = useState(taiwanDate())
  const [games, setGames] = useState<Game[]>([])
  const [odds, setOdds] = useState<OddsRecord | null>(null)
  const [teamForm, setTeamForm] = useState<TeamFormData | null>(null)
  const [injuryData, setInjuryData] = useState<InjuryData | null>(null)
  const [tab, setTab] = useState<Tab>('games')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [predictionRecords, setPredictionRecords] = useState<PredictionRecord[]>([])
  const [backtest, setBacktest] = useState<BacktestData | null>(null)
  const load = async () => {
    setLoading(true); setError('')
    try { const [g, o, tf, inj, bt] = await Promise.all([getScoreboard(date), getOdds(), fetch(`${import.meta.env.BASE_URL}data/team-form.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null), fetch(`${import.meta.env.BASE_URL}data/injuries.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null), fetch(`${import.meta.env.BASE_URL}data/backtest.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null)]); setGames(g); setOdds(o); setTeamForm(tf); setInjuryData(inj); setBacktest(bt); setUpdated(new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })) }
    catch (e) { setError(e instanceof Error ? e.message : '讀取失敗') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [date])
  useEffect(() => {
    if (teamForm) capturePregamePredictions(games, teamForm, injuryData)
    settleCompletedPredictions(games)
    setPredictionRecords(getPredictionRecords())
  }, [games, teamForm, injuryData])
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
        {loading ? <div className="empty"><RefreshCw className="spin" size={22}/>正在同步 NBA 賽程…</div> : games.length===0 ? <div className="empty"><CalendarDays size={25}/><b>當日沒有賽事</b><span>可切換日期查看其他比賽。</span></div> : <div className="game-grid">{games.map(g => <GameCard key={g.id} game={g} odds={odds} teamForm={teamForm} injuryData={injuryData} onClick={()=>{setSelected(g.id);setTab('analysis')}}/> )}</div>}</>}
      {tab==='analysis' && <><section className="section-heading"><div><span className="eyebrow">PRE-GAME INTELLIGENCE</span><h2>賽前分析</h2></div><span className="muted">{upcoming.length} 場未完賽</span></section>{active ? <MatchAnalysis game={active} odds={odds} teamForm={teamForm} injuryData={injuryData} onBack={()=>setSelected(null)}/> : <div className="analysis-list">{upcoming.map(g=><button className="analysis-row" key={g.id} onClick={()=>setSelected(g.id)}><span>{g.away.abbreviation} @ {g.home.abbreviation}</span><b>{g.away.displayName} 對 {g.home.displayName}</b><span>{g.detail || '待開賽'} <ChevronRight size={15}/></span></button>)}</div>}{!active && upcoming.length===0 && <div className="empty">目前沒有可分析的未完賽賽事，請切換日期。</div>}</>}
      {tab==='parlay' && <><section className="section-heading"><div><span className="eyebrow">PARLAY & VERIFICATION</span><h2>串關研究與驗證</h2></div><span className="muted">分析工具，不保證結果</span></section><ParlayLab/></>}
      {tab==='performance' && <><section className="section-heading"><div><span className="eyebrow">MODEL TRACK RECORD</span><h2>模型績效</h2></div><span className="muted">真實紀錄優先</span></section><section className="analysis-panel"><div className="panel-title">歷史 Walk-Forward 回測｜{(backtest?.seasons?.join(' / ') || backtest?.season)??'尚未完成'}</div><div className="performance-grid"><div className="perf-card"><Target/><span>歷史回測樣本</span><strong>{backtest?.sampleSize??'—'}</strong><small>{backtest?(backtest.seasons?.length ? '三季逐場賽前資料回放' : '逐場賽前資料回放'):'等待首次回測完成'}</small></div><div className="perf-card"><Trophy/><span>勝負方向命中率</span><strong>{backtest?(backtest.metrics.winnerAccuracy*100).toFixed(1)+'%':'—'}</strong><small>歷史單季回測，不代表未來</small></div><div className="perf-card"><TrendingUp/><span>Brier Score</span><strong>{backtest?backtest.metrics.brierScore.toFixed(3):'—'}</strong><small>越低越好</small></div><div className="perf-card"><Activity/><span>預測分差 MAE</span><strong>{backtest?backtest.metrics.marginMAE.toFixed(1):'—'}</strong><small>平均分差絕對誤差</small></div><div className="perf-card"><Activity/><span>預測總分 MAE</span><strong>{backtest?backtest.metrics.totalMAE.toFixed(1):'—'}</strong><small>平均總分絕對誤差</small></div></div><p className="method-note">{backtest?.method??'回測使用前一完整例行賽季；每場預測只使用該場開賽前已完成的賽事資料。'}</p><small className="muted">資料更新：{backtest?.updatedAt?new Date(backtest.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'尚無'}｜不含歷史傷兵與台灣運彩盤口，因此不計 ATS／大小分／ROI。</small></section>{backtest?.seasonResults?.length ? <section className="analysis-panel multi-season-panel"><div className="panel-title">三季分季回測｜觀察跨年度穩定度</div><div className="season-results">{backtest.seasonResults.map(row=><div className="season-result" key={row.season}><b>{row.season}</b><span>{row.metrics.sampleSize.toLocaleString()} 場預測</span><strong>{(row.metrics.winnerAccuracy*100).toFixed(1)}%</strong><small>命中率</small><span>Brier {row.metrics.brierScore.toFixed(3)} · 分差 MAE {row.metrics.marginMAE.toFixed(1)}</span></div>)}</div>{backtest.calibration?.length ? <><div className="panel-title calibration-title">勝率機率校準｜預測區間 vs 實際主勝率</div><div className="calibration-list">{backtest.calibration.map(row=><div className="calibration-row" key={row.range}><span>{row.range}</span><div className="calibration-track"><i style={{width:(row.predictedHomeWin*100)+'%'}}/><b style={{left:(row.actualHomeWin*100)+'%'}}/></div><small>預測 {(row.predictedHomeWin*100).toFixed(1)}% / 實際 {(row.actualHomeWin*100).toFixed(1)}% · {row.sampleSize} 場</small></div>)}</div></> : null}<p className="method-note">校準越接近「預測 60% 就實際約 60%」，代表機率越可信；樣本數較少的區間需審慎解讀。</p></section> : null}<div className="performance-grid"><div className="perf-card"><Target/><span>賽前預測紀錄</span><strong>{predictionStats.total}</strong><small>只保存開賽前已產生的預測</small></div><div className="perf-card"><Trophy/><span>已結算場次</span><strong>{predictionStats.settled}</strong><small>需先有賽前預測紀錄</small></div><div className="perf-card"><TrendingUp/><span>勝負方向命中率</span><strong>{predictionStats.accuracy===null?'—':(predictionStats.accuracy*100).toFixed(1)+'%'}</strong><small>僅計入已結算預測</small></div><div className="perf-card"><ShieldCheck/><span>Brier Score</span><strong>{predictionStats.brier===null?'—':predictionStats.brier.toFixed(3)}</strong><small>越低越好；0 為完美機率預測</small></div><div className="perf-card"><Activity/><span>平均分差誤差</span><strong>{predictionStats.marginError===null?'—':predictionStats.marginError.toFixed(1)}</strong><small>預測主隊分差與實際分差差距</small></div><div className="perf-card"><CircleAlert/><span>ATS／大小分／ROI</span><strong>—</strong><small>待接通可追溯官方盤口與結算</small></div></div><div className="notice"><CircleAlert size={17}/>預測紀錄目前保存在這台裝置的瀏覽器；只會在網站被開啟且取得賽前資料時建立紀錄。換裝置、清除瀏覽器資料或未曾於開賽前開啟網站，均不會補造歷史預測。Brier Score 評估機率品質，不能單獨代表投注獲利。</div></>}
      <footer><div className="footer-brand">NBA <b>EDGE</b></div><span>數據研究工具，不構成投注建議。預測不保證結果，請理性評估風險。</span><span>DATA-DRIVEN · ALWAYS VERIFY</span></footer>
    </main>
    {completed.length>0 && <div className="completed-count">已完賽 {completed.length} 場</div>}
  </div>
}
function GameCard({game, odds, teamForm, injuryData, onClick}:{game:Game;odds:OddsRecord|null;teamForm:TeamFormData|null;injuryData:InjuryData|null;onClick:()=>void}) {
 const m=marketFor(game,odds), done=game.status.toLowerCase().includes('final')
 const report=done?null:analyzeMatch(game,teamForm,injuryData)
 const favorite=report?.available?(report.homeWin>=0.5?game.home:game.away):null
 const favoriteProbability=report?.available?Math.max(report.homeWin,report.awayWin):null
 const spreadLine=m?.spread.find(x=>x.point!==undefined)
 const totalLine=m?.total.find(x=>x.point!==undefined)
 const time = new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}).format(new Date(game.date))
 return <button className="game-card" onClick={onClick}>
  <div className="game-top"><span className={done?'game-state done':'game-state'}>{done?'FINAL':game.detail || '即將開賽'}</span><span>{done?'完賽':time+' 台灣時間'}</span></div>
  <div className="teams"><TeamLine team={game.away}/><div className="versus">{done?<><b>{game.away.score}</b><small>FINAL</small><b>{game.home.score}</b></>:'VS'}</div><TeamLine team={game.home}/></div>
  {!done && <div className={favorite?'pick-strip':'pick-strip pick-pending'}>
   <span className="pick-label">{favorite?'模型看好':'模型預測'}</span>
   {favorite?<><b>{favorite.displayName}</b><strong>{(favoriteProbability!*100).toFixed(1)}%</strong><small>預測 {report!.projectedAway.toFixed(0)} : {report!.projectedHome.toFixed(0)}</small></>:<b>資料累積中，暫不提供勝方</b>}
  </div>}
  <div className="market-strip">
   <div><small>讓分盤</small><b>{spreadLine?spreadLine.name+' '+(spreadLine.point!>0?'+':'')+spreadLine.point:(m?'尚無讓分資料':'來源未接通')}</b></div>
   <div><small>大小分</small><b>{totalLine?'總分 '+totalLine.point:(m?'尚無大小分資料':'來源未接通')}</b></div>
   <span className="card-arrow"><ChevronRight size={16}/></span>
  </div>
 </button>
}
function TeamLine({team}:{team:Game['home']}) { return <div className="team-line">{team.logo?<img src={team.logo} alt="" />:<span className="team-placeholder">{team.abbreviation}</span>}<div><b>{team.abbreviation}</b><small>{team.displayName}</small></div></div> }
export default App