import type { Ctx } from '../main';
import { createProduct, editProduct, listProducts, productMovements, recentChanges, setProductActive, stockMove, type Movement, type MoveType, type Product, type ProductFields, type RemoteChange } from '../api';
import { codeKey, downloadCsv, esc, fmtDateTime, fmtMoney, fmtQty, icon, openSheet, paintIcons, toast, todayIso } from '../ui';
import { moveLabel, moveQty } from './movimientos';
import { changedKeys, fieldValue, OLD_APP_NOTICE, storeCanApply } from './modificados';

type Filter = '' | 'bajo' | 'bajo-con' | 'negativo' | 'agotado' | 'sin-existencia' | 'sin-costo' | 'desactivados';

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
        <option value="sin-costo">Sin costo</option>
        <option value="desactivados">Desactivados</option></select></label>
      <button class="btn" id="csv">${icon('download')} CSV</button>
      ${ctx.canManageDevices ? `<button class="btn primary" id="new">${icon('package-plus')} Nuevo producto</button>` : ''}
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
      && (f !== 'negativo' || (p.stock ?? 0) < 0)
      && (f !== 'desactivados' || p.active === false));
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
              <div class="small muted">${esc(p.barcode ?? 'sin código')}${p.category ? ` · ${esc(p.category)}` : ''} · ${fmtMoney(p.price)}${p.active === false ? ' · <span class="pill off">desactivado</span>' : ''}</div></div>
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

  const newBtn = el.querySelector<HTMLButtonElement>('#new');
  if (newBtn) newBtn.onclick = () => void openNew(ctx, products);
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

const MOVE_LABEL: Record<MoveType, string> = { entrada_compra: 'Entrada por compra', salida_manual: 'Salida manual', merma: 'Merma' };
const storeName = (ctx: Ctx) => ctx.business.name || ctx.business.license_key;

// Pantalla de "¿Seguro?" dentro de la hoja (en tablet y celular es más clara que la ventana del navegador)
function reviewScreen(body: HTMLElement, opts: { intro: string; table: string; warns: string[]; onBack: () => void; onSend: () => Promise<void> }) {
  body.innerHTML = `<div class="small muted" style="margin-bottom:10px">${opts.intro}</div>
    ${opts.table}
    ${opts.warns.length ? `<div class="banner wait small" style="margin-top:12px">${icon('triangle-alert')}<div><b>¿Seguro?</b><br>${opts.warns.map(esc).join('<br>')}</div></div>` : ''}
    <div class="modal-actions" style="margin-top:14px"><button class="btn" id="r-back">Corregir</button><button class="btn primary" id="r-send">Sí, enviar</button></div>`;
  paintIcons();
  body.querySelector<HTMLButtonElement>('#r-back')!.onclick = opts.onBack;
  const send = body.querySelector<HTMLButtonElement>('#r-send')!;
  send.onclick = async () => {
    send.disabled = true;
    try { await opts.onSend(); } catch (e) { send.disabled = false; toast((e as Error).message); }
  };
}

