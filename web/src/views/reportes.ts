import type { Ctx } from '../main';
import { reportCashiers, reportDaily, reportProducts, type CashierRow, type DayRow, type ProductRow } from '../api';
import { daysAgoIso, downloadCsv, esc, fmtMoney, fmtQty, icon, paintIcons, rangeOf, todayIso } from '../ui';

type Tab = 'dia' | 'producto' | 'cajero';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
};

export async function renderReportes(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Ventas por día, por producto y por cajero (sin canceladas)';
  const now = new Date();
  const presets: [string, string, string][] = [
    ['Hoy', todayIso(), todayIso()],
    ['7 días', daysAgoIso(6), todayIso()],
    ['30 días', daysAgoIso(29), todayIso()],
    ['Este mes', iso(new Date(now.getFullYear(), now.getMonth(), 1)), todayIso()],
    ['Mes pasado', iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))],
  ];
  el.innerHTML = `<div class="filters">
      <label>Desde<input type="date" id="f-from" value="${daysAgoIso(29)}" max="${todayIso()}"></label>
      <label>Hasta<input type="date" id="f-to" value="${todayIso()}" max="${todayIso()}"></label>
      <div class="chips">${presets.map(([l, a, b]) => `<button class="chip" data-a="${a}" data-b="${b}">${l}</button>`).join('')}</div>
    </div>
    <div class="tabs" role="tablist">
      <button class="tab on" data-tab="dia">Por día</button>
      <button class="tab" data-tab="producto">Por producto</button>
      <button class="tab" data-tab="cajero">Por cajero</button>
      <button class="btn" id="csv" style="margin-left:auto">${icon('download')} CSV</button>
    </div>
    <div id="out"><div class="card empty">Cargando…</div></div>`;
  paintIcons();
  const from = el.querySelector<HTMLInputElement>('#f-from')!;
  const to = el.querySelector<HTMLInputElement>('#f-to')!;
  const out = el.querySelector<HTMLElement>('#out')!;
  let tab: Tab = 'dia';
  let days: DayRow[] = [], prods: ProductRow[] = [], cashiers: CashierRow[] = [];
  let sortBy: 'amount' | 'qty' | 'profit' = 'amount';
  let seq = 0;

  const kpis = () => {
    const total = days.reduce((a, d) => a + d.total, 0);
    const tickets = days.reduce((a, d) => a + d.tickets, 0);
    const profit = days.reduce((a, d) => a + d.profit, 0);
    const cancelled = days.reduce((a, d) => a + d.cancelled, 0);
    return `<div class="kpis">
      <div class="card kpi"><small>Ventas</small><b>${fmtMoney(total)}</b></div>
      <div class="card kpi"><small>Tickets</small><b>${tickets}</b></div>
      <div class="card kpi"><small>Ticket promedio</small><b>${fmtMoney(tickets ? total / tickets : 0)}</b></div>
      <div class="card kpi"><small>Ganancia</small><b>${fmtMoney(profit)}</b></div>
      ${cancelled ? `<div class="card kpi"><small>Canceladas</small><b style="color:var(--danger)">${cancelled}</b></div>` : ''}
    </div>`;
  };

  const drawDays = () => {
    if (!days.length) return '<div class="card empty">No hay ventas en este rango.</div>';
    const max = Math.max(...days.map((d) => d.total), 1);
    return `<div class="card pad"><div class="bars" role="img" aria-label="Ventas por día">${days.map((d) =>
      `<div class="bar" title="${esc(fmtDay(d.day))}: ${fmtMoney(d.total)}"><span style="height:${Math.max(2, (d.total / max) * 100)}%"></span>
        <small>${Number(d.day.slice(8))}</small></div>`).join('')}</div></div>
      <div class="card table-wrap" style="margin-top:12px"><table class="table">
        <thead><tr><th>Día</th><th class="r">Ventas</th><th class="r">Tickets</th><th class="r">Promedio</th><th class="r">Ganancia</th><th class="r">Canceladas</th></tr></thead>
        <tbody>${[...days].reverse().map((d) => `<tr><td>${esc(fmtDay(d.day))}</td><td class="r num">${fmtMoney(d.total)}</td>
          <td class="r num">${d.tickets}</td><td class="r num">${fmtMoney(d.tickets ? d.total / d.tickets : 0)}</td>
          <td class="r num">${fmtMoney(d.profit)}</td><td class="r num">${d.cancelled || ''}</td></tr>`).join('')}</tbody></table></div>`;
  };

  const sortedProds = () => [...prods].sort((a, b) =>
    sortBy === 'qty' ? b.qty - a.qty : sortBy === 'profit' ? (b.amount - b.cost) - (a.amount - a.cost) : b.amount - a.amount);

  const drawProds = () => {
    if (!prods.length) return '<div class="card empty">No hay ventas en este rango.</div>';
    const list = sortedProds();
    return `<div class="filters"><label>Ordenar por<select id="sort">
        <option value="amount"${sortBy === 'amount' ? ' selected' : ''}>Importe</option>
        <option value="qty"${sortBy === 'qty' ? ' selected' : ''}>Piezas</option>
        <option value="profit"${sortBy === 'profit' ? ' selected' : ''}>Ganancia</option></select></label>
        <span class="small muted" style="align-self:center">${prods.length} productos vendidos</span></div>
      <div class="card table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Producto</th><th class="r">Piezas</th><th class="r">Importe</th><th class="r">Ganancia</th><th class="r">Tickets</th></tr></thead>
        <tbody>${list.slice(0, 200).map((p, i) => `<tr><td class="muted">${i + 1}</td>
          <td>${esc(p.name ?? p.internal_id)}<div class="small muted">${esc(p.barcode ?? '')}</div></td>
          <td class="r num">${fmtQty(p.qty)}</td><td class="r num">${fmtMoney(p.amount)}</td>
          <td class="r num">${fmtMoney(p.amount - p.cost)}</td><td class="r num">${p.tickets}</td></tr>`).join('')}</tbody></table></div>
      ${list.length > 200 ? `<p class="small muted">Se muestran 200 de ${list.length}. El CSV trae todos.</p>` : ''}`;
  };

  const drawCashiers = () => {
    if (!cashiers.length) return '<div class="card empty">No hay ventas en este rango.</div>';
    return `<div class="card table-wrap"><table class="table">
      <thead><tr><th>Cajero</th><th class="r">Ventas</th><th class="r">Tickets</th><th class="r">Promedio</th><th class="r">Canceladas</th><th class="r">Importe cancelado</th></tr></thead>
      <tbody>${cashiers.map((c) => `<tr><td>${esc(c.cashier)}</td><td class="r num">${fmtMoney(c.total)}</td><td class="r num">${c.tickets}</td>
        <td class="r num">${fmtMoney(c.tickets ? c.total / c.tickets : 0)}</td>
        <td class="r num">${c.cancelled ? `<span style="color:var(--danger)">${c.cancelled}</span>` : ''}</td>
        <td class="r num">${c.cancelled ? fmtMoney(c.cancelled_amount) : ''}</td></tr>`).join('')}</tbody></table></div>`;
  };

  const draw = () => {
    out.innerHTML = kpis() + (tab === 'dia' ? drawDays() : tab === 'producto' ? drawProds() : drawCashiers());
    const sort = out.querySelector<HTMLSelectElement>('#sort');
    if (sort) sort.onchange = () => { sortBy = sort.value as typeof sortBy; draw(); };
  };

  const load = async () => {
    if (!from.value || !to.value) return;
    const [a, b] = from.value <= to.value ? [from.value, to.value] : [to.value, from.value];
    const [f, t] = rangeOf(a, b);
    const my = ++seq;
    out.innerHTML = '<div class="card empty">Cargando…</div>';
    try {
      const [d, p, c] = await Promise.all([reportDaily(ctx.business.id, f, t), reportProducts(ctx.business.id, f, t), reportCashiers(ctx.business.id, f, t)]);
      if (my !== seq) return;
      days = d; prods = p; cashiers = c;
      draw();
    } catch (e) {
      if (my === seq) out.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
    }
  };

  from.onchange = load;
  to.onchange = load;
  el.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => {
    b.onclick = () => { from.value = b.dataset.a!; to.value = b.dataset.b!; void load(); };
  });
  el.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab as Tab;
      el.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    };
  });
  el.querySelector<HTMLButtonElement>('#csv')!.onclick = () => {
    const name = `${tab === 'dia' ? 'ventas-por-dia' : tab === 'producto' ? 'ventas-por-producto' : 'ventas-por-cajero'}-${from.value}-a-${to.value}.csv`;
    if (tab === 'dia') downloadCsv(name, ['Día', 'Ventas', 'Tickets', 'Ganancia', 'Canceladas'], days.map((d) => [d.day, d.total, d.tickets, d.profit, d.cancelled]));
    else if (tab === 'producto') downloadCsv(name, ['Código de barras', 'Producto', 'Identificador interno', 'Piezas', 'Importe', 'Costo', 'Ganancia', 'Tickets'],
      sortedProds().map((p) => [p.barcode, p.name, p.internal_id, p.qty, p.amount, p.cost, +(p.amount - p.cost).toFixed(2), p.tickets]));
    else downloadCsv(name, ['Cajero', 'Ventas', 'Tickets', 'Canceladas', 'Importe cancelado'], cashiers.map((c) => [c.cashier, c.total, c.tickets, c.cancelled, c.cancelled_amount]));
  };
  await load();
}
