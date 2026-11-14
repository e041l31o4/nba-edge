import { useEffect, useMemo, useState } from 'react'
import { Activity, CalendarDays, ChevronLeft, ChevronRight, CircleAlert, RefreshCw, ShieldCheck, Target, TrendingUp, Trophy } from 'lucide-react'
import { dateLabel, getOdds, getScoreboard, taiwanDate, type Game, type OddsRecord, type OddsSnapshot } from './lib'
import { loadDataset } from './lib/memberData'
import ParlayLab from './ParlayLab'
import MatchAnalysis from './MatchAnalysis'
import { analyzeMatch, coverProbability, totalProbability, decimalExpectedValue, type TeamFormData, type InjuryData, type RosterData, type TeamMetricsData, type ProbabilityCalibrator } from './model'
import { getPredictionRecords, summarizePredictions, summarizeMarketRecords, type PredictionRecord } from './predictionLedger'
import { supabase } from './lib/supabase'

type PublicGameAnalysisData = {
  teamForm: TeamFormData | null
  injuryData: InjuryData | null
  rosterData: RosterData | null
  teamMetrics: TeamMetricsData | null
  odds: OddsRecord | null
  oddsHistory: OddsSnapshot[]
  calibrator: ProbabilityCalibrator | null
  marketBacktest: BacktestData['marketBacktest'] | null
}

