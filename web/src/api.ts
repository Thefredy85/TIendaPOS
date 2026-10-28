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
  for (const table of ['pos_sales', 'pos_cash_cuts', 'pos_devices', 'pos_inventory_movements']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `business_id=eq.${businessId}` }, () => onChange(table));
  }
  ch.subscribe();
  return () => { void sb.removeChannel(ch); };
}

// ---------- licencias (solo superadmin; columnas sin el secreto del código) ----------

export interface License {
  business_id: string; cut_day: number; monthly_amount: number; paid_until: string;
  enforce: boolean; notes: string | null; updated_at: string;
}
export interface LicensePayment {
  id: string; business_id: string; paid_at: string; amount: number; method: string | null;
  covers_from: string; covers_until: string; notes: string | null;
}
export interface AppPolicy { min_version: string | null; min_version_set_at: string | null; contact_text: string | null }

export async function listLicenses(): Promise<License[]> {
  const rows = check(await sb.from('licenses').select('business_id, cut_day, monthly_amount, paid_until, enforce, notes, updated_at'));
  return rows.map((r) => ({ ...r, monthly_amount: n(r.monthly_amount) ?? 0 })) as License[];
}

export async function listPayments(businessId: string): Promise<LicensePayment[]> {
  const rows = check(await sb.from('license_payments').select('id, business_id, paid_at, amount, method, covers_from, covers_until, notes')
    .eq('business_id', businessId).order('paid_at', { ascending: false }).limit(50));
  return rows.map((r) => ({ ...r, amount: n(r.amount) ?? 0 })) as LicensePayment[];
}

export async function getPolicy(): Promise<AppPolicy> {
  const rows = check(await sb.from('app_policy').select('min_version, min_version_set_at, contact_text'));
  return (rows[0] as AppPolicy) ?? { min_version: null, min_version_set_at: null, contact_text: null };
}

export async function licUpsert(businessId: string, cutDay: number, amount: number, paidUntil: string, notes: string | null) {
  return check(await sb.rpc('lic_upsert', { p_business_id: businessId, p_cut_day: cutDay, p_monthly_amount: amount, p_paid_until: paidUntil, p_notes: notes }));
}
export async function licRegisterPayment(businessId: string, amount: number, method: string, notes: string | null): Promise<{ paid_until: string; covers_from: string }> {
  return check(await sb.rpc('lic_register_payment', { p_business_id: businessId, p_amount: amount, p_method: method, p_notes: notes }));
}
export async function licSetEnforce(businessId: string, enforce: boolean) {
  return check(await sb.rpc('lic_set_enforce', { p_business_id: businessId, p_enforce: enforce }));
}
export async function licUnlockCode(businessId: string): Promise<{ code: string; day: string; days: number }> {
  return check(await sb.rpc('lic_unlock_code', { p_business_id: businessId }));
}
export async function licSetMinVersion(version: string | null) {
  return check(await sb.rpc('lic_set_min_version', { p_version: version }));
}
export async function licSetContact(text: string | null) {
  return check(await sb.rpc('lic_set_contact', { p_text: text }));
}

// ---------- inventario ----------

export interface Product {
  internal_id: string; barcode: string | null; name: string | null; category: string | null;
  presentation: string | null; supplier: string | null; unit: string | null;
  cost: number | null; price: number | null; stock: number | null; min_stock: number | null; active: boolean | null;
}

// Trae todos los productos activos (de 1000 en 1000: PostgREST limita cada respuesta).
export async function listProducts(businessId: string): Promise<Product[]> {
  const out: Product[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await sb.from('pos_products')
      .select('internal_id, barcode, name, category, presentation, supplier, unit, cost, price, stock, min_stock, active')
      .eq('business_id', businessId).is('deleted_at', null).order('name').range(from, from + 999));
    out.push(...rows.map((p) => ({ ...p, cost: n(p.cost), price: n(p.price), stock: n(p.stock), min_stock: n(p.min_stock) })) as Product[]);
    if (rows.length < 1000) return out;
  }
}

// ---------- movimientos ----------

export interface Movement {
  id: string; ts: string | null; type: string | null; internal_id: string | null; product_name: string | null;
  quantity: number | null; stock_before: number | null; stock_after: number | null; total_cost: number | null;
  reason: string | null; reference: string | null; user_name: string | null; authorized_by: string | null;
  notes: string | null; voided_at: string | null;
}

export async function listMovements(businessId: string, from: Date, to: Date,
  opts: { type?: string; internalId?: string; withSales?: boolean; limit?: number } = {}): Promise<Movement[]> {
  let q = sb.from('pos_inventory_movements')
    .select('id, ts, type, internal_id, product_name, quantity, stock_before, stock_after, total_cost, reason, reference, user_name, authorized_by, notes, voided_at')
    .eq('business_id', businessId).gte('ts', from.toISOString()).lt('ts', to.toISOString())
    .order('ts', { ascending: false }).limit(opts.limit ?? 2000);
  if (opts.type) q = q.eq('type', opts.type);
  else if (!opts.withSales) q = q.neq('type', 'venta');
  if (opts.internalId) q = q.eq('internal_id', opts.internalId);
  return check(await q).map((m) => ({
    ...m, quantity: n(m.quantity), stock_before: n(m.stock_before), stock_after: n(m.stock_after), total_cost: n(m.total_cost),
  })) as Movement[];
}

