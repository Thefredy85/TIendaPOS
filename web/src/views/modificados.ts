import type { Ctx } from '../main';
import { cancelChange, editProduct, listDevices, listProducts, recentChanges, stockMove, type MoveType, type ProductFields, type RemoteChange } from '../api';
import { askConfirm, ago, esc, fmtDateTime, fmtMoney, fmtQty, icon, paintIcons, toast } from '../ui';

// Primera versión de la app que aplica las órdenes del panel
export const MIN_EDIT_VERSION = '0.2.15';

export const isOlder = (v: string, min: string) => {
  const a = v.split('.').map(Number); const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); }
  return false;
};

// ¿Alguna caja aprobada de esta tienda ya entiende las órdenes?
export async function storeCanApply(businessId: string): Promise<boolean> {
  const devices = await listDevices(businessId);
  return devices.some((d) => d.status === 'aprobado' && d.app_version && !isOlder(d.app_version, MIN_EDIT_VERSION));
}
export const OLD_APP_NOTICE = `Esta tienda todavía no tiene la versión ${MIN_EDIT_VERSION}: el cambio se quedará esperando hasta que se actualice.`;

const FIELD_LABEL: Record<keyof ProductFields, string> = { cost: 'Costo', price: 'Precio', name: 'Nombre', category: 'Categoría', min_stock: 'Mínimo' };

export function fieldValue(k: keyof ProductFields, v: string | number | undefined | null): string {
  if (k === 'cost' || k === 'price') return fmtMoney(Number(v ?? 0));
  if (k === 'min_stock') return fmtQty(Number(v ?? 0));
  return String(v ?? '—');
}
export const changedKeys = (after: ProductFields) => Object.keys(after) as (keyof ProductFields)[];

const MOVE_TEXT: Record<MoveType, string> = { entrada_compra: 'Entrada por compra', salida_manual: 'Salida manual', merma: 'Merma' };
const KNOWN = ['product_edit', 'stock_move', 'product_active', 'product_create', 'catalog_save', 'user_save', 'role_permissions'];
const ROLE_ONE: Record<string, string> = { admin: 'Administrador', encargado: 'Encargado', cajero: 'Cajero' };
const PERM_ONE: Record<string, string> = { settings: 'Configuración', catalogs: 'Catálogos', products: 'Productos', movements: 'Entradas y salidas', counts: 'Conteos', cashcut: 'Cortes' };
const CATALOG_ONE: Record<string, string> = { category: 'Categoría', presentation: 'Presentación', unit: 'Unidad', supplier: 'Proveedor' };

// Qué dice cada cambio en una línea
function describe(c: RemoteChange): string {
  const p = c.payload;
  if (c.type === 'stock_move') {
    const q = Number(p.quantity ?? 0);
    return `${MOVE_TEXT[p.type as MoveType] ?? p.type} ${p.type === 'entrada_compra' ? '+' : '−'}${fmtQty(q)} · ${p.reason ?? ''}`;
  }
  if (c.type === 'product_active') return p.active ? 'Activar (vuelve a la venta)' : 'Desactivar (sale de la venta)';
  if (c.type === 'catalog_save') {
    const parts: string[] = [];
    if (!p.id) parts.push('Alta');
    else if (p.old_name && p.old_name !== p.name) parts.push(`Nombre ${p.old_name} → ${p.name} (también en sus productos)`);
    if (p.active === false) parts.push('Desactivar');
    if (p.active === true) parts.push('Activar');
    for (const [k, l] of [['description', 'Descripción'], ['abbreviation', 'Abreviatura'], ['phone', 'Teléfono'], ['notes', 'Notas']] as const) {
      if (p[k] !== undefined && p[k] !== '') parts.push(`${l}: ${p[k]}`);
    }
    return `${CATALOG_ONE[p.kind ?? ''] ?? 'Catálogo'} · ${parts.join(' · ') || 'Datos'}`;
  }
  // El PIN nunca viaja en la orden: solo se dice si se cambió
  if (c.type === 'user_save') {
    const o = p.old ?? {}; const parts: string[] = [];
    if (!p.uid) parts.push(`Alta · ${ROLE_ONE[p.role ?? ''] ?? p.role}`);
    else {
      if (o.display_name !== undefined && o.display_name !== p.display_name) parts.push(`Nombre ${o.display_name ?? '—'} → ${p.display_name}`);
      if (o.role !== undefined && o.role !== p.role) parts.push(`Rol ${ROLE_ONE[o.role] ?? o.role} → ${ROLE_ONE[p.role ?? ''] ?? p.role}`);
    }
    if (p.has_pin) parts.push(p.uid ? 'PIN nuevo' : 'con PIN');
    if (p.active === false) parts.push('Desactivar');
    if (p.active === true) parts.push('Activar');
    return `Usuario de la caja · ${parts.join(' · ') || 'Datos'}`;
  }
  if (c.type === 'role_permissions') {
    const parts: string[] = [];
    for (const [r, keys] of Object.entries((p.after ?? {}) as Record<string, Record<string, boolean>>)) {
      for (const [k, v] of Object.entries(keys)) parts.push(`${ROLE_ONE[r] ?? r} · ${PERM_ONE[k] ?? k}: ${v ? 'Sí' : 'No'}`);
    }
    return parts.join(' · ');
  }
  if (c.type === 'product_create') return `Alta · código ${p.barcode ?? '—'} · ${p.category ?? ''} · costo ${fmtMoney(Number(p.cost ?? 0))} · precio ${fmtMoney(Number(p.price ?? 0))}`;
  return changedKeys(p.after).map((k) => `${FIELD_LABEL[k]} ${fieldValue(k, p.before[k])} → ${fieldValue(k, p.after[k])}`).join(' · ');
}