// Entrada o salida de inventario: siempre suma o resta, nunca fija la existencia
function openMove(ctx: Ctx, p: Product, canApply: boolean) {
  const body = openSheet(`Entrada o salida: ${p.name ?? 'Producto'}`, '');
  const close = () => body.closest('.sheet-bg')?.remove();
  const stock = p.stock ?? 0;
  let draft: { type: MoveType; qty: string; reason: string } = { type: 'entrada_compra', qty: '', reason: '' };
  const form = () => {
    body.innerHTML = `<form class="edit-form" novalidate>
      <div class="small muted" style="margin-bottom:10px">Código ${esc(p.barcode ?? 'sin código')} · Existencia en la nube ${fmtQty(stock)}</div>
      ${canApply ? '' : `<div class="banner wait small">${esc(OLD_APP_NOTICE)}</div>`}
      <label>Tipo<select id="m-type">${(Object.keys(MOVE_LABEL) as MoveType[]).map((t) => `<option value="${t}"${t === draft.type ? ' selected' : ''}>${MOVE_LABEL[t]}</option>`).join('')}</select></label>
      <label>Cantidad<input id="m-qty" type="number" inputmode="decimal" step="any" min="0" value="${esc(draft.qty)}" placeholder="Piezas"></label>
      <label>Motivo<input id="m-reason" maxlength="200" value="${esc(draft.reason)}" placeholder="Ej. compra al proveedor, producto caducado"></label>
      <div class="small muted">La caja suma o resta esta cantidad a la existencia que tenga en ese momento. No se fija un número, así no se pierden las ventas hechas mientras tanto.</div>
      <div class="err" role="alert"></div>
      <div class="modal-actions" style="margin-top:14px"><button class="btn" type="button" id="m-cancel">Cancelar</button><button class="btn primary" type="submit">Revisar</button></div>
    </form>`;
    const f = body.querySelector('form')!;
    const val = (id: string) => f.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value.trim();
    f.querySelector<HTMLButtonElement>('#m-cancel')!.onclick = close;
    f.onsubmit = (e) => {
      e.preventDefault();
      draft = { type: val('m-type') as MoveType, qty: val('m-qty'), reason: val('m-reason') };
      const err = f.querySelector('.err')!;
      const qty = Number(draft.qty);
      if (!draft.qty || !Number.isFinite(qty) || qty <= 0) { err.textContent = 'La cantidad debe ser mayor que 0.'; return; }
      if (qty > 100000) { err.textContent = 'La cantidad es demasiado grande.'; return; }
      if (!draft.reason) { err.textContent = 'Escribe el motivo.'; return; }
      const delta = draft.type === 'entrada_compra' ? qty : -qty;
      const after = stock + delta;
      const warns: string[] = [];
      if (qty >= Math.max(50, Math.abs(stock) * 5)) warns.push(`${fmtQty(qty)} piezas es mucho para este producto (hoy tiene ${fmtQty(stock)}). Revisa si sobra un número.`);
      if (after < 0) warns.push(`La existencia quedaría en negativo (${fmtQty(after)}).`);
      reviewScreen(body, {
        intro: `¿Enviar este movimiento a la caja de ${esc(storeName(ctx))}?`,
        table: `<div class="card table-wrap"><table class="table"><tbody>
          <tr><td>Movimiento</td><td><b>${MOVE_LABEL[draft.type]}</b></td></tr>
          <tr><td>Cantidad</td><td><b class="num">${delta > 0 ? '+' : '−'}${fmtQty(qty)}</b></td></tr>
          <tr><td>Existencia</td><td class="num">${fmtQty(stock)} → <b>${fmtQty(after)}</b> <span class="small muted">(aprox.: la caja pudo vender mientras tanto)</span></td></tr>
          <tr><td>Motivo</td><td>${esc(draft.reason)}</td></tr></tbody></table></div>`,
        warns, onBack: form,
        onSend: async () => {
          await stockMove(ctx.business.id, p.internal_id, draft.type, qty, draft.reason);
          toast('Enviado a la caja. Míralo en Modificados.');
          close();
        },
      });
    };
  };
  form();
}

// Ocultar o volver a mostrar en la venta, sin borrar nada
function openActive(ctx: Ctx, p: Product, canApply: boolean) {
  const turnOn = p.active === false;
  const body = openSheet(`${turnOn ? 'Activar' : 'Desactivar'}: ${p.name ?? 'Producto'}`, '');
  const close = () => body.closest('.sheet-bg')?.remove();
  reviewScreen(body, {
    intro: `${canApply ? '' : `<div class="banner wait small" style="margin-bottom:10px">${esc(OLD_APP_NOTICE)}</div>`}¿Enviar este cambio a la caja de ${esc(storeName(ctx))}?`,
    table: `<div class="card pad small">${turnOn
      ? 'El producto <b>volverá a aparecer</b> en la venta de la caja.'
      : 'El producto <b>dejará de aparecer</b> en la venta de la caja. No se borra: conserva su existencia y su historial, y se puede volver a activar.'}</div>`,
    warns: !turnOn && (p.stock ?? 0) > 0 ? [`Todavía tiene ${fmtQty(p.stock)} en existencia.`] : [],
    onBack: close,
    onSend: async () => {
      await setProductActive(ctx.business.id, p.internal_id, turnOn);
      toast('Enviado a la caja. Míralo en Modificados.');
      close();
    },
  });
}

