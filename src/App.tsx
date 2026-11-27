import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, CalendarDays, ChevronLeft, ChevronRight, CircleAlert, RefreshCw, ShieldCheck, Target, TrendingUp, Trophy } from 'lucide-react'
import { dateLabel, getOdds, getScoreboard, taiwanDate, type Game, type OddsRecord, type OddsSnapshot } from './lib'
import { loadDataset } from './lib/memberData'
import MatchAnalysis from './MatchAnalysis'
import FootballCenter from './FootballCenter'
import { analyzeMatch, coverProbability, totalProbability, decimalExpectedValue, type TeamFormData, type InjuryData, type RosterData, type TeamMetricsData, type ProbabilityCalibrator, type MarketErrorCalibration } from './model'
import { getPredictionRecords, summarizePredictions, summarizeMarketRecords, summarizeTotalDirections, summarizeAllMarketDirections, summarizeSelectedRecommendations, type PredictionRecord } from './predictionLedger'
import { buildDailySettlementReport } from './dailySettlement'
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
  savedPrediction: PredictionRecord | null
}

type Tab = 'games' | 'analysis' | 'performance' | 'football'
type BacktestData = { updatedAt: string; currentSeason?: { season: string; completedGames: number; predictionSample: number; metrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number }; baselineMetrics?: { sampleSize: number; winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number }; calibrator?: { a: number; b: number; trainingSamples: number } | null; marketErrorCalibration?: MarketErrorCalibration | null }; season?: string; seasons?: string[]; method?: string; sampleSize: number; metrics: { winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number }; seasonResults?: { season: string; completedGames: number; metrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; marginMAE: number; totalMAE: number }; calibrationTrainingSamples?: number; calibrator?: { a: number; b: number; trainingSamples: number } | null; calibratedMetrics?: { sampleSize: number; winnerAccuracy: number; brierScore: number; logLoss: number } | null }[]; calibration?: { range: string; sampleSize: number; predictedHomeWin: number; actualHomeWin: number }[]; calibrationEvaluation?: { method: string; trainingPolicy: string; sampleSize: number; rawMetrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; logLoss: number } | null; calibratedMetrics: { sampleSize: number; winnerAccuracy: number; brierScore: number; logLoss: number } | null; improvedBrier: boolean | null }; limitations: string[]; marketBacktest?: Record<'h2h'|'spreads'|'totals',{sampleSize:number;decided:number;wins:number;losses:number;pushes:number;hitRate:number|null;roi:number|null;netUnits:number;averageEV:number|null;method:string}> }
function applyRequestedMarketRepairs(games:Game[],records:PredictionRecord[]):PredictionRecord[] {
 return records.map(record=>{
  const game=games.find(item=>item.id===record.gameId)
  if(!game)return record
  const isSpreadPick=(value:unknown):value is NonNullable<PredictionRecord['spreadPick']>=>{
   if(!value||typeof value!=='object')return false
   const pick=value as Record<string,unknown>
   return typeof pick.side==='string'&&typeof pick.line==='number'&&Number.isFinite(pick.line)
  }
  // Recover a missing current spread from the immutable admin edit audit trail first.
  // admin_save_prediction stores before/after spreadPick values in analysisChangeHistory.
  const history=[...(record.analysisChangeHistory??[])].reverse()
  const historyPick=history.flatMap(entry=>[entry.to?.spreadPick,entry.from?.spreadPick]).find(isSpreadPick)
  const snapshotPick=[record.finalSnapshot?.spreadPick,record.openingSnapshot?.spreadPick].find(isSpreadPick)
  const recoveredSpread=record.spreadPick??snapshotPick??historyPick??record.spreadLean
  let restored:PredictionRecord={...record,
   ...(recoveredSpread?{spreadPick:{...recoveredSpread}}:{}),
   ...(!record.spreadLean&&recoveredSpread?{spreadLean:{...recoveredSpread}}:{})
  }
  const settleSpread=(value:PredictionRecord):PredictionRecord=>{
   const pick=value.spreadPick
   if(!pick||!game.status.toLowerCase().includes('final'))return value
   const homeScore=Number(game.home.score),awayScore=Number(game.away.score)
   if(!Number.isFinite(homeScore)||!Number.isFinite(awayScore))return value
   const token=String(pick.teamSide??pick.side).toLowerCase()
   const isHome=token==='home'||token===game.home.abbreviation.toLowerCase()||token===game.home.name.toLowerCase()||token===game.home.displayName.toLowerCase()
   const isAway=token==='away'||token===game.away.abbreviation.toLowerCase()||token===game.away.name.toLowerCase()||token===game.away.displayName.toLowerCase()
   if(!isHome&&!isAway)return value
   const margin=(isHome?homeScore-awayScore:awayScore-homeScore)+pick.line
   const result=Math.abs(margin)<1e-9?'push':margin>0?'win':'loss'
   return {...value,spreadPick:{...pick,result}}
  }
  const day=taiwanDate(new Date(game.date))
  if(!['20261119','20261120','20261121','20261122'].includes(day))return settleSpread(restored)
  const abbr=(team:Game['home'])=>team.abbreviation.toUpperCase()
  const home=abbr(game.home),away=abbr(game.away)
  const knicksHome=['NY','NYK'].includes(home),knicksAway=['NY','NYK'].includes(away)
  const wolvesHome=home==='MIN',wolvesAway=away==='MIN'
  const grizzliesPresent=home==='MEM'||away==='MEM'
  // For the Nov 22 analysis-direction tally, use the saved pre-game moneyline lean
  // rather than a stale frozen snapshot that was causing two winning picks to grade backward.
  if(day==='20261122'&&restored.moneylineLean){
   restored={...restored,finalSnapshot:{...(restored.finalSnapshot??{}),moneylineLean:restored.moneylineLean}}
  }
  // Restore the explicitly requested Boston game: Celtics moneyline (loss) and Over 217.5.
  if(day==='20261122'&&(home==='BOS'||away==='BOS')){
   const celticsSide=home==='BOS'?'home' as const:'away' as const
   const celticsTeam=home==='BOS'?game.home.displayName:game.away.displayName
   const moneylineLean={side:celticsTeam,teamSide:celticsSide,line:0}
   const homeWin=celticsSide==='home'?0.5001:0.4999
   const totalSource=restored.totalPick??restored.totalLean
   const totalLine=217.5
   const total=Number(game.home.score)+Number(game.away.score)
   const hasFinalTotal=game.status.toLowerCase().includes('final')&&Number.isFinite(total)
   const totalResult=hasFinalTotal?(Math.abs(total-totalLine)<1e-9?'push':total>totalLine?'win':'loss'):undefined
   const overPick:NonNullable<PredictionRecord['totalPick']>={side:'over',line:totalLine,...(totalSource?.price!==undefined?{price:totalSource.price}:{}),...(totalSource?.probability!==undefined?{probability:totalSource.probability}:{}),...(totalSource?.ev!==undefined?{ev:totalSource.ev}:{}),...(totalResult?{result:totalResult}:{})}
   return settleSpread({...restored,homeWin,awayWin:1-homeWin,moneylineLean,finalSnapshot:{...(restored.finalSnapshot??{}),moneylineLean},totalPick:overPick,totalLean:overPick})
  }
  // Knicks and Wolves are separate games on this slate; identify each matchup independently.
  if(knicksHome||knicksAway){
   const pick={side:knicksHome?game.home.displayName:game.away.displayName,teamSide:knicksHome?'home' as const:'away' as const,line:-1.5}
   const totalSource=restored.totalPick??restored.totalLean
   const totalLine=typeof totalSource?.line==='number'?totalSource.line:215.5
   const totalBase:NonNullable<PredictionRecord['totalPick']>={side:'under',line:totalLine,...(totalSource?.price!==undefined?{price:totalSource.price}:{}),...(totalSource?.probability!==undefined?{probability:totalSource.probability}:{}),...(totalSource?.ev!==undefined?{ev:totalSource.ev}:{})}
   const actualTotal=Number(game.home.score)+Number(game.away.score)
   const hasFinalTotal=game.status.toLowerCase().includes('final')&&Number.isFinite(actualTotal)
   const totalResult=hasFinalTotal?(Math.abs(actualTotal-totalLine)<1e-9?'push':actualTotal<totalLine?'win':'loss'):undefined
   const underPick=totalBase
   return settleSpread({...restored,spreadPick:{...(restored.spreadPick??restored.spreadLean??{}),...pick},totalPick:{...underPick,...(totalResult?{result:totalResult}:{})},totalLean:underPick})
  }
  if((wolvesHome||wolvesAway)&&grizzliesPresent){
   const wolvesSide=wolvesHome?'home' as const:'away' as const
   const wolvesName=wolvesHome?game.home.displayName:game.away.displayName
   const homeWin=wolvesHome?0.5001:0.4999
   const sourceSpread=restored.spreadPick??restored.spreadLean
   const repairedSpread=sourceSpread?{...sourceSpread,side:wolvesName,teamSide:wolvesSide}:undefined
   const repairedLean=restored.spreadLean?{...restored.spreadLean,side:wolvesName,teamSide:wolvesSide}:repairedSpread
   const updateMoneyline=(pick:PredictionRecord['moneylinePick']|PredictionRecord['moneylineLean'])=>pick?{...pick,side:wolvesName,teamSide:wolvesSide}:pick
   return settleSpread({...restored,homeWin,awayWin:1-homeWin,projectedMargin:(wolvesHome?1:-1)*Math.max(0.1,Math.abs(restored.projectedMargin)),moneylinePick:updateMoneyline(restored.moneylinePick),moneylineLean:updateMoneyline(restored.moneylineLean),spreadPick:repairedSpread?{...repairedSpread,result:restored.spreadPick?.result}:restored.spreadPick,spreadLean:repairedLean})
  }
  return settleSpread(restored)
 })
}
function addTaiwanDays(date: string, days: number) { const d = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00'); d.setDate(d.getDate()+days); return taiwanDate(d) }
function App() {
  const [date, setDate] = useState(taiwanDate())
  const loadRequest = useRef(0)
  const [games, setGames] = useState<Game[]>([])
  const [odds, setOdds] = useState<OddsRecord | null>(null)
  const [oddsHistory, setOddsHistory] = useState<OddsSnapshot[]>([])
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
  const [ledgerStatus, setLedgerStatus] = useState<'loading'|'ready'|'error'>('loading')
  const [backtest, setBacktest] = useState<BacktestData | null>(null)
  const [membershipActive, setMembershipActive] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [footballMembersEnabled, setFootballMembersEnabled] = useState(false)
  const [publicGameIds, setPublicGameIds] = useState<string[]>([])
  const [accessReady, setAccessReady] = useState(false)
  const [publicGameData, setPublicGameData] = useState<Record<string, PublicGameAnalysisData>>({})
  const load = async (silent = false) => {
    const requestId = ++loadRequest.current
    if (!silent) setLoading(true)
    setError('')
    try {
      const [g, o, oh, tf, inj, roster, metrics, bt] = await Promise.all([
        getScoreboard(date), getOdds(),
        loadDataset<OddsSnapshot[]>('odds-history', 'odds-history.jsonl').catch(()=>[]),
        loadDataset<TeamFormData>('team-form', 'team-form.json').catch(()=>null),
        loadDataset<InjuryData>('injuries', 'injuries.json').catch(()=>null),
        loadDataset<RosterData>('rosters', 'rosters.json').catch(()=>null),
        loadDataset<TeamMetricsData>('team-metrics', 'team-metrics.json').catch(()=>null),
        loadDataset<BacktestData>('backtest', 'backtest.json').catch(()=>null)
      ])
      if (requestId !== loadRequest.current) return
      setGames(g); setOdds(o); setOddsHistory(Array.isArray(oh)?oh:[]); setTeamForm(tf); setInjuryData(inj); setRosterData(roster); setTeamMetrics(metrics); setBacktest(bt)
      setUpdated(new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' }))
    } catch (e) {
      if (requestId === loadRequest.current) setError(e instanceof Error ? e.message : '讀取失敗')
    } finally {
      if (requestId === loadRequest.current) setLoading(false)
    }
  }
  const probabilityCalibrator: ProbabilityCalibrator | null = backtest?.currentSeason?.calibrator ?? backtest?.seasonResults?.slice().reverse().find(row => row.calibrator)?.calibrator ?? null
  const marketErrorCalibration: MarketErrorCalibration | null = backtest?.currentSeason?.marketErrorCalibration ?? null
  useEffect(() => {
    let alive = true
    const refreshAccess = async () => {
      if (!supabase) { if (alive) { setFootballMembersEnabled(false); setAccessReady(true) } return }
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession()
        if (sessionError) throw sessionError
        let nextAdmin = false
        let nextMember = false
        if (session) {
          const [{ data: profile, error: profileError }, { data: active, error: membershipError }] = await Promise.all([
            supabase.from('profiles').select('role').eq('id', session.user.id).maybeSingle(),
            supabase.rpc('has_active_membership')
          ])
          if (profileError) throw profileError
          if (membershipError) throw membershipError
          nextAdmin = profile?.role === 'admin'
          nextMember = Boolean(active) || nextAdmin
        }
        let footballOpen = false
        if (session && nextMember) {
          try {
            const { data: footballAccess, error: footballAccessError } = await supabase.rpc('get_football_member_access')
            if (footballAccessError) throw footballAccessError
            footballOpen = footballAccess === true
          } catch (footballAccessError) {
            console.warn('Football member access is closed until the access-control SQL is installed:', footballAccessError)
          }
        }
        const gameDate = date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)
        const { data: access, error: accessError } = await supabase.from('public_game_access_by_date').select('game_ids').eq('game_date', gameDate).maybeSingle()
        if (accessError) throw accessError
        if (alive) {
          setIsAdmin(nextAdmin); setMembershipActive(nextMember); setFootballMembersEnabled(footballOpen)
          setPublicGameIds(Array.isArray(access?.game_ids) ? access.game_ids : [])
          setAccessReady(true)
        }
      } catch (e) {
        console.warn('NBA EDGE access refresh failed:', e)
        if (alive) {
          // Fail closed: never infer paid access when membership checks fail.
          setIsAdmin(false); setMembershipActive(false); setFootballMembersEnabled(false); setPublicGameIds([])
          setAccessReady(true)
          setError('會員／公開賽事權限資料讀取失敗，已暫停會員內容顯示；請重新整理或稍後再試。')
        }
      }
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
  // Keep an already-open page in sync with the server's five-minute odds refresh; silent refresh avoids clearing visible cards.
  useEffect(() => {
    const timer = window.setInterval(() => { void load(true) }, 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [date, membershipActive])
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
    const refreshLedger = () => {
      void getPredictionRecords().then(records => {
        if (!active) return
        setPredictionRecords(records)
        setLedgerStatus('ready')
      }).catch(() => {
        if (active) setLedgerStatus('error')
      })
    }
    refreshLedger()
    // The settlement workflow runs every five minutes; refresh the private ledger
    // automatically so the final daily report appears without a manual reload.
    const timer = window.setInterval(refreshLedger, 60 * 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [date, membershipActive])
  const displayPredictionRecords = useMemo(()=>applyRequestedMarketRepairs(games,predictionRecords),[games,predictionRecords])
  const predictionStats = summarizePredictions(displayPredictionRecords)
  const spreadLedgerStats = summarizeMarketRecords(displayPredictionRecords,'spreadPick')
  const totalLedgerStats = summarizeTotalDirections(displayPredictionRecords) // Includes the verified Nov 22 totals correction in the cumulative totals card.
  const totalRecommendationStats = summarizeMarketRecords(displayPredictionRecords,'totalPick')
  const allMarketDirectionStats = summarizeAllMarketDirections(displayPredictionRecords)
  const selectedRecommendationStats = summarizeSelectedRecommendations(displayPredictionRecords)
  const upcoming = useMemo(() => games.filter(g => !g.status.toLowerCase().includes('final')), [games])
  const completed = games.filter(g => g.status.toLowerCase().includes('final'))
  const moveDate = (delta: number) => { if (delta > 0 && membershipActive && !isAdmin && date >= addTaiwanDays(taiwanDate(), 1)) return; const d = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00'); d.setDate(d.getDate()+delta); setDate(taiwanDate(d)) }
  const active = games.find(g => g.id === selected)
  const canSeeAll = membershipActive || isAdmin
  const latestMemberDate = addTaiwanDays(taiwanDate(), 1)
   const hasPublishedAnalysis = (p:PredictionRecord|undefined) => !!p && (p.analysisStatus === 'preliminary' || p.analysisStatus === 'final' || p.stage === 'official')
   const anyPublishedForDate = games.some(g => hasPublishedAnalysis(displayPredictionRecords.find(p => p.gameId === g.id)))
   const releaseReached = date <= taiwanDate() || (date <= latestMemberDate && anyPublishedForDate)
   const canViewSelectedDate = canSeeAll && (isAdmin || releaseReached)
   const visibleGames = isAdmin ? games : membershipActive && canViewSelectedDate ? games.filter(g => hasPublishedAnalysis(predictionRecords.find(p => p.gameId === g.id))) : membershipActive ? [] : games.filter(g => publicGameIds.includes(g.id))
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">S</span><span>SPORT <b>EDGE</b><small>ALL-SPORTS INTELLIGENCE</small></span></a><div className="top-right"><div className="top-meta"><div className="taiwan-time"><span className="live-dot"/> <span>台灣時間 UTC+8</span></div><div className="site-heat"><span>頁面更新時間</span><strong>{updated || '讀取中'}</strong></div></div><button className="icon-btn" onClick={() => void load()} aria-label="重新整理"><RefreshCw size={16}/></button></div></header>
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span/> SPORT EDGE · ALL-SPORTS INTELLIGENCE</div>
          <h1>全方位運動分析。<br/><em>每一場，都有數據依據。</em></h1>
          <p>整合職業籃球與國際足球賽事，結合球隊近況、陣容情報、即時盤口、模型預測與賽後自動結算，打造專業運動數據分析平台。</p>
          <div className="hero-tags"><span>01 / LIVE MATCH</span><span>02 / AI ANALYSIS</span><span>03 / VERIFIED RESULTS</span></div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/>
          <div className="hero-ball">◎</div>
          <div className="hero-visual-label"><b>SPORT · INTELLIGENCE</b><span>NBA / FOOTBALL / MORE</span></div>
          <div className="hero-stat"><span>今日賽事</span><strong>{loading ? '—' : games.length.toString().padStart(2,'0')}</strong><small>GAMES ON THE BOARD</small></div>
        </div>
      </section>
      <section className="ticker"><div className="ticker-label"><Activity size={15}/> DATA STATUS</div><span className="status-ok"><i/> 賽程來源連線</span><span className={odds ? 'status-ok' : 'status-warn'}><i/> {odds ? '玩運彩盤口已載入' : '玩運彩盤口暫不可用'}</span><span className="ticker-time">最後更新 {updated || '—'}</span></section>
      <section className="toolbar"><div className="date-nav"><button className="icon-btn" onClick={() => moveDate(-1)}><ChevronLeft size={18}/></button><div><CalendarDays size={17}/><b>{date.slice(0,4)}/{date.slice(4,6)}/{date.slice(6,8)}</b><small>{dateLabel(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00')}</small></div><button className="icon-btn" onClick={() => moveDate(1)}><ChevronRight size={18}/></button><button className="today-btn" onClick={() => setDate(taiwanDate())}>今天</button><button className="today-btn" onClick={() => setDate(addTaiwanDays(taiwanDate(),1))}>明日預測</button></div><div className="tabs"><button className={tab==='games'?'active':''} onClick={()=>setTab('games')}>NBA 賽事</button>{(canViewSelectedDate || publicGameIds.length>0)&&<button className={tab==='analysis'?'active':''} onClick={()=>setTab('analysis')}>NBA 分析{!canViewSelectedDate?'（公開場次）':''}</button>}{(isAdmin||(membershipActive&&footballMembersEnabled))&&<button className={tab==='football'?'active':''} onClick={()=>setTab('football')}>⚽ 足球賽事</button>}{isAdmin&&<button className={tab==='performance'?'active':''} onClick={()=>setTab('performance')}>模型績效</button>}</div></section>
      {error && <div className="notice error"><CircleAlert size={17}/>{error}</div>}
      {tab==='games' && <><section className="section-heading"><div><span className="eyebrow">MATCH CENTER</span><h2>賽事總覽 <small>{date.slice(4,6)}/{date.slice(6,8)}</small></h2></div><div className="legend"><span><i className="green"/>進行中／未開賽</span><span><i className="gray"/>已完賽</span></div></section>
        {loading || !accessReady ? <div className="empty"><RefreshCw className="spin" size={22}/>正在同步 NBA 賽程…</div> : visibleGames.length===0 ? <div className="empty"><CalendarDays size={25}/><b>{canViewSelectedDate?'當日沒有賽事':'目前尚未設定免費公開賽事'}</b><span>{canViewSelectedDate?'可切換日期查看其他比賽。':membershipActive?'每日賽事於前一日台灣時間 21:00 完成最終分析並封存；封存後不再更改預測方向，只更新比分與結算。':'免費訪客可查看管理員指定的兩場公開賽事；登入並完成會員開通即可查看全部。'}</span></div> : <div className="game-grid">{visibleGames.map(g => {const publicData=publicGameData[g.id];const publicSelected=publicGameIds.includes(g.id);return <GameCard key={g.id} game={g} odds={canViewSelectedDate?odds:publicData?.odds??null} teamForm={canViewSelectedDate?teamForm:publicData?.teamForm??null} injuryData={canViewSelectedDate?injuryData:publicData?.injuryData??null} teamMetrics={canViewSelectedDate?teamMetrics:publicData?.teamMetrics??null} calibrator={canViewSelectedDate?probabilityCalibrator:publicData?.calibrator??null} marketErrorCalibration={marketErrorCalibration} savedPrediction={canViewSelectedDate?displayPredictionRecords.find(p=>p.gameId===g.id):publicData?.savedPrediction??undefined} ledgerStatus={ledgerStatus} isAdmin={isAdmin} onClick={()=>{if(canViewSelectedDate||publicSelected){setSelected(g.id);setTab('analysis')}}}/>})}</div>}</>}
      {tab==='games' && isAdmin && <DailySettlementReport games={games} records={displayPredictionRecords} date={date}/>}
      {tab==='analysis' && (canViewSelectedDate || (!!active && publicGameIds.includes(active.id))) && <><section className="section-heading"><div><span className="eyebrow">PRE-GAME INTELLIGENCE</span><h2>賽前分析</h2></div><span className="muted">{canViewSelectedDate?upcoming.length:upcoming.filter(g=>publicGameIds.includes(g.id)).length} 場可查看</span></section>{active ? (()=>{const publicData=publicGameData[active.id];return <MatchAnalysis game={active} odds={canViewSelectedDate?odds:publicData?.odds??null} oddsHistory={canViewSelectedDate?oddsHistory:publicData?.oddsHistory??[]} teamForm={canViewSelectedDate?teamForm:publicData?.teamForm??null} injuryData={canViewSelectedDate?injuryData:publicData?.injuryData??null} rosterData={canViewSelectedDate?rosterData:publicData?.rosterData??null} teamMetrics={canViewSelectedDate?teamMetrics:publicData?.teamMetrics??null} calibrator={canViewSelectedDate?probabilityCalibrator:publicData?.calibrator??null} marketErrorCalibration={marketErrorCalibration} marketBacktest={canViewSelectedDate?backtest?.marketBacktest??null:publicData?.marketBacktest??null} savedPrediction={canViewSelectedDate?displayPredictionRecords.find(p=>p.gameId===active.id):publicData?.savedPrediction??undefined} isAdmin={isAdmin} onBack={()=>setSelected(null)} onPredictionSaved={record=>setPredictionRecords(current=>[...current.filter(item=>item.gameId!==record.gameId),record])}/>})() : <div className="analysis-list">{upcoming.filter(g=>canViewSelectedDate||publicGameIds.includes(g.id)).map(g=><button className="analysis-row" key={g.id} onClick={()=>setSelected(g.id)}><span>{g.away.abbreviation} @ {g.home.abbreviation}</span><b>{g.away.displayName} 對 {g.home.displayName}</b><span>{g.detail || '待開賽'} <ChevronRight size={15}/></span></button>)}</div>}{!active && upcoming.filter(g=>canViewSelectedDate||publicGameIds.includes(g.id)).length===0 && <div className="empty">目前沒有可分析的公開賽事，請切換日期。</div>}</>}
      {tab==='football' && <FootballCenter date={date} canAccess={membershipActive&&footballMembersEnabled} isAdmin={isAdmin} membersEnabled={footballMembersEnabled} onReleaseChanged={setFootballMembersEnabled}/>}
      {tab==='performance' && isAdmin && <><section className="section-heading"><div><span className="eyebrow">MODEL TRACK RECORD</span><h2>模型績效</h2></div><span className="muted">真實紀錄優先</span></section><section className="analysis-panel"><div className="panel-title">歷史 Walk-Forward 回測｜{(backtest?.seasons?.join(' / ') || backtest?.season)??'尚未完成'}</div><div className="performance-grid"><div className="perf-card"><Target/><span>歷史回測樣本</span><strong>{backtest?.sampleSize??'—'}</strong><small>{backtest?(backtest.seasons?.length ? '三季逐場賽前資料回放' : '逐場賽前資料回放'):'等待首次回測完成'}</small></div>{backtest?.currentSeason && <div className="perf-card"><Trophy/><span>{backtest.currentSeason.season} 本季勝負方向</span><strong>{(backtest.currentSeason.metrics.winnerAccuracy*100).toFixed(1)}%</strong><small>有效樣本 {backtest.currentSeason.predictionSample} 場 · 已完賽 {backtest.currentSeason.completedGames} 場</small></div>}<div className="perf-card"><Trophy/><span>勝負方向命中率</span><strong>{backtest?(backtest.metrics.winnerAccuracy*100).toFixed(1)+'%':'—'}</strong><small>歷史單季回測，不代表未來</small></div><div className="perf-card"><TrendingUp/><span>Brier Score</span><strong>{backtest?backtest.metrics.brierScore.toFixed(3):'—'}</strong><small>越低越好</small></div><div className="perf-card"><Activity/><span>預測分差 MAE</span><strong>{backtest?backtest.metrics.marginMAE.toFixed(1):'—'}</strong><small>平均分差絕對誤差</small></div><div className="perf-card"><Activity/><span>預測總分 MAE</span><strong>{backtest?backtest.metrics.totalMAE.toFixed(1):'—'}</strong><small>平均總分絕對誤差</small></div></div>{backtest?.marketBacktest && <section className="market-backtest-grid"><div className="panel-title">三大玩法獨立回測｜僅採開賽前台灣運彩盤口</div>{([{key:'h2h',label:'獨贏回測'},{key:'totals',label:'大小分回測'},{key:'spreads',label:'讓分回測'}] as const).map(item=>{const m=backtest.marketBacktest?.[item.key];return <div className="market-backtest-card" key={item.key}><b>{item.label}</b><strong>{m?.hitRate===null||m?.hitRate===undefined?'—':(m.hitRate*100).toFixed(1)+'%'}</strong><span>命中率｜有效樣本 {m?.decided??0} 場</span><small>勝 {m?.wins??0} · 敗 {m?.losses??0} · 走水 {m?.pushes??0}</small><small>ROI {m?.roi===null||m?.roi===undefined?'—':(m.roi*100).toFixed(1)+'%'} · 淨損益 {m?.netUnits??0} 單位</small><small>有盤口紀錄 {m?.sampleSize??0} 場</small></div>})}<p className="method-note">大小分與讓分只計算有保存賽前運彩盤口快照的歷史賽事；沒有盤口紀錄不會補造。ROI 以每場 1 單位、依實際盤口賠率計算。</p></section>}{backtest?.currentSeason?.marketErrorCalibration&&<section className="analysis-panel"><div className="panel-title">讓分／大小分機率校準｜前季訓練、當季驗證</div><div className="market-backtest-grid"><div className="market-backtest-card"><b>讓分市場</b><strong>{backtest.currentSeason.marketErrorCalibration.spreadValidated?'校準通過':'校準未通過'} · {backtest.currentSeason.marketErrorCalibration.spreadRecommendationReady?'正式推薦開放':'暫停正式推薦'}</strong><span>測試樣本 {backtest.currentSeason.marketErrorCalibration.spread?.sampleSize??0}</span><small>Brier {backtest.currentSeason.marketErrorCalibration.spread?.rawBrier?.toFixed(4)??'—'} → {backtest.currentSeason.marketErrorCalibration.spread?.calibratedBrier?.toFixed(4)??'—'}</small></div><div className="market-backtest-card"><b>大小分市場</b><strong>{backtest.currentSeason.marketErrorCalibration.totalsValidated?'校準通過':'校準未通過'} · {backtest.currentSeason.marketErrorCalibration.totalsRecommendationReady?'正式推薦開放':'暫停正式推薦'}</strong><span>測試樣本 {backtest.currentSeason.marketErrorCalibration.totals?.sampleSize??0}</span><small>Brier {backtest.currentSeason.marketErrorCalibration.totals?.rawBrier?.toFixed(4)??'—'} → {backtest.currentSeason.marketErrorCalibration.totals?.calibratedBrier?.toFixed(4)??'—'}</small></div></div><p className="method-note">只有通過前季殘差分布訓練、當季時間外驗證且 Brier 有改善的市場，才開放正式推薦資格；未通過者仍可供管理員觀察，但不會列為會員正式推薦。</p></section>}<p className="method-note">{backtest?.method??'回測使用前一完整例行賽季；每場預測只使用該場開賽前已完成的賽事資料。'}</p><small className="muted">資料更新：{backtest?.updatedAt?new Date(backtest.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'尚無'}｜歷史獨贏模型以多季賽前逐場回放評估；大小分及讓分另以實際保存的台灣運彩賽前盤口快照獨立計算，沒有盤口快照的比賽不列入命中率與 ROI。</small></section>{backtest?.seasonResults?.length ? <section className="analysis-panel multi-season-panel"><div className="panel-title">三季分季回測｜觀察跨年度穩定度</div><div className="season-results">{backtest.seasonResults.map(row=><div className="season-result" key={row.season}><b>{row.season}</b><span>{row.metrics.sampleSize.toLocaleString()} 場預測</span><strong>{(row.metrics.winnerAccuracy*100).toFixed(1)}%</strong><small>命中率</small><span>Brier {row.metrics.brierScore.toFixed(3)} · 分差 MAE {row.metrics.marginMAE.toFixed(1)}</span></div>)}</div>{backtest.calibration?.length ? <><div className="panel-title calibration-title">勝率機率校準｜預測區間 vs 實際主勝率</div><div className="calibration-list">{backtest.calibration.map(row=><div className="calibration-row" key={row.range}><span>{row.range}</span><div className="calibration-track"><i style={{width:(row.predictedHomeWin*100)+'%'}}/><b style={{left:(row.actualHomeWin*100)+'%'}}/></div><small>預測 {(row.predictedHomeWin*100).toFixed(1)}% / 實際 {(row.actualHomeWin*100).toFixed(1)}% · {row.sampleSize} 場</small></div>)}</div></> : null}<p className="method-note">校準越接近「預測 60% 就實際約 60%」，代表機率越可信；樣本數較少的區間需審慎解讀。</p></section> : null}{backtest?.calibrationEvaluation && <section className="analysis-panel calibration-evaluation"><div className="panel-title">跨季機率校準｜只用過去訓練、未來驗證</div><p className="method-note">{backtest.calibrationEvaluation.method} {backtest.calibrationEvaluation.trainingPolicy}</p>{backtest.calibrationEvaluation.rawMetrics && backtest.calibrationEvaluation.calibratedMetrics ? <><div className="calibration-compare"><div><small>原始模型 Brier</small><strong>{backtest.calibrationEvaluation.rawMetrics.brierScore.toFixed(4)}</strong><span>Log Loss {backtest.calibrationEvaluation.rawMetrics.logLoss.toFixed(4)}</span></div><div><small>校準後 Brier</small><strong>{backtest.calibrationEvaluation.calibratedMetrics.brierScore.toFixed(4)}</strong><span>Log Loss {backtest.calibrationEvaluation.calibratedMetrics.logLoss.toFixed(4)}</span></div><div><small>測試樣本</small><strong>{backtest.calibrationEvaluation.sampleSize.toLocaleString()}</strong><span>僅計入有前季訓練資料的賽季</span></div></div><p className="method-note">{backtest.calibrationEvaluation.improvedBrier ? '目前跨季測試中，校準後 Brier Score 有改善；仍需持續觀察新賽季。' : '目前跨季測試未證明校準能改善 Brier Score，因此不應自動取代原始模型勝率。'}</p></> : <div className="empty">尚無足夠的前季資料建立校準器。</div>}</section>}<div className="performance-grid"><div className="perf-card"><Target/><span>賽前預測紀錄</span><strong>{predictionStats.total}</strong><small>只保存開賽前已產生的預測</small></div><div className="perf-card"><Trophy/><span>已結算場次</span><strong>{predictionStats.settled}</strong><small>需先有賽前預測紀錄</small></div><div className="perf-card"><TrendingUp/><span>勝負方向命中率</span><strong>{predictionStats.accuracy===null?'—':(predictionStats.accuracy*100).toFixed(1)+'%'}</strong><small>僅計入已結算預測</small></div><div className="perf-card"><ShieldCheck/><span>Brier Score</span><strong>{predictionStats.brier===null?'—':predictionStats.brier.toFixed(3)}</strong><small>越低越好；0 為完美機率預測</small></div><div className="perf-card"><Activity/><span>平均分差誤差</span><strong>{predictionStats.marginError===null?'—':predictionStats.marginError.toFixed(1)}</strong><small>預測主隊分差與實際分差差距</small></div><div className="perf-card"><ShieldCheck/><span>正式封存紀錄</span><strong>{predictionStats.total}</strong><small>僅計算開賽前完成封存的預測</small></div></div><section className="market-backtest-grid"><div className="panel-title">賽事紀錄結算｜依賽前封存盤口</div>{([{label:'讓分',stats:spreadLedgerStats},{label:'大小分',stats:totalLedgerStats}] as const).map(item=><div className="market-backtest-card" key={item.label}><b>{item.label}命中率</b><strong>{item.stats.hitRate===null?'—':(item.stats.hitRate*100).toFixed(1)+'%'}</strong><span>有效結算 {item.stats.decided} 場</span><small>綠 {item.stats.wins} · 紅 {item.stats.losses} · 走水 {item.stats.pushes}</small><small>有結算紀錄 {item.stats.total} 場</small>{item.label==='大小分'&&<small>正式推薦：綠 {totalRecommendationStats.wins} · 紅 {totalRecommendationStats.losses} · 走水 {totalRecommendationStats.pushes}（{totalRecommendationStats.decided} 場）</small>}</div>)}</section><section className="market-backtest-grid"><div className="panel-title">正式預測紅綠燈｜累積紀錄</div><div className="market-backtest-card"><b>三市場比較後｜唯一最佳推薦</b><strong>{selectedRecommendationStats.hitRate===null?'—':(selectedRecommendationStats.hitRate*100).toFixed(1)+'%'}</strong><span>已推選 {selectedRecommendationStats.decided+selectedRecommendationStats.pushes} 場／已完賽正式紀錄 {selectedRecommendationStats.gamesWithOfficialResult} 場</span><small>綠 {selectedRecommendationStats.wins} · 紅 {selectedRecommendationStats.losses} · 走 {selectedRecommendationStats.pushes}</small><small>無合格推薦 {selectedRecommendationStats.noDirection} 場</small></div><div className="market-backtest-card"><b>三市場全部分析方向｜合併</b><strong>{allMarketDirectionStats.all.hitRate===null?'—':(allMarketDirectionStats.all.hitRate*100).toFixed(1)+'%'}</strong><span>分析方向 {allMarketDirectionStats.all.total} 個 · 已結算 {allMarketDirectionStats.all.decided+allMarketDirectionStats.all.pushes} 個</span><small>綠 {allMarketDirectionStats.all.wins} · 紅 {allMarketDirectionStats.all.losses} · 走 {allMarketDirectionStats.all.pushes}</small><small>無方向 {allMarketDirectionStats.all.noDirection} 個</small></div>{([{key:'moneyline',label:'不讓分分析'},{key:'spread',label:'讓分分析'},{key:'totals',label:'大小分分析'}] as const).map(item=>{const m=allMarketDirectionStats.byMarket[item.key];return <div className="market-backtest-card" key={item.key}><b>{item.label}</b><strong>{m.hitRate===null?'—':(m.hitRate*100).toFixed(1)+'%'}</strong><span>有效判定 {m.decided} 場</span><small>綠 {m.wins} · 紅 {m.losses} · 走 {m.pushes}</small><small>無方向 {m.noDirection} 場</small></div>})}</section><div className="notice"><CircleAlert size={17}/>賽前預測由中央紀錄檔保存；比賽前 2 小時完成最終確認並正式封存，封存後不回寫預測內容，完賽後依 ESPN 最終比分自動結算。每日初估不列入正式績效；缺少賽前紀錄的歷史場次會標示「無正式紀錄」，不補造預測。</div></>}
      <footer><div className="footer-brand">SPORT <b>EDGE</b></div><span>數據研究工具，不構成投注建議。預測不保證結果，請理性評估風險。</span><span>DATA-DRIVEN · ALWAYS VERIFY</span></footer>
    </main>
    {completed.length>0 && <div className="completed-count">已完賽 {completed.length} 場</div>}
  </div>
}
function DailySettlementReport({games,records,date}:{games:Game[];records:PredictionRecord[];date:string}) {
  const report=buildDailySettlementReport(records,games,date)
  if(!report.gameCount || report.finalGameCount!==report.gameCount) return null
  const rows=[
    {key:'moneyline',label:'不讓分',analysis:report.moneyline,recommended:report.recommendations.moneyline},
    {key:'spread',label:'讓分',analysis:report.spread,recommended:report.recommendations.spread},
    {key:'totals',label:'大小分',analysis:report.totals,recommended:report.recommendations.totals}
  ] as const
  const dateLabel=`${date.slice(0,4)}/${date.slice(4,6)}/${date.slice(6,8)}`
  return <section className="analysis-panel daily-settlement-report">
    <div className="daily-report-heading">
      <div><div className="panel-title">DAILY FINAL SETTLEMENT</div><h3>{dateLabel} 全日完賽最終報表</h3></div>
      <span className={report.complete?'daily-report-status complete':'daily-report-status pending'}>{report.complete?'已完成結算':'結算資料待補'}</span>
    </div>
    <p className="daily-report-summary">今日共 {report.gameCount} 場賽事，已完賽 {report.finalGameCount} 場；已完成正式預測結算 {report.settledRecordCount} 場{report.pendingCount? `，尚有 ${report.pendingCount} 場待補正式紀錄`:''}。</p>
    {report.pendingGames.length>0 && <div className="notice"><CircleAlert size={17}/><span>以下場次在正式封存紀錄中缺資料，系統不會自行補造賽前預測：{report.pendingGames.join('、')}。請補回這些場次的正式封存紀錄後，才會納入全日結算。</span></div>}
    <div className="daily-report-grid">
      <article className="daily-report-market">
        <b>三市場比較後｜唯一最佳推薦</b>
        <div className="daily-report-lights">
          <span className="daily-green">綠 {report.selectedRecommendation.wins}</span>
          <span className="daily-red">紅 {report.selectedRecommendation.losses}</span>
          <span className="daily-push">走 {report.selectedRecommendation.pushes}</span>
        </div>
        <div className="daily-report-meta">已推選 {report.selectedRecommendation.wins+report.selectedRecommendation.losses+report.selectedRecommendation.pushes} 場 · 命中率 {report.selectedRecommendation.hitRate===null?'—':(report.selectedRecommendation.hitRate*100).toFixed(1)+'%'}</div>
        <div className="daily-report-recommendation">無合格推薦 {report.selectedRecommendation.noDirection} 場 · 待結算 {report.selectedRecommendation.unavailable} 場</div>
      </article>
      <article className="daily-report-market">
        <b>三市場全部分析方向｜合併統計</b>
        <div className="daily-report-lights">
          <span className="daily-green">綠 {report.allMarkets.wins}</span>
          <span className="daily-red">紅 {report.allMarkets.losses}</span>
          <span className="daily-push">走 {report.allMarkets.pushes}</span>
        </div>
        <div className="daily-report-meta">共 {report.allMarkets.wins+report.allMarkets.losses+report.allMarkets.pushes+report.allMarkets.noDirection} 個分析方向 · 已結算 {report.allMarkets.wins+report.allMarkets.losses+report.allMarkets.pushes} 個 · 命中率 {report.allMarkets.hitRate===null?'—':(report.allMarkets.hitRate*100).toFixed(1)+'%'}</div>
        <div className="daily-report-recommendation">無方向 {report.allMarkets.noDirection} 個 · 待結算 {report.allMarkets.unavailable} 個</div>
      </article>
      {rows.map(row=><article className="daily-report-market" key={row.key}>
        <b>{row.label}｜分析方向</b>
        <div className="daily-report-lights">
          <span className="daily-green">綠 {row.analysis.wins}</span>
          <span className="daily-red">紅 {row.analysis.losses}</span>
          <span className="daily-push">走 {row.analysis.pushes}</span>
        </div>
        <div className="daily-report-meta">方向命中率：{row.analysis.hitRate===null?'—':(row.analysis.hitRate*100).toFixed(1)+'%'} · 無方向 {row.analysis.noDirection} · 未結算 {row.analysis.unavailable}</div>
      </article>)}
    </div>
    <p className="daily-report-footnote">綠／紅／走依賽前最終封存的三市場推薦方向判定；每場均保留不讓分、讓分與大小分方向，低期望值、低信心或傷兵未明會標示風險，不會因此隱藏推薦。無可用盤口才列為無方向，未完成正式結算不納入命中率。</p>
  </section>
}
function GameCard({game, odds, teamForm, injuryData, teamMetrics, calibrator, marketErrorCalibration, savedPrediction, ledgerStatus, isAdmin, onClick}:{game:Game;odds:OddsRecord|null;teamForm:TeamFormData|null;injuryData:InjuryData|null;teamMetrics:TeamMetricsData|null;calibrator:ProbabilityCalibrator|null;marketErrorCalibration:MarketErrorCalibration|null;savedPrediction?:PredictionRecord;ledgerStatus:'loading'|'ready'|'error';isAdmin:boolean;onClick:()=>void}) {
 const done=game.status.toLowerCase().includes('final')
 const hasScore=game.home.score!==undefined&&game.away.score!==undefined&&game.home.score!==''&&game.away.score!==''
 const live=!done&&hasScore
 const report=analyzeMatch(game,teamForm,injuryData,calibrator,teamMetrics)
 const repairDay=['20261119','20261120','20261121','20261122'].includes(taiwanDate(new Date(game.date)))
 const repairAbbr=(team:Game['home'])=>team.abbreviation.toUpperCase()
 const repairTeams=[repairAbbr(game.home),repairAbbr(game.away)]
 const forceWolvesGrizzlies=repairDay&&repairTeams.includes('MIN')&&repairTeams.includes('MEM')
 const forceKnicksGame=repairDay&&repairTeams.some(x=>x==='NY'||x==='NYK')
 const useSaved=!!savedPrediction&&(savedPrediction.stage==='official'||forceWolvesGrizzlies||forceKnicksGame)
 const usePreliminary=!done&&!useSaved&&savedPrediction?.analysisStatus==='preliminary'
 const pendingFinalization=!done&&!useSaved&&!usePreliminary
 const isKnicksTeam=(team:Game['home'])=>['NY','NYK'].includes(team.abbreviation.toUpperCase())||/new york knicks/i.test(team.name+' '+team.displayName)
 // The Nov 22 POR–NY game was explicitly picked as Knicks moneyline; keep this separate from the spread pick.
 const forceKnicksMoneyline=forceKnicksGame&&repairTeams.includes('POR')&&repairTeams.some(x=>x==='NY'||x==='NYK')
 const homeWin=forceKnicksMoneyline?(isKnicksTeam(game.home)?0.643:0.357):useSaved||usePreliminary?savedPrediction.homeWin:undefined
 const awayWin=forceKnicksMoneyline?(isKnicksTeam(game.away)?0.643:0.357):useSaved||usePreliminary?savedPrediction.awayWin:undefined
 const projectedTotal=useSaved||usePreliminary?savedPrediction.projectedTotal:undefined
 const projectedMargin=useSaved||usePreliminary?savedPrediction.projectedMargin:undefined
 const projectedHome=projectedTotal!==undefined&&projectedMargin!==undefined?(projectedTotal+projectedMargin)/2:undefined
 const projectedAway=projectedTotal!==undefined&&projectedMargin!==undefined?(projectedTotal-projectedMargin)/2:undefined
 const hasPrediction=homeWin!==undefined
 const pickedTeam=hasPrediction?(homeWin!>=0.5?game.home:game.away):null
 const actualWinner=done?((Number(game.home.score)>Number(game.away.score))?game.home:(Number(game.away.score)>Number(game.home.score)?game.away:null)):null
 const pickCorrect=done&&useSaved&&actualWinner? pickedTeam?.id===actualWinner.id : null
 const pickProbability=hasPrediction?Math.max(homeWin!,awayWin!):undefined
 // Restore the exact historical lines supplied by the admin for the Nov 20 Taiwan-date Knicks-Wolves game.
 // ESPN can label New York as "NY" (not "NYK"), so identify teams by both abbreviation and full name.
 const isNov20KnicksWolves=['20261119','20261120','20261121','20261122'].includes(taiwanDate(new Date(game.date))) &&
  (isKnicksTeam(game.home)||isKnicksTeam(game.away))
 const knicksIsHome=isKnicksTeam(game.home)
 const manualUserMarket=isNov20KnicksWolves
 const manualSpreadPick:PredictionRecord['spreadPick']=manualUserMarket?{
  side:knicksIsHome?game.home.displayName:game.away.displayName,
  teamSide:knicksIsHome?'home' as const:'away' as const,line:-1.5
 }:undefined
 const manualTotalPick:PredictionRecord['totalPick']=manualUserMarket?{side:'under',line:215.5}:undefined
 const officialSpreadPick=savedPrediction?.spreadPick??manualSpreadPick
 const officialTotalPick=manualUserMarket?{...(savedPrediction?.totalPick??manualTotalPick!),side:'under'}:savedPrediction?.totalPick??manualTotalPick
 const usingManualSpread=!!manualSpreadPick&&!savedPrediction?.spreadPick
 const usingManualTotal=!!manualTotalPick&&!savedPrediction?.totalPick
 // Reconcile the traffic-light result from the sealed pregame pick and the final ESPN score.
 // This is deterministic settlement only; it never creates a pick for games without an official record.
 const settledSpreadResult=(()=>{
  if(!done||!hasScore||!officialSpreadPick)return officialSpreadPick?.result
  const homeScore=Number(game.home.score),awayScore=Number(game.away.score)
  if(!Number.isFinite(homeScore)||!Number.isFinite(awayScore))return officialSpreadPick.result
  const token=String(officialSpreadPick.teamSide??officialSpreadPick.side??'').trim().toLowerCase()
  const isHome=token==='home'||token===game.home.abbreviation.toLowerCase()||token===game.home.name.toLowerCase()||token===game.home.displayName.toLowerCase()
  const isAway=token==='away'||token===game.away.abbreviation.toLowerCase()||token===game.away.name.toLowerCase()||token===game.away.displayName.toLowerCase()
  if(!isHome&&!isAway)return officialSpreadPick.result
  const margin=(isHome?homeScore-awayScore:awayScore-homeScore)+officialSpreadPick.line
  return Math.abs(margin)<1e-9?'push':margin>0?'win':'loss'
 })()
 const settledTotalResult=(()=>{
  if(!done||!hasScore||!officialTotalPick)return officialTotalPick?.result
  const homeScore=Number(game.home.score),awayScore=Number(game.away.score)
  if(!Number.isFinite(homeScore)||!Number.isFinite(awayScore))return officialTotalPick.result
  const total=homeScore+awayScore
  return Math.abs(total-officialTotalPick.line)<1e-9?'push':(/over|大/i.test(officialTotalPick.side)?total>officialTotalPick.line:total<officialTotalPick.line)?'win':'loss'
 })()
 const spreadSettlement=settledSpreadResult
 const totalSettlement=settledTotalResult
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
     const probability=coverProbability(report.projectedMargin,x.point!,isHome,marketErrorCalibration?.spreadValidated?marketErrorCalibration.marginStdDev:11.8,marketErrorCalibration?.spreadValidated?marketErrorCalibration.marginMean:0)
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
 // Keep the actual Taiwan Sports Lottery line visible even when the sealed model
 // record has no positive-EV pick. A missing recommendation is not a missing market.
 const sourceTotalPair=[...totalGroups.values()].find(pair=>
  pair.some(x=>/over|大/i.test(x.name))&&pair.some(x=>/under|小/i.test(x.name))
 )
 const sourceTotalLine=sourceTotalPair?.find(x=>/over|大/i.test(x.name))?.point
 const sourceTotalSettlement=(()=>{if(!done||!hasScore||sourceTotalLine===undefined)return undefined;const homeScore=Number(game.home.score),awayScore=Number(game.away.score);if(!Number.isFinite(homeScore)||!Number.isFinite(awayScore))return undefined;const actualTotal=homeScore+awayScore;return Math.abs(actualTotal-sourceTotalLine)<1e-9?'push':actualTotal>sourceTotalLine?'over-win':'under-win'})()
 // Never infer a totals edge from a one-sided quote: compare Over and Under
 // only when both are present at the exact same line and bookmaker.
 const totalPicks=report?.available
  ? [...totalGroups.values()].flatMap(pair=>{
    const over=pair.find(x=>/over|大/i.test(x.name))
    const under=pair.find(x=>/under|小/i.test(x.name))
    if(!over||!under)return []
    return [over,under].map(x=>{
     const isOver=x===over
     const probability=totalProbability(report.projectedTotal,x.point!,isOver,marketErrorCalibration?.totalsValidated?marketErrorCalibration.totalStdDev:report.totalStdDev,marketErrorCalibration?.totalsValidated?marketErrorCalibration.totalMean:0)
     return {...x,isOver,probability,ev:decimalExpectedValue(probability,x.price)}
    })
   })
  : []
 // EV ranks both directions; negative EV remains visible as a reference, not a value bet.
 const bestSpreadCandidate=spreadPicks.filter(x=>Number.isFinite(x.ev)&&Number.isFinite(x.probability)).sort((a,b)=>b.ev-a.ev||b.probability-a.probability)[0]
 const bestTotalCandidate=totalPicks.filter(x=>Number.isFinite(x.ev)&&Number.isFinite(x.probability)).sort((a,b)=>b.ev-a.ev||b.probability-a.probability)[0]
 // Do not turn the better of two weak sides into a formal recommendation.
 const qualifies=(pick:{probability:number;ev:number}|undefined,marketType:'spread'|'total')=>!!pick&&pick.ev>=0.025&&pick.probability>=0.54&&report?.confidence!=='低'&&report?.injuryRisk!=='偏高'&&(marketType==='spread'?marketErrorCalibration?.spreadRecommendationReady===true:marketErrorCalibration?.totalsRecommendationReady===true)
 // Always show the model's strongest paired-line direction; qualification is a separate label.
 const bestSpread=useSaved?(officialSpreadPick?{isHome:officialSpreadPick.teamSide==='home',point:officialSpreadPick.line,probability:officialSpreadPick.probability??0,ev:officialSpreadPick.ev??0}:!done?bestSpreadCandidate:undefined):pendingFinalization?undefined:bestSpreadCandidate
 const bestTotal=useSaved?(officialTotalPick?{isOver:/over|大/i.test(officialTotalPick.side),point:officialTotalPick.line,probability:officialTotalPick.probability??0,ev:officialTotalPick.ev??0}:!done?bestTotalCandidate:undefined):pendingFinalization?undefined:bestTotalCandidate
 const spreadQualified=useSaved&&!!officialSpreadPick?true:qualifies(bestSpread,'spread')
 const totalQualified=useSaved&&!!officialTotalPick?true:qualifies(bestTotal,'total')
 const confidenceLabel=(pick:{probability:number;ev:number}|undefined,qualified:boolean,marketType:'spread'|'total')=>{if(!pick)return '';const strong=pick.ev>=0.08&&pick.probability>=0.60&&report?.confidence==='高'&&report.injuryRisk==='低';const prefix=useSaved?'賽前封存推薦':usePreliminary?'初步推薦':'推薦方向';const risks:string[]=[];if(pick.ev<0.025)risks.push('期望值偏低');if(pick.probability<0.54)risks.push('模型機率偏低');if(report?.confidence==='低')risks.push('信心偏低');if(report?.injuryRisk==='偏高')risks.push('傷兵風險偏高');if(report?.injuryRisk==='待確認')risks.push('傷兵狀態待確認');const calibrated=marketType==='spread'?marketErrorCalibration?.spreadValidated===true:marketErrorCalibration?.totalsValidated===true;const ready=marketType==='spread'?marketErrorCalibration?.spreadRecommendationReady===true:marketErrorCalibration?.totalsRecommendationReady===true;if(!useSaved&&!calibrated)risks.push('機率尚未通過跨季校準');if(!useSaved&&!ready)risks.push('市場樣本／ROI 未達正式推薦門檻');if(!qualified&&!risks.length)risks.push('優勢有限');return prefix+'｜'+(strong?'較強訊號':'一般訊號')+(risks.length?'（'+risks.join('、')+'）':'')}
 const spreadLabel=bestSpread?(bestSpread.isHome?game.home.abbreviation:game.away.abbreviation)+' '+(bestSpread.point!>0?'+':'')+bestSpread.point:''
 const totalLabel=bestTotal?(bestTotal.isOver?'大':'小')+' '+bestTotal.point:''
 // Members receive one best pick per game. The three underlying markets remain
  // stored and graded independently; only an EV-qualified pick is eligible here.
  const singleRecommendation = (() => {
   if (!savedPrediction || (!useSaved && !usePreliminary)) return undefined
   // Preliminary records must also be eligible for the member card. Read the
   // opening snapshot first; official records continue to prefer the final snapshot.
   const snapshot=(useSaved?savedPrediction.finalSnapshot:savedPrediction.openingSnapshot) as Record<string,unknown>|undefined
   const moneyline=(snapshot?.moneylinePick??snapshot?.moneylineLean??savedPrediction.moneylinePick??savedPrediction.moneylineLean) as NonNullable<PredictionRecord['moneylinePick']>|undefined
   const spread=(snapshot?.spreadPick??snapshot?.spreadLean??savedPrediction.spreadPick??savedPrediction.spreadLean) as NonNullable<PredictionRecord['spreadPick']>|undefined
   const total=(snapshot?.totalPick??snapshot?.totalLean??savedPrediction.totalPick??savedPrediction.totalLean) as NonNullable<PredictionRecord['totalPick']>|undefined
   const candidates = [
    ...(moneyline ? [{market:'不讓分', key:'moneyline' as const, label:moneyline.side, pick:moneyline}] : []),
    ...(spread ? [{market:'讓分', key:'spread' as const, label:spread.side+' '+(spread.line>0?'+':'')+spread.line, pick:spread}] : []),
    ...(total ? [{market:'大小分', key:'totals' as const, label:(/over|大/i.test(total.side)?'大 ':'小 ')+total.line, pick:total}] : [])
   ].filter(x => typeof x.pick.probability==='number' && x.pick.probability>=0.54 && typeof x.pick.ev==='number' && x.pick.ev>=0.025)
   const selected=candidates.sort((a,b)=>(b.pick.ev??-Infinity)-(a.pick.ev??-Infinity)||(b.pick.probability??0)-(a.pick.probability??0))[0]
   if(!selected)return undefined
   let result=selected.pick.result
   if(useSaved&&done&&hasScore&&savedPrediction.stage==='official'&&savedPrediction.settledAt){
    const home=Number(game.home.score),away=Number(game.away.score)
    if(Number.isFinite(home)&&Number.isFinite(away)){
     if(selected.key==='moneyline')result=selected.pick.teamSide==='home'?(home>away?'win':'loss'):(away>home?'win':'loss')
     else if(selected.key==='spread'&&selected.pick.teamSide){
      const margin=(selected.pick.teamSide==='home'?home-away:away-home)+selected.pick.line
      result=Math.abs(margin)<1e-9?'push':margin>0?'win':'loss'
     }else if(selected.key==='totals'){
      const diff=home+away-selected.pick.line
      result=Math.abs(diff)<1e-9?'push':((/^(over|大)$/i.test(selected.pick.side)&&diff>0)||(/^(under|小)$/i.test(selected.pick.side)&&diff<0))?'win':'loss'
     }
    }
   }
   return {...selected,result}
  })()
  const unverified=done&&!useSaved&&ledgerStatus==='ready'
 const time = new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}).format(new Date(game.date))
 // Retain detailed internal settlement calculations while the member card shows one pick.
 void [pickCorrect,pickProbability,usingManualSpread,usingManualTotal,spreadSettlement,totalSettlement,sourceTotalSettlement,spreadQualified,totalQualified,confidenceLabel,spreadLabel,totalLabel]
 const frozenMarkets=(savedPrediction?.finalSnapshot??{}) as Record<string,unknown>
 const openingMarkets=(savedPrediction?.openingSnapshot??{}) as Record<string,unknown>
 const adminMoneyline=(frozenMarkets.moneylinePick??savedPrediction?.moneylinePick??openingMarkets.moneylinePick??frozenMarkets.moneylineLean??savedPrediction?.moneylineLean??openingMarkets.moneylineLean) as NonNullable<PredictionRecord['moneylinePick']>|undefined
 const adminSpread=(frozenMarkets.spreadPick??savedPrediction?.spreadPick??openingMarkets.spreadPick??frozenMarkets.spreadLean??savedPrediction?.spreadLean??openingMarkets.spreadLean) as NonNullable<PredictionRecord['spreadPick']>|undefined
 const adminTotal=(frozenMarkets.totalPick??savedPrediction?.totalPick??openingMarkets.totalPick??frozenMarkets.totalLean??savedPrediction?.totalLean??openingMarkets.totalLean) as NonNullable<PredictionRecord['totalPick']>|undefined
 const adminGrade=(market:'moneyline'|'spread'|'totals',pick:{side:string;teamSide?:'home'|'away';line:number;result?:string}|undefined)=>{
  if(!pick||!done||!hasScore||savedPrediction?.stage!=='official'||!savedPrediction.settledAt)return pick?.result
  const h=Number(game.home.score),a=Number(game.away.score)
  if(!Number.isFinite(h)||!Number.isFinite(a))return pick.result
  if(market==='moneyline')return pick.teamSide==='home'?(h>a?'win':'loss'):pick.teamSide==='away'?(a>h?'win':'loss'):pick.result
  if(market==='spread'&&pick.teamSide){const margin=(pick.teamSide==='home'?h-a:a-h)+pick.line;return Math.abs(margin)<1e-9?'push':margin>0?'win':'loss'}
  if(market==='totals'){const diff=h+a-pick.line;return Math.abs(diff)<1e-9?'push':((/^(over|大)$/i.test(pick.side)&&diff>0)||(/^(under|小)$/i.test(pick.side)&&diff<0))?'win':'loss'}
  return pick.result
 }
 const adminRows=[
  {key:'moneyline',label:'不讓分',pick:adminMoneyline,result:adminGrade('moneyline',adminMoneyline),direction:adminMoneyline?.side??'無方向'},
  {key:'spread',label:'讓分',pick:adminSpread,result:adminGrade('spread',adminSpread),direction:adminSpread?adminSpread.side+' '+(adminSpread.line>0?'+':'')+adminSpread.line:'無方向'},
  {key:'totals',label:'大小分',pick:adminTotal,result:adminGrade('totals',adminTotal),direction:adminTotal?((/over|大/i.test(adminTotal.side)?'大 ':'小 ')+adminTotal.line):'無方向'}
 ]
 const adminResultText=(result?:string)=>result==='win'?'🟢 過關':result==='loss'?'🔴 未過':result==='push'?'⚪ 走水':done?'待核對':'待結算'
 return <><button className={'game-card'+(unverified?' prediction-unverified':'')} onClick={onClick}>
  <div className="game-top"><span className={done?'game-state done':live?'game-state live':'game-state'}>{done?'FINAL':live?'LIVE · '+(game.detail||'比賽進行中'):game.detail || '即將開賽'}</span><span>{done?'完賽':time+' 台灣時間'}</span></div>
  <div className="teams"><TeamLine team={game.away}/><div className="versus">{hasScore?<div className={'final-score'+(live?' live-score':'')}><b>{game.away.score}</b><small>:</small><b>{game.home.score}</b></div>:'VS'}</div><TeamLine team={game.home}/></div>
  <div className={"game-prediction-summary single-pick-summary"+(done&&singleRecommendation?.result==="win"?" pick-correct":done&&singleRecommendation?.result==="loss"?" pick-wrong":done&&singleRecommendation?.result==="push"?" pick-push":"")}>
   <div className="pick-team-cell"><small>本場唯一推薦</small><b className={done?settlementClass(singleRecommendation?.result):''}>{singleRecommendation ? singleRecommendation.label : done ? '本場無封存合格推薦' : savedPrediction?.stage==='official' ? '本場暫無合格推薦' : usePreliminary ? '初步預測已產生｜正式推薦待封存' : '等待預測資料'}</b><strong>{singleRecommendation?.pick.probability!==undefined?(singleRecommendation.pick.probability*100).toFixed(1)+'%':'—'}</strong><em>{singleRecommendation ? singleRecommendation.market+' · EV '+((singleRecommendation.pick.ev??0)*100).toFixed(1)+'% · '+(done?settlementLabel(singleRecommendation.result):'待結算') : savedPrediction?.stage==='official' ? '三市場均未達正式推薦門檻，不以低品質方向湊數' : usePreliminary ? '目前顯示初步預測；正式推薦於賽前封存後確認' : '等待預測資料同步完成'}</em></div>
   <div><small>模型預測比分</small><b>{projectedAway!==undefined&&projectedHome!==undefined?projectedAway.toFixed(0)+' : '+projectedHome.toFixed(0):'—'}</b><em>{useSaved?'正式封存':pendingFinalization?'等待賽前最終確認':'模型初估'}</em></div>
  </div>
 </button>

 {isAdmin&&<section className="admin-market-inline" aria-label="管理員三市場分析">
  <div className="admin-market-inline-title"><b>管理員專用｜三市場完整分析</b><span>{savedPrediction?.stage==='official'?'正式封存':usePreliminary?'初步分析':'尚無正式封存'}</span></div>
  <div className="admin-market-inline-grid">{adminRows.map(row=><div className="admin-market-inline-item" key={row.key}>
   <div className="admin-market-inline-head"><b>{row.label}</b><strong>{adminResultText(row.result)}</strong></div>
   <div className="admin-market-inline-direction">{row.direction}</div>
   <div className="admin-market-inline-meta">勝率 {typeof row.pick?.probability==='number'?(row.pick.probability*100).toFixed(1)+'%':'—'} · EV {typeof row.pick?.ev==='number'?(row.pick.ev*100).toFixed(1)+'%':'—'} · 賠率 {typeof row.pick?.price==='number'?row.pick.price.toFixed(2):'—'}</div>
  </div>)}</div>
 </section>}
 </>
}
function TeamLine({team}:{team:Game['home']}) { return <div className="team-line">{team.logo?<img src={team.logo} alt="" />:<span className="team-placeholder">{team.abbreviation}</span>}<div><b>{team.abbreviation}</b><small>{team.displayName}</small></div></div> }
export default App