const PILL: Record<RemoteChange['status'], [string, string]> = {
  pendiente: ['wait', 'Esperando a la caja'], aplicado: ['ok', 'Aplicado'], rechazado: ['bad', 'Rechazado'], cancelado: ['off', 'Cancelado'],
};

export async function renderModificados(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Cambios hechos desde el panel en los últimos 30 días';
  el.innerHTML = '<div class="card empty">Cargando…</div>';
  let working = false;

  const draw = async () => {
    if (working) return;
    let changes: RemoteChange[], names: Map<string, string>, canApply: boolean;
    try {
      const [c, products, ok] = await Promise.all([recentChanges(ctx.business.id), listProducts(ctx.business.id), storeCanApply(ctx.business.id)]);
      changes = c.filter((x) => KNOWN.includes(x.type));
      names = new Map(products.map((p) => [p.internal_id, p.name ?? 'Sin nombre']));
      canApply = ok;
    } catch (e) {
      el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      return;
    }
    const undone = new Set(changes.filter((c) => c.status !== 'cancelado' && c.status !== 'rechazado').map((c) => c.payload.undo_of).filter(Boolean));
    const busy = new Set(changes.filter((c) => c.status === 'pendiente' && c.type === 'product_edit').map((c) => c.payload.internal_id));
    // Se deshacen cambios de datos (si no hay otro esperando) y movimientos (con el movimiento contrario)
    // Un "deshacer" no se puede deshacer: se encadenaría sin querer. Para volver al valor, se edita de nuevo.
    const canUndo = (c: RemoteChange) => ctx.canManageDevices && c.status === 'aplicado' && !undone.has(c.id) && !c.payload.undo_of
      && (c.type === 'stock_move' || (c.type === 'product_edit' && !busy.has(c.payload.internal_id)));
    const title = (c: RemoteChange) => c.type === 'user_save' ? (c.payload.display_name ?? 'Usuario')
      : c.type === 'role_permissions' ? 'Permisos por rol'
      : c.type === 'product_create' || c.type === 'catalog_save' ? (c.payload.name ?? 'Producto nuevo')
      : names.get(c.payload.internal_id) ?? 'Producto ya no disponible';

    el.innerHTML = `${!canApply && ctx.canManageDevices ? `<div class="banner wait">${icon('shield-alert')}<span class="small">${esc(OLD_APP_NOTICE)}</span></div>` : ''}
      ${changes.length ? `<ul class="list card">${changes.map((c) => {
        const [cls, label] = PILL[c.status];
        const what = describe(c);
        return `<li class="assign">
          <div class="grow"><div><b>${esc(title(c))}</b>${c.payload.undo_of ? ' <span class="small muted">(deshacer)</span>' : ''}</div>
            <div class="small">${esc(what)}</div>
            <div class="small muted" title="${esc(fmtDateTime(c.created_at))}">${esc(c.email ?? '—')} · ${esc(ago(c.created_at))}</div>
            ${c.status === 'rechazado' && c.result ? `<div class="small" style="color:var(--danger)">${esc(c.result)}</div>` : ''}</div>
          <span class="pill ${cls}">${label}</span>
          ${c.status === 'pendiente' && ctx.canManageDevices ? `<button class="btn" data-cancel="${c.id}">Cancelar</button>` : ''}
          ${canUndo(c) ? `<button class="btn" data-undo="${c.id}">Deshacer</button>` : ''}
        </li>`;
      }).join('')}</ul>` : '<div class="card empty">Todavía no hay cambios hechos desde el panel.</div>'}`;
    paintIcons();

    const act = async (fn: () => Promise<unknown>, done: string) => {
      working = true;
      try { await fn(); toast(done); } catch (e) { toast((e as Error).message); }
      working = false;
      await draw();
    };
    el.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach((b) => {
      b.onclick = async () => {
        if (await askConfirm('¿Retirar este cambio? La caja ya no lo aplicará.')) void act(() => cancelChange(b.dataset.cancel!), 'Cambio cancelado');
      };
    });
    el.querySelectorAll<HTMLButtonElement>('[data-undo]').forEach((b) => {
      b.onclick = async () => {
        const c = changes.find((x) => x.id === b.dataset.undo)!;
        if (c.type === 'stock_move') {
          const back: MoveType = c.payload.type === 'entrada_compra' ? 'salida_manual' : 'entrada_compra';
          const q = Number(c.payload.quantity ?? 0);
          if (!await askConfirm(`¿Deshacer este movimiento de "${title(c)}"?

Se enviará ${MOVE_TEXT[back].toLowerCase()} de ${fmtQty(q)} para compensarlo.`)) return;
          void act(() => stockMove(ctx.business.id, c.payload.internal_id, back, q, `Deshacer: ${c.payload.reason ?? ''}`.slice(0, 200), c.id), 'Enviado a la caja');
          return;
        }
        const lines = changedKeys(c.payload.after).map((k) => `${FIELD_LABEL[k]}: ${fieldValue(k, c.payload.after[k])} → ${fieldValue(k, c.payload.before[k])}`).join('\n');
        if (!await askConfirm(`¿Deshacer este cambio de "${names.get(c.payload.internal_id) ?? 'producto'}"?\n\n${lines}`)) return;
        const before = Object.fromEntries(changedKeys(c.payload.after).map((k) => [k, c.payload.before[k]])) as ProductFields;
        void act(() => editProduct(ctx.business.id, c.payload.internal_id, c.payload.after, before, c.id), 'Enviado a la caja');
      };
    });
  };

  await draw();
  ctx.onChange((t) => { if (t === 'pos_commands') void draw(); });
  ctx.every(60_000, () => void draw());
}