// Alta de producto: nace con existencia 0; la existencia se agrega con una entrada
async function openNew(ctx: Ctx, products: Product[]) {
  let canApply = true;
  try { canApply = await storeCanApply(ctx.business.id); } catch { /* se avisa si falla al enviar */ }
  const body = openSheet('Nuevo producto', '');
  const close = () => body.closest('.sheet-bg')?.remove();
  const cats = [...new Set(products.map((x) => x.category ?? '').filter(Boolean))].sort();
  let d = { barcode: '', name: '', category: cats[0] ?? '', cost: '', price: '', min: '0' };
  const form = () => {
    body.innerHTML = `<form class="edit-form" novalidate>
      ${canApply ? '' : `<div class="banner wait small">${esc(OLD_APP_NOTICE)}</div>`}
      <label>Código de barras<input id="n-code" required maxlength="60" inputmode="numeric" value="${esc(d.barcode)}" autocomplete="off"></label>
      <label>Nombre<input id="n-name" required maxlength="200" value="${esc(d.name)}"></label>
      <div class="edit-row">
        <label>Costo<input id="n-cost" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(d.cost)}"></label>
        <label>Precio<input id="n-price" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(d.price)}"></label>
      </div>
      <div class="edit-row">
        <label>Categoría<select id="n-cat">${cats.map((c) => `<option${c === d.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label>Mínimo<input id="n-min" type="number" inputmode="decimal" step="1" min="0" value="${esc(d.min)}"></label>
      </div>
      <div class="small muted">Nace con existencia 0. Para ponerle existencia, después haz una entrada desde su ficha. Si la categoría que buscas no aparece, créala primero en la caja.</div>
      <div class="err" role="alert"></div>
      <div class="modal-actions" style="margin-top:14px"><button class="btn" type="button" id="n-cancel">Cancelar</button><button class="btn primary" type="submit">Revisar</button></div>
    </form>`;
    const f = body.querySelector('form')!;
    const val = (id: string) => f.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value.trim();
    f.querySelector<HTMLButtonElement>('#n-cancel')!.onclick = close;
    f.onsubmit = (e) => {
      e.preventDefault();
      d = { barcode: val('n-code'), name: val('n-name'), category: val('n-cat'), cost: val('n-cost'), price: val('n-price'), min: val('n-min') };
      const err = f.querySelector('.err')!;
      if (!codeKey(d.barcode)) { err.textContent = 'El código de barras es obligatorio.'; return; }
      const dup = products.find((x) => codeKey(x.barcode) === codeKey(d.barcode));
      if (dup) { err.textContent = `Ese código ya es de "${dup.name ?? 'otro producto'}".`; return; }
      if (!d.name) { err.textContent = 'Escribe el nombre.'; return; }
      if (!d.category) { err.textContent = 'Elige una categoría.'; return; }
      const nums = { cost: Number(d.cost), price: Number(d.price), min: Number(d.min) };
      if ([d.cost, d.price, d.min].some((v) => v === '') || Object.values(nums).some((n) => !Number.isFinite(n) || n < 0)) {
        err.textContent = 'Costo, precio y mínimo deben ser números de 0 en adelante.'; return;
      }
      const warns: string[] = [];
      if (nums.price === 0) warns.push('El precio quedaría en $0.00.');
      else if (nums.cost > 0 && nums.price <= nums.cost) warns.push(`El precio (${fmtMoney(nums.price)}) es igual o menor que el costo (${fmtMoney(nums.cost)}).`);
      if (nums.cost === 0) warns.push('El costo quedaría en $0.00.');
      const similar = products.find((x) => (x.name ?? '').trim().toLowerCase() === d.name.toLowerCase());
      if (similar) warns.push(`Ya existe un producto llamado "${similar.name}" (código ${similar.barcode ?? 'sin código'}).`);
      reviewScreen(body, {
        intro: `¿Dar de alta este producto en la caja de ${esc(storeName(ctx))}?`,
        table: `<div class="card table-wrap"><table class="table"><tbody>
          <tr><td>Código</td><td><b>${esc(d.barcode)}</b></td></tr><tr><td>Nombre</td><td><b>${esc(d.name)}</b></td></tr>
          <tr><td>Categoría</td><td>${esc(d.category)}</td></tr><tr><td>Costo</td><td class="num">${fmtMoney(nums.cost)}</td></tr>
          <tr><td>Precio</td><td class="num">${fmtMoney(nums.price)}</td></tr><tr><td>Mínimo</td><td class="num">${fmtQty(nums.min)}</td></tr>
          <tr><td>Existencia</td><td class="num">0</td></tr></tbody></table></div>`,
        warns, onBack: form,
        onSend: async () => {
          await createProduct(ctx.business.id, { barcode: d.barcode, name: d.name, category: d.category, cost: nums.cost, price: nums.price, min_stock: nums.min });
          toast('Enviado a la caja. Aparecerá en Inventario cuando la caja lo dé de alta.');
          close();
        },
      });
    };
  };
  form();
}

async function openProduct(ctx: Ctx, p: Product, products: Product[]) {
  const body = openSheet(p.name ?? 'Producto', '<div class="empty">Cargando…</div>');
  let actions = '';
  let canApply = true;
  if (ctx.canManageDevices) {
    try {
      const [changes, ok] = await Promise.all([recentChanges(ctx.business.id), storeCanApply(ctx.business.id)]);
      canApply = ok;
      const waiting = (type: string) => changes.some((c: RemoteChange) => c.type === type && c.status === 'pendiente' && c.payload.internal_id === p.internal_id);
      const notes: string[] = [];
      const buttons: string[] = [];
      if (waiting('product_edit')) notes.push('Tiene un cambio de datos esperando a la caja.');
      else buttons.push(`<button class="btn primary" id="p-edit">${icon('pencil')} Editar</button>`);
      buttons.push(`<button class="btn" id="p-move">${icon('arrow-down-up')} Entrada o salida</button>`);
      if (waiting('stock_move')) notes.push('Tiene movimientos esperando a la caja.');
      if (waiting('product_active')) notes.push(`Tiene un cambio para ${p.active === false ? 'activarlo' : 'desactivarlo'} esperando a la caja.`);
      else buttons.push(`<button class="btn" id="p-active">${icon(p.active === false ? 'eye' : 'eye-off')} ${p.active === false ? 'Activar' : 'Desactivar'}</button>`);
      actions = `${notes.length ? `<div class="banner wait small">${notes.map(esc).join(' ')} Míralo en Modificados.</div>` : ''}
        <div class="chips" style="margin-bottom:12px">${buttons.join('')}</div>`;
    } catch { /* sin datos de cambios: solo no se ofrecen acciones */ }
  }
  const wire = () => {
    const go = (id: string, fn: () => void) => {
      const b = body.querySelector<HTMLButtonElement>(id);
      if (b) b.onclick = () => { body.closest('.sheet-bg')?.remove(); fn(); };
    };
    go('#p-edit', () => openEdit(ctx, p, products, canApply));
    go('#p-move', () => openMove(ctx, p, canApply));
    go('#p-active', () => openActive(ctx, p, canApply));
  };
  const head = `${actions}<div class="card pad small" style="margin-bottom:12px">
      ${p.active === false ? '<div style="margin-bottom:6px"><span class="pill off">Desactivado: no aparece en la venta</span></div>' : ''}
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
            <div class="small muted">${fmtDateTime(m.ts)} · ${esc(m.user_name ?? '—')}${m.reason ? ` · ${esc(m.reason)}` : ''}</div></div>
          <div class="right num">${moveQty(m)}<div class="small muted">queda ${fmtQty(m.stock_after)}</div></div></li>`).join('')}</ul>`
      : '<div class="card empty small">Sin movimientos registrados en la nube.</div>');
  } catch (e) {
    body.innerHTML = head + `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
  }
  paintIcons();
  wire();
}