type Tab = 'games' | 'analysis' | 'performance' | 'parlay'
type BacktestData = { updatedAt: string; currentSeason?: { season: string; completedGames: number; predictionSample: number; metrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number } }; season?: string; seasons?: string[]; method?: string; sampleSize: number; metrics: { winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number }; seasonResults?: { season: string; completedGames: number; metrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number }; calibrationTrainingSamples?: number; calibrator?: { a: number; b: number; trainingSamples: number } | null; calibratedMetrics?: { sampleSize: number; winnerAccuracy: number; brierScore: number; logLoss: number } | null }[]; calibration?: { range: string; sampleSize: number; predictedHomeWin: number; actualHomeWin: number }[]; calibrationEvaluation?: { method: string; trainingPolicy: string; sampleSize: number; rawMetrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; logLoss: number } | null; calibratedMetrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; logLoss: number } | null; improvedBrier: boolean | null }; limitations: string[]; marketBacktest?: Record<'h2h'|'spreads'|'totals',{sampleSize:number;decided:number;wins:number;losses:number;pushes:number;hitRate:number|null;roi:number|null;netUnits:number;averageEV:number|null;method:string}> }
function addTaiwanDays(date: string, days: number) { const d = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00'); d.setDate(d.getDate()+days); return taiwanDate(d) }
function App() {
  const [date, setDate] = useState(taiwanDate())
  const [games, setGames] = useState<Game[]>([])
  const [odds, setOdds] = useState<OddsRecord | null>(null)
  const [oddsHistory, setOddsHistory] = useState<OddsSnapshot[]>([])
  const [teamForm, setTeamForm] = useState<TeamFormData | null>(null)
  const [injuryData, setInjuryData] = useState<InjuryData | null>(null)
  const [rosterData, setRosterData] = useState<RosterData | null>(null)
  const [teamMetrics, setTeamMetrics] = useState<TeamMetricsData | null>(null)
  const [tab, setTab] = useState<Tab>('games')
  const [loading, setLoading] = useState(true)
  const [introPlaying, setIntroPlaying] = useState(true)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [predictionRecords, setPredictionRecords] = useState<PredictionRecord[]>([])
  const [ledgerStatus, setLedgerStatus] = useState<'loading'|'ready'|'error'>('loading')
  const [backtest, setBacktest] = useState<BacktestData | null>(null)
  const [membershipActive, setMembershipActive] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [publicGameIds, setPublicGameIds] = useState<string[]>([])
  const [accessReady, setAccessReady] = useState(false)
  const [publicGameData, setPublicGameData] = useState<Record<string, PublicGameAnalysisData>>({})
  const load = async () => {
    setLoading(true); setError('')
    try { const [g, o, oh, tf, inj, roster, metrics, bt] = await Promise.all([getScoreboard(date), getOdds(), loadDataset<OddsSnapshot[]>('odds-history', 'odds-history.jsonl').catch(()=>[]), loadDataset<TeamFormData>('team-form', 'team-form.json').catch(()=>null), loadDataset<InjuryData>('injuries', 'injuries.json').catch(()=>null), loadDataset<RosterData>('rosters', 'rosters.json').catch(()=>null), loadDataset<TeamMetricsData>('team-metrics', 'team-metrics.json').catch(()=>null), loadDataset<BacktestData>('backtest', 'backtest.json').catch(()=>null)]); setGames(g); setOdds(o); setOddsHistory(Array.isArray(oh)?oh:[]); setTeamForm(tf); setInjuryData(inj); setRosterData(roster); setTeamMetrics(metrics); setBacktest(bt); setUpdated(new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })) }
    catch (e) { setError(e instanceof Error ? e.message : '讀取失敗') }
    finally { setLoading(false) }
  }
  useEffect(() => { const timer = window.setTimeout(() => setIntroPlaying(false), 3200); return () => window.clearTimeout(timer) }, [])
  const probabilityCalibrator: ProbabilityCalibrator | null = backtest?.seasonResults?.slice().reverse().find(row => row.calibrator)?.calibrator ?? null
  useEffect(() => {
    let alive = true
    const refreshAccess = async () => {
      if (!supabase) { if (alive) setAccessReady(true); return }
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        const [{ data: profile }, { data: active }] = await Promise.all([
          supabase.from('profiles').select('role').eq('id', session.user.id).maybeSingle(),
          supabase.rpc('has_active_membership')
        ])
        if (alive) { setIsAdmin(profile?.role === 'admin'); setMembershipActive(Boolean(active) || profile?.role === 'admin') }
      } else if (alive) { setIsAdmin(false); setMembershipActive(false) }
      const gameDate = date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)
      const { data: access } = await supabase.from('public_game_access_by_date').select('game_ids').eq('game_date', gameDate).maybeSingle()
      if (alive) { setPublicGameIds(Array.isArray(access?.game_ids) ? access.game_ids : []); setAccessReady(true) }
    }
    void refreshAccess()
    if (!supabase) return () => { alive = false }
    const { data: authListener } = supabase.auth.onAuthStateChange(() => {
      window.setTimeout(() => { if (alive) void refreshAccess() }, 0)
    })
    return () => { alive = false; authListener.subscription.unsubscribe() }
  }, [date])
  useEffect(() => { setAccessReady(false) }, [date])
  // Guests can only request the two games explicitly published by the admin for this Taiwan date.
  const publicGameKey = games.map(game => game.id).join('|')
  useEffect(() => {
    let alive = true
    if (!accessReady || membershipActive || isAdmin || !supabase || !publicGameIds.length || !games.length) {
      setPublicGameData({})
      return () => { alive = false }
    }
    const selectedGames = games.filter(game => publicGameIds.includes(game.id))
    setPublicGameData({})
    setError('')
    void Promise.all(selectedGames.map(async game => {
      const { data, error: publicError } = await supabase!.rpc('get_public_game_analysis', {
        p_game_date: date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8),
        p_game_id: game.id,
        p_home_team_id: game.home.id,
        p_away_team_id: game.away.id,
        p_home_abbr: game.home.abbreviation,
        p_away_abbr: game.away.abbreviation,
        p_home_name: game.home.name,
        p_away_name: game.away.name
      })
      if (publicError) throw publicError
      return [game.id, data as PublicGameAnalysisData] as const
    })).then(rows => {
      if (alive) setPublicGameData(Object.fromEntries(rows))
    }).catch(error => {
      if (alive) {
        setPublicGameData({})
        setError('免費公開賽事分析資料尚未完成資料庫設定或資料同步；請管理員確認已套用最新 Supabase migration，並等待資料刷新完成。')
        console.warn('Public game analysis unavailable:', error)
      }
    })
    return () => { alive = false }
  }, [date, publicGameIds.join('|'), publicGameKey, accessReady, membershipActive, isAdmin])
  useEffect(() => { void load() }, [date, membershipActive])
  // 場中比分每 30 秒同步一次；只更新賽程比分，不重新計算或覆寫已封存的賽前預測。
  useEffect(() => {
    let active = true
    const timer = window.setInterval(async () => {
      try {
        const latest = await getScoreboard(date)
        if (!active) return
        setGames(latest)
        setUpdated(new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' }))
      } catch {
        // 即時來源短暫中斷時保留最後一次成功比分。
      }
    }, 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [date])
  useEffect(() => {
    let active = true
    setLedgerStatus('loading')
    void getPredictionRecords().then(records => {
      if (!active) return
      setPredictionRecords(records)
      setLedgerStatus('ready')
    }).catch(() => {
      if (active) setLedgerStatus('error')
    })
    return () => { active = false }
  }, [date, membershipActive])
  const predictionStats = summarizePredictions(predictionRecords)
  const spreadLedgerStats = summarizeMarketRecords(predictionRecords,'spreadPick')
  const totalLedgerStats = summarizeMarketRecords(predictionRecords,'totalPick')
  const upcoming = useMemo(() => games.filter(g => !g.status.toLowerCase().includes('final')), [games])
  const completed = games.filter(g => g.status.toLowerCase().includes('final'))
  const moveDate = (delta: number) => { if (delta > 0 && membershipActive && !isAdmin && date >= addTaiwanDays(taiwanDate(), 1)) return; const d = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00'); d.setDate(d.getDate()+delta); setDate(taiwanDate(d)) }
  const active = games.find(g => g.id === selected)
  const canSeeAll = membershipActive || isAdmin
  const latestMemberDate = addTaiwanDays(taiwanDate(), 1)
  const firstGameStart = games.length ? Math.min(...games.map(g => new Date(g.date).getTime()).filter(Number.isFinite)) : Number.POSITIVE_INFINITY
  const releaseReached = date <= taiwanDate() || (date <= latestMemberDate && firstGameStart <= Date.now() + 24 * 60 * 60 * 1000)
  const canViewSelectedDate = canSeeAll && (isAdmin || releaseReached)
  const visibleGames = isAdmin || (membershipActive && canViewSelectedDate) ? games : membershipActive ? [] : games.filter(g => publicGameIds.includes(g.id))
  return <div className="app-shell">
    {introPlaying && <div className="arena-intro" role="status" aria-label="NBA EDGE 開場動畫">
      <div className="intro-arena"><div className="intro-center-circle"/><div className="intro-key intro-key-left"/><div className="intro-key intro-key-right"/><div className="intro-hoop intro-hoop-left"/><div className="intro-hoop intro-hoop-right"/></div>
      <div className="intro-lights"/>
      <div className="intro-ball"><i/><i/><i/></div>
      <div className="intro-copy"><span>THE GAME STARTS HERE</span><strong>NBA <b>EDGE</b></strong><small>DATA · MATCHUP · INSIGHT</small></div>
      <button className="intro-skip" onClick={() => setIntroPlaying(false)}>略過動畫 <span>↗</span></button>
    </div>}
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">E</span><span>NBA <b>EDGE</b><small>DATA · MATCHUP · INSIGHT</small></span></a><div className="top-right"><span className="live-dot"/> <span>台灣時間 UTC+8</span><button className="icon-btn" onClick={() => void load()} aria-label="重新整理"><RefreshCw size={16}/></button></div></header>
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span/> THE DAILY MATCHUP INTELLIGENCE</div>
          <h1>不只看比分。<br/><em>看懂勝負關鍵。</em></h1>
          <p>從球隊近況、陣容與數據出發，讓每一場預測都有依據、每一次結果都能驗證。</p>
          <div className="hero-tags"><span>01 / MATCHUP</span><span>02 / MODEL EDGE</span><span>03 / TRACK RECORD</span></div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/>
          <div className="hero-ball">◎</div>
          <div className="hero-visual-label"><b>NBA</b><span>EDGE / 2026—27</span></div>
          <div className="hero-stat"><span>今日賽事</span><strong>{loading ? '—' : games.length.toString().padStart(2,'0')}</strong><small>GAMES ON THE BOARD</small></div>
        </div>
      </section>
      <section className="ticker"><div className="ticker-label"><Activity size={15}/> DATA STATUS</div><span className="status-ok"><i/> 賽程來源連線</span><span className={odds ? 'status-ok' : 'status-warn'}><i/> {odds ? '盤口資料已載入' : '官方盤口來源未接通'}</span><span className="ticker-time">最後更新 {updated || '—'}</span></section>
      <section className="toolbar"><div className="date-nav"><button className="icon-btn" onClick={() => moveDate(-1)}><ChevronLeft size={18}/></button><div><CalendarDays size={17}/><b>{date.slice(0,4)}/{date.slice(4,6)}/{date.slice(6,8)}</b><small>{dateLabel(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00')}</small></div><button className="icon-btn" onClick={() => moveDate(1)}><ChevronRight size={18}/></button><button className="today-btn" onClick={() => setDate(taiwanDate())}>今天</button></div><div className="tabs"><button className={tab==='games'?'active':''} onClick={()=>setTab('games')}>賽事總覽</button>{(canViewSelectedDate || publicGameIds.length>0)&&<button className={tab==='analysis'?'active':''} onClick={()=>setTab('analysis')}>賽前分析{!canViewSelectedDate?'（公開場次）':''}</button>}{canViewSelectedDate&&<><button className={tab==='performance'?'active':''} onClick={()=>setTab('performance')}>模型績效</button><button className={tab==='parlay'?'active':''} onClick={()=>setTab('parlay')}>串關研究</button></>}</div></section>
      {error && <div className="notice error"><CircleAlert size={17}/>{error}</div>}
      {tab==='games' && <><section className="section-heading"><div><span className="eyebrow">MATCH CENTER</span><h2>賽事總覽 <small>{date.slice(4,6)}/{date.slice(6,8)}</small></h2></div><div className="legend"><span><i className="green"/>進行中／未開賽</span><span><i className="gray"/>已完賽</span></div></section>
        {loading || !accessReady ? <div className="empty"><RefreshCw className="spin" size={22}/>正在同步 NBA 賽程…</div> : visibleGames.length===0 ? <div className="empty"><CalendarDays size={25}/><b>{canViewSelectedDate?'當日沒有賽事':'目前尚未設定免費公開賽事'}</b><span>{canViewSelectedDate?'可切換日期查看其他比賽。':membershipActive?'當日全部賽事會在首場開賽前 24 小時同步開放。':'免費訪客可查看管理員指定的兩場公開賽事；登入並完成會員開通即可查看全部。'}</span></div> : <div className="game-grid">{visibleGames.map(g => {const publicData=publicGameData[g.id];const publicSelected=publicGameIds.includes(g.id);return <GameCard key={g.id} game={g} odds={canViewSelectedDate?odds:publicData?.odds??null} teamForm={canViewSelectedDate?teamForm:publicData?.teamForm??null} injuryData={canViewSelectedDate?injuryData:publicData?.injuryData??null} teamMetrics={canViewSelectedDate?teamMetrics:publicData?.teamMetrics??null} calibrator={canViewSelectedDate?probabilityCalibrator:publicData?.calibrator??null} savedPrediction={canViewSelectedDate?predictionRecords.find(p=>p.gameId===g.id):undefined} ledgerStatus={ledgerStatus} onClick={()=>{if(canViewSelectedDate||publicSelected){setSelected(g.id);setTab('analysis')}}}/>})}</div>}</>}
      {tab==='analysis' && (canViewSelectedDate || (!!active && publicGameIds.includes(active.id))) && <><section className="section-heading"><div><span className="eyebrow">PRE-GAME INTELLIGENCE</span><h2>賽前分析</h2></div><span className="muted">{canViewSelectedDate?upcoming.length:upcoming.filter(g=>publicGameIds.includes(g.id)).length} 場可查看</span></section>{active ? (()=>{const publicData=publicGameData[active.id];return <MatchAnalysis game={active} odds={canViewSelectedDate?odds:publicData?.odds??null} oddsHistory={canViewSelectedDate?oddsHistory:publicData?.oddsHistory??[]} teamForm={canViewSelectedDate?teamForm:publicData?.teamForm??null} injuryData={canViewSelectedDate?injuryData:publicData?.injuryData??null} rosterData={canViewSelectedDate?rosterData:publicData?.rosterData??null} teamMetrics={canViewSelectedDate?teamMetrics:publicData?.teamMetrics??null} calibrator={canViewSelectedDate?probabilityCalibrator:publicData?.calibrator??null} marketBacktest={canViewSelectedDate?backtest?.marketBacktest??null:publicData?.marketBacktest??null} savedPrediction={canViewSelectedDate?predictionRecords.find(p=>p.gameId===active.id):undefined} onBack={()=>setSelected(null)}/>})() : <div className="analysis-list">{upcoming.filter(g=>canViewSelectedDate||publicGameIds.includes(g.id)).map(g=><button className="analysis-row" key={g.id} onClick={()=>setSelected(g.id)}><span>{g.away.abbreviation} @ {g.home.abbreviation}</span><b>{g.away.displayName} 對 {g.home.displayName}</b><span>{g.detail || '待開賽'} <ChevronRight size={15}/></span></button>)}</div>}{!active && upcoming.filter(g=>canViewSelectedDate||publicGameIds.includes(g.id)).length===0 && <div className="empty">目前沒有可分析的公開賽事，請切換日期。</div>}</>}
      {tab==='parlay' && canViewSelectedDate && <><section className="section-heading"><div><span className="eyebrow">PARLAY & VERIFICATION</span><h2>串關研究與驗證</h2></div><span className="muted">分析工具，不保證結果</span></section><ParlayLab/></>}
      {tab==='performance' && canViewSelectedDate && <><section className="section-heading"><div><span className="eyebrow">MODEL TRACK RECORD</span><h2>模型績效</h2></div><span className="muted">真實紀錄優先</span></section><section className="analysis-panel"><div className="panel-title">歷史 Walk-Forward 回測｜{(backtest?.seasons?.join(' / ') || backtest?.season)??'尚未完成'}</div><div className="performance-grid"><div className="perf-card"><Target/><span>歷史回測樣本</span><strong>{backtest?.sampleSize??'—'}</strong><small>{backtest?(backtest.seasons?.length ? '三季逐場賽前資料回放' : '逐場賽前資料回放'):'等待首次回測完成'}</small></div>{backtest?.currentSeason && <div className="perf-card"><Trophy/><span>{backtest.currentSeason.season} 本季勝負方向</span><strong>{(backtest.currentSeason.metrics.winnerAccuracy*100).toFixed(1)}%</strong><small>有效樣本 {backtest.currentSeason.predictionSample} 場 · 已完賽 {backtest.currentSeason.completedGames} 場</small></div>}<div className="perf-card"><Trophy/><span>勝負方向命中率</span><strong>{backtest?(backtest.metrics.winnerAccuracy*100).toFixed(1)+'%':'—'}</strong><small>歷史單季回測，不代表未來</small></div><div className="perf-card"><TrendingUp/><span>Brier Score</span><strong>{backtest?backtest.metrics.brierScore.toFixed(3):'—'}</strong><small>越低越好</small></div><div className="perf-card"><Activity/><span>預測分差 MAE</span><strong>{backtest?backtest.metrics.marginMAE.toFixed(1):'—'}</strong><small>平均分差絕對誤差</small></div><div className="perf-card"><Activity/><span>預測總分 MAE</span><strong>{backtest?backtest.metrics.totalMAE.toFixed(1):'—'}</strong><small>平均總分絕對誤差</small></div></div>{backtest?.marketBacktest && <section className="market-backtest-grid"><div className="panel-title">三大玩法獨立回測｜僅採開賽前台灣運彩盤口</div>{([{key:'h2h',label:'獨贏回測'},{key:'totals',label:'大小分回測'},{key:'spreads',label:'讓分回測'}] as const).map(item=>{const m=backtest.marketBacktest?.[item.key];return <div className="market-backtest-card" key={item.key}><b>{item.label}</b><strong>{m?.hitRate===null||m?.hitRate===undefined?'—':(m.hitRate*100).toFixed(1)+'%'}</strong><span>命中率｜有效樣本 {m?.decided??0} 場</span><small>勝 {m?.wins??0} · 敗 {m?.losses??0} · 走水 {m?.pushes??0}</small><small>ROI {m?.roi===null||m?.roi===undefined?'—':(m.roi*100).toFixed(1)+'%'} · 淨損益 {m?.netUnits??0} 單位</small><small>有盤口紀錄 {m?.sampleSize??0} 場</small></div>})}<p className="method-note">大小分與讓分只計算有保存賽前運彩盤口快照的歷史賽事；沒有盤口紀錄不會補造。ROI 以每場 1 單位、依實際盤口賠率計算。</p></section>}<p className="method-note">{backtest?.method??'回測使用前一完整例行賽季；每場預測只使用該場開賽前已完成的賽事資料。'}</p><small className="muted">資料更新：{backtest?.updatedAt?new Date(backtest.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'尚無'}｜歷史獨贏模型以多季賽前逐場回放評估；大小分及讓分另以實際保存的台灣運彩賽前盤口快照獨立計算，沒有盤口快照的比賽不列入命中率與 ROI。</small></section>{backtest?.seasonResults?.length ? <section className="analysis-panel multi-season-panel"><div className="panel-title">三季分季回測｜觀察跨年度穩定度</div><div className="season-results">{backtest.seasonResults.map(row=><div className="season-result" key={row.season}><b>{row.season}</b><span>{row.metrics.sampleSize.toLocaleString()} 場預測</span><strong>{(row.metrics.winnerAccuracy*100).toFixed(1)}%</strong><small>命中率</small><span>Brier {row.metrics.brierScore.toFixed(3)} · 分差 MAE {row.metrics.marginMAE.toFixed(1)}</span></div>)}</div>{backtest.calibration?.length ? <><div className="panel-title calibration-title">勝率機率校準｜預測區間 vs 實際主勝率</div><div className="calibration-list">{backtest.calibration.map(row=><div className="calibration-row" key={row.range}><span>{row.range}</span><div className="calibration-track"><i style={{width:(row.predictedHomeWin*100)+'%'}}/><b style={{left:(row.actualHomeWin*100)+'%'}}/></div><small>預測 {(row.predictedHomeWin*100).toFixed(1)}% / 實際 {(row.actualHomeWin*100).toFixed(1)}% · {row.sampleSize} 場</small></div>)}</div></> : null}<p className="method-note">校準越接近「預測 60% 就實際約 60%」，代表機率越可信；樣本數較少的區間需審慎解讀。</p></section> : null}{backtest?.calibrationEvaluation && <section className="analysis-panel calibration-evaluation"><div className="panel-title">跨季機率校準｜只用過去訓練、未來驗證</div><p className="method-note">{backtest.calibrationEvaluation.method} {backtest.calibrationEvaluation.trainingPolicy}</p>{backtest.calibrationEvaluation.rawMetrics && backtest.calibrationEvaluation.calibratedMetrics ? <><div className="calibration-compare"><div><small>原始模型 Brier</small><strong>{backtest.calibrationEvaluation.rawMetrics.brierScore.toFixed(4)}</strong><span>Log Loss {backtest.calibrationEvaluation.rawMetrics.logLoss.toFixed(4)}</span></div><div><small>校準後 Brier</small><strong>{backtest.calibrationEvaluation.calibratedMetrics.brierScore.toFixed(4)}</strong><span>Log Loss {backtest.calibrationEvaluation.calibratedMetrics.logLoss.toFixed(4)}</span></div><div><small>測試樣本</small><strong>{backtest.calibrationEvaluation.sampleSize.toLocaleString()}</strong><span>僅計入有前季訓練資料的賽季</span></div></div><p className="method-note">{backtest.calibrationEvaluation.improvedBrier ? '目前跨季測試中，校準後 Brier Score 有改善；仍需持續觀察新賽季。' : '目前跨季測試未證明校準能改善 Brier Score，因此不應自動取代原始模型勝率。'}</p></> : <div className="empty">尚無足夠的前季資料建立校準器。</div>}</section>}<div className="performance-grid"><div className="perf-card"><Target/><span>賽前預測紀錄</span><strong>{predictionStats.total}</strong><small>只保存開賽前已產生的預測</small></div><div className="perf-card"><Trophy/><span>已結算場次</span><strong>{predictionStats.settled}</strong><small>需先有賽前預測紀錄</small></div><div className="perf-card"><TrendingUp/><span>勝負方向命中率</span><strong>{predictionStats.accuracy===null?'—':(predictionStats.accuracy*100).toFixed(1)+'%'}</strong><small>僅計入已結算預測</small></div><div className="perf-card"><ShieldCheck/><span>Brier Score</span><strong>{predictionStats.brier===null?'—':predictionStats.brier.toFixed(3)}</strong><small>越低越好；0 為完美機率預測</small></div><div className="perf-card"><Activity/><span>平均分差誤差</span><strong>{predictionStats.marginError===null?'—':predictionStats.marginError.toFixed(1)}</strong><small>預測主隊分差與實際分差差距</small></div><div className="perf-card"><ShieldCheck/><span>正式封存紀錄</span><strong>{predictionStats.total}</strong><small>僅計算開賽前完成封存的預測</small></div></div><section className="market-backtest-grid"><div className="panel-title">賽事紀錄結算｜依賽前封存盤口</div>{([{label:'讓分',stats:spreadLedgerStats},{label:'大小分',stats:totalLedgerStats}] as const).map(item=><div className="market-backtest-card" key={item.label}><b>{item.label}命中率</b><strong>{item.stats.hitRate===null?'—':(item.stats.hitRate*100).toFixed(1)+'%'}</strong><span>有效結算 {item.stats.decided} 場</span><small>綠 {item.stats.wins} · 紅 {item.stats.losses} · 走水 {item.stats.pushes}</small><small>有結算紀錄 {item.stats.total} 場</small></div>)}</section><div className="notice"><CircleAlert size={17}/>賽前預測由中央紀錄檔保存；開賽前 60 分鐘正式封存，封存後不回寫預測內容，完賽後依 ESPN 最終比分自動結算。每日初估不列入正式績效；缺少賽前紀錄的歷史場次會標示「無正式紀錄」，不補造預測。</div></>}
      <footer><div className="footer-brand">NBA <b>EDGE</b></div><span>數據研究工具，不構成投注建議。預測不保證結果，請理性評估風險。</span><span>DATA-DRIVEN · ALWAYS VERIFY</span></footer>
    </main>
    {completed.length>0 && <div className="completed-count">已完賽 {completed.length} 場</div>}
  </div>
}
function GameCard({game, odds, teamForm, injuryData, teamMetrics, calibrator, savedPrediction, ledgerStatus, onClick}:{game:Game;odds:OddsRecord|null;teamForm:TeamFormData|null;injuryData:InjuryData|null;teamMetrics:TeamMetricsData|null;calibrator:ProbabilityCalibrator|null;savedPrediction?:PredictionRecord;ledgerStatus:'loading'|'ready'|'error';onClick:()=>void}) {
 const done=game.status.toLowerCase().includes('final')
 const hasScore=game.home.score!==undefined&&game.away.score!==undefined&&game.home.score!==''&&game.away.score!==''
 const live=!done&&hasScore
 const report=analyzeMatch(game,teamForm,injuryData,calibrator,teamMetrics)
 const available=!!report?.available
 const useSaved=!!savedPrediction && (!!savedPrediction.spreadPick || !!savedPrediction.totalPick)
 const homeWin=useSaved?savedPrediction.homeWin:(!done&&available?report!.homeWin:undefined)
 const awayWin=useSaved?savedPrediction.awayWin:(!done&&available?report!.awayWin:undefined)
 const projectedTotal=useSaved?savedPrediction.projectedTotal:(!done&&available?report!.projectedTotal:undefined)
 const projectedMargin=useSaved?savedPrediction.projectedMargin:(!done&&available?report!.projectedMargin:undefined)
 const projectedHome=useSaved?(projectedTotal!==undefined&&projectedMargin!==undefined?(projectedTotal+projectedMargin)/2:undefined):(!done&&available?report!.projectedHome:undefined)
 const projectedAway=useSaved?(projectedTotal!==undefined&&projectedMargin!==undefined?(projectedTotal-projectedMargin)/2:undefined):(!done&&available?report!.projectedAway:undefined)
 const hasPrediction=homeWin!==undefined
 const pickedTeam=hasPrediction?(homeWin!>=0.5?game.home:game.away):null
 const actualWinner=done?((Number(game.home.score)>Number(game.away.score))?game.home:(Number(game.away.score)>Number(game.home.score)?game.away:null)):null
 const pickCorrect=done&&useSaved&&actualWinner? pickedTeam?.id===actualWinner.id : null
 const pickProbability=hasPrediction?Math.max(homeWin!,awayWin!):undefined
 const spreadSettlement=savedPrediction?.spreadPick?.result
 const totalSettlement=savedPrediction?.totalPick?.result
 const settlementLabel=(result?:string)=>result==='win'?'過關':result==='loss'?'未過':result==='push'?'走水':'尚未結算'
 const settlementClass=(result?:string)=>result==='win'?'pick-correct':result==='loss'?'pick-wrong':''
 // Card recommendations only use the Taiwan Sports Lottery market feed, never international odds.
 const lotteryGame=odds?.source?.toLowerCase().includes('taiwan sports lottery')
  ? odds.games.find(x=>x.home_team.toLowerCase()===game.home.name.toLowerCase()&&x.away_team.toLowerCase()===game.away.name.toLowerCase())
  : undefined
 const lotteryBooks=lotteryGame?.bookmakers??[]
 const cardSpread=lotteryBooks.flatMap(b=>b.markets.filter(m=>m.key==='spreads').flatMap(m=>m.outcomes.map(o=>({book:b.title,name:o.name,point:o.point,price:o.price}))))
 const cardTotals=lotteryBooks.flatMap(b=>b.markets.filter(m=>m.key==='totals').flatMap(m=>m.outcomes.map(o=>({book:b.title,name:o.name,point:o.point,price:o.price}))))
 const matchesTeam=(outcome:string,team:Game['home'])=>{
  // Taiwan Sports Lottery may label NBA teams in Traditional Chinese while ESPN
  // supplies English display names. Match both canonical abbreviations and local aliases.
  const normalize=(value:string)=>value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g,'')
  const localAliases:Record<string,string[]> = {
   ATL:['老鷹','亞特蘭大老鷹'],BOS:['塞爾提克','波士頓塞爾提克'],BKN:['籃網','布魯克林籃網'],
   CHA:['黃蜂','夏洛特黃蜂'],CHI:['公牛','芝加哥公牛'],CLE:['騎士','克里夫蘭騎士'],
   DAL:['獨行俠','達拉斯獨行俠'],DEN:['金塊','丹佛金塊'],DET:['活塞','底特律活塞'],
   GSW:['勇士','金州勇士'],HOU:['火箭','休士頓火箭'],IND:['溜馬','印第安納溜馬'],
   LAC:['快艇','洛杉磯快艇'],LAL:['湖人','洛杉磯湖人'],MEM:['灰熊','曼菲斯灰熊','孟菲斯灰熊'],
   MIA:['熱火','邁阿密熱火'],MIL:['公鹿','密爾瓦基公鹿'],MIN:['灰狼','明尼蘇達灰狼'],
   NOP:['鵜鶘','鵜鶘隊','紐奧良鵜鶘','新奧爾良鵜鶘'],NYK:['尼克','紐約尼克'],
   OKC:['雷霆','奧克拉荷馬雷霆'],ORL:['魔術','奧蘭多魔術'],PHI:['76人','費城76人'],
   PHX:['太陽','鳳凰城太陽'],POR:['拓荒者','波特蘭拓荒者'],SAC:['國王','沙加緬度國王'],
   SAS:['馬刺','聖安東尼奧馬刺'],TOR:['暴龍','多倫多暴龍'],UTA:['爵士','猶他爵士'],
   WAS:['巫師','華盛頓巫師']
  }
  const normalized=normalize(outcome)
  const aliases=[team.name,team.displayName,team.abbreviation,team.displayName.split(' ').slice(-1)[0],...(localAliases[team.abbreviation.toUpperCase()]??[])]
    .map(value=>normalize(value||''))
    .filter(value=>value.length>=2)
  return aliases.some(alias=>normalized===alias||normalized.includes(alias)||alias.includes(normalized))
 }
 const spreadGroups=new Map<string,typeof cardSpread>()
 cardSpread.filter(x=>typeof x.point==='number'&&Number.isFinite(x.price)&&x.price>1).forEach(x=>{
  const key=String(x.book)+'|'+String(Math.abs(x.point!))
  const list=spreadGroups.get(key)??[]
  list.push(x);spreadGroups.set(key,list)
 })
 const spreadPicks=report?.available
  ? [...spreadGroups.values()].flatMap(pair=>{
    const home=pair.find(x=>matchesTeam(x.name,game.home))
    const away=pair.find(x=>matchesTeam(x.name,game.away))
    if(!home||!away)return []
    return [home,away].map(x=>{
     const isHome=x===home
     const probability=coverProbability(report.projectedMargin,x.point!,isHome)
     return {...x,isHome,isAway:!isHome,probability,ev:decimalExpectedValue(probability,x.price)}
    })
   })
  : []
 const totalGroups=new Map<string,typeof cardTotals>()
 cardTotals.filter(x=>typeof x.point==='number'&&Number.isFinite(x.price)&&x.price>1).forEach(x=>{
  const key=String(x.book)+'|'+String(x.point)
  const list=totalGroups.get(key)??[]
  list.push(x);totalGroups.set(key,list)
 })
 // Never infer a totals edge from a one-sided quote: compare Over and Under
 // only when both are present at the exact same line and bookmaker.
 const totalPicks=report?.available
  ? [...totalGroups.values()].flatMap(pair=>{
    const over=pair.find(x=>/over|大/i.test(x.name))
    const under=pair.find(x=>/under|小/i.test(x.name))
    if(!over||!under)return []
    return [over,under].map(x=>{
     const isOver=x===over
     const probability=totalProbability(report.projectedTotal,x.point!,isOver,report.totalStdDev)
     return {...x,isOver,probability,ev:decimalExpectedValue(probability,x.price)}
    })
   })
  : []
 // EV ranks both directions; negative EV remains visible as a reference, not a value bet.
 const bestSpreadCandidate=spreadPicks.filter(x=>Number.isFinite(x.ev)&&Number.isFinite(x.probability)).sort((a,b)=>b.ev-a.ev||b.probability-a.probability)[0]
 const bestTotalCandidate=totalPicks.filter(x=>Number.isFinite(x.ev)&&Number.isFinite(x.probability)).sort((a,b)=>b.ev-a.ev||b.probability-a.probability)[0]
 // Do not turn the better of two weak sides into a formal recommendation.
 const qualifies=(pick:{probability:number;ev:number}|undefined)=>!!pick&&pick.ev>=0.025&&pick.probability>=0.54&&report?.confidence!=='低'&&report?.injuryRisk!=='待確認'&&report?.injuryRisk!=='偏高'
 // Always show the model's strongest paired-line direction; qualification is a separate label.
 const bestSpread=bestSpreadCandidate
 const bestTotal=bestTotalCandidate
 const spreadQualified=qualifies(bestSpreadCandidate)
 const totalQualified=qualifies(bestTotalCandidate)
 const confidenceLabel=(pick:{probability:number;ev:number}|undefined,qualified:boolean)=>!pick?'':qualified?(pick.ev>=0.08&&pick.probability>=0.60&&report?.confidence==='高'&&report.injuryRisk==='低'?'正式推薦｜較強信號':'正式推薦｜一般信號'):'分析傾向｜未達正式推薦門檻'
 const spreadLabel=bestSpread?(bestSpread.isHome?game.home.abbreviation:game.away.abbreviation)+' '+(bestSpread.point!>0?'+':'')+bestSpread.point:''
 const totalLabel=bestTotal?(bestTotal.isOver?'大':'小')+' '+bestTotal.point:''
 const unverified=done&&!useSaved&&ledgerStatus==='ready'
 const time = new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}).format(new Date(game.date))
 return <button className={'game-card'+(unverified?' prediction-unverified':'')} onClick={onClick}>
  <div className="game-top"><span className={done?'game-state done':live?'game-state live':'game-state'}>{done?'FINAL':live?'LIVE · '+(game.detail||'比賽進行中'):game.detail || '即將開賽'}</span><span>{done?'完賽':time+' 台灣時間'}</span></div>
  <div className="teams"><TeamLine team={game.away}/><div className="versus">{hasScore?<div className={'final-score'+(live?' live-score':'')}><b>{game.away.score}</b><small>:</small><b>{game.home.score}</b></div>:'VS'}</div><TeamLine team={game.home}/></div>
  <div className={'game-prediction-summary'+(!hasPrediction?' prediction-pending':'')+(pickCorrect===true?' pick-correct':pickCorrect===false?' pick-wrong':'')+(unverified?' prediction-unverified':'')}>
   <div className="pick-team-cell"><small>預測勝方</small>{done&&!useSaved&&ledgerStatus==='loading'?<b className="pick-unverified">賽前紀錄載入中</b>:done&&!useSaved&&ledgerStatus==='error'?<b className="pick-unverified">紀錄暫時無法讀取</b>:unverified?<b className="pick-unverified">未留存賽前預測</b>:hasPrediction?(pickedTeam!.logo?<img className="pick-team-logo" src={pickedTeam!.logo} alt={pickedTeam!.displayName} title={pickedTeam!.displayName}/>:<b className="pick-team-fallback">{pickedTeam!.abbreviation}</b>):<b className="pick-unverified">{report?.reason||'球隊近期資料尚未配對'}</b>}<strong>{hasPrediction?(pickProbability!*100).toFixed(1)+'%':'—'}</strong><em>{pickCorrect===true?'預測命中':pickCorrect===false?'預測未中':unverified?'不補算命中率':hasPrediction?'獨贏信心：'+(pickProbability!>=0.68&&report?.confidence==='高'&&report.injuryRisk==='低'?'高':pickProbability!>=0.58&&report?.injuryRisk!=='待確認'&&report?.injuryRisk!=='偏高'?'中':'一般')+' · '+(useSaved?'正式封存':'每日初估') :'模型資料不足，暫無預測'}</em></div>
   <div><small>預測比分</small><b>{projectedAway!==undefined&&projectedHome!==undefined?projectedAway.toFixed(0)+' : '+projectedHome.toFixed(0):'—'}</b><em>{done&&!useSaved&&ledgerStatus==='loading'?'賽前紀錄載入中':done&&!useSaved&&ledgerStatus==='error'?'紀錄暫時無法讀取':unverified?'未留存賽前預測':useSaved?'賽前封存':savedPrediction?.stage==='draft'?'每日滾動初估':'模型預測'}</em></div>
   <div className="market-pick-cell"><small>大小分分析</small><b className={done?settlementClass(totalSettlement):''}>{done?(savedPrediction?.totalPick?((savedPrediction.totalPick.side==='over'?'大 ':'小 ')+savedPrediction.totalPick.line+' · '+settlementLabel(totalSettlement)):'無賽前盤口紀錄'):bestTotal?totalLabel:!report?.available?'資料不足 · 暫無預測':lotteryGame?'大小分盤口未配對':'盤口未同步'}</b><em>{done?(savedPrediction?.totalPick?'賽前命中率 '+(savedPrediction.totalPick.probability*100).toFixed(1)+'% · 賠率 '+savedPrediction.totalPick.price:'舊賽事無法補造盤口與結算'):bestTotal?confidenceLabel(bestTotal,totalQualified)+' · '+(bestTotal.probability*100).toFixed(1)+'% · EV '+(bestTotal.ev*100).toFixed(1)+'%':!report?.available?(report?.reason||'模型資料尚未載入'):lotteryGame?'尚未取得同線雙邊大小分盤口':'等待台灣運彩盤口'}</em></div>
   <div className="market-pick-cell"><small>讓分分析</small><b className={done?settlementClass(spreadSettlement):''}>{done?(savedPrediction?.spreadPick?(savedPrediction.spreadPick.side+' '+(savedPrediction.spreadPick.line>0?'+':'')+savedPrediction.spreadPick.line+' · '+settlementLabel(spreadSettlement)):'無賽前盤口紀錄'):bestSpread?spreadLabel:!report?.available?'模型待補資料':lotteryGame?'讓分隊伍或盤口未配對':'盤口未同步'}</b><em>{done?(savedPrediction?.spreadPick?(savedPrediction.spreadPick.probability!==undefined&&savedPrediction.spreadPick.price!==undefined?'賽前過盤率 '+(savedPrediction.spreadPick.probability*100).toFixed(1)+'% · 賠率 '+savedPrediction.spreadPick.price:'原始推薦方向已恢復；原始過盤率與賠率無可驗證資料'):'舊賽事無法補造盤口與結算'):bestSpread?confidenceLabel(bestSpread,spreadQualified)+' · '+(bestSpread.probability*100).toFixed(1)+'% · EV '+(bestSpread.ev*100).toFixed(1)+'%':!report?.available?(report?.reason||'模型資料尚未載入'):lotteryGame?'尚未配對有效讓分隊伍':'等待台灣運彩盤口'}</em></div>
  </div>
 </button>
}
function TeamLine({team}:{team:Game['home']}) { return <div className="team-line">{team.logo?<img src={team.logo} alt="" />:<span className="team-placeholder">{team.abbreviation}</span>}<div><b>{team.abbreviation}</b><small>{team.displayName}</small></div></div> }
export default App