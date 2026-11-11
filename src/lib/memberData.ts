import { supabase } from './supabase'

const privateMode = import.meta.env.VITE_MEMBERSHIP_ENABLED === 'true'

export async function loadDataset<T>(key: string, publicFile: string): Promise<T | null> {
  if (privateMode) {
    if (!supabase) throw new Error('會員資料庫尚未設定')
    const { data, error } = await supabase.rpc('get_member_dataset', { p_dataset_key: key })
    if (error) throw new Error(error.message || '會員資料讀取失敗')
    return data as T
  }

  const response = await fetch(`${import.meta.env.BASE_URL}data/${publicFile}?t=${Date.now()}`, { cache: 'no-store' })
  if (!response.ok) return null
  if (publicFile.endsWith('.jsonl')) {
    const raw = await response.text()
    return raw.split(/\\r?\\n/).filter(line => line.trim()).map(line => JSON.parse(line)) as T
  }
  return response.json() as Promise<T>
}
