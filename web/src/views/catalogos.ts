import type { Ctx } from '../main';
import { listCatalogs, listDevices, listProducts, recentChanges, saveCatalog, type Catalog, type CatalogKind, type Product, type RemoteChange } from '../api';
import { esc, icon, openSheet, paintIcons, toast } from '../ui';
import { isOlder } from './modificados';

// Catálogos de la caja (v0.2.16). El panel no escribe en la caja: deja una orden y la
// caja la valida. Cambiar un nombre cambia ese campo en los productos que lo usan
// (nunca precio, código ni existencia). No se borra nada desde aquí.

export const CATALOG_VERSION = '0.2.16';

export const KINDS: { kind: CatalogKind; title: string; one: string; nuevo: string; field: keyof Product; extras: { key: keyof Catalog['data']; label: string; max: number }[] }[] = [
  { kind: 'category', title: 'Categorías', one: 'categoría', nuevo: 'Nueva categoría', field: 'category', extras: [{ key: 'description', label: 'Descripción', max: 300 }] },
  { kind: 'presentation', title: 'Presentaciones', one: 'presentación', nuevo: 'Nueva presentación', field: 'presentation', extras: [{ key: 'description', label: 'Descripción', max: 300 }] },
  { kind: 'unit', title: 'Unidades', one: 'unidad', nuevo: 'Nueva unidad', field: 'unit', extras: [{ key: 'abbreviation', label: 'Abreviatura', max: 20 }] },
  { kind: 'supplier', title: 'Proveedores', one: 'proveedor', nuevo: 'Nuevo proveedor', field: 'supplier', extras: [{ key: 'phone', label: 'Teléfono', max: 40 }, { key: 'notes', label: 'Notas', max: 300 }] },
];
const kindOf = (k: CatalogKind) => KINDS.find((x) => x.kind === k)!;
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim();
const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

// Productos que usan ese nombre en su campo (igual que compara la caja)
export const usedBy = (products: Product[], kind: CatalogKind, name: string) =>
  products.filter((p) => same(p[kindOf(kind).field] as string | null, name));

// Nombres de categorías para los formularios: los del catálogo de la caja (activos) o,
// si la caja aún no los envía, los que tienen los productos.
export async function categoryNames(businessId: string, products: Product[]): Promise<{ names: string[]; fromCatalog: boolean }> {
  try {
    const cats = (await listCatalogs(businessId)).filter((c) => c.kind === 'category' && c.active);
    if (cats.length) return { names: cats.map((c) => c.name), fromCatalog: true };
  } catch { /* sin la tabla: se usan los de los productos */ }
  return { names: [...new Set(products.map((x) => x.category ?? '').filter(Boolean))].sort(), fromCatalog: false };
}

