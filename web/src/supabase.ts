import { createClient } from '@supabase/supabase-js';

// La llave publishable es pública por diseño (la misma que usa la app de la tienda).
// La seguridad la ponen las reglas RLS: cada usuario solo ve los negocios de los que es miembro.
export const SUPABASE_URL = 'https://qizccncdyhzxeltwzjni.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_yrmAdp65Ai2IzEnTQkMVeA_zT_qeLSA';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'tienda-pos-panel' },
});
