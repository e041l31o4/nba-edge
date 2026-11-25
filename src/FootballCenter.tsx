import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, CalendarDays, RefreshCw, ShieldCheck, Target, Trophy, LockKeyhole } from 'lucide-react'
import { buildFootballModel, getUclMatches, isFinalStatus, type FootballMatch, type FootballModel } from './football'
import { supabase } from './lib/supabase'
import { loadDataset } from './lib/memberData'
import './football.css'

type Props={date:string;canAccess:boolean;isAdmin:boolean;membersEnabled:boolean;onReleaseChanged:(enabled:boolean)=>void}
type RecordRow={gameId:string;date:string;home:string;away:string;homeWin:number;draw:number;awayWin:number;homeXg:number;awayXg:number;moneylinePick:{side:'home'|'draw'|'away';probability:number};totalPick:{side:'over'|'under';line:number;probability:number};correctScores:Array<{score:string;probability:number}>;sportsLotteryOdds?:{home:number;draw:number;away:number;over:number;under:number;totalLine:number};sampleHome:number;sampleAway:number;confidence?:'低'|'中'|'高';dataWarnings?:string[];capturedAt?:string;source?:string;stage:'official';analysisStatus:'final';lockedAt:string;publishedAt?:string;actualHome?:number;actualAway?:number;settledAt?:string;settlement?:{moneyline:'win'|'loss';total:'win'|'loss'|'push';correctScore:'win'|'loss'}}
const pct=(n:number)=>(n*100).toFixed(1)+'%'
const localTime=(value:string)=>new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value))
const isoDate=(date:string)=>date.length===8?date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8):date
function shiftDate(date:string,days:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
function lockTime(date:string){const p=isoDate(date).split('-').map(Number);return new Date(Date.UTC(p[0],p[1]-1,p[2]-1,13,0,0)).toISOString()}
function direction(m:FootballModel){return m.homeWin>=m.draw&&m.homeWin>=m.awayWin?'主勝':m.draw>=m.awayWin?'和局':'客勝'}
function calculateSettlement(record:RecordRow|undefined,match:FootballMatch){
 if(!record)return undefined
 if(record.settlement)return record.settlement
 if(!isFinalStatus(match.status)||match.home.score===undefined||match.away.score===undefined)return undefined
 const home=match.home.score,away=match.away.score,total=home+away,line=record.totalPick.line
 const winner=home>away?'home':home<away?'away':'draw'
 const score=`${home}-${away}`
 const correct=record.correctScores?.some(item=>item.score.replace(':','-')===score)??false
 return {
  moneyline:record.moneylinePick.side===winner?'win' as const:'loss' as const,
  total:total===line?'push' as const:((record.totalPick.side==='over'&&total>line)||(record.totalPick.side==='under'&&total<line))?'win' as const:'loss' as const,
  correctScore:correct?'win' as const:'loss' as const
 }
}
export default function FootballCenter({date,canAccess,isAdmin,membersEnabled,onReleaseChanged}:Props){
 const [now,setNow]=useState(Date.now())
 const [matches,setMatches]=useState<FootballMatch[]>([])
 const [history,setHistory]=useState<FootballMatch[]>([])
 const [records,setRecords]=useState<RecordRow[]>([])
 const [loading,setLoading]=useState(false)
 const [error,setError]=useState('')
 const line=2.5
 const [selected,setSelected]=useState<string|null>(null)
 const [updated,setUpdated]=useState('')
 const [accessSaving,setAccessSaving]=useState(false)
 const [notice,setNotice]=useState('')
 useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),30_000);return()=>window.clearInterval(timer)},[])
 const taiwanToday=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now))
 const memberDateAllowed=isoDate(date)<=shiftDate(taiwanToday,1)&&now>=new Date(lockTime(date)).getTime()
 const canViewFootball=isAdmin||(canAccess&&memberDateAllowed)
 const toggleMemberAccess=async()=>{if(!supabase){setError('會員資料庫尚未設定，無法變更足球開放權限。');return}setAccessSaving(true);setError('');setNotice('');try{const result=await supabase.rpc('admin_set_football_member_access',{p_enabled:!membersEnabled});if(result.error)throw result.error;onReleaseChanged(result.data===true);setNotice(result.data===true?'已開放足球頁面給符合會員資格的會員。':'已關閉足球會員權限，目前只有管理員可以查看。')}catch(e){setError(e instanceof Error?e.message:'足球會員開放設定失敗；請先確認已執行 FOOTBALL_SETUP.sql。')}finally{setAccessSaving(false)}}
 useEffect(()=>{let alive=true;setLoading(true);setError('');setSelected(null);getUclMatches(isoDate(date)).then(data=>{if(!alive)return;setMatches(data.matches);setHistory(data.history);setUpdated(new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}))}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'足球賽程讀取失敗')}).finally(()=>{if(alive)setLoading(false)});return()=>{alive=false}},[date])
 useEffect(()=>{
  let alive=true
  if(!canViewFootball){setRecords([]);return()=>{alive=false}}
  const refresh=()=>loadDataset<{footballRecords:RecordRow[]}>('prediction-ledger','prediction-ledger.json')
   .then(data=>{if(alive&&Array.isArray(data?.footballRecords))setRecords(data.footballRecords)})
   .catch(()=>{ /* Keep the last known frozen predictions; do not replace them with a read-error screen. */ })
  void refresh()
  const timer=window.setInterval(()=>void refresh(),60_000)
  return()=>{alive=false;window.clearInterval(timer)}
 },[canViewFootball,date])
 const rows=useMemo(()=>{const visible=Array.from(new Map([...matches,...history.filter(match=>isFinalStatus(match.status))].map(match=>[match.id,match])).values()).sort((a,b)=>b.date.localeCompare(a.date));return visible.map(match=>{const record=records.find(r=>r.gameId===match.id);const model=buildFootballModel(match,history,line);return {match,model,record,settlement:calculateSettlement(record,match)}})},[matches,history,line,records])
 const active=rows.find(x=>x.match.id===selected)
 const performance=useMemo(()=>{
  const settled=rows.filter(x=>!!x.settlement)
  const tally=(key:'moneyline'|'total'|'correctScore')=>{const wins=settled.filter(x=>x.settlement?.[key]==='win').length;const decided=settled.filter(x=>x.settlement?.[key]==='win'||x.settlement?.[key]==='loss').length;return {wins,decided,rate:decided?wins/decided:null}}
  return {settled:settled.length,moneyline:tally('moneyline'),total:tally('total'),correctScore:tally('correctScore')}
 },[rows])
 if(!canViewFootball)return <section className="football-lock"><ShieldCheck size={30}/><h2>足球賽前分析｜會員專區</h2><p>會員僅可在賽事前一日台灣時間 21:00 正式預測封存後查看；管理員可提前預覽。</p></section>
 return <div className="football-center">
  {isAdmin&&<section className="football-odds-entry"><div className="football-market-title"><ShieldCheck size={16}/> 足球頁面存取權限</div><p>預設只有管理員可查看。關閉時，其他會員無法看到足球分頁，也無法讀取足球預測紀錄。</p><div className="football-lock-row"><span>{membersEnabled?'目前：已開放符合資格會員':'目前：僅管理員可查看'}</span><button disabled={accessSaving} onClick={()=>void toggleMemberAccess()}>{accessSaving?'更新中…':membersEnabled?'關閉會員查看':'開放給會員查看'}</button></div></section>}
  <section className="football-hero"><div><span className="football-eyebrow">FOOTBALL INTELLIGENCE / 2026—27</span><h2>UEFA <b>CHAMPIONS LEAGUE</b></h2><p>歐洲冠軍聯賽｜勝平負・總進球・正確比數</p></div><div className="football-ball">⚽</div></section>
  <section className="football-performance"><div><small>已結算賽事</small><b>{performance.settled}</b></div><div><small>勝平負命中</small><b>{performance.moneyline.rate===null?'—':pct(performance.moneyline.rate)}</b><em>{performance.moneyline.wins}/{performance.moneyline.decided}</em></div><div><small>大小球命中</small><b>{performance.total.rate===null?'—':pct(performance.total.rate)}</b><em>{performance.total.wins}/{performance.total.decided}</em></div><div><small>正確比數命中</small><b>{performance.correctScore.rate===null?'—':pct(performance.correctScore.rate)}</b><em>{performance.correctScore.wins}/{performance.correctScore.decided}</em></div></section>
  <div className="football-status"><span><i/> ESPN 賽程／比分來源</span><span><Activity size={14}/> 近期賽事樣本 {history.filter(x=>isFinalStatus(x.status)).length} 場</span><span className="football-updated">更新 {updated||'—'}</span></div>
  {error&&<div className="football-error"><AlertTriangle size={17}/>{error}</div>}{notice&&<div className="football-success"><ShieldCheck size={17}/>{notice}</div>}
  <div className="football-toolbar"><div><b>當日賽事</b><small>{isoDate(date).replace(/-/g,'/')} · 台灣時間</small></div><button onClick={()=>{setLoading(true);getUclMatches(isoDate(date)).then(d=>{setMatches(d.matches);setHistory(d.history);setUpdated(new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit'}))}).catch(e=>setError(e.message)).finally(()=>setLoading(false))}}><RefreshCw size={15}/> 重新整理</button></div>
  {loading?<div className="football-empty"><RefreshCw className="spin" size={20}/> 正在同步歐冠賽程與近期戰績…</div>:rows.length===0?<div className="football-empty"><CalendarDays size={22}/><b>這一天沒有讀取到歐冠賽事</b><span>可切換日期查看其他比賽；賽程以 UEFA 公布資訊為準。</span></div>:<div className="football-match-grid">{rows.map(({match,model,record,settlement:rowSettlement})=><button className={'football-match '+(selected===match.id?'selected':'')} key={match.id} onClick={()=>{setSelected(match.id);setError('');setNotice('')}}><div className="football-match-top"><span>UEFA CHAMPIONS LEAGUE</span><small>{localTime(match.date)}</small></div><div className="football-teams"><div><img src={match.home.logo} onError={e=>{e.currentTarget.style.display='none'}}/><b>{match.home.name}</b></div><span>VS</span><div><img src={match.away.logo} onError={e=>{e.currentTarget.style.display='none'}}/><b>{match.away.name}</b></div></div><div className="football-pick-hero"><span>預測勝方</span><strong>{record?(record.moneylinePick.side==='home'?match.home.name:record.moneylinePick.side==='away'?match.away.name:'和局'):isAdmin?(direction(model)==='主勝'?match.home.name:direction(model)==='客勝'?match.away.name:'和局'):'尚未發布'}</strong><b>{record?pct(record.moneylinePick.probability):isAdmin?pct(Math.max(model.homeWin,model.draw,model.awayWin)):'—'}</b><small>{record?(record.source==='retrospective_backfill'?'歷史補算（非原始封存）':'21:00 正式封存推薦'):isAdmin?'目前模型預覽':'等待正式封存'}</small></div><div className="football-mini-picks"><span>主勝／和局／客勝 <b>{record?pct(record.homeWin)+' / '+pct(record.draw)+' / '+pct(record.awayWin):isAdmin?pct(model.homeWin)+' / '+pct(model.draw)+' / '+pct(model.awayWin):'尚未發布'}</b></span><span>首選比數 <b>{record?(record.correctScores?.[0]?.score??'—'):isAdmin?(model.topScores[0]?.score??'—'):'待發布'}</b></span></div>{rowSettlement&&<div className="football-traffic-row"><span className={'football-light '+(rowSettlement.moneyline==='win'?'is-green':'is-red')}>● 勝平負：{rowSettlement.moneyline==='win'?'命中':'未中'}</span><span className={'football-light '+(rowSettlement.total==='win'?'is-green':rowSettlement.total==='push'?'is-yellow':'is-red')}>● 大小球：{rowSettlement.total==='win'?'命中':rowSettlement.total==='push'?'走盤':'未中'}</span><span className={'football-light '+(rowSettlement.correctScore==='win'?'is-green':'is-red')}>● 正確比數：{rowSettlement.correctScore==='win'?'命中':'未中'}</span></div>}<div className="football-match-bottom"><span>{isFinalStatus(match.status)?'已完賽':match.detail||'未開賽'}</span><b>{record?'已封存':isAdmin?'管理員預覽':'尚未發布'} · 查看 →</b></div></button>)}</div>}
  {active&&<section className="football-analysis"><div className="football-analysis-head"><div><span className="football-eyebrow">MATCH ANALYSIS</span><h3>{active.match.home.name} <small>vs</small> {active.match.away.name}</h3></div><button onClick={()=>setSelected(null)}>收合</button></div>
   {isAdmin&&!active.record?<><div className="football-market-grid"><article><div className="football-market-title"><Trophy size={16}/> 不讓分｜勝平負</div><div className="football-outcomes"><div><small>主勝</small><b>{pct(active.model.homeWin)}</b></div><div><small>和局</small><b>{pct(active.model.draw)}</b></div><div><small>客勝</small><b>{pct(active.model.awayWin)}</b></div></div><p>模型方向：<strong>{direction(active.model)}</strong></p></article>
    <article><div className="football-market-title"><Activity size={16}/> 總進球大小</div><label className="football-line">固定分析盤口 <b>2.5 球</b></label><div className="football-outcomes"><div><small>大於 {line}</small><b>{pct(active.model.over)}</b></div><div><small>小於 {line}</small><b>{pct(active.model.under)}</b></div></div><p>預期進球：<strong>{active.model.homeXg.toFixed(2)} : {active.model.awayXg.toFixed(2)}</strong></p></article>
    <article><div className="football-market-title"><Target size={16}/> 正確比數｜機率前三</div><div className="football-score-list">{active.model.topScores.map(x=><div key={x.score}><b>{x.score}</b><span>{pct(x.probability)}</span></div>)}</div><p>比分為機率排序，不代表保證命中。</p></article></div>
    <section className="football-odds-entry"><div className="football-market-title"><LockKeyhole size={16}/> 每日正式預測封存</div><p>系統依照目前模型結果，於台灣時間每日 21:00 自動保存勝平負、2.5 球大小、前三組正確比分與機率。封存後不再改動原始推薦，只更新賽果及紅綠燈。</p><div className="football-lock-row"><span>本場預定封存：{new Date(lockTime(date)).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</span><b>{active.record?'已完成封存':'等待自動封存'}</b></div></section>
    <div className="football-model-note"><b>模型透明度</b><span>近期樣本：主隊 {active.model.sampleHome} 場／客隊 {active.model.sampleAway} 場；信心等級：{active.model.confidence}。</span>{!active.model.dataReady&&<span className="football-warning">樣本不足提醒：{active.model.dataWarnings.join('；')}；系統仍會保存模型方向並標示樣本風險。</span>}<span>主隊近期：{active.model.homeRecent.join('｜')||'尚無足夠紀錄'}</span><span>客隊近期：{active.model.awayRecent.join('｜')||'尚無足夠紀錄'}</span><span>以近 120 日歐冠及球隊所屬聯賽完賽進失球資料加權，並納入主客場分項；再以 Poisson 分布計算勝平負、大小球及比分機率。</span></div>
   </>:active.record?<><div className="football-market-grid"><article><div className="football-market-title"><Trophy size={16}/> 正式封存｜勝平負</div><div className="football-outcomes"><div><small>主勝</small><b>{pct(active.record.homeWin)}</b></div><div><small>和局</small><b>{pct(active.record.draw)}</b></div><div><small>客勝</small><b>{pct(active.record.awayWin)}</b></div></div><p>正式方向：<strong>{active.record.moneylinePick.side==='home'?'主勝':active.record.moneylinePick.side==='draw'?'和局':'客勝'}</strong>（{pct(active.record.moneylinePick.probability)}）</p></article><article><div className="football-market-title"><Activity size={16}/> 總進球大小</div><div className="football-outcomes"><div><small>盤口</small><b>{active.record.totalPick.line}</b></div><div><small>推薦</small><b>{active.record.totalPick.side==='over'?'大分':'小分'}</b></div><div><small>機率</small><b>{pct(active.record.totalPick.probability)}</b></div></div></article><article><div className="football-market-title"><Target size={16}/> 正確比數｜前三</div><div className="football-score-list">{active.record.correctScores.map(x=><div key={x.score}><b>{x.score}</b><span>{pct(x.probability)}</span></div>)}</div></article></div><div className="football-model-note"><b>{active.record.source==='retrospective_backfill'?'歷史補算版本（非原始賽前預測）':'正式版本已鎖定'}</b>{active.record.sportsLotteryOdds?<><span>台灣運彩勝平負：主勝 {active.record.sportsLotteryOdds.home.toFixed(2)}／和局 {active.record.sportsLotteryOdds.draw.toFixed(2)}／客勝 {active.record.sportsLotteryOdds.away.toFixed(2)}</span><span>總進球盤口 {active.record.sportsLotteryOdds.totalLine}：大 {active.record.sportsLotteryOdds.over.toFixed(2)}／小 {active.record.sportsLotteryOdds.under.toFixed(2)}</span></>:<span>本次封存依模型預測保存，官方運彩賠率未提供。</span>}<span>鎖定時間：{new Date(active.record.lockedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</span><span>封存來源：{active.record.source==='automatic_21_00_taiwan_snapshot'?'每日 21:00 自動封存':active.record.source==='retrospective_backfill'?'歷史補算（非賽前原始封存）':'管理員封存'}</span>{active.settlement&&<><span>最終比分：{active.match.home.score}-{active.match.away.score}</span><div className="football-traffic-row football-traffic-detail"><span className={'football-light '+(active.settlement.moneyline==='win'?'is-green':'is-red')}>● 勝平負：{active.settlement.moneyline==='win'?'命中':'未中'}</span><span className={'football-light '+(active.settlement.total==='win'?'is-green':active.settlement.total==='push'?'is-yellow':'is-red')}>● 大小球：{active.settlement.total==='win'?'命中':active.settlement.total==='push'?'走盤':'未中'}</span><span className={'football-light '+(active.settlement.correctScore==='win'?'is-green':'is-red')}>● 正確比數：{active.settlement.correctScore==='win'?'命中':'未中'}</span></div></>}</div></>:<div className="football-empty"><LockKeyhole size={22}/><b>本場正式預測尚未發布</b><span>管理員完成盤口核對並在鎖定時間前封存後，會員才會看到正式推薦。</span></div>}
  </section>}
    <div className="football-disclaimer">足球賽果具高度不確定性，模型機率僅供參考。正式推薦以已封存版本為準；鎖定後不修改方向，後續僅更新賽果與結算。</div>
 </div>
}
