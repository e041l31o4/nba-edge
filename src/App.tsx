import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowDownRight, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, CircleAlert, RefreshCw, ShieldCheck, Target, TrendingUp, Trophy } from 'lucide-react'
import { dateLabel, getOdds, getScoreboard, marketFor, taiwanDate, type Game, type OddsRecord } from './lib'
import ParlayLab from './ParlayLab'\nimport MatchAnalysis from './MatchAnalysis'\nimport type { TeamFormData, InjuryData } from './model'

type Tab = 'games' | 'analysis' | 'performance' | 'parlay'
function App() {
  const [date, setDate] = useState(taiwanDate())
  const [games, setGames] = useState<Game[]>([])
  const [odds, setOdds] = useState<OddsRecord | null>(null)\n  const [teamForm, setTeamForm] = useState<TeamFormData | null>(null)\n  const [injuryData, setInjuryData] = useState<InjuryData | null>(null)
  const [tab, setTab] = useState<Tab>('games')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const load = async () => {
    setLoading(true); setError('')
    try { const [g, o, tf, inj] = await Promise.all([getScoreboard(date), getOdds(), fetch(`${import.meta.env.BASE_URL}data/team-form.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null), fetch(`${import.meta.env.BASE_URL}data/injuries.json?t=${Date.now()}`).then(r=>r.ok?r.json():null).catch(()=>null)]); setGames(g); setOdds(o); setTeamForm(tf); setInjuryData(inj); setUpdated(new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })) }
    catch (e) { setError(e instanceof Error ? e.message : '讀取失敗') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [date])
  const upcoming = useMemo(() => games.filter(g => !g.status.toLowerCase().includes('final')), [games])
  const completed = games.filter(g => g.status.toLowerCase().includes('final'))
  const moveDate = (delta: number) => { const d = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00'); d.setDate(d.getDate()+delta); setDate(taiwanDate(d)) }
  const active = games.find(g => g.id === selected)
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">E</span><span>NBA <b>EDGE</b><small>DATA · MATCHUP · INSIGHT</small></span></a><div className="top-right"><span className="live-dot"/> <span>台灣時間 UTC+8</span><button className="icon-btn" onClick={() => void load()} aria-label="重新整理"><RefreshCw size={16}/></button></div></header>
    <main>
      <section className="hero"><div><div className="eyebrow"><span/> NBA ANALYTICS PLATFORM</div><h1>看懂數據，<em>掌握比賽節奏。</em></h1><p>以賽程、球隊表現、盤口與賽前資訊，建立可追蹤、可驗證的 NBA 分析。</p></div><div className="hero-stat"><span>今日賽事</span><strong>{loading ? '—' : games.length.toString().padStart(2,'0')}</strong><small>GAMES SCHEDULED</small></div></section>
      <section className="ticker"><div className="ticker-label"><Activity size={15}/> DATA STATUS</div><span className="status-ok"><i/> 賽程來源連線</span><span className={odds ? 'status-ok' : 'status-warn'}><i/> {odds ? '盤口資料已載入' : '尚未取得即時盤口'}</span><span className="ticker-time">最後更新 {updated || '—'}</span></section>
      <section className="toolbar"><div className="date-nav"><button className="icon-btn" onClick={() => moveDate(-1)}><ChevronLeft size={18}/></button><div><CalendarDays size={17}/><b>{date.slice(0,4)}/{date.slice(4,6)}/{date.slice(6,8)}</b><small>{dateLabel(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00')}</small></div><button className="icon-btn" onClick={() => moveDate(1)}><ChevronRight size={18}/></button><button className="today-btn" onClick={() => setDate(taiwanDate())}>今天</button></div><div className="tabs"><button className={tab==='games'?'active':''} onClick={()=>setTab('games')}>賽事總覽</button><button className={tab==='analysis'?'active':''} onClick={()=>setTab('analysis')}>賽前分析</button><button className={tab==='performance'?'active':''} onClick={()=>setTab('performance')}>模型績效</button><button className={tab==='parlay'?'active':''} onClick={()=>setTab('parlay')}>串關研究</button></div></section>
      {error && <div className="notice error"><CircleAlert size={17}/>{error}</div>}
      {tab==='games' && <><section className="section-heading"><div><span className="eyebrow">MATCH CENTER</span><h2>賽事總覽 <small>{date.slice(4,6)}/{date.slice(6,8)}</small></h2></div><div className="legend"><span><i className="green"/>進行中／未開賽</span><span><i className="gray"/>已完賽</span></div></section>
        {loading ? <div className="empty"><RefreshCw className="spin" size={22}/>正在同步 NBA 賽程…</div> : games.length===0 ? <div className="empty"><CalendarDays size={25}/><b>當日沒有賽事</b><span>可切換日期查看其他比賽。</span></div> : <div className="game-grid">{games.map(g => <GameCard key={g.id} game={g} odds={odds} onClick={()=>{setSelected(g.id);setTab('analysis')}}/> )}</div>}</>}
      {tab==='analysis' && <><section className="section-heading"><div><span className="eyebrow">PRE-GAME INTELLIGENCE</span><h2>賽前分析</h2></div><span className="muted">{upcoming.length} 場未完賽</span></section>{active ? <MatchAnalysis game={active} odds={odds} teamForm={teamForm} injuryData={injuryData} onBack={()=>setSelected(null)}/> : <div className="analysis-list">{upcoming.map(g=><button className="analysis-row" key={g.id} onClick={()=>setSelected(g.id)}><span>{g.away.abbreviation} @ {g.home.abbreviation}</span><b>{g.away.displayName} 對 {g.home.displayName}</b><span>{g.detail || '待開賽'} <ChevronRight size={15}/></span></button>)}</div>}{!active && upcoming.length===0 && <div className="empty">目前沒有可分析的未完賽賽事，請切換日期。</div>}</>}
      {tab==='parlay' && <><section className="section-heading"><div><span className="eyebrow">PARLAY & VERIFICATION</span><h2>串關研究與驗證</h2></div><span className="muted">分析工具，不保證結果</span></section><ParlayLab/></>}
      {tab==='performance' && <><section className="section-heading"><div><span className="eyebrow">MODEL TRACK RECORD</span><h2>模型績效</h2></div><span className="muted">真實紀錄優先</span></section><div className="performance-grid"><div className="perf-card"><Target/><span>歷史預測筆數</span><strong>0</strong><small>尚未建立有效樣本</small></div><div className="perf-card"><Trophy/><span>讓分命中率</span><strong>—</strong><small>累積足夠賽事後計算</small></div><div className="perf-card"><TrendingUp/><span>大小分命中率</span><strong>—</strong><small>累積足夠賽事後計算</small></div><div className="perf-card"><ShieldCheck/><span>投資報酬率 ROI</span><strong>—</strong><small>需有真實盤口與結算資料</small></div></div><div className="notice"><CircleAlert size={17}/>目前尚未有經過結算的歷史預測，因此不顯示虛構命中率或 ROI。後續會逐場保存預測時間、盤口與賽果，並以實際結算計算績效。</div></>}
      <footer><div className="footer-brand">NBA <b>EDGE</b></div><span>數據研究工具，不構成投注建議。預測不保證結果，請理性評估風險。</span><span>DATA-DRIVEN · ALWAYS VERIFY</span></footer>
    </main>
    {completed.length>0 && <div className="completed-count">已完賽 {completed.length} 場</div>}
  </div>
}
function GameCard({game, odds, onClick}:{game:Game;odds:OddsRecord|null;onClick:()=>void}) {
 const m=marketFor(game,odds), done=game.status.toLowerCase().includes('final')
 const time = new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}).format(new Date(game.date))
 return <button className="game-card" onClick={onClick}><div className="game-top"><span className={done?'game-state done':'game-state'}>{done?'FINAL':game.detail || '即將開賽'}</span><span>{done?'完賽':time+' 台灣時間'}</span></div><div className="teams"><TeamLine team={game.away}/><div className="versus">{done?<><b>{game.away.score}</b><small>FINAL</small><b>{game.home.score}</b></>:'VS'}</div><TeamLine team={game.home}/></div><div className="market-strip"><div><small>讓分盤</small><b>{m?.spread.length ? '已取得盤口' : '盤口待更新'}</b></div><div><small>大小分</small><b>{m?.total.length ? '已取得盤口' : '盤口待更新'}</b></div><span className="card-arrow"><ChevronRight size={16}/></span></div></button>
}
function TeamLine({team}:{team:Game['home']}) { return <div className="team-line">{team.logo?<img src={team.logo} alt="" />:<span className="team-placeholder">{team.abbreviation}</span>}<div><b>{team.abbreviation}</b><small>{team.displayName}</small></div></div> }
function Analysis({game,odds,onBack}:{game:Game;odds:OddsRecord|null;onBack:()=>void}) {
 const m=marketFor(game,odds)
 return <div className="analysis-detail"><button className="back-btn" onClick={onBack}>← 返回賽事列表</button><div className="matchup-head"><div><span>{game.detail || '賽前資料'}</span><h3>{game.away.displayName} <em>@</em> {game.home.displayName}</h3><small>{new Date(game.date).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}（台灣時間）</small></div></div><div className="analysis-panels"><div className="analysis-panel"><div className="panel-title"><ArrowUpRight size={17}/> 讓分盤分析</div>{m?.spread.length ? m.spread.slice(0,8).map((x,i)=><div className="odds-line" key={i}><span>{x.book} · {x.name}</span><b>{(x.point ?? 0)>0?'+':''}{x.point ?? '—'}</b><small>{x.price>0?'+' : ''}{x.price}</small></div>) : <Missing/>}</div><div className="analysis-panel"><div className="panel-title"><ArrowDownRight size={17}/> 大小分分析</div>{m?.total.length ? m.total.slice(0,8).map((x,i)=><div className="odds-line" key={i}><span>{x.book} · {x.name}</span><b>{x.point}</b><small>{x.price>0?'+' : ''}{x.price}</small></div>) : <Missing/>}</div></div><div className="notice"><CircleAlert size={17}/>模型預測與傷兵影響評估尚未完成資料驗證；本場暫不產生推薦。待取得可靠球隊數據、傷兵狀態與有效盤口後，才會計算預測機率及優勢值。</div><div className="data-check"><b>本場資料檢查</b><span><i className="ok"/> 賽程：已取得</span><span><i className={m?'ok':'warn'}/> 盤口：{m?'已取得':'尚未取得'}</span><span><i className="warn"/> 傷兵：尚未完成來源同步</span><span><i className="warn"/> 近期效率數據：待建置</span></div></div>
}
function Missing(){return <div className="missing"><CircleAlert size={18}/><b>目前沒有可驗證的盤口</b><span>不以估算值或假盤口代替真實市場資料。</span></div>}
export default App