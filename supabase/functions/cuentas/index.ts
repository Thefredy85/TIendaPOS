// Edge Function "cuentas": el administrador del sistema crea cuentas del panel y pone
// contraseñas temporales. Crear cuentas requiere la llave service_role, que solo existe
// aquí dentro (Supabase la inyecta como variable); nunca llega al navegador.
//
// Se publica sin verificación de JWT en la puerta (--no-verify-jwt) porque aquí mismo se
// valida la sesión contra Auth y se exige que la persona esté en la tabla superadmins.

const BASE = Deno.env.get('SUPABASE_URL') ?? 'https://qizccncdyhzxeltwzjni.supabase.co';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ORIGINS = ['https://tienda-pos-panel.pages.dev', 'http://localhost:5173'];
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return {
    ...(ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

// Quién llama, según su sesión (null si no hay sesión válida)
async function callerId(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${BASE}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return ((await r.json())?.id as string) ?? null;
}

async function isSuperadmin(id: string): Promise<boolean> {
  const r = await fetch(`${BASE}/rest/v1/superadmins?select=user_id&user_id=eq.${id}`, { headers: admin });
  if (!r.ok) throw new Error(`superadmins ${r.status}`);
  return (await r.json()).length > 0;
}

const badPassword = (p: string) => p.length < 8 || p.length > 72;

type Reply = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string): Reply => ({ status, body: { error } });

async function createAccount(b: Record<string, unknown>): Promise<Reply> {
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');
  const businessId = String(b.business_id ?? '');
  const role = String(b.role ?? '');
  if (!EMAIL.test(email)) return fail(400, 'Escribe un correo válido.');
  if (badPassword(password)) return fail(400, 'La contraseña debe tener entre 8 y 72 caracteres.');
  if (!UUID.test(businessId)) return fail(400, 'Elige la tienda.');
  if (role !== 'owner' && role !== 'gestor') return fail(400, 'Elige el tipo de acceso.');

  const created = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { must_change_password: true } }),
  });
  const user = await created.json().catch(() => ({}));
  if (!created.ok) {
    if (user.error_code === 'email_exists' || /already/i.test(String(user.msg ?? ''))) {
      return fail(409, 'Ese correo ya tiene cuenta. Dale acceso desde Usuarios → Accesos o desde Cuentas sin tienda.');
    }
    if (user.error_code === 'weak_password') return fail(400, 'Esa contraseña es muy débil. Usa otra.');
    return fail(502, 'No se pudo crear la cuenta. Intenta de nuevo.');
  }

  const member = await fetch(`${BASE}/rest/v1/business_members`, {
    method: 'POST', headers: { ...admin, Prefer: 'return=minimal' },
    body: JSON.stringify({ business_id: businessId, user_id: user.id, role }),
  });
  if (!member.ok) {
    // sin tienda la cuenta no sirve: se deshace para poder intentar de nuevo con el mismo correo
    await fetch(`${BASE}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: admin });
    return fail(502, 'No se pudo asignar la tienda. La cuenta no se creó.');
  }
  return { status: 200, body: { user_id: user.id, email } };
}

async function resetPassword(b: Record<string, unknown>): Promise<Reply> {
  const userId = String(b.user_id ?? '');
  const password = String(b.password ?? '');
  if (!UUID.test(userId)) return fail(400, 'Cuenta inválida.');
  if (badPassword(password)) return fail(400, 'La contraseña debe tener entre 8 y 72 caracteres.');
  if (await isSuperadmin(userId)) return fail(400, 'La cuenta del administrador del sistema no se cambia desde aquí.');
  const r = await fetch(`${BASE}/auth/v1/admin/users/${userId}`, {
    method: 'PUT', headers: admin,
    body: JSON.stringify({ password, user_metadata: { must_change_password: true } }),
  });
  if (r.status === 404) return fail(404, 'Esa cuenta ya no existe.');
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    return fail(e.error_code === 'weak_password' ? 400 : 502,
      e.error_code === 'weak_password' ? 'Esa contraseña es muy débil. Usa otra.' : 'No se pudo cambiar la contraseña. Intenta de nuevo.');
  }
  return { status: 200, body: { user_id: userId } };
}

Deno.serve(async (req) => {
  const headers = cors(req);
  const send = ({ status, body }: Reply) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return send(fail(405, 'Método no permitido'));
  try {
    const id = await callerId(req);
    if (!id) return send(fail(401, 'Tu sesión terminó. Vuelve a entrar.'));
    if (!(await isSuperadmin(id))) return send(fail(403, 'Solo el administrador del sistema puede hacer esto.'));
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return send(fail(400, 'Solicitud inválida.'));
    if (body.action === 'create') return send(await createAccount(body));
    if (body.action === 'reset') return send(await resetPassword(body));
    return send(fail(400, 'Acción desconocida.'));
  } catch (e) {
    console.error('cuentas:', (e as Error).message);
    return send(fail(500, 'Algo falló en el servidor. Intenta de nuevo.'));
  }
});
