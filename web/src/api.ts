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

// Todas las ventas del rango, de 1000 en 1000 (PostgREST limita cada respuesta)
export async function listAllSales(businessId: string, from: Date, to: Date): Promise<Sale[]> {
  const out: Sale[] = [];
  for (let at = 0; ; at += 1000) {
    const rows = check(await sb.from('pos_sales').select(SALE_COLS).eq('business_id', businessId)
      .gte('ts', from.toISOString()).lt('ts', to.toISOString()).order('ts', { ascending: false }).range(at, at + 999));
    out.push(...rows.map(toSale));
    if (rows.length < 1000) return out;
  }
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
  for (const table of ['pos_sales', 'pos_cash_cuts', 'pos_devices', 'pos_inventory_movements', 'pos_commands']) {
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

// ---------- cambios desde la web (órdenes que aplica la caja) ----------

export type ProductFields = Partial<{ cost: number; price: number; name: string; category: string; min_stock: number }>;
export type MoveType = 'entrada_compra' | 'salida_manual' | 'merma';
// Lo que trae cada orden según su tipo (product_edit, stock_move, product_active, product_create)
export interface RemotePayload {
  internal_id: string; before: ProductFields; after: ProductFields; undo_of?: string;
  type?: MoveType; quantity?: number; reason?: string; by?: string; active?: boolean;
  barcode?: string; name?: string; category?: string; cost?: number; price?: number; min_stock?: number;
  // catalog_save
  kind?: CatalogKind; id?: string; old_name?: string; description?: string; abbreviation?: string; phone?: string; notes?: string;
  // user_save (el PIN nunca viene aquí: solo has_pin) y role_permissions
  uid?: string; display_name?: string; role?: string; has_pin?: boolean;
  old?: { display_name?: string; role?: string; active?: boolean };
  // role_permissions usa before/after con la forma { rol: { permiso: bool } }
}
export interface RemoteChange {
  id: string; type: string; status: 'pendiente' | 'aplicado' | 'rechazado' | 'cancelado';
  payload: RemotePayload;
  created_at: string; applied_at: string | null; result: string | null; email: string | null;
}

export async function stockMove(businessId: string, internalId: string, type: MoveType, quantity: number, reason: string, undoOf: string | null = null): Promise<string> {
  return check(await sb.rpc('panel_stock_move', { p_business_id: businessId, p_internal_id: internalId, p_type: type, p_quantity: quantity, p_reason: reason, p_undo_of: undoOf })) as string;
}
export async function setProductActive(businessId: string, internalId: string, active: boolean): Promise<string> {
  return check(await sb.rpc('panel_set_product_active', { p_business_id: businessId, p_internal_id: internalId, p_active: active })) as string;
}
export interface NewProduct { barcode: string; name: string; category: string; cost: number; price: number; min_stock: number }
export async function createProduct(businessId: string, p: NewProduct): Promise<string> {
  return check(await sb.rpc('panel_create_product', {
    p_business_id: businessId, p_barcode: p.barcode, p_name: p.name, p_category: p.category,
    p_cost: p.cost, p_price: p.price, p_min_stock: p.min_stock,
  })) as string;
}

// ---------- catálogos (v0.2.16): los sube la caja; el panel deja órdenes ----------

export type CatalogKind = 'category' | 'unit' | 'supplier' | 'presentation';
export interface Catalog {
  kind: CatalogKind; id: string; name: string; active: boolean; sort_order: number | null;
  data: Partial<Record<'description' | 'abbreviation' | 'phone' | 'notes', string>>;
}
export async function listCatalogs(businessId: string): Promise<Catalog[]> {
  const rows = check(await sb.from('pos_catalogs').select('kind, id, name, active, sort_order, data')
    .eq('business_id', businessId).is('deleted_at', null).order('kind').order('sort_order').order('name').range(0, 4999));
  return rows.map((c) => ({ ...c, sort_order: n(c.sort_order), data: (c.data ?? {}) as Catalog['data'] })) as Catalog[];
}
export async function saveCatalog(businessId: string, kind: CatalogKind, id: string | null, oldName: string | null,
  name: string, active: boolean | null, data: Catalog['data']): Promise<string> {
  return check(await sb.rpc('panel_save_catalog', {
    p_business_id: businessId, p_kind: kind, p_id: id, p_old_name: oldName, p_name: name, p_active: active, p_data: data,
  })) as string;
}

export interface SuspiciousProduct { internal_id: string; barcode: string | null; name: string | null; stock: number | null; old_names: string[]; lines: number; last_seen: string | null }
export async function suspiciousProducts(businessId: string): Promise<SuspiciousProduct[]> {
  return check(await sb.rpc('panel_suspicious_products', { p_business_id: businessId })) as SuspiciousProduct[];
}
export interface StockWithoutSale { internal_id: string; barcode: string | null; name: string | null; category: string | null; stock: number | null;
  last_in_ts: string; last_in_qty: number | null; last_in_user: string | null; last_sale_ts: string | null }
export async function stockWithoutSales(businessId: string, from: Date, to: Date): Promise<StockWithoutSale[]> {
  return (check(await sb.rpc('panel_stock_without_sales', { p_business_id: businessId, p_from: from.toISOString(), p_to: to.toISOString() })) as StockWithoutSale[])
    .map((r) => ({ ...r, stock: n(r.stock), last_in_qty: n(r.last_in_qty) }));
}
export interface SaleWithoutMove { sale_id: string; ts: string | null; internal_id: string | null; name: string | null; qty: number | null }
export async function salesWithoutMoves(businessId: string, from: Date, to: Date): Promise<SaleWithoutMove[]> {
  return check(await sb.rpc('panel_sales_without_moves', { p_business_id: businessId, p_from: from.toISOString(), p_to: to.toISOString() })) as SaleWithoutMove[];
}

export async function editProduct(businessId: string, internalId: string, before: ProductFields, after: ProductFields, undoOf: string | null = null): Promise<string> {
  return check(await sb.rpc('panel_edit_product', { p_business_id: businessId, p_internal_id: internalId, p_before: before, p_after: after, p_undo_of: undoOf })) as string;
}
export async function cancelChange(commandId: string): Promise<boolean> {
  return check(await sb.rpc('panel_cancel_command', { p_command_id: commandId })) as boolean;
}
export async function recentChanges(businessId: string, days = 30): Promise<RemoteChange[]> {
  return check(await sb.rpc('panel_recent_changes', { p_business_id: businessId, p_days: days })) as RemoteChange[];
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

// En la caja el usuario ES el PIN de acceso: nunca se muestra ni se descarga. Desde la
// v0.2.17 la caja sube un identificador interno ("U-…") que sí se puede usar (uid).
export interface PosUser { uid: string | null; display_name: string | null; role: string | null; active: boolean | null }
export type RolePermissions = Record<string, Record<string, boolean>>;

export async function listPosUsers(businessId: string): Promise<{ users: PosUser[]; canEdit: boolean }> {
  const safe = check(await sb.from('pos_users').select('username, display_name, role, active')
    .eq('business_id', businessId).is('deleted_at', null).like('username', 'U-%').order('display_name'));
  if (safe.length) {
    return { users: safe.map((u) => ({ uid: u.username as string, display_name: u.display_name, role: u.role, active: u.active })), canEdit: true };
  }
  // caja vieja: filas con el PIN como usuario; solo se leen nombre, rol y estado
  const old = check(await sb.from('pos_users').select('display_name, role, active')
    .eq('business_id', businessId).is('deleted_at', null).order('display_name'));
  return { users: old.map((u) => ({ uid: null, ...u })) as PosUser[], canEdit: false };
}
export interface PosUserOld { display_name?: string | null; role?: string | null; active?: boolean | null }
export async function saveCajaUser(businessId: string, uid: string | null, old: PosUserOld | null, displayName: string,
  role: string, active: boolean | null, pin: string | null): Promise<string> {
  return check(await sb.rpc('panel_save_pos_user', {
    p_business_id: businessId, p_uid: uid, p_old: old, p_display_name: displayName, p_role: role, p_active: active, p_pin: pin,
  })) as string;
}
export async function saveRolePermissions(businessId: string, before: RolePermissions, after: RolePermissions): Promise<string> {
  return check(await sb.rpc('panel_save_role_permissions', { p_business_id: businessId, p_before: before, p_after: after })) as string;
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

// Solo el superadmin: quien ya se registró y todavía no tiene tienda
export interface UnassignedAccount { user_id: string; email: string; created_at: string; confirmed: boolean }

export async function listUnassignedAccounts(): Promise<UnassignedAccount[]> {
  return check(await sb.rpc('panel_unassigned_accounts')) as UnassignedAccount[];
}

// Solo el superadmin; lo hace la Edge Function "cuentas" (lleva la llave que el navegador no debe tener)
async function callAccounts(body: Record<string, unknown>) {
  const { data, error } = await sb.functions.invoke('cuentas', { body });
  if (!error) return data;
  let message = 'No se pudo completar. Revisa tu conexión e intenta de nuevo.';
  try { message = (await (error as unknown as { context: Response }).context.json()).error ?? message; } catch { /* sin respuesta del servidor */ }
  throw new Error(message);
}
export const createAccount = (email: string, password: string, businessId: string, role: 'owner' | 'gestor') =>
  callAccounts({ action: 'create', email, password, business_id: businessId, role });
export const resetAccountPassword = (userId: string, password: string) =>
  callAccounts({ action: 'reset', user_id: userId, password });

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

// Ventas canceladas desde una fecha (las viejas pueden no tener cancelled_at: se usa su fecha de venta)
export interface CancelledSale {
  id: string; business_id: string; ts: string | null; total: number | null;
  cancelled_at: string | null; cancelled_by: string | null; cancelled_authorized_by: string | null;
}

export async function listCancelled(from: Date, businessId?: string): Promise<CancelledSale[]> {
  const iso = from.toISOString();
  let q = sb.from('pos_sales').select('id, business_id, ts, total, cancelled_at, cancelled_by, cancelled_authorized_by')
    .eq('cancelled', true).or(`cancelled_at.gte."${iso}",and(cancelled_at.is.null,ts.gte."${iso}")`)
    .order('ts', { ascending: false }).limit(500);
  if (businessId) q = q.eq('business_id', businessId);
  return check(await q).map((r) => ({ ...r, total: n(r.total) }));
}

export async function salesSince(from: Date): Promise<{ business_id: string; total: number | null; cancelled: boolean }[]> {
  const rows = check(await sb.from('pos_sales').select('business_id, total, cancelled').gte('ts', from.toISOString()).limit(10000));
  return rows.map((r) => ({ ...r, total: n(r.total) }));
}
