import type { FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, supabaseConfigured } from './lib/supabase'

type Plan = { id: string; name: string; price_twd: number; duration_days: number; active: boolean; sort_order: number }
type Order = { id: string; user_id: string; plan_name: string; amount_twd: number; duration_days: number; status: string; created_at: string; submitted_at: string | null; transfer_last5: string | null; transfer_note: string | null; expires_at: string | null; profiles?: { email: string } }
type Settings = { bank_name: string; bank_code: string; account_name: string; account_number: string; payment_note: string }

export default function MembershipGate({ children }: { children: ReactNode }) {
  const membershipEnabled = import.meta.env.VITE_MEMBERSHIP_ENABLED === 'true'
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [profile, setProfile] = useState<{ role: string; email: string } | null>(null)
  const [active, setActive] = useState(false)
  const [plans, setPlans] = useState<Plan[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [settings, setSettings] = useState<Settings>({ bank_name: '', bank_code: '', account_name: '', account_number: '', payment_note: '' })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login'|'signup'>('login')
  const [last5, setLast5] = useState<Record<string,string>>({})
  const [note, setNote] = useState<Record<string,string>>({})
  const [planName, setPlanName] = useState('')
  const [planPrice, setPlanPrice] = useState('')
  const [planDays, setPlanDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async (current: Session | null) => {
    if (!supabase || !current) { setProfile(null); setActive(false); setReady(true); return }
    const [{ data: p, error: pe }, { data: membership, error: me }, { data: pl, error: ple }, { data: ord, error: oe }] = await Promise.all([
      supabase.from('profiles').select('role,email').eq('id', current.user.id).single(),
      supabase.rpc('has_active_membership'),
      supabase.from('membership_plans').select('*').eq('active', true).order('sort_order'),
      supabase.from('membership_orders').select('*').order('created_at', { ascending: false })
    ])
    if (pe || me || ple || oe) throw pe || me || ple || oe
    const isAdmin = p?.role === 'admin'
    let enrichedOrders = ord || []
    if (isAdmin && ord?.length) {
      const userIds = [...new Set(ord.map(order => order.user_id))]
      const { data: owners, error: ownersError } = await supabase.from('profiles').select('id,email').in('id', userIds)
      if (ownersError) throw ownersError
      const emailById = new Map((owners || []).map(owner => [owner.id, owner.email]))
      enrichedOrders = ord.map(order => ({ ...order, profiles: { email: emailById.get(order.user_id) || '未知帳號' } }))
    }
    setProfile(p)
    setActive(Boolean(membership) || isAdmin)
    setPlans(pl || [])
    setOrders(enrichedOrders)
    const { data: s, error: se } = await supabase.from('membership_payment_settings').select('*').eq('id', true).single()
    if (se) throw se
    if (s) setSettings({ bank_name:s.bank_name, bank_code:s.bank_code, account_name:s.account_name, account_number:s.account_number, payment_note:s.payment_note })
    setReady(true)
  }, [])

  useEffect(() => {
    if (!supabase) { setReady(true); return }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      void refresh(data.session).catch(e => { setError(e.message || '會員資料讀取失敗'); setReady(true) })
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setReady(false)
      window.setTimeout(() => { void refresh(next).catch(e => { setError(e.message || '會員資料讀取失敗'); setReady(true) }) }, 0)
    })
    return () => listener.subscription.unsubscribe()
  }, [refresh])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : '操作失敗') } finally { setBusy(false) }
  }
  const authSubmit = (e: FormEvent) => {
    e.preventDefault()
    void act(async () => {
      if (!supabase) return
      if (mode === 'signup') {
        const { error: e1 } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: window.location.origin + window.location.pathname } })
        if (e1) throw e1
        setMessage('註冊申請已送出。若已開啟 Email 驗證，請先到信箱完成驗證，再回來登入。')
      } else {
        const { error: e1 } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (e1) throw e1
      }
    })
  }
  const signOut = () => void act(async () => { await supabase?.auth.signOut(); setSession(null); setProfile(null); setActive(false) })
  const reload = () => void act(async () => { if (session) await refresh(session) })
  const createOrder = (planId: string) => void act(async () => {
    const { error: e1 } = await supabase!.rpc('create_manual_membership_order', { p_plan_id: planId })
    if (e1) throw e1
    await refresh(session)
    setMessage('申請已建立，請依下方匯款資訊轉帳，再填寫帳號末五碼通知管理員。')
  })
  const submitTransfer = (orderId: string) => void act(async () => {
    const { error: e1 } = await supabase!.rpc('submit_manual_transfer', { p_order_id: orderId, p_transfer_last5: last5[orderId] || '', p_transfer_note: note[orderId] || '' })
    if (e1) throw e1
    await refresh(session)
    setMessage('匯款資料已送出，待管理員核對入帳。')
  })
  const approve = (orderId: string) => void act(async () => {
    const { error: e1 } = await supabase!.rpc('admin_approve_manual_order', { p_order_id: orderId })
    if (e1) throw e1
    await refresh(session)
    setMessage('已確認收款並開通會員。')
  })
  const saveSettings = () => void act(async () => {
    const { error: e1 } = await supabase!.from('membership_payment_settings').upsert({ id:true, ...settings, updated_at:new Date().toISOString() })
    if (e1) throw e1
    setMessage('匯款資訊已更新。')
  })
  const addPlan = (e: FormEvent) => {
    e.preventDefault()
    void act(async () => {
      const { error: e1 } = await supabase!.from('membership_plans').insert({ name:planName.trim(), price_twd:Number(planPrice), duration_days:Number(planDays), active:true, sort_order:plans.length })
      if (e1) throw e1
      setPlanName(''); setPlanPrice(''); setPlanDays('')
      await refresh(session)
      setMessage('會員方案已新增。')
    })
  }
  const statusText = (s: string) => ({ pending:'待付款／待審核', paid:'已開通', failed:'未通過', refunded:'已退款', expired:'已到期' }[s] || s)
  if (!membershipEnabled) return <>{children}</>
  if (!supabaseConfigured || !supabase) return <div className="member-shell"><div className="member-card"><b>NBA EDGE 會員系統尚未設定</b><p>目前尚未設定 Supabase 連線環境變數，會員登入暫不可用。</p></div></div>
  if (!ready) return <div className="member-shell"><div className="member-card">正在確認會員資格…</div></div>
  if (!session) return <div className="member-shell"><div className="member-card member-auth"><div className="member-brand">NBA <b>EDGE</b></div><span className="member-kicker">MEMBER ACCESS</span><h1>{mode === 'login' ? '會員登入' : '建立會員帳號'}</h1><p>註冊後選擇方案，完成匯款並由管理員確認，即可使用完整分析功能。</p><form onSubmit={authSubmit}><label>Email<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>密碼<input type="password" minLength={8} autoComplete={mode==='login'?'current-password':'new-password'} required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="member-primary" disabled={busy}>{busy?'處理中…':mode==='login'?'登入':'註冊帳號'}</button></form><button className="member-link" onClick={()=>{setMode(mode==='login'?'signup':'login');setError('');setMessage('')}}>{mode==='login'?'還沒有帳號？立即註冊':'已有帳號？返回登入'}</button>{message&&<p className="member-message">{message}</p>}{error&&<p className="member-error">{error}</p>}</div></div>
  if (!profile) return <div className="member-shell"><div className="member-card"><b>會員資料尚未建立</b><p>{error || '請確認資料庫 migration 已套用，並重新登入。'}</p><button onClick={reload}>重新讀取</button><button onClick={signOut}>登出</button></div></div>
  if (profile.role === 'admin') return <div className="member-shell"><div className="member-dashboard"><header><div className="member-brand">NBA <b>EDGE</b><span>管理後台</span></div><button onClick={signOut}>登出</button></header><h1>會員管理</h1><p>管理員帳號永久免費。請以銀行實際入帳為準，核對後再開通。</p>{message&&<p className="member-message">{message}</p>}{error&&<p className="member-error">{error}</p>}<section className="member-panel"><h2>收款帳戶設定</h2><div className="member-fields">{([['bank_name','銀行名稱'],['bank_code','銀行代碼'],['account_name','戶名'],['account_number','銀行帳號'],['payment_note','匯款備註']] as const).map(([k,label])=><label key={k}>{label}<input value={settings[k]} onChange={e=>setSettings(s=>({...s,[k]:e.target.value}))}/></label>)}</div><button className="member-primary" onClick={saveSettings} disabled={busy}>儲存匯款資訊</button></section><section className="member-panel"><h2>新增會員方案</h2><form className="member-fields" onSubmit={addPlan}><label>方案名稱<input required value={planName} onChange={e=>setPlanName(e.target.value)} placeholder="例如：月費會員"/></label><label>價格（NT$）<input type="number" min="0" required value={planPrice} onChange={e=>setPlanPrice(e.target.value)}/></label><label>有效天數<input type="number" min="1" required value={planDays} onChange={e=>setPlanDays(e.target.value)}/></label><button className="member-primary" disabled={busy}>新增方案</button></form><div className="member-orders">{plans.map(p=><div className="member-order" key={p.id}><b>{p.name}</b><span>NT$ {p.price_twd.toLocaleString()}／{p.duration_days} 天</span></div>)}</div></section><section className="member-panel"><h2>會員申請與收款審核</h2>{orders.length===0?<p>目前沒有訂單。</p>:orders.map(o=><div className="member-order" key={o.id}><div><b>{o.plan_name}</b><span>NT$ {o.amount_twd.toLocaleString()} · {o.duration_days} 天</span><small>帳號 {o.profiles?.email || o.user_id.slice(0,8)+'…'} · 申請 {new Date(o.created_at).toLocaleString('zh-TW')}</small><small>匯款末五碼：{o.transfer_last5||'尚未填寫'} {o.transfer_note||''}</small><small>狀態：{statusText(o.status)} {o.expires_at?'· 到期 '+new Date(o.expires_at).toLocaleDateString('zh-TW'):''}</small></div>{o.status==='pending'&&<button className="member-primary" onClick={()=>approve(o.id)} disabled={busy}>確認收款並開通</button>}</div>)}</section></div></div>
  if (active) return <><div className="member-strip"><span>會員有效 · {profile.email}</span><button onClick={signOut}>登出</button></div>{children}</>
  return <div className="member-shell"><div className="member-dashboard"><header><div className="member-brand">NBA <b>EDGE</b><span>會員中心</span></div><button onClick={signOut}>登出</button></header><h1>選擇會員方案</h1><p>完成匯款並由管理員確認後，系統會自動開通指定天數。</p>{message&&<p className="member-message">{message}</p>}{error&&<p className="member-error">{error}</p>}<div className="member-plan-grid">{plans.map(p=><article className="member-plan" key={p.id}><h2>{p.name}</h2><strong>NT$ {p.price_twd.toLocaleString()}</strong><span>有效 {p.duration_days} 天</span><button className="member-primary" onClick={()=>createOrder(p.id)} disabled={busy}>申請此方案</button></article>)}</div>{plans.length===0&&<p>目前尚無開放方案，請稍後再查看。</p>}<section className="member-panel"><h2>匯款資訊</h2><p>請先建立方案申請，再依管理員提供的帳戶資訊匯款。</p><div className="member-bank"><p>銀行：{settings.bank_name||'尚未設定'}（{settings.bank_code}）</p><p>戶名：{settings.account_name||'尚未設定'}</p><p>帳號：{settings.account_number||'尚未設定'}</p><p>{settings.payment_note}</p></div><h2>我的申請紀錄</h2>{orders.map(o=><div className="member-order" key={o.id}><div><b>{o.plan_name} · NT$ {o.amount_twd.toLocaleString()}</b><span>{statusText(o.status)}{o.expires_at?' · 到期 '+new Date(o.expires_at).toLocaleDateString('zh-TW'):''}</span></div>{o.status==='pending'&&<div className="member-transfer"><label>匯款帳號末五碼<input inputMode="numeric" maxLength={5} value={last5[o.id]||o.transfer_last5||''} onChange={e=>setLast5(s=>({...s,[o.id]:e.target.value.replace(/\D/g,'').slice(0,5)}))}/></label><label>備註（選填）<input value={note[o.id]||o.transfer_note||''} onChange={e=>setNote(s=>({...s,[o.id]:e.target.value}))}/></label><button className="member-primary" onClick={()=>submitTransfer(o.id)} disabled={busy}>送出匯款通知</button></div>}</div>)}</section></div></div>
}
