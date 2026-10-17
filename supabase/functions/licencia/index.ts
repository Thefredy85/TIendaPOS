// Edge Function "licencia": firma la licencia que recibe cada caja.
//
// La caja manda su token (el que le dio pos_register_device). Esta función le pide a
// la base la licencia de esa caja con la RPC pos_license (que valida que la caja esté
// aprobada), firma EXACTAMENTE esos bytes con la llave privada Ed25519 (secreto
// LICENSE_SIGNING_KEY, que nunca sale de Supabase) y devuelve { payload, signature }.
// La app comprueba la firma con la llave pública que lleva dentro: editar la licencia
// guardada en la PC de la tienda no sirve, porque la firma deja de coincidir.
//
// Se publica sin verificación de JWT (--no-verify-jwt): la caja no tiene sesión; se
// identifica con su token, que valida pos_license.

// Llave publishable: es pública por diseño (la misma que usa la app de la tienda).
const PUBLISHABLE_KEY = 'sb_publishable_yrmAdp65Ai2IzEnTQkMVeA_zT_qeLSA';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://qizccncdyhzxeltwzjni.supabase.co';

let signingKey: Promise<CryptoKey> | null = null;
function getKey(): Promise<CryptoKey> {
  if (!signingKey) {
    const b64 = Deno.env.get('LICENSE_SIGNING_KEY') ?? '';
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    signingKey = crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  }
  return signingKey;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  let token = '';
  try {
    token = String((await req.json())?.token ?? '');
  } catch {
    // cuerpo vacío o inválido: se rechaza abajo
  }
  if (token.length < 32 || token.length > 200) return json({ error: 'Token de caja inválido' }, 401);

  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pos_license`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token }),
  });
  const payload = await r.text();
  if (!r.ok) {
    let message = 'No se pudo leer la licencia';
    try { message = JSON.parse(payload).message ?? message; } catch { /* respuesta no JSON */ }
    return json({ error: message }, r.status === 401 || r.status === 403 ? 401 : 502);
  }
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, await getKey(), new TextEncoder().encode(payload)));
  return json({ payload, signature: btoa(String.fromCharCode(...signature)) });
});