export async function renderCatalogos(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Categorías, presentaciones, unidades y proveedores de la caja';
  el.innerHTML = '<div class="card empty">Cargando…</div>';
  let tab: CatalogKind = 'category';
  let rows: Catalog[] = [], products: Product[] = [], pending: RemoteChange[] = [], canApply = true;

  const load = async () => {
    try {
      const [c, p, ch, devs] = await Promise.all([listCatalogs(ctx.business.id), listProducts(ctx.business.id), recentChanges(ctx.business.id), listDevices(ctx.business.id)]);
      rows = c; products = p;
      pending = ch.filter((x) => x.type === 'catalog_save' && x.status === 'pendiente');
      canApply = devs.some((d) => d.status === 'aprobado' && d.app_version && !isOlder(d.app_version, CATALOG_VERSION));
    } catch (e) {
      el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      return;
    }
    draw();
  };

  const draw = () => {
    if (!rows.length) {
      el.innerHTML = `<div class="banner info">${icon('info')}<span class="small">La caja de esta tienda todavía no envía sus catálogos. Aparecerán aquí cuando tenga la versión ${CATALOG_VERSION} o una más nueva.</span></div>`;
      paintIcons();
      return;
    }
    const k = kindOf(tab);
    const list = rows.filter((r) => r.kind === tab);
    const waitFor = (r: Catalog) => pending.find((x) => x.payload.kind === r.kind && x.payload.id === r.id);
    const newWaiting = pending.filter((x) => x.payload.kind === tab && !x.payload.id);
    el.innerHTML = `${!canApply && ctx.canManageDevices ? `<div class="banner wait">${icon('shield-alert')}<span class="small">La caja todavía no tiene la versión ${CATALOG_VERSION}: los cambios se quedarán esperando hasta que se actualice.</span></div>` : ''}
      <div class="tabs" role="tablist">
        ${KINDS.map((x) => `<button class="tab${x.kind === tab ? ' on' : ''}" data-tab="${x.kind}">${x.title} <span class="small muted">${rows.filter((r) => r.kind === x.kind).length}</span></button>`).join('')}
        ${ctx.canManageDevices ? `<button class="btn primary" id="new" style="margin-left:auto">${icon('plus')} ${k.nuevo}</button>` : ''}
      </div>
      ${newWaiting.map((x) => `<div class="banner wait small">${icon('history')}<span>Alta esperando a la caja: <b>${esc(x.payload.name)}</b></span></div>`).join('')}
      ${list.length ? `<ul class="list card">${list.map((r) => {
        const n = usedBy(products, r.kind, r.name).length;
        const extra = k.extras.map((e) => r.data[e.key] ? `${e.label}: ${esc(r.data[e.key])}` : '').filter(Boolean).join(' · ');
        const w = waitFor(r);
        return `<li class="assign"><div class="grow"><div><b>${esc(r.name)}</b>${r.active ? '' : ' <span class="pill off">desactivado</span>'}</div>
          <div class="small muted">${n} producto${n === 1 ? '' : 's'}${extra ? ` · ${extra}` : ''}</div>
          ${w ? `<div class="small" style="color:var(--warn)">Cambio esperando a la caja: ${esc(w.payload.name)}${w.payload.active === false ? ' (desactivar)' : w.payload.active === true ? ' (activar)' : ''}</div>` : ''}</div>
          ${ctx.canManageDevices && !w ? `<button class="btn" data-edit="${esc(r.id)}">${icon('pencil')} Editar</button>
            <button class="btn" data-active="${esc(r.id)}">${icon(r.active ? 'eye-off' : 'eye')} ${r.active ? 'Desactivar' : 'Activar'}</button>` : ''}</li>`;
      }).join('')}</ul>` : '<div class="card empty">No hay registros en este catálogo.</div>'}
      <p class="small muted" style="margin-top:10px">Los cambios se envían a la caja, que los revisa y los aplica. Desde el panel no se borra nada; para borrar, hazlo en la caja.</p>`;
    paintIcons();
    el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab as CatalogKind; draw(); });
    el.querySelector<HTMLButtonElement>('#new')?.addEventListener('click', () => openForm(ctx, tab, null, rows, products, load));
    el.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) => b.onclick = () =>
      openForm(ctx, tab, list.find((r) => r.id === b.dataset.edit) ?? null, rows, products, load));
    el.querySelectorAll<HTMLButtonElement>('[data-active]').forEach((b) => b.onclick = () => {
      const r = list.find((x) => x.id === b.dataset.active);
      if (r) openActive(ctx, r, products, load);
    });
  };

  ctx.onChange((t) => { if (t === 'pos_catalogs' || t === 'pos_commands') load(); });
  await load();
}

function review(body: HTMLElement, intro: string, table: string, warns: string[], onBack: () => void, onSend: () => Promise<void>) {
  body.innerHTML = `<div class="small muted" style="margin-bottom:10px">${intro}</div>${table}
    ${warns.length ? `<div class="banner wait small" style="margin-top:12px">${icon('triangle-alert')}<div><b>¿Seguro?</b><br>${warns.map(esc).join('<br>')}</div></div>` : ''}
    <div class="modal-actions" style="margin-top:14px"><button class="btn" id="r-back">Corregir</button><button class="btn primary" id="r-send">Sí, enviar</button></div>`;
  paintIcons();
  body.querySelector<HTMLButtonElement>('#r-back')!.onclick = onBack;
  const send = body.querySelector<HTMLButtonElement>('#r-send')!;
  send.onclick = async () => {
    send.disabled = true;
    try { await onSend(); } catch (e) { send.disabled = false; toast((e as Error).message); }
  };
}

const productList = (ps: Product[]) => `<div class="card table-wrap" style="margin-top:10px;max-height:260px;overflow:auto"><table class="table">
  <thead><tr><th>Producto</th><th>Código</th></tr></thead><tbody>
  ${ps.slice(0, 200).map((p) => `<tr><td>${esc(p.name ?? 'Sin nombre')}${p.active === false ? ' <span class="pill off">desactivado</span>' : ''}</td><td>${esc(p.barcode ?? '—')}</td></tr>`).join('')}
  ${ps.length > 200 ? `<tr><td colspan="2" class="small muted">… y ${ps.length - 200} más</td></tr>` : ''}</tbody></table></div>`;

