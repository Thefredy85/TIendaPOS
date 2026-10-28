import type { Ctx } from '../main';
import { listMovements, type Movement } from '../api';
import { daysAgoIso, downloadCsv, esc, fmtDateTime, fmtQty, icon, openSheet, paintIcons, rangeOf, todayIso } from '../ui';

// Tipos que escribe la app (src-tauri/src/main.rs)
const TYPES: Record<string, string> = {
  entrada_compra: 'Entrada',
  salida_manual: 'Salida',
  merma: 'Merma',
  ajuste_conteo: 'Ajuste por conteo',
  venta: 'Venta',
  devolucion_venta: 'Devolución de venta',
  eliminacion_movimiento: 'Eliminación de movimiento',
};
export const moveLabel = (t: string | null) => esc(TYPES[t ?? ''] ?? t ?? '—');

// La cantidad viene con signo: + entra, − sale
export function moveQty(m: Movement): string {
  const q = m.quantity ?? 0;
  const color = q > 0 ? 'var(--green)' : q < 0 ? 'var(--danger)' : 'var(--muted)';
  return `<b style="color:${color}">${q > 0 ? '+' : q < 0 ? '−' : ''}${fmtQty(Math.abs(q))}</b>`;
}

export async function renderMovimientos(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Entradas, salidas, mermas y ajustes del inventario';
  el.innerHTML = `<div class="filters">
      <label>Desde<input type="date" id="f-from" value="${daysAgoIso(29)}" max="${todayIso()}"></label>
      <label>Hasta<input type="date" id="f-to" value="${todayIso()}" max="${todayIso()}"></label>
      <label>Tipo<select id="f-type"><option value="">Todos menos ventas</option>
        ${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
        <option value="*">Todos con ventas</option></select></label>
      <label>Usuario<select id="f-user"><option value="">Todos</option></select></label>
      <label class="grow-field">Producto<input type="search" id="f-q" placeholder="Nombre del producto" autocomplete="off"></label>
      <button class="btn" id="csv">${icon('download')} CSV</button>
    </div>
    <div class="kpis" id="sum"></div>
    <div id="list"><div class="card empty">Cargando…</div></div>`;
  paintIcons();
  const from = el.querySelector<HTMLInputElement>('#f-from')!;
  const to = el.querySelector<HTMLInputElement>('#f-to')!;
  const type = el.querySelector<HTMLSelectElement>('#f-type')!;
  const user = el.querySelector<HTMLSelectElement>('#f-user')!;
  const q = el.querySelector<HTMLInputElement>('#f-q')!;
  let moves: Movement[] = [];
  let shown: Movement[] = [];
  const LIMIT = 2000;

  const draw = () => {
    const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    shown = moves.filter((m) => (!user.value || m.user_name === user.value)
      && words.every((w) => (m.product_name ?? '').toLowerCase().includes(w)));
    const sum = (t: string[]) => shown.filter((m) => t.includes(m.type ?? '') && !m.voided_at).length;
    el.querySelector('#sum')!.innerHTML = `
      <div class="card kpi"><small>Movimientos</small><b>${shown.length}</b></div>
      <div class="card kpi"><small>Entradas</small><b>${sum(['entrada_compra'])}</b></div>
      <div class="card kpi"><small>Salidas y mermas</small><b>${sum(['salida_manual', 'merma'])}</b></div>
      <div class="card kpi"><small>Ajustes y eliminaciones</small><b>${sum(['ajuste_conteo', 'eliminacion_movimiento'])}</b></div>`;
    el.querySelector('#list')!.innerHTML = shown.length
      ? `<ul class="list card">${shown.slice(0, 400).map((m, i) => `<li class="click" data-i="${i}">
          <div class="grow"><div><b>${esc(m.product_name ?? m.internal_id ?? 'Producto')}</b>
            ${m.voided_at ? '<span class="pill off">anulado</span>' : ''}</div>
            <div class="small muted">${moveLabel(m.type)} · ${fmtDateTime(m.ts)} · ${esc(m.user_name ?? '—')}${m.authorized_by && m.authorized_by !== m.user_name ? `, autorizó ${esc(m.authorized_by)}` : ''}</div></div>
          <div class="right num">${moveQty(m)}<div class="small muted">${fmtQty(m.stock_before)} → ${fmtQty(m.stock_after)}</div></div></li>`).join('')}</ul>
        ${shown.length > 400 ? `<p class="small muted">Se muestran 400 de ${shown.length}. Acota las fechas o descarga el CSV.</p>` : ''}
        ${moves.length >= LIMIT ? `<p class="small muted">Se cargaron los ${LIMIT} más recientes del rango. Acota las fechas para ver los anteriores.</p>` : ''}`
      : '<div class="card empty">No hay movimientos con estos filtros.</div>';
    el.querySelectorAll<HTMLElement>('[data-i]').forEach((li) => { li.onclick = () => openMove(shown[Number(li.dataset.i)]); });
  };

  const load = async () => {
    if (!from.value || !to.value) return;
    const [a, b] = rangeOf(from.value <= to.value ? from.value : to.value, from.value <= to.value ? to.value : from.value);
    try {
      moves = await listMovements(ctx.business.id, a, b,
        { type: type.value && type.value !== '*' ? type.value : undefined, withSales: type.value === '*', limit: LIMIT });
    } catch (e) {
      el.querySelector('#list')!.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      return;
    }
    const keep = user.value;
    const names = [...new Set(moves.map((m) => m.user_name).filter(Boolean))].sort() as string[];
    user.innerHTML = `<option value="">Todos</option>${names.map((n) => `<option${n === keep ? ' selected' : ''}>${esc(n)}</option>`).join('')}`;
    draw();
  };

  from.onchange = load;
  to.onchange = load;
  type.onchange = load;
  user.onchange = draw;
  q.oninput = draw;
  el.querySelector<HTMLButtonElement>('#csv')!.onclick = () => downloadCsv(`movimientos-${from.value}-a-${to.value}.csv`,
    ['Fecha', 'Tipo', 'Producto', 'Identificador interno', 'Cantidad', 'Existencia antes', 'Existencia después', 'Costo total', 'Usuario', 'Autorizó', 'Motivo', 'Referencia', 'Notas', 'Anulado'],
    shown.map((m) => [m.ts ? new Date(m.ts).toLocaleString('es-MX') : '', TYPES[m.type ?? ''] ?? m.type, m.product_name, m.internal_id,
      m.quantity, m.stock_before, m.stock_after, m.total_cost, m.user_name, m.authorized_by, m.reason, m.reference, m.notes, m.voided_at ? 'sí' : '']));
  await load();
  ctx.onChange((t) => { if (t === 'pos_inventory_movements' && to.value === todayIso()) void load(); });
}

