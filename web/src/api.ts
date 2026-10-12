import { sb } from './supabase';

// ---------- tipos (columnas de supabase/migrations/20261012000100_fase1_seguridad_y_esquema.sql) ----------

export interface Business { id: string; license_key: string; name: string | null; status: string }

export type DeviceStatus = 'pendiente' | 'aprobado' | 'revocado';
export interface Device {
  id: string; business_id: string; name: string | null; status: DeviceStatus;
  app_version: string | null; last_seen_at: string | null; session_user_name: string | null;
  cash_open: boolean | null; cash_period_start: string | null; cash_opening_amount: number | null;
  registered_at: string; approved_at: string | null;
}

export interface Sale {
  id: string; device_id: string | null; ts: string | null; subtotal: number | null; total: number | null;
  payment_method: string | null; payment_breakdown: Record<string, number>; cashier: string | null;
  profit: number | null; notes: string | null; cancelled: boolean; cancelled_at: string | null;
  cancelled_by: string | null; cancelled_authorized_by: string | null;
}

export interface SaleItem {
  line_no: number; internal_id: string | null; barcode: string | null; name: string | null;
  qty: number | null; price: number | null; cost: number | null;
}

export interface CashCut {
  id: string; device_id: string | null; cut_type: 'apertura' | 'x' | 'z' | null; ts: string | null;
  period_start: string | null; period_end: string | null; opening_amount: number | null; total: number | null;
  sales_count: number | null; payments: Record<string, number>; cashier: string | null; notes: string | null;
}

export type Role = 'superadmin' | 'owner' | 'gestor';

// Postgres devuelve numeric como texto: se convierte a número al leer.
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const numObj = (o: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries((o as Record<string, unknown>) ?? {}).map(([k, v]) => [k, Number(v) || 0]));

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

// ---------- negocios y rol ----------

export async function listBusinesses(): Promise<Business[]> {
  return check(await sb.from('businesses').select('id, license_key, name, status').order('name'));
}

export async function myRole(businessId: string): Promise<Role | null> {
  const uid = (await sb.auth.getUser()).data.user?.id;
  if (!uid) return null;
  const sa = check(await sb.from('superadmins').select('user_id').eq('user_id', uid));
  if (sa.length) return 'superadmin';
  const m = check(await sb.from('business_members').select('role').eq('business_id', businessId).eq('user_id', uid));
  return (m[0]?.role as Role) ?? null;
}

// ---------- cajas ----------

const DEVICE_COLS = 'id, business_id, name, status, app_version, last_seen_at, session_user_name, cash_open, cash_period_start, cash_opening_amount, registered_at, approved_at';

export async function listDevices(businessId: string): Promise<Device[]> {
  const rows = check(await sb.from('pos_devices').select(DEVICE_COLS).eq('business_id', businessId).order('registered_at'));
  return rows.map((d) => ({ ...d, cash_opening_amount: n(d.cash_opening_amount) })) as Device[];
}

export async function setDeviceStatus(deviceId: string, status: 'aprobado' | 'revocado'): Promise<void> {
  check(await sb.rpc('pos_set_device_status', { p_device_id: deviceId, p_status: status }));
}

// ---------- ventas ----------

const SALE_COLS = 'id, device_id, ts, subtotal, total, payment_method, payment_breakdown, cashier, profit, notes, cancelled, cancelled_at, cancelled_by, cancelled_authorized_by';

const toSale = (s: Record<string, unknown>): Sale => ({
  ...(s as unknown as Sale),
  subtotal: n(s.subtotal), total: n(s.total), profit: n(s.profit), payment_breakdown: numObj(s.payment_breakdown),
});

export async function listSales(businessId: string, from: Date, to: Date, cashier?: string): Promise<Sale[]> {
  let q = sb.from('pos_sales').select(SALE_COLS).eq('business_id', businessId)
    .gte('ts', from.toISOString()).lt('ts', to.toISOString()).order('ts', { ascending: false }).limit(1000);
  if (cashier) q = q.eq('cashier', cashier);
  return check(await q).map(toSale);
}

export async function getSaleItems(businessId: string, saleId: string): Promise<SaleItem[]> {
  const rows = check(await sb.from('pos_sale_items').select('line_no, internal_id, barcode, name, qty, price, cost')
    .eq('business_id', businessId).eq('sale_id', saleId).order('line_no'));
  return rows.map((r) => ({ ...r, qty: n(r.qty), price: n(r.price), cost: n(r.cost) }));
}

// ---------- cortes ----------

const toCut = (c: Record<string, unknown>): CashCut => ({
  ...(c as unknown as CashCut),
  opening_amount: n(c.opening_amount), total: n(c.total), sales_count: n(c.sales_count), payments: numObj(c.payments),
});

export async function listCuts(businessId: string, from: Date, to: Date): Promise<CashCut[]> {
  const rows = check(await sb.from('pos_cash_cuts')
    .select('id, device_id, cut_type, ts, period_start, period_end, opening_amount, total, sales_count, payments, cashier, notes')
    .eq('business_id', businessId).gte('ts', from.toISOString()).lt('ts', to.toISOString())
    .order('ts', { ascending: false }).limit(500));
  return rows.map(toCut);
}

// ---------- tiempo real ----------
// Avisa cuando cambian ventas, cortes o cajas del negocio (Supabase Realtime respeta RLS).
export function watchBusiness(businessId: string, onChange: (table: string) => void): () => void {
  const ch = sb.channel(`negocio-${businessId}`);
  for (const table of ['pos_sales', 'pos_cash_cuts', 'pos_devices']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `business_id=eq.${businessId}` }, () => onChange(table));
  }
  ch.subscribe();
  return () => { void sb.removeChannel(ch); };
}
