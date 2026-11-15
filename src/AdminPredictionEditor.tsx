import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import type { Game } from './lib'
import type { ModelResult } from './model'
import type { PredictionRecord } from './predictionLedger'

type Props = {
  game: Game
  report: ModelResult
  savedPrediction?: PredictionRecord
  onSaved: (record: PredictionRecord) => void
}
const n = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const parseOptional = (value: string) => value.trim() === '' ? undefined : Number(value)
const fmt = (value: number) => value > 0 ? '+' + value.toFixed(1) : value.toFixed(1)

function buildRationale(game: Game, report: ModelResult, values: {
  homeWin: number; projectedHome: number; projectedAway: number;
  spreadSide: 'home'|'away'|'none'; spreadLine: number; totalSide: 'over'|'under'|'none'; totalLine: number
}) {
  const margin = values.projectedHome - values.projectedAway
  const total = values.projectedHome + values.projectedAway
  const winner = values.homeWin >= 0.5 ? game.home.displayName : game.away.displayName
  const winnerFactors: string[] = []
  const winnerRisks: string[] = []
  if (Math.abs(report.homeNet - report.awayNet) >= 1) winnerFactors.push(report.homeNet > report.awayNet
    ? `主隊近10場平均淨勝分較佳（${fmt(report.homeNet)} vs ${fmt(report.awayNet)}）`
    : `客隊近10場平均淨勝分較佳（${fmt(report.awayNet)} vs ${fmt(report.homeNet)}）`)
  if (report.homeRestDays !== null && report.awayRestDays !== null && report.homeRestDays !== report.awayRestDays) winnerFactors.push(
    report.homeRestDays > report.awayRestDays ? `主隊多休息 ${report.homeRestDays-report.awayRestDays} 天` : `客隊多休息 ${report.awayRestDays-report.homeRestDays} 天`)
  if (Math.abs(report.homeInjuryImpact-report.awayInjuryImpact) >= 0.5) winnerFactors.push(
    report.homeInjuryImpact < report.awayInjuryImpact ? `主隊傷兵預估影響較低（${report.homeInjuryImpact.toFixed(1)} 分 vs ${report.awayInjuryImpact.toFixed(1)} 分）` : `客隊傷兵預估影響較低（${report.awayInjuryImpact.toFixed(1)} 分 vs ${report.homeInjuryImpact.toFixed(1)} 分）`)
  if (report.homeBackToBack || report.awayBackToBack) winnerRisks.push(`背靠背賽程：${report.homeBackToBack ? game.home.abbreviation+' 是' : ''}${report.homeBackToBack && report.awayBackToBack ? '、' : ''}${report.awayBackToBack ? game.away.abbreviation+' 是' : ''}`)
  if (report.injuryRisk === '待確認' || report.injuryRisk === '偏高') winnerRisks.push(`傷兵風險為「${report.injuryRisk}」，勝率需保留`)
  if (!winnerFactors.length) winnerFactors.push('目前可驗證的近期數據差距有限，方向主要反映管理員設定的勝率與預測比分')
  if (Math.abs(values.homeWin - report.homeWin) >= 0.03) winnerRisks.push(`管理員設定勝率與模型原始值不同（模型主勝 ${(report.homeWin*100).toFixed(1)}%）`)

  let spreadSummary = '管理員未設定讓分方向。'
  const spreadFactors: string[] = []
  if (values.spreadSide !== 'none') {
    const edge = values.spreadSide === 'home' ? margin + values.spreadLine : -margin + values.spreadLine
    spreadSummary = `${values.spreadSide === 'home' ? game.home.displayName : game.away.displayName} ${values.spreadLine > 0 ? '+' : ''}${values.spreadLine}；依目前預測比分，估計讓分後淨優勢 ${fmt(edge)} 分。`
    spreadFactors.push(edge > 0 ? '管理員設定方向與預測分差相符' : '管理員設定方向與預測分差存在落差，屬於逆模型方向')
    if (report.confidence === '低') spreadFactors.push('模型信心偏低，不宜把方向視為高把握')
    if (values.spreadSide === 'home' && margin < 0 || values.spreadSide === 'away' && margin > 0) spreadFactors.push('預測比分本身不支持該隊直接取勝，需仰賴讓分保護')
  }

  let totalSummary = '管理員未設定大小分方向。'
  const totalFactors: string[] = []
  if (values.totalSide !== 'none') {
    const gap = values.totalSide === 'over' ? total - values.totalLine : values.totalLine - total
    totalSummary = `${values.totalSide === 'over' ? '大分' : '小分'} ${values.totalLine}；預測總分 ${total.toFixed(1)}，與盤口差距 ${fmt(gap)} 分。`
    totalFactors.push(gap > 0 ? '預測總分支持所選方向' : gap < 0 ? '預測總分與所選方向相反，屬於逆模型方向' : '預測總分正好落在盤口，方向優勢有限')
    if (report.paceAdjustment !== 0) totalFactors.push(`節奏修正 ${fmt(report.paceAdjustment)} 分`)
    if (report.totalTrend !== null) totalFactors.push(`近期總分環境參考值 ${report.totalTrend.toFixed(1)} 分`)
    if (report.totalStdDev >= 18) totalFactors.push('總分波動估計偏大，需留意比分變異')
  }

  return {
    generatedAt: new Date().toISOString(),
    method: '依模型欄位與管理員最後設定自動計算；屬規則化解釋，不是外部生成式 AI 的主觀推測。',
    winner: { pick: winner, summary: `${winner} 勝；主勝率 ${(values.homeWin*100).toFixed(1)}%，客勝率 ${((1-values.homeWin)*100).toFixed(1)}%。`, factors: winnerFactors, risks: winnerRisks },
    spread: { summary: spreadSummary, factors: spreadFactors },
    total: { summary: totalSummary, factors: totalFactors },
    modelReference: { homeWin: report.homeWin, projectedMargin: report.projectedMargin, projectedTotal: report.projectedTotal, confidence: report.confidence, injuryRisk: report.injuryRisk }
  }
}