function openForm(ctx: Ctx, kind: CatalogKind, item: Catalog | null, rows: Catalog[], products: Product[], done: () => void) {
  const k = kindOf(kind);
  const body = openSheet(item ? `Editar ${k.one}: ${item.name}` : k.nuevo, '');
  const close = () => body.closest('.sheet-bg')?.remove();
  const d: Record<string, string> = { name: item?.name ?? '' };
  for (const e of k.extras) d[e.key] = item?.data[e.key] ?? '';
  const form = () => {
    body.innerHTML = `<form class="edit-form" novalidate>
      <label>Nombre<input id="c-name" required maxlength="100" value="${esc(d.name)}" autocomplete="off"></label>
      ${k.extras.map((e) => `<label>${e.label}<input id="c-${e.key}" maxlength="${e.max}" value="${esc(d[e.key])}" autocomplete="off"></label>`).join('')}
      ${item ? `<div class="small muted">Si cambias el nombre, también cambia en los ${usedBy(products, kind, item.name).length} productos que lo usan. Solo cambia ese dato: precio, código y existencia quedan igual.</div>` : ''}
      <div class="err" role="alert"></div>
      <div class="modal-actions" style="margin-top:14px"><button class="btn" type="button" id="c-cancel">Cancelar</button><button class="btn primary" type="submit">Revisar</button></div>
    </form>`;
    const f = body.querySelector('form')!;
    f.querySelector<HTMLButtonElement>('#c-cancel')!.onclick = close;
    f.onsubmit = (ev) => {
      ev.preventDefault();
      for (const key of ['name', ...k.extras.map((e) => e.key)]) d[key] = f.querySelector<HTMLInputElement>(`#c-${key}`)!.value.trim();
      const err = f.querySelector('.err')!;
      if (!d.name) { err.textContent = 'Escribe el nombre.'; return; }
      const dup = rows.find((r) => r.kind === kind && r.id !== item?.id && lower(r.name) === lower(d.name));
      if (dup) { err.textContent = `Ya existe "${dup.name}" en este catálogo.`; return; }
      const changes: [string, string, string][] = [];
      if (!item || !same(item.name, d.name)) changes.push(['Nombre', item?.name ?? '', d.name]);
      for (const e of k.extras) if (!item || (item.data[e.key] ?? '') !== d[e.key]) if (item || d[e.key]) changes.push([e.label, item?.data[e.key] ?? '', d[e.key]]);
      if (item && !changes.length) { err.textContent = 'No cambiaste nada.'; return; }
      const renamed = item && !same(item.name, d.name);
      const affected = renamed ? usedBy(products, kind, item!.name) : [];
      const warns: string[] = [];
      if (affected.length) warns.push(`${affected.length} producto${affected.length === 1 ? '' : 's'} cambiará${affected.length === 1 ? '' : 'n'} su ${k.one} de "${item!.name}" a "${d.name}". Precio, código y existencia quedan igual.`);
      const table = `<div class="card table-wrap"><table class="table"><thead><tr><th>Dato</th>${item ? '<th>Antes</th>' : ''}<th>${item ? 'Después' : 'Valor'}</th></tr></thead><tbody>
        ${changes.map(([l, a, b]) => `<tr><td>${l}</td>${item ? `<td>${esc(a || '—')}</td>` : ''}<td><b>${esc(b || '—')}</b></td></tr>`).join('')}</tbody></table></div>
        ${affected.length ? `<div class="small" style="margin-top:10px"><b>Productos que cambian de ${esc(k.one)}</b></div>${productList(affected)}` : ''}`;
      review(body, `¿Enviar este cambio a la caja de ${esc(ctx.business.name || ctx.business.license_key)}?`, table, warns, form, async () => {
        const data: Catalog['data'] = {};
        for (const e of k.extras) data[e.key] = d[e.key];
        await saveCatalog(ctx.business.id, kind, item?.id ?? null, item?.name ?? null, d.name, null, data);
        toast('Enviado a la caja. Míralo en Modificados.');
        close();
        done();
      });
    };
  };
  form();
}

function openActive(ctx: Ctx, item: Catalog, products: Product[], done: () => void) {
  const k = kindOf(item.kind);
  const turnOn = !item.active;
  const body = openSheet(`${turnOn ? 'Activar' : 'Desactivar'} ${k.one}: ${item.name}`, '');
  const close = () => body.closest('.sheet-bg')?.remove();
  const used = usedBy(products, item.kind, item.name);
  const text = turnOn
    ? `<b>${esc(item.name)}</b> volverá a aparecer en las listas de la caja.`
    : `<b>${esc(item.name)}</b> dejará de aparecer en las listas de la caja. No se borra y se puede volver a activar. <b>Los productos que la usan dejarán de aparecer en la venta</b> mientras esté desactivada.`;
  review(body, `¿Enviar este cambio a la caja de ${esc(ctx.business.name || ctx.business.license_key)}?`,
    `<div class="card pad small">${text}</div>${!turnOn && used.length ? productList(used) : ''}`,
    !turnOn && used.length ? [`${used.length} producto${used.length === 1 ? '' : 's'} dejará${used.length === 1 ? '' : 'n'} de aparecer en la venta.`] : [],
    close, async () => {
      await saveCatalog(ctx.business.id, item.kind, item.id, item.name, item.name, turnOn, {});
      toast('Enviado a la caja. Míralo en Modificados.');
      close();
      done();
    });
}
