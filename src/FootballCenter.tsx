import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, CalendarDays, RefreshCw, ShieldCheck, Target, Trophy } from 'lucide-react'
import { buildFootballModel, getUclMatches, type FootballMatch } from './football'
import './football.css'

type Props={date:string;canAccess:boolean;isAdmin:boolean}
const pct=(n:number)=>(n*100).toFixed(1)+'%'
const localTime=(value:string)=>new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value))
export default function FootballCenter({date,canAccess,isAdmin}:Props){
 const [matches,setMatches]=useState<FootballMatch[]>([])
 const [history,setHistory]=useState<FootballMatch[]>([])
 const [loading,setLoading]=useState(false)
 const [error,setError]=useState('')
 const [line,setLine]=useState(2.5)
 const [selected,setSelected]=useState<string|null>(null)
 const [updated,setUpdated]=useState('')
 useEffect(()=>{let alive=true;setLoading(true);setError('');setSelected(null);getUclMatches(date).then(data=>{if(!alive)return;setMatches(data.matches);setHistory(data.history);setUpdated(new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}))}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'足球賽程讀取失敗')}).finally(()=>{if(alive)setLoading(false)});return()=>{alive=false}},[date])
 const rows=useMemo(()=>matches.map(match=>({match,model:buildFootballModel(match,history,line)})),[matches,history,line])
 const active=rows.find(x=>x.match.id===selected)
 if(!canAccess)return <section className="football-lock"><ShieldCheck size={30}/><h2>足球賽前分析｜會員專區</h2><p>歐洲冠軍聯賽的勝平負、總進球大小與正確比數分析，僅開放已啟用會員及管理員查看。</p></section>
 return <div className="football-center">
  <section className="football-hero"><div><span className="football-eyebrow">FOOTBALL INTELLIGENCE / 2026—27</span><h2>UEFA <b>CHAMPIONS LEAGUE</b></h2><p>歐洲冠軍聯賽｜勝平負・總進球・正確比數</p></div><div className="football-ball">⚽</div></section>
  <div className="football-status"><span><i/> UEFA 賽程資料</span><span><Activity size={14}/> 近況樣本 {history.filter(x=>x.status.toLowerCase().includes('final')).length} 場</span><span className="football-updated">更新 {updated||'—'}</span></div>
  {error&&<div className="football-error"><AlertTriangle size={17}/>{error}</div>}
  <div className="football-toolbar"><div><b>當日賽事</b><small>{date.slice(0,4)}/{date.slice(4,6)}/{date.slice(6,8)} · 台灣時間</small></div><button onClick={()=>{setLoading(true);getUclMatches(date).then(d=>{setMatches(d.matches);setHistory(d.history);setUpdated(new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}))}).catch(e=>setError(e.message)).finally(()=>setLoading(false))}}><RefreshCw size={15}/> 重新整理</button></div>
  {loading?<div className="football-empty"><RefreshCw className="spin" size={20}/> 正在同步歐冠賽程與近期戰績…</div>:rows.length===0?<div className="football-empty"><CalendarDays size={22}/><b>這一天沒有讀取到歐冠賽事</b><span>可切換日期查看其他比賽；賽程依 UEFA 官方公布為準。</span></div>:<div className="football-match-grid">{rows.map(({match,model})=><button className={'football-match '+(selected===match.id?'selected':'')} key={match.id} onClick={()=>setSelected(match.id)}><div className="football-match-top"><span>UEFA CHAMPIONS LEAGUE</span><small>{localTime(match.date)}</small></div><div className="football-teams"><div><img src={match.home.logo} onError={e=>{e.currentTarget.style.display='none'}}/><b>{match.home.name}</b></div><span>VS</span><div><img src={match.away.logo} onError={e=>{e.currentTarget.style.display='none'}}/><b>{match.away.name}</b></div></div><div className="football-mini-picks"><span>勝平負 <b>{pct(model.homeWin)} / {pct(model.draw)} / {pct(model.awayWin)}</b></span><span>模型比分 <b>{model.topScores[0]?.score??'—'}</b></span></div><div className="football-match-bottom"><span>{match.status.toLowerCase().includes('final')?'已完賽':match.detail||'未開賽'}</span><b>查看三項分析 →</b></div></button>)}</div>}
  {active&&<section className="football-analysis"><div className="football-analysis-head"><div><span className="football-eyebrow">MATCH ANALYSIS</span><h3>{active.match.home.name} <small>vs</small> {active.match.away.name}</h3></div><button onClick={()=>setSelected(null)}>收合</button></div>
   <div className="football-market-grid"><article><div className="football-market-title"><Trophy size={16}/> 不讓分｜勝平負</div><div className="football-outcomes"><div><small>主勝</small><b>{pct(active.model.homeWin)}</b></div><div><small>和局</small><b>{pct(active.model.draw)}</b></div><div><small>客勝</small><b>{pct(active.model.awayWin)}</b></div></div><p>模型方向：<strong>{Math.max(active.model.homeWin,active.model.draw,active.model.awayWin)===active.model.homeWin?'主勝':Math.max(active.model.homeWin,active.model.draw,active.model.awayWin)===active.model.draw?'和局':'客勝'}</strong></p></article>
    <article><div className="football-market-title"><Activity size={16}/> 總進球大小</div><label className="football-line">分析盤口 <select value={line} onChange={e=>setLine(Number(e.target.value))}><option value={1.5}>1.5 球</option><option value={2.5}>2.5 球</option><option value={3.5}>3.5 球</option></select></label><div className="football-outcomes"><div><small>大於 {line}</small><b>{pct(active.model.over)}</b></div><div><small>小於 {line}</small><b>{pct(active.model.under)}</b></div></div><p>預期進球：<strong>{active.model.homeXg.toFixed(2)} : {active.model.awayXg.toFixed(2)}</strong></p></article>
    <article><div className="football-market-title"><Target size={16}/> 正確比數｜機率前三</div><div className="football-score-list">{active.model.topScores.map(x=><div key={x.score}><b>{x.score}</b><span>{pct(x.probability)}</span></div>)}</div><p>比分為機率排序，不代表保證命中。</p></article>
   </div>
   <div className="football-model-note"><b>模型透明度</b><span>近期樣本：主隊 {active.model.sampleHome} 場／客隊 {active.model.sampleAway} 場；信心等級：{active.model.confidence}。</span><span>以近期歐冠進失球資料估計預期進球，再以 Poisson 分布計算勝平負、大小球及比分機率。樣本不足時採用保守聯賽基準值。</span><span className="football-warning">目前版本尚未串接台灣運彩即時足球盤口；大小球為模型基準線，並非官方投注盤。未取得官方盤口前不會標示為已核對盤口。</span></div>
   {isAdmin&&<div className="football-admin-note">管理員檢視：此為第一階段足球模型預覽。正式推薦封存、會員發布及獨立結算尚未接入現有 NBA prediction ledger。</div>}
  </section>}
  <div className="football-disclaimer">本分析為數據模型參考，不保證賽果。賽程、隊伍近期數據以可取得的 ESPN 資料為準。</div>
 </div>
}
