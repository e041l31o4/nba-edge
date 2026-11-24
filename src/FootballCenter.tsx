import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, CalendarDays, RefreshCw, ShieldCheck, Target, Trophy, LockKeyhole, Save } from 'lucide-react'
import { buildFootballModel, getUclMatches, type FootballMatch, type FootballModel } from './football'
import { loadDataset } from './lib/memberData'
import { supabase } from './lib/supabase'
import './football.css'

type Props={date:string;canAccess:boolean;isAdmin:boolean}
type RecordRow={gameId:string;date:string;home:string;away:string;homeWin:number;draw:number;awayWin:number;homeXg:number;awayXg:number;moneylinePick:{side:'home'|'draw'|'away';probability:number};totalPick:{side:'over'|'under';line:number;probability:number};correctScores:Array<{score:string;probability:number}>;sportsLotteryOdds:{home:number;draw:number;away:number;over:number;under:number;totalLine:number};sampleHome:number;sampleAway:number;stage:'official';analysisStatus:'final';lockedAt:string;publishedAt?:string;actualHome?:number;actualAway?:number;settledAt?:string;settlement?:{moneyline:'win'|'loss';total:'win'|'loss'|'push';correctScore:'win'|'loss'}}
type OddsForm={home:string;draw:string;away:string;over:string;under:string}
const pct=(n:number)=>(n*100).toFixed(1)+'%'
const localTime=(value:string)=>new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value))
const isoDate=(date:string)=>date.length===8?date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8):date
function shiftDate(date:string,days:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
function lockTime(date:string){const p=isoDate(date).split('-').map(Number);return new Date(Date.UTC(p[0],p[1]-1,p[2]-1,13,0,0)).toISOString()}
function direction(m:FootballModel){return m.homeWin>=m.draw&&m.homeWin>=m.awayWin?'主勝':m.draw>=m.awayWin?'和局':'客勝'}
export default function FootballCenter({date,canAccess,isAdmin}:Props){
 const [now,setNow]=useState(Date.now())
 const [matches,setMatches]=useState<FootballMatch[]>([])
 const [history,setHistory]=useState<FootballMatch[]>([])
 const [records,setRecords]=useState<RecordRow[]>([])
 const [loading,setLoading]=useState(false)
 const [error,setError]=useState('')
 const [line,setLine]=useState(2.5)
 const [selected,setSelected]=useState<string|null>(null)
 const [updated,setUpdated]=useState('')
 const [saving,setSaving]=useState(false)
 const [odds,setOdds]=useState<OddsForm>({home:'',draw:'',away:'',over:'',under:''})
 const [notice,setNotice]=useState('')
 useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),30_000);return()=>window.clearInterval(timer)},[])
 const taiwanToday=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now))
 const memberDateAllowed=isoDate(date)<=shiftDate(taiwanToday,1)&&now>=new Date(lockTime(date)).getTime()
 const canViewFootball=isAdmin||(canAccess&&memberDateAllowed)
 useEffect(()=>{let alive=true;setLoading(true);setError('');setSelected(null);getUclMatches(isoDate(date)).then(data=>{if(!alive)return;setMatches(data.matches);setHistory(data.history);setUpdated(new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}))}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'足球賽程讀取失敗')}).finally(()=>{if(alive)setLoading(false)});return()=>{alive=false}},[date])
 useEffect(()=>{let alive=true;if(!canViewFootball){setRecords([]);return()=>{alive=false}};loadDataset<{records:RecordRow[]}>('football-prediction-ledger','football-prediction-ledger.json').then(data=>{if(alive)setRecords(Array.isArray(data?.records)?data!.records:[])}).catch(()=>{if(alive)setRecords([])});return()=>{alive=false}},[canViewFootball,date])
 const rows=useMemo(()=>matches.map(match=>({match,model:buildFootballModel(match,history,line),record:records.find(r=>r.gameId===match.id)})),[matches,history,line,records])
 const active=rows.find(x=>x.match.id===selected)
 const performance=useMemo(()=>{
  const settled=records.filter(x=>!!x.settledAt&&!!x.settlement)
  const tally=(key:'moneyline'|'total'|'correctScore')=>{const wins=settled.filter(x=>x.settlement?.[key]==='win').length;const decided=settled.filter(x=>x.settlement?.[key]==='win'||x.settlement?.[key]==='loss').length;return {wins,decided,rate:decided?wins/decided:null}}
  return {settled:settled.length,moneyline:tally('moneyline'),total:tally('total'),correctScore:tally('correctScore')}
 },[records])
 const locked=now>=new Date(lockTime(date)).getTime()
 const oddsReady=Object.values(odds).every(v=>v.trim()!==''&&Number.isFinite(Number(v))&&Number(v)>1)
 const settleOfficial=async(match:FootballMatch)=>{
  if(!supabase||match.home.score===undefined||match.away.score===undefined||!match.status.toLowerCase().includes('final'))return
  setSaving(true);setError('');setNotice('')
  try{const result=await supabase.rpc('admin_settle_football_prediction',{p_game_id:match.id,p_home_goals:match.home.score,p_away_goals:match.away.score});if(result.error)throw result.error;setRecords(current=>[...current.filter(x=>x.gameId!==match.id),result.data as RecordRow]);setNotice('正式賽果已結算；原始推薦與鎖定時間均未更動。')}
  catch(e){setError(e instanceof Error?e.message:'足球賽果結算失敗')}
  finally{setSaving(false)}
 }
 const saveOfficial=async(match:FootballMatch,model:FootballModel)=>{
  if(!supabase){setError('會員資料庫尚未設定，無法封存足球預測。');return}
  if(!oddsReady){setError('請先輸入並核對台灣運彩官方勝平負及大小球賠率，再發布會員預測。');return}
  if(Date.now()>=new Date(lockTime(date)).getTime()){setError('已超過台灣時間 21:00 鎖定時間，本場不得新增或修改正式預測。');return}
  setSaving(true);setError('');setNotice('')
  const pOdds={home:Number(odds.home),draw:Number(odds.draw),away:Number(odds.away),over:Number(odds.over),under:Number(odds.under),totalLine:line}
  const winner=[{side:'home' as const,probability:model.homeWin},{side:'draw' as const,probability:model.draw},{side:'away' as const,probability:model.awayWin}].sort((a,b)=>b.probability-a.probability)[0];
  const record:RecordRow={gameId:match.id,date:match.date,home:match.home.name,away:match.away.name,homeWin:model.homeWin,draw:model.draw,awayWin:model.awayWin,homeXg:model.homeXg,awayXg:model.awayXg,moneylinePick:{side:winner.side,probability:winner.probability},totalPick:{side:model.over>=model.under?'over':'under',line:line,probability:Math.max(model.over,model.under)},correctScores:model.topScores,sportsLotteryOdds:pOdds,sampleHome:model.sampleHome,sampleAway:model.sampleAway,stage:'official',analysisStatus:'final',lockedAt:lockTime(date)}
  try{const result=await supabase.rpc('admin_save_football_prediction',{p_game_id:match.id,p_record:record});if(result.error)throw result.error;setRecords(current=>[...current.filter(x=>x.gameId!==match.id),result.data as RecordRow]);setNotice('已封存並發布。資料庫將在台灣時間 21:00 後拒絕修改。')}
  catch(e){setError(e instanceof Error?e.message:'足球預測封存失敗')}
  finally{setSaving(false)}
 }
 if(!canViewFootball)return <section className="football-lock"><ShieldCheck size={30}/><h2>足球賽前分析｜會員專區</h2><p>會員僅可在賽事前一日台灣時間 21:00 正式預測封存後查看；管理員可提前預覽。</p></section>
 return <div className="football-center">
  <section className="football-hero"><div><span className="football-eyebrow">FOOTBALL INTELLIGENCE / 2026—27</span><h2>UEFA <b>CHAMPIONS LEAGUE</b></h2><p>歐洲冠軍聯賽｜勝平負・總進球・正確比數</p></div><div className="football-ball">⚽</div></section>
  <section className="football-performance"><div><small>已結算賽事</small><b>{performance.settled}</b></div><div><small>勝平負命中</small><b>{performance.moneyline.rate===null?'—':pct(performance.moneyline.rate)}</b><em>{performance.moneyline.wins}/{performance.moneyline.decided}</em></div><div><small>大小球命中</small><b>{performance.total.rate===null?'—':pct(performance.total.rate)}</b><em>{performance.total.wins}/{performance.total.decided}</em></div><div><small>正確比數命中</small><b>{performance.correctScore.rate===null?'—':pct(performance.correctScore.rate)}</b><em>{performance.correctScore.wins}/{performance.correctScore.decided}</em></div></section>
  <div className="football-status"><span><i/> ESPN 賽程／比分來源</span><span><Activity size={14}/> 近期賽事樣本 {history.filter(x=>x.status.toLowerCase().includes('final')).length} 場</span><span className="football-updated">更新 {updated||'—'}</span></div>
  {error&&<div className="football-error"><AlertTriangle size={17}/>{error}</div>}{notice&&<div className="football-success"><ShieldCheck size={17}/>{notice}</div>}
  <div className="football-toolbar"><div><b>當日賽事</b><small>{isoDate(date).replace(/-/g,'/')} · 台灣時間</small></div><button onClick={()=>{setLoading(true);getUclMatches(isoDate(date)).then(d=>{setMatches(d.matches);setHistory(d.history);setUpdated(new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}))}).catch(e=>setError(e.message)).finally(()=>setLoading(false))}}><RefreshCw size={15}/> 重新整理</button></div>
  {loading?<div className="football-empty"><RefreshCw className="spin" size={20}/> 正在同步歐冠賽程與近期戰績…</div>:rows.length===0?<div className="football-empty"><CalendarDays size={22}/><b>這一天沒有讀取到歐冠賽事</b><span>可切換日期查看其他比賽；賽程以 UEFA 公布資訊為準。</span></div>:<div className="football-match-grid">{rows.map(({match,model,record})=><button className={'football-match '+(selected===match.id?'selected':'')} key={match.id} onClick={()=>{setSelected(match.id);setError('');setNotice('')}}><div className="football-match-top"><span>UEFA CHAMPIONS LEAGUE</span><small>{localTime(match.date)}</small></div><div className="football-teams"><div><img src={match.home.logo} onError={e=>{e.currentTarget.style.display='none'}}/><b>{match.home.name}</b></div><span>VS</span><div><img src={match.away.logo} onError={e=>{e.currentTarget.style.display='none'}}/><b>{match.away.name}</b></div></div><div className="football-mini-picks"><span>勝平負 <b>{isAdmin?pct(model.homeWin)+' / '+pct(model.draw)+' / '+pct(model.awayWin):record?pct(record.homeWin)+' / '+pct(record.draw)+' / '+pct(record.awayWin):'尚未發布'}</b></span><span>首選比數 <b>{isAdmin?(model.topScores[0]?.score??'—'):(record?.correctScores?.[0]?.score??'待發布')}</b></span></div><div className="football-match-bottom"><span>{match.status.toLowerCase().includes('final')?'已完賽':match.detail||'未開賽'}</span><b>{record?'已封存':isAdmin?'管理員預覽':'尚未發布'} · 查看 →</b></div></button>)}</div>}
  {active&&<section className="football-analysis"><div className="football-analysis-head"><div><span className="football-eyebrow">MATCH ANALYSIS</span><h3>{active.match.home.name} <small>vs</small> {active.match.away.name}</h3></div><button onClick={()=>setSelected(null)}>收合</button></div>
   {isAdmin?<><div className="football-market-grid"><article><div className="football-market-title"><Trophy size={16}/> 不讓分｜勝平負</div><div className="football-outcomes"><div><small>主勝</small><b>{pct(active.model.homeWin)}</b></div><div><small>和局</small><b>{pct(active.model.draw)}</b></div><div><small>客勝</small><b>{pct(active.model.awayWin)}</b></div></div><p>模型方向：<strong>{direction(active.model)}</strong></p></article>
    <article><div className="football-market-title"><Activity size={16}/> 總進球大小</div><label className="football-line">分析盤口 <select value={line} onChange={e=>setLine(Number(e.target.value))}><option value={1.5}>1.5 球</option><option value={2.5}>2.5 球</option><option value={3.5}>3.5 球</option><option value={4.5}>4.5 球</option></select></label><div className="football-outcomes"><div><small>大於 {line}</small><b>{pct(active.model.over)}</b></div><div><small>小於 {line}</small><b>{pct(active.model.under)}</b></div></div><p>預期進球：<strong>{active.model.homeXg.toFixed(2)} : {active.model.awayXg.toFixed(2)}</strong></p></article>
    <article><div className="football-market-title"><Target size={16}/> 正確比數｜機率前三</div><div className="football-score-list">{active.model.topScores.map(x=><div key={x.score}><b>{x.score}</b><span>{pct(x.probability)}</span></div>)}</div><p>比分為機率排序，不代表保證命中。</p></article></div>
    <section className="football-odds-entry"><div className="football-market-title">台灣運彩盤口核對｜管理員輸入</div><p>請依官方台灣運彩當場盤口輸入賠率；未核對完成前，不可發布給會員。</p><div className="football-odds-fields"><label>主勝賠率<input inputMode="decimal" value={odds.home} onChange={e=>setOdds(v=>({...v,home:e.target.value}))} placeholder="例：1.85"/></label><label>和局賠率<input inputMode="decimal" value={odds.draw} onChange={e=>setOdds(v=>({...v,draw:e.target.value}))} placeholder="例：3.40"/></label><label>客勝賠率<input inputMode="decimal" value={odds.away} onChange={e=>setOdds(v=>({...v,away:e.target.value}))} placeholder="例：4.20"/></label><label>大分賠率<input inputMode="decimal" value={odds.over} onChange={e=>setOdds(v=>({...v,over:e.target.value}))} placeholder="例：1.90"/></label><label>小分賠率<input inputMode="decimal" value={odds.under} onChange={e=>setOdds(v=>({...v,under:e.target.value}))} placeholder="例：1.80"/></label></div><div className="football-lock-row"><span><LockKeyhole size={15}/> 鎖定時間：{new Date(lockTime(date)).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</span><button disabled={saving||!oddsReady||locked} onClick={()=>void saveOfficial(active.match,active.model)}><Save size={15}/>{saving?'封存中…':active.record?'更新正式預測':'封存並發布會員'}</button></div>{locked&&<small className="football-warning">已超過鎖定時間，禁止新增或修改。</small>}{!oddsReady&&<small className="football-warning">五項賠率皆需填寫且大於 1.00，才可封存。</small>}</section>
    <div className="football-model-note"><b>模型透明度</b><span>近期樣本：主隊 {active.model.sampleHome} 場／客隊 {active.model.sampleAway} 場；信心等級：{active.model.confidence}。</span><span>主隊近期：{active.model.homeRecent.join('｜')||'尚無足夠紀錄'}</span><span>客隊近期：{active.model.awayRecent.join('｜')||'尚無足夠紀錄'}</span><span>以近 120 日歐冠及球隊所屬聯賽完賽進失球資料加權，並對樣本不足的球隊向基準值收縮，再以 Poisson 分布計算勝平負、大小球及比分機率。這是進球率估值，不等同官方射門品質 xG。</span><span className="football-warning">目前尚未自動串接台灣運彩足球盤口；此版本由管理員核對官方頁面後輸入，未輸入前不發布會員。</span></div>
   </>:active.record?<><div className="football-market-grid"><article><div className="football-market-title"><Trophy size={16}/> 正式封存｜勝平負</div><div className="football-outcomes"><div><small>主勝</small><b>{pct(active.record.homeWin)}</b></div><div><small>和局</small><b>{pct(active.record.draw)}</b></div><div><small>客勝</small><b>{pct(active.record.awayWin)}</b></div></div><p>正式方向：<strong>{active.record.moneylinePick.side==='home'?'主勝':active.record.moneylinePick.side==='draw'?'和局':'客勝'}</strong>（{pct(active.record.moneylinePick.probability)}）</p></article><article><div className="football-market-title"><Activity size={16}/> 總進球大小</div><div className="football-outcomes"><div><small>盤口</small><b>{active.record.totalPick.line}</b></div><div><small>推薦</small><b>{active.record.totalPick.side==='over'?'大分':'小分'}</b></div><div><small>機率</small><b>{pct(active.record.totalPick.probability)}</b></div></div></article><article><div className="football-market-title"><Target size={16}/> 正確比數｜前三</div><div className="football-score-list">{active.record.correctScores.map(x=><div key={x.score}><b>{x.score}</b><span>{pct(x.probability)}</span></div>)}</div></article></div><div className="football-model-note"><b>正式版本已鎖定</b><span>台灣運彩勝平負：主勝 {active.record.sportsLotteryOdds.home.toFixed(2)}／和局 {active.record.sportsLotteryOdds.draw.toFixed(2)}／客勝 {active.record.sportsLotteryOdds.away.toFixed(2)}</span><span>總進球盤口 {active.record.sportsLotteryOdds.totalLine}：大 {active.record.sportsLotteryOdds.over.toFixed(2)}／小 {active.record.sportsLotteryOdds.under.toFixed(2)}</span><span>鎖定時間：{new Date(active.record.lockedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</span>{active.record.settledAt&&<span>最終比分：{active.record.actualHome}-{active.record.actualAway}｜勝平負 {active.record.settlement?.moneyline==='win'?'命中':'未命中'}｜大小球 {active.record.settlement?.total==='win'?'命中':active.record.settlement?.total==='push'?'走盤':'未命中'}｜正確比數 {active.record.settlement?.correctScore==='win'?'命中':'未命中'}</span>}</div></>:<div className="football-empty"><LockKeyhole size={22}/><b>本場正式預測尚未發布</b><span>管理員完成盤口核對並在鎖定時間前封存後，會員才會看到正式推薦。</span></div>}
  </section>}
  {isAdmin&&active?.record&&active.match.status.toLowerCase().includes('final')&&<div className="football-settle-row"><span>官方賽果：{active.match.home.score??'—'} - {active.match.away.score??'—'}</span><button disabled={saving||!!active.record.settledAt||active.match.home.score===undefined||active.match.away.score===undefined} onClick={()=>void settleOfficial(active.match)}>{active.record.settledAt?'已完成結算':saving?'結算中…':'依正式比分結算'}</button></div>}
  <div className="football-disclaimer">足球賽果具高度不確定性，模型機率僅供參考。正式推薦以已封存版本為準；鎖定後不修改方向，後續僅更新賽果與結算。</div>
 </div>
}
