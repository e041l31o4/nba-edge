import { createClient } from '@supabase/supabase-js'

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(url && key)
export const supabase = supabaseConfigured ? createClient(url!, key!) : null