export default function AdminPredictionEditor({game,report,savedPrediction,onSaved}:Props) {
  const [homeWinPct,setHomeWinPct] = useState('50')
  const [homeScore,setHomeScore] = useState('0')
  const [awayScore,setAwayScore] = useState('0')
  const [spreadSide,setSpreadSide] = useState<'home'|'away'|'none'>('none')
  const [spreadLine,setSpreadLine] = useState('')
  const [spreadPrice,setSpreadPrice] = useState('')
  const [spreadProbability,setSpreadProbability] = useState('')
  const [totalSide,setTotalSide] = useState<'over'|'under'|'none'>('none')
  const [totalLine,setTotalLine] = useState('')
  const [totalPrice,setTotalPrice] = useState('')
  const [totalProbabilityPct,setTotalProbabilityPct] = useState('')
  const [saving,setSaving] = useState(false)
  const [message,setMessage] = useState('')
  useEffect(() => {
    const h = savedPrediction?.projectedTotal !== undefined && savedPrediction?.projectedMargin !== undefined
      ? (savedPrediction.projectedTotal + savedPrediction.projectedMargin) / 2 : report.projectedHome
    const a = savedPrediction?.projectedTotal !== undefined && savedPrediction?.projectedMargin !== undefined
      ? (savedPrediction.projectedTotal - savedPrediction.projectedMargin) / 2 : report.projectedAway
    setHomeWinPct(String((n(savedPrediction?.homeWin,report.homeWin)*100).toFixed(1)))
    setHomeScore(h.toFixed(1)); setAwayScore(a.toFixed(1))
    setSpreadSide(savedPrediction?.spreadPick?.teamSide ?? 'none')
    setSpreadLine(savedPrediction?.spreadPick ? String(savedPrediction.spreadPick.line) : '')
    setSpreadPrice(savedPrediction?.spreadPick?.price === undefined ? '' : String(savedPrediction.spreadPick.price))
    setSpreadProbability(savedPrediction?.spreadPick?.probability === undefined ? '' : String((savedPrediction.spreadPick.probability*100).toFixed(1)))
    setTotalSide(savedPrediction?.totalPick?.side === 'over' || savedPrediction?.totalPick?.side === 'under' ? savedPrediction.totalPick.side : 'none')
    setTotalLine(savedPrediction?.totalPick ? String(savedPrediction.totalPick.line) : '')
    setTotalPrice(savedPrediction?.totalPick?.price === undefined ? '' : String(savedPrediction.totalPick.price))
    setTotalProbabilityPct(savedPrediction?.totalPick?.probability === undefined ? '' : String((savedPrediction.totalPick.probability*100).toFixed(1)))
  },[game.id,savedPrediction?.capturedAt,report.projectedHome,report.projectedAway,report.homeWin])
  const preview = useMemo(() => buildRationale(game,report,{homeWin:Number(homeWinPct)/100,projectedHome:Number(homeScore),projectedAway:Number(awayScore),spreadSide,spreadLine:Number(spreadLine)||0,totalSide,totalLine:Number(totalLine)||0}),[game,report,homeWinPct,homeScore,awayScore,spreadSide,spreadLine,totalSide,totalLine])
  const save = async () => {
    if (!supabase) { setMessage('資料庫尚未設定，無法儲存。'); return }
    const hw=Number(homeScore), aw=Number(awayScore), hp=Number(homeWinPct)/100
    if (![hw,aw,hp].every(Number.isFinite) || hp<=0 || hp>=1 || hw<0 || aw<0) { setMessage('請確認勝率與預測比分數值正確。'); return }
    if (spreadSide!=='none' && (!Number.isFinite(Number(spreadLine)) || spreadLine.trim()==='')) { setMessage('請填寫讓分盤口。'); return }
    if (totalSide!=='none' && (!Number.isFinite(Number(totalLine)) || totalLine.trim()==='')) { setMessage('請填寫大小分盤口。'); return }
    setSaving(true);setMessage('')
    try {
      const now=new Date().toISOString()
      const existing=savedPrediction
      const rationale=buildRationale(game,report,{homeWin:hp,projectedHome:hw,projectedAway:aw,spreadSide,spreadLine:Number(spreadLine)||0,totalSide,totalLine:Number(totalLine)||0})
      const record:PredictionRecord = {
        ...(existing??{} as PredictionRecord),
        gameId:game.id,date:game.date,home:game.home.abbreviation,away:game.away.abbreviation,
        homeWin:hp,awayWin:1-hp,projectedMargin:hw-aw,projectedTotal:hw+aw,
        ...(spreadSide==='none'?{spreadPick:undefined}:{spreadPick:{side:spreadSide==='home'?game.home.displayName:game.away.displayName,teamSide:spreadSide,line:Number(spreadLine),...(parseOptional(spreadPrice)!==undefined?{price:parseOptional(spreadPrice)}:{}),...(parseOptional(spreadProbability)!==undefined?{probability:Number(spreadProbability)/100}:{})}}),
        ...(totalSide==='none'?{totalPick:undefined}:{totalPick:{side:totalSide,line:Number(totalLine),...(parseOptional(totalPrice)!==undefined?{price:parseOptional(totalPrice)}:{}),...(parseOptional(totalProbabilityPct)!==undefined?{probability:Number(totalProbabilityPct)/100}:{})}}),
        stage:existing?.stage??'draft',capturedAt:existing?.capturedAt??now,
        adminRationale:rationale,
        adminOverride:{active:true,updatedAt:now,source:'admin'}
      } as PredictionRecord
      const {data,error}=await supabase.rpc('admin_save_prediction',{p_game_id:game.id,p_record:record})
      if(error) throw error
      onSaved((data??record) as PredictionRecord)
      setMessage('已儲存。系統已更新人工設定、選擇理由與稽核紀錄。')
    } catch(error) {
      setMessage(error instanceof Error?error.message:'儲存失敗，請稍後重試。')
    } finally {setSaving(false)}
  }
  return <section className="analysis-panel admin-editor">
    <div className="panel-title">管理員專用｜手動設定最終分析</div>
    <p className="method-note">可直接覆寫模型方向。儲存後會同步會員資料庫，並保留原始模型值與每次修改紀錄；正式封存狀態依原有流程保留。</p>
    <div className="admin-edit-grid">
      <label>主隊勝率（%）<input type="number" min="1" max="99" step="0.1" value={homeWinPct} onChange={e=>setHomeWinPct(e.target.value)}/></label>
      <label>主隊預測得分<input type="number" min="0" step="0.1" value={homeScore} onChange={e=>setHomeScore(e.target.value)}/></label>
      <label>客隊預測得分<input type="number" min="0" step="0.1" value={awayScore} onChange={e=>setAwayScore(e.target.value)}/></label>
    </div>
    <div className="admin-edit-grid">
      <label>讓分方向<select value={spreadSide} onChange={e=>setSpreadSide(e.target.value as typeof spreadSide)}><option value="none">不設定</option><option value="home">{game.home.displayName}</option><option value="away">{game.away.displayName}</option></select></label>
      <label>讓分盤口（該隊角度）<input type="number" step="0.5" value={spreadLine} onChange={e=>setSpreadLine(e.target.value)} placeholder="+5.5 / -5.5"/></label>
      <label>讓分賠率<input type="number" step="0.01" value={spreadPrice} onChange={e=>setSpreadPrice(e.target.value)} placeholder="選填"/></label>
      <label>讓分過盤率（%）<input type="number" min="1" max="99" step="0.1" value={spreadProbability} onChange={e=>setSpreadProbability(e.target.value)} placeholder="選填"/></label>
    </div>
    <div className="admin-edit-grid">
      <label>大小分方向<select value={totalSide} onChange={e=>setTotalSide(e.target.value as typeof totalSide)}><option value="none">不設定</option><option value="over">大分</option><option value="under">小分</option></select></label>
      <label>大小分盤口<input type="number" step="0.5" value={totalLine} onChange={e=>setTotalLine(e.target.value)} placeholder="例如 221.5"/></label>
      <label>大小分賠率<input type="number" step="0.01" value={totalPrice} onChange={e=>setTotalPrice(e.target.value)} placeholder="選填"/></label>
      <label>大小分模型機率（%）<input type="number" min="1" max="99" step="0.1" value={totalProbabilityPct} onChange={e=>setTotalProbabilityPct(e.target.value)} placeholder="選填"/></label>
    </div>
    <div className="admin-rationale-preview">
      <b>系統自動判讀｜儲存時一併保存</b>
      <p><strong>勝負：</strong>{preview.winner.summary}</p><ul>{preview.winner.factors.map((x:string)=><li key={x}>{x}</li>)}</ul>
      {preview.winner.risks.map((x:string)=><p className="method-note" key={x}>風險：{x}</p>)}
      <p><strong>讓分：</strong>{preview.spread.summary}</p><ul>{preview.spread.factors.map((x:string)=><li key={x}>{x}</li>)}</ul>
      <p><strong>大小分：</strong>{preview.total.summary}</p><ul>{preview.total.factors.map((x:string)=><li key={x}>{x}</li>)}</ul>
    </div>
    <div className="admin-editor-actions"><button className="primary-btn" disabled={saving} onClick={()=>void save()}>{saving?'儲存中…':'儲存管理員分析'}</button>{message&&<span role="status">{message}</span>}</div>
  </section>
}