// Últimos movimientos de un producto (cualquier fecha)
export async function productMovements(businessId: string, internalId: string, limit = 30): Promise<Movement[]> {
  return listMovements(businessId, new Date(2000, 0, 1), new Date(Date.now() + 86_400_000), { internalId, withSales: true, limit });
}

// ---------- usuarios del POS y permisos (solo lectura) ----------

export interface PosUser { username: string; display_name: string | null; role: string | null; active: boolean | null }
export type RolePermissions = Record<string, Record<string, boolean>>;

export async function listPosUsers(businessId: string): Promise<PosUser[]> {
  return check(await sb.from('pos_users').select('username, display_name, role, active')
    .eq('business_id', businessId).is('deleted_at', null).order('display_name'));
}

export async function getRolePermissions(businessId: string): Promise<RolePermissions | null> {
  const rows = check(await sb.from('pos_role_permissions').select('permissions, source_at')
    .eq('business_id', businessId).order('source_at', { ascending: false }).limit(1));
  return (rows[0]?.permissions as RolePermissions) ?? null;
}

// ---------- reportes (funciones de supabase/migrations/20261028000000_panel_tiendas.sql) ----------

export interface DayRow { day: string; total: number; tickets: number; cancelled: number; profit: number }
export interface ProductRow { internal_id: string; barcode: string | null; name: string | null; qty: number; amount: number; cost: number; tickets: number }
export interface CashierRow { cashier: string; total: number; tickets: number; cancelled: number; cancelled_amount: number }

const numRow = <T>(r: Record<string, unknown>, keys: string[]): T =>
  ({ ...r, ...Object.fromEntries(keys.map((k) => [k, Number(r[k]) || 0])) }) as T;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Mexico_City';

export async function reportDaily(businessId: string, from: Date, to: Date): Promise<DayRow[]> {
  const rows = check(await sb.rpc('panel_report_daily', { p_business_id: businessId, p_from: from.toISOString(), p_to: to.toISOString(), p_tz: TZ }));
  return (rows as Record<string, unknown>[]).map((r) => numRow<DayRow>(r, ['total', 'tickets', 'cancelled', 'profit']));
}
export async function reportProducts(businessId: string, from: Date, to: Date): Promise<ProductRow[]> {
  const rows = check(await sb.rpc('panel_report_products', { p_business_id: businessId, p_from: from.toISOString(), p_to: to.toISOString() }));
  return (rows as Record<string, unknown>[]).map((r) => numRow<ProductRow>(r, ['qty', 'amount', 'cost', 'tickets']));
}
export async function reportCashiers(businessId: string, from: Date, to: Date): Promise<CashierRow[]> {
  const rows = check(await sb.rpc('panel_report_cashiers', { p_business_id: businessId, p_from: from.toISOString(), p_to: to.toISOString() }));
  return (rows as Record<string, unknown>[]).map((r) => numRow<CashierRow>(r, ['total', 'tickets', 'cancelled', 'cancelled_amount']));
}

// ---------- accesos al panel ----------

export interface Member { user_id: string; email: string; role: 'owner' | 'gestor'; created_at: string }

export async function listMembers(businessId: string): Promise<Member[]> {
  return check(await sb.rpc('panel_list_members', { p_business_id: businessId })) as Member[];
}
export async function addMember(businessId: string, email: string, role: 'owner' | 'gestor') {
  return check(await sb.rpc('panel_add_member', { p_business_id: businessId, p_email: email, p_role: role }));
}
export async function removeMember(businessId: string, userId: string): Promise<boolean> {
  return check(await sb.rpc('panel_remove_member', { p_business_id: businessId, p_user_id: userId })) as boolean;
}

// ---------- licencia propia (dueño y gestor) ----------

export interface MyLicense { defined: boolean; cut_day?: number; monthly_amount?: number; paid_until?: string; enforce?: boolean; contact_text: string | null }

export async function myLicense(businessId: string): Promise<MyLicense> {
  const r = check(await sb.rpc('panel_my_license', { p_business_id: businessId })) as MyLicense;
  return { ...r, monthly_amount: r.monthly_amount === undefined ? undefined : Number(r.monthly_amount) };
}

// ---------- resumen de todas las tiendas (superadmin) ----------

export async function listAllDevices(): Promise<Device[]> {
  const rows = check(await sb.from('pos_devices').select(DEVICE_COLS).order('registered_at'));
  return rows.map((d) => ({ ...d, cash_opening_amount: n(d.cash_opening_amount) })) as Device[];
}

export async function salesSince(from: Date): Promise<{ business_id: string; total: number | null; cancelled: boolean }[]> {
  const rows = check(await sb.from('pos_sales').select('business_id, total, cancelled').gte('ts', from.toISOString()).limit(10000));
  return rows.map((r) => ({ ...r, total: n(r.total) }));
}
