import type { Ctx } from '../main';
import { cancelChange, editProduct, listDevices, listProducts, recentChanges, type ProductFields, type RemoteChange } from '../api';
import { ago, esc, fmtDateTime, fmtMoney, fmtQty, icon, paintIcons, toast } from '../ui';

// Primera versión de la app que aplica las órdenes del panel
export const MIN_EDIT_VERSION = '0.2.15';

const isOlder = (v: string, min: string) => {
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
      changes = c.filter((x) => x.type === 'product_edit');
      names = new Map(products.map((p) => [p.internal_id, p.name ?? 'Sin nombre']));
      canApply = ok;
    } catch (e) {
      el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      return;
    }
    const undone = new Set(changes.filter((c) => c.status !== 'cancelado' && c.status !== 'rechazado').map((c) => c.payload.undo_of).filter(Boolean));
    const busy = new Set(changes.filter((c) => c.status === 'pendiente').map((c) => c.payload.internal_id));
    const canUndo = (c: RemoteChange) => ctx.canManageDevices && c.status === 'aplicado' && !undone.has(c.id) && !busy.has(c.payload.internal_id);

    el.innerHTML = `${!canApply && ctx.canManageDevices ? `<div class="banner wait">${icon('shield-alert')}<span class="small">${esc(OLD_APP_NOTICE)}</span></div>` : ''}
      ${changes.length ? `<ul class="list card">${changes.map((c) => {
        const [cls, label] = PILL[c.status];
        const what = changedKeys(c.payload.after).map((k) => `${FIELD_LABEL[k]} ${fieldValue(k, c.payload.before[k])} → ${fieldValue(k, c.payload.after[k])}`).join(' · ');
        return `<li class="assign">
          <div class="grow"><div><b>${esc(names.get(c.payload.internal_id) ?? 'Producto ya no disponible')}</b>${c.payload.undo_of ? ' <span class="small muted">(deshacer)</span>' : ''}</div>
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
      b.onclick = () => {
        if (confirm('¿Retirar este cambio? La caja ya no lo aplicará.')) void act(() => cancelChange(b.dataset.cancel!), 'Cambio cancelado');
      };
    });
    el.querySelectorAll<HTMLButtonElement>('[data-undo]').forEach((b) => {
      b.onclick = () => {
        const c = changes.find((x) => x.id === b.dataset.undo)!;
        const lines = changedKeys(c.payload.after).map((k) => `${FIELD_LABEL[k]}: ${fieldValue(k, c.payload.after[k])} → ${fieldValue(k, c.payload.before[k])}`).join('\n');
        if (!confirm(`¿Deshacer este cambio de "${names.get(c.payload.internal_id) ?? 'producto'}"?\n\n${lines}`)) return;
        const before = Object.fromEntries(changedKeys(c.payload.after).map((k) => [k, c.payload.before[k]])) as ProductFields;
        void act(() => editProduct(ctx.business.id, c.payload.internal_id, c.payload.after, before, c.id), 'Enviado a la caja');
      };
    });
  };

  await draw();
  ctx.onChange((t) => { if (t === 'pos_commands') void draw(); });
  ctx.every(60_000, () => void draw());
}
