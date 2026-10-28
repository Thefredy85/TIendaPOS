import type { Ctx } from '../main';
import { listProducts, productMovements, type Movement, type Product } from '../api';
import { codeKey, downloadCsv, esc, fmtDateTime, fmtMoney, fmtQty, icon, openSheet, paintIcons, todayIso } from '../ui';
import { moveLabel, moveQty } from './movimientos';

type Filter = '' | 'bajo' | 'negativo' | 'agotado';

const isLow = (p: Product) => p.min_stock !== null && p.min_stock > 0 && (p.stock ?? 0) <= p.min_stock;

export async function renderInventario(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Existencias actuales (las envía la caja en cada cambio)';
  el.innerHTML = `<div class="filters">
      <label class="grow-field">Buscar<input type="search" id="f-q" placeholder="Código de barras o nombre" autocomplete="off"></label>
      <label>Categoría<select id="f-cat"><option value="">Todas</option></select></label>
      <label>Mostrar<select id="f-state">
        <option value="">Todos</option><option value="bajo">Bajo mínimo</option>
        <option value="agotado">Sin existencia</option><option value="negativo">En negativo</option></select></label>
      <button class="btn" id="csv">${icon('download')} CSV</button>
    </div>
    <div class="kpis" id="sum"></div>
    <div id="list"><div class="card empty">Cargando…</div></div>`;
  paintIcons();
  const q = el.querySelector<HTMLInputElement>('#f-q')!;
  const cat = el.querySelector<HTMLSelectElement>('#f-cat')!;
  const st = el.querySelector<HTMLSelectElement>('#f-state')!;
  let products: Product[] = [];
  let shown: Product[] = [];

  const filtered = (): Product[] => {
    const text = q.value.trim();
    const code = codeKey(text);
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const f = st.value as Filter;
    let list = products.filter((p) => (!cat.value || p.category === cat.value)
      && (f !== 'bajo' || isLow(p))
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
    el.querySelectorAll<HTMLElement>('[data-i]').forEach((li) => { li.onclick = () => openProduct(ctx, shown[Number(li.dataset.i)]); });
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

async function openProduct(ctx: Ctx, p: Product) {
  const body = openSheet(p.name ?? 'Producto', '<div class="empty">Cargando…</div>');
  const head = `<div class="card pad small" style="margin-bottom:12px">
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
  }
}
