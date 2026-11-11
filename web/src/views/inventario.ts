import type { Ctx } from '../main';
import { editProduct, listProducts, productMovements, recentChanges, type Movement, type Product, type ProductFields } from '../api';
import { codeKey, downloadCsv, esc, fmtDateTime, fmtMoney, fmtQty, icon, openSheet, paintIcons, toast, todayIso } from '../ui';
import { moveLabel, moveQty } from './movimientos';
import { changedKeys, fieldValue, OLD_APP_NOTICE, storeCanApply } from './modificados';

type Filter = '' | 'bajo' | 'bajo-con' | 'negativo' | 'agotado' | 'sin-existencia' | 'sin-costo';

const isLow = (p: Product) => p.min_stock !== null && p.min_stock > 0 && (p.stock ?? 0) <= p.min_stock;

export async function renderInventario(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Existencias actuales (las envía la caja en cada cambio)';
  el.innerHTML = `<div class="filters">
      <label class="grow-field">Buscar<input type="search" id="f-q" placeholder="Código de barras o nombre" autocomplete="off"></label>
      <label>Categoría<select id="f-cat"><option value="">Todas</option></select></label>
      <label>Mostrar<select id="f-state">
        <option value="">Todos</option><option value="bajo">Bajo mínimo</option>
        <option value="bajo-con">Bajo mínimo con existencia</option>
        <option value="agotado">Sin existencia</option><option value="negativo">En negativo</option>
        <option value="sin-existencia">Sin existencia o en negativo</option>
        <option value="sin-costo">Sin costo</option></select></label>
      <button class="btn" id="csv">${icon('download')} CSV</button>
    </div>
    <div class="kpis" id="sum"></div>
    <div id="list"><div class="card empty">Cargando…</div></div>`;
  paintIcons();
  const q = el.querySelector<HTMLInputElement>('#f-q')!;
  const cat = el.querySelector<HTMLSelectElement>('#f-cat')!;
  const st = el.querySelector<HTMLSelectElement>('#f-state')!;
  // las Alertas llegan con el filtro en la dirección: #/inventario/bajo-con
  const preset = location.hash.split('/')[2];
  if (preset && [...st.options].some((o) => o.value === preset)) st.value = preset;
  let products: Product[] = [];
  let shown: Product[] = [];

  const filtered = (): Product[] => {
    const text = q.value.trim();
    const code = codeKey(text);
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const f = st.value as Filter;
    let list = products.filter((p) => (!cat.value || p.category === cat.value)
      && (f !== 'bajo' || isLow(p))
      && (f !== 'bajo-con' || (isLow(p) && (p.stock ?? 0) > 0))
      && (f !== 'sin-existencia' || (p.stock ?? 0) <= 0)
      && (f !== 'sin-costo' || !p.cost)
      && (f !== 'agotado' || (p.stock ?? 0) === 0)
      && (f !== 'negativo' || (p.stock ?? 0) < 0));
    if (!text) return list;
    // Primero por código de barras (exacto, con o sin ceros), luego por identificador interno y al final por nombre
    const byCode = code ? list.filter((p) => codeKey(p.barcode) === code) : [];
    if (byCode.length) return byCode;
    const byId = list.filter((p) => p.internal_id === text);
    if (byId.length) return byId;
    list = list.filter((p) => {
      const hay = `${p.name ?? ''} ${p.barcode ?? ''} ${p.category ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    return list;
  };

  const draw = () => {
    shown = filtered();
    const value = products.reduce((a, p) => a + Math.max(0, p.stock ?? 0) * (p.cost ?? 0), 0);
    const low = products.filter(isLow).length;
    const neg = products.filter((p) => (p.stock ?? 0) < 0).length;
    el.querySelector('#sum')!.innerHTML = `
      <div class="card kpi"><small>Productos</small><b>${products.length}</b></div>
      <div class="card kpi"><small>Valor a costo</small><b>${fmtMoney(value)}</b></div>
      <div class="card kpi"><small>Bajo mínimo</small><b${low ? ' style="color:var(--warn)"' : ''}>${low}</b></div>
      <div class="card kpi"><small>En negativo</small><b${neg ? ' style="color:var(--danger)"' : ''}>${neg}</b></div>`;
    const limit = 300;
    el.querySelector('#list')!.innerHTML = shown.length
      ? `<ul class="list card">${shown.slice(0, limit).map((p, i) => {
          const s = p.stock ?? 0;
          const cls = s < 0 ? 'bad' : s === 0 ? 'off' : isLow(p) ? 'wait' : 'ok';
          return `<li class="click" data-i="${i}">
            <div class="grow"><div><b>${esc(p.name ?? 'Sin nombre')}</b></div>
              <div class="small muted">${esc(p.barcode ?? 'sin código')}${p.category ? ` · ${esc(p.category)}` : ''} · ${fmtMoney(p.price)}</div></div>
            <div class="right"><span class="pill ${cls} num">${fmtQty(s)}${p.unit ? ` ${esc(p.unit)}` : ''}</span>
              ${p.min_stock ? `<div class="small muted">mín. ${fmtQty(p.min_stock)}</div>` : ''}</div></li>`;
        }).join('')}</ul>
        ${shown.length > limit ? `<p class="small muted">Se muestran ${limit} de ${shown.length}. Usa la búsqueda o descarga el CSV para ver todos.</p>` : ''}`
      : `<div class="card empty">${products.length ? 'Ningún producto coincide.' : 'Esta tienda aún no ha enviado productos.'}</div>`;
    el.querySelectorAll<HTMLElement>('[data-i]').forEach((li) => { li.onclick = () => openProduct(ctx, shown[Number(li.dataset.i)], products); });
  };

  const load = async () => {
    try {
      products = await listProducts(ctx.business.id);
    } catch (e) {
      el.querySelector('#list')!.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      return;
    }
    const keep = cat.value;
    const cats = [...new Set(products.map((p) => p.category).filter(Boolean))].sort() as string[];
    cat.innerHTML = `<option value="">Todas</option>${cats.map((c) => `<option${c === keep ? ' selected' : ''}>${esc(c)}</option>`).join('')}`;
    draw();
  };

  q.oninput = draw;
  cat.onchange = draw;
  st.onchange = draw;
  el.querySelector<HTMLButtonElement>('#csv')!.onclick = () => downloadCsv(`inventario-${todayIso()}.csv`,
    ['Código de barras', 'Nombre', 'Categoría', 'Presentación', 'Proveedor', 'Unidad', 'Costo', 'Precio', 'Existencia', 'Mínimo', 'Identificador interno'],
    shown.map((p) => [p.barcode, p.name, p.category, p.presentation, p.supplier, p.unit, p.cost, p.price, p.stock, p.min_stock, p.internal_id]));
  await load();
  // la existencia cambia con cada movimiento (venta, entrada, salida…)
  let timer = 0;
  ctx.onChange((t) => {
    if (t !== 'pos_inventory_movements') return;
    clearTimeout(timer);
    timer = window.setTimeout(() => void load(), 1500);
  });
}

const FIELD_NAMES: Record<keyof ProductFields, string> = { cost: 'Costo', price: 'Precio', name: 'Nombre', category: 'Categoría', min_stock: 'Mínimo' };

// Avisos contra errores de dedo: no impiden guardar, solo piden revisar
function editWarnings(before: Required<ProductFields>, after: ProductFields): string[] {
  const out: string[] = [];
  for (const k of ['cost', 'price'] as const) {
    const was = before[k]; const now = after[k];
    if (now === undefined || was <= 0) continue;
    if (now >= was * 1.5 || now <= was * 0.5) out.push(`${FIELD_NAMES[k]}: cambia de ${fmtMoney(was)} a ${fmtMoney(now)}. Revisa si sobra o falta un número.`);
  }
  const cost = after.cost ?? before.cost; const price = after.price ?? before.price;
  if (price > 0 && cost > 0 && price <= cost) out.push(`El precio (${fmtMoney(price)}) quedaría igual o menor que el costo (${fmtMoney(cost)}).`);
  if ((after.price !== undefined) && after.price === 0) out.push('El precio quedaría en $0.00.');
  return out;
}

function openEdit(ctx: Ctx, p: Product, products: Product[], canApply: boolean) {
  const before: Required<ProductFields> = { cost: p.cost ?? 0, price: p.price ?? 0, name: p.name ?? '', category: p.category ?? '', min_stock: p.min_stock ?? 0 };
  // incluye la categoría actual aunque esté vacía: abrir y guardar no debe cambiarla sin querer
  const cats = [...new Set([before.category, ...products.map((x) => x.category ?? '').filter(Boolean)])].sort();
  const body = openSheet(`Editar: ${p.name ?? 'Producto'}`, '');
  const close = () => body.closest('.sheet-bg')?.remove();
  let draft: ProductFields = {};

  const form = () => {
    const val = <K extends keyof ProductFields>(k: K) => (draft[k] ?? before[k]) as string | number;
    body.innerHTML = `<form class="edit-form" novalidate>
      <div class="small muted" style="margin-bottom:10px">Código ${esc(p.barcode ?? 'sin código')} · Existencia ${fmtQty(p.stock)} (no se edita aquí)</div>
      ${canApply ? '' : `<div class="banner wait small">${esc(OLD_APP_NOTICE)}</div>`}
      <label>Nombre<input id="e-name" required maxlength="200" value="${esc(val('name'))}"></label>
      <div class="edit-row">
        <label>Costo<input id="e-cost" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(val('cost'))}"></label>
        <label>Precio<input id="e-price" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(val('price'))}"></label>
      </div>
      <div class="edit-row">
        <label>Categoría<select id="e-cat">${cats.map((c) => `<option${c === val('category') ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label>Mínimo<input id="e-min" type="number" inputmode="decimal" step="1" min="0" value="${esc(val('min_stock'))}"></label>
      </div>
      <div class="err" role="alert"></div>
      <div class="modal-actions" style="margin-top:14px"><button class="btn" type="button" id="e-cancel">Cancelar</button><button class="btn primary" type="submit">Revisar cambio</button></div>
    </form>`;
    const f = body.querySelector('form')!;
    const get = (id: string) => f.querySelector<HTMLInputElement>(`#${id}`)!.value.trim();
    f.querySelector<HTMLButtonElement>('#e-cancel')!.onclick = close;
    f.onsubmit = (e) => {
      e.preventDefault();
      const err = f.querySelector('.err')!;
      const nums = { cost: Number(get('e-cost')), price: Number(get('e-price')), min_stock: Number(get('e-min')) };
      if (!get('e-name')) { err.textContent = 'El nombre no puede quedar vacío.'; return; }
      if ([get('e-cost'), get('e-price'), get('e-min')].some((v) => v === '') || Object.values(nums).some((n) => !Number.isFinite(n) || n < 0)) {
        err.textContent = 'Costo, precio y mínimo deben ser números de 0 en adelante.'; return;
      }
      const wanted: Required<ProductFields> = { ...nums, name: get('e-name'), category: get('e-cat') };
      draft = Object.fromEntries((Object.keys(wanted) as (keyof ProductFields)[]).filter((k) => wanted[k] !== before[k]).map((k) => [k, wanted[k]])) as ProductFields;
      if (!Object.keys(draft).length) { err.textContent = 'No cambiaste nada.'; return; }
      review();
    };
  };

  const review = () => {
    const keys = changedKeys(draft);
    const warns = editWarnings(before, draft);
    body.innerHTML = `<div class="small muted" style="margin-bottom:10px">¿Enviar este cambio a la caja de ${esc(ctx.business.name || ctx.business.license_key)}?</div>
      <div class="card table-wrap"><table class="table"><thead><tr><th></th><th>Antes</th><th>Después</th></tr></thead>
        <tbody>${keys.map((k) => `<tr><td>${FIELD_NAMES[k]}</td><td>${esc(fieldValue(k, before[k]))}</td><td><b>${esc(fieldValue(k, draft[k]))}</b></td></tr>`).join('')}</tbody></table></div>
      ${warns.length ? `<div class="banner wait small" style="margin-top:12px">${icon('triangle-alert')}<div><b>¿Seguro?</b><br>${warns.map(esc).join('<br>')}</div></div>` : ''}
      <div class="modal-actions" style="margin-top:14px"><button class="btn" id="e-back">Corregir</button><button class="btn primary" id="e-send">Sí, enviar</button></div>`;
    paintIcons();
    body.querySelector<HTMLButtonElement>('#e-back')!.onclick = form;
    const send = body.querySelector<HTMLButtonElement>('#e-send')!;
    send.onclick = async () => {
      send.disabled = true;
      const sentBefore = Object.fromEntries(keys.map((k) => [k, before[k]])) as ProductFields;
      try {
        await editProduct(ctx.business.id, p.internal_id, sentBefore, draft);
        toast('Enviado a la caja. Míralo en Modificados.');
        close();
      } catch (e) {
        send.disabled = false;
        toast((e as Error).message);
      }
    };
  };
  form();
}

async function openProduct(ctx: Ctx, p: Product, products: Product[]) {
  const body = openSheet(p.name ?? 'Producto', '<div class="empty">Cargando…</div>');
  let editBar = '';
  let canApply = true;
  if (ctx.canManageDevices) {
    try {
      const [changes, ok] = await Promise.all([recentChanges(ctx.business.id), storeCanApply(ctx.business.id)]);
      canApply = ok;
      const waiting = changes.some((c) => c.type === 'product_edit' && c.status === 'pendiente' && c.payload.internal_id === p.internal_id);
      editBar = waiting
        ? '<div class="banner wait small">Este producto tiene un cambio esperando a la caja. Míralo en Modificados.</div>'
        : `<button class="btn primary" id="p-edit" style="margin-bottom:12px">${icon('pencil')} Editar</button>`;
    } catch { /* sin datos de cambios: solo no se ofrece editar */ }
  }
  const wireEdit = () => {
    const b = body.querySelector<HTMLButtonElement>('#p-edit');
    if (b) b.onclick = () => { body.closest('.sheet-bg')?.remove(); openEdit(ctx, p, products, canApply); };
  };
  const head = `${editBar}<div class="card pad small" style="margin-bottom:12px">
      <div>Código: <b>${esc(p.barcode ?? '—')}</b></div>
      <div class="muted">${[p.category, p.presentation, p.supplier].filter(Boolean).map(esc).join(' · ') || '—'}</div>
      <div style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap">
        <span>Existencia <b class="num">${fmtQty(p.stock)}</b></span>
        <span>Mínimo <b class="num">${fmtQty(p.min_stock)}</b></span>
        <span>Costo <b class="num">${fmtMoney(p.cost)}</b></span>
        <span>Precio <b class="num">${fmtMoney(p.price)}</b></span>
      </div></div>
    <div class="section-title" style="margin-top:0">Últimos movimientos</div>`;
  try {
    const moves: Movement[] = await productMovements(ctx.business.id, p.internal_id);
    body.innerHTML = head + (moves.length
      ? `<ul class="list card">${moves.map((m) => `<li>
          <div class="grow"><div>${moveLabel(m.type)}${m.voided_at ? ' <span class="pill off">anulado</span>' : ''}</div>
            <div class="small muted">${fmtDateTime(m.ts)} · ${esc(m.user_name ?? '—')}</div></div>
          <div class="right num">${moveQty(m)}<div class="small muted">queda ${fmtQty(m.stock_after)}</div></div></li>`).join('')}</ul>`
      : '<div class="card empty small">Sin movimientos registrados en la nube.</div>');
    paintIcons();
  } catch (e) {
    body.innerHTML = head + `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
    paintIcons();
  }
  wireEdit();
}