function openMove(m: Movement) {
  const row = (k: string, v: string) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0"><span class="muted">${k}</span><span class="right">${v}</span></div>`;
  openSheet(TYPES[m.type ?? ''] ?? 'Movimiento', `<div class="card pad">
    ${row('Producto', `<b>${esc(m.product_name ?? '—')}</b>`)}
    ${row('Fecha', fmtDateTime(m.ts))}
    ${row('Cantidad', `<span class="num">${moveQty(m)}</span>`)}
    ${row('Existencia', `<span class="num">${fmtQty(m.stock_before)} → ${fmtQty(m.stock_after)}</span>`)}
    ${m.total_cost !== null ? row('Costo total', `<span class="num">${m.total_cost.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}</span>`) : ''}
    ${row('Usuario', esc(m.user_name ?? '—'))}
    ${m.authorized_by ? row('Autorizó', esc(m.authorized_by)) : ''}
    ${m.reason ? row('Motivo', esc(m.reason)) : ''}
    ${m.reference ? row('Referencia', `<span class="small">${esc(m.reference)}</span>`) : ''}
    ${m.notes ? row('Notas', esc(m.notes)) : ''}
    ${m.voided_at ? row('Anulado', fmtDateTime(m.voided_at)) : ''}
  </div>`);
}
