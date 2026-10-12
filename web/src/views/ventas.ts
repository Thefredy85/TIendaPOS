import type { Ctx } from '../main';
import { getSaleItems, listSales, type Sale } from '../api';
import { dayRange, esc, fmtDateTime, fmtMoney, fmtQty, fmtTime, icon, openSheet, paintIcons, todayIso } from '../ui';

export function saleRow(s: Sale): string {
  const items = s.cancelled ? `<span class="pill bad">Cancelada</span>` : '';
  return `<li class="click" data-sale="${esc(s.id)}">
    <div class="grow">
      <div class="${s.cancelled ? 'cancelled' : ''}"><b class="num">${fmtTime(s.ts)}</b> · ${esc(s.cashier ?? '—')} ${items}</div>
      <div class="small muted">${esc(s.payment_method ?? '')} · ${esc(s.id)}</div>
    </div>
    <div class="num right ${s.cancelled ? 'cancelled' : ''}"><b>${fmtMoney(s.total)}</b></div>
  </li>`;
}

export async function openSale(ctx: Ctx, s: Sale) {
  const body = openSheet(`Venta ${fmtTime(s.ts)}`, '<div class="empty">Cargando…</div>');
  try {
    const items = await getSaleItems(ctx.business.id, s.id);
    const pays = Object.entries(s.payment_breakdown);
    body.innerHTML = `
      ${s.cancelled ? `<div class="banner bad">${icon('ban')}<div><b>Venta cancelada</b><br><span class="small">
        ${fmtDateTime(s.cancelled_at)} por ${esc(s.cancelled_by ?? '—')}${s.cancelled_authorized_by && s.cancelled_authorized_by !== s.cancelled_by ? `, autorizó ${esc(s.cancelled_authorized_by)}` : ''}</span></div></div>` : ''}
      <div class="small muted" style="margin-bottom:10px">${fmtDateTime(s.ts)} · Cajero: ${esc(s.cashier ?? '—')}<br>Folio ${esc(s.id)}</div>
      <ul class="list card">${items.length ? items.map((i) => `<li>
          <div class="grow"><div>${esc(i.name ?? i.internal_id ?? 'Producto')}</div>
            <div class="small muted">${fmtQty(i.qty)} × ${fmtMoney(i.price)}${i.barcode ? ` · ${esc(i.barcode)}` : ''}</div></div>
          <div class="num">${fmtMoney((i.qty ?? 0) * (i.price ?? 0))}</div></li>`).join('')
        : '<li class="muted small">Sin detalle de productos</li>'}</ul>
      <div class="card pad" style="margin-top:12px">
        <div style="display:flex;justify-content:space-between"><span>Total</span><b class="num">${fmtMoney(s.total)}</b></div>
        ${pays.map(([k, v]) => `<div class="small muted" style="display:flex;justify-content:space-between"><span>${esc(k)}</span><span class="num">${fmtMoney(v)}</span></div>`).join('')}
        ${s.profit !== null ? `<div class="small muted" style="display:flex;justify-content:space-between;margin-top:6px"><span>Ganancia</span><span class="num">${fmtMoney(s.profit)}</span></div>` : ''}
      </div>`;
    paintIcons();
  } catch (e) {
    body.innerHTML = `<div class="empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
  }
}

export async function renderVentas(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Ventas por día';
  el.innerHTML = `<div class="filters">
      <label>Día<input type="date" id="f-day" value="${todayIso()}" max="${todayIso()}"></label>
      <label>Cajero<select id="f-cashier"><option value="">Todos</option></select></label>
    </div>
    <div class="kpis" id="sum"></div>
    <div id="list"><div class="card empty">Cargando…</div></div>`;
  const day = el.querySelector<HTMLInputElement>('#f-day')!;
  const cashierSel = el.querySelector<HTMLSelectElement>('#f-cashier')!;
  let sales: Sale[] = [];

  const draw = () => {
    const shown = cashierSel.value ? sales.filter((s) => s.cashier === cashierSel.value) : sales;
    const valid = shown.filter((s) => !s.cancelled);
    const total = valid.reduce((a, s) => a + (s.total ?? 0), 0);
    el.querySelector('#sum')!.innerHTML = `
      <div class="card kpi"><small>Total</small><b>${fmtMoney(total)}</b></div>
      <div class="card kpi"><small>Tickets</small><b>${valid.length}</b></div>
      <div class="card kpi"><small>Canceladas</small><b>${shown.length - valid.length}</b></div>`;
    el.querySelector('#list')!.innerHTML = shown.length
      ? `<ul class="list card">${shown.map(saleRow).join('')}</ul>`
      : '<div class="card empty">No hay ventas en este día.</div>';
    el.querySelectorAll<HTMLElement>('[data-sale]').forEach((li) => {
      li.onclick = () => openSale(ctx, sales.find((s) => s.id === li.dataset.sale)!);
    });
    paintIcons();
  };

  const load = async () => {
    if (!day.value) return;
    const [from, to] = dayRange(day.value);
    try {
      sales = await listSales(ctx.business.id, from, to);
    } catch (e) {
      el.querySelector('#list')!.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      return;
    }
    const keep = cashierSel.value;
    const names = [...new Set(sales.map((s) => s.cashier).filter(Boolean))].sort() as string[];
    cashierSel.innerHTML = `<option value="">Todos</option>${names.map((n) => `<option${n === keep ? ' selected' : ''}>${esc(n)}</option>`).join('')}`;
    draw();
  };

  day.onchange = load;
  cashierSel.onchange = draw;
  await load();
  ctx.onChange((t) => { if (t === 'pos_sales' && day.value === todayIso()) void load(); });
}
