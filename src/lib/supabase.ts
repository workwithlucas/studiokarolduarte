import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/db'
import { LOCAL_SUPABASE_ANON_KEY, LOCAL_SUPABASE_URL } from './local-supabase'

// Vite dev (and Node scripts, where import.meta.env is undefined) talk to the local stack.
const env = import.meta.env as ImportMetaEnv | undefined
const useLocal = env === undefined || env.DEV

const url = useLocal ? LOCAL_SUPABASE_URL : (env?.VITE_SUPABASE_URL ?? '')
const key = useLocal ? LOCAL_SUPABASE_ANON_KEY : (env?.VITE_SUPABASE_ANON_KEY ?? '')

export const supabase = createClient<Database>(url, key)
