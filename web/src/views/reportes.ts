import type { Ctx } from '../main';
import { listAllSales, listCuts, listMovements, listProducts, reportCashiers, reportDaily, reportProducts, type CashierRow, type DayRow, type ProductRow } from '../api';
import { downloadXlsx } from '../xlsx';
import { moveLabel } from './movimientos';
import { daysAgoIso, downloadCsv, esc, fmtDateTime, fmtMoney, fmtQty, icon, paintIcons, rangeOf, toast, todayIso } from '../ui';

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
      <button class="btn" id="xlsx" title="Un archivo con ventas, productos, movimientos, cortes e inventario del periodo">${icon('file-spreadsheet')} Excel</button>
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
  // Excel del periodo: todo lo de Reportes más el detalle de ventas, movimientos, cortes e inventario
  const xlsxBtn = el.querySelector<HTMLButtonElement>('#xlsx')!;
  xlsxBtn.onclick = async () => {
    xlsxBtn.disabled = true;
    try {
      const [f, t] = rangeOf(from.value, to.value);
      const [sales, moves, cuts, products] = await Promise.all([
        listAllSales(ctx.business.id, f, t), listMovements(ctx.business.id, f, t, { limit: 20000 }),
        listCuts(ctx.business.id, f, t), listProducts(ctx.business.id)]);
      const pay = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ');
      downloadXlsx(`reporte-${ctx.business.name || ctx.business.license_key}-${from.value}-a-${to.value}.xlsx`, [
        { name: 'Por día', header: ['Día', 'Ventas', 'Tickets', 'Ganancia', 'Canceladas'], rows: days.map((d) => [d.day, d.total, d.tickets, d.profit, d.cancelled]) },
        { name: 'Por producto', header: ['Código de barras', 'Producto', 'Piezas', 'Importe', 'Costo', 'Ganancia', 'Tickets'],
          rows: [...prods].sort((a, b) => b.amount - a.amount).map((p) => [p.barcode, p.name, p.qty, p.amount, p.cost, +(p.amount - p.cost).toFixed(2), p.tickets]) },
        { name: 'Por cajero', header: ['Cajero', 'Ventas', 'Tickets', 'Canceladas', 'Importe cancelado'], rows: cashiers.map((c) => [c.cashier, c.total, c.tickets, c.cancelled, c.cancelled_amount]) },
        { name: 'Ventas', header: ['Fecha', 'Folio', 'Cajero', 'Forma de pago', 'Desglose', 'Total', 'Ganancia', 'Cancelada', 'Canceló'],
          rows: sales.map((s) => [fmtDateTime(s.ts), s.id, s.cashier, s.payment_method, pay(s.payment_breakdown), s.total, s.profit, s.cancelled, s.cancelled_by]) },
        { name: 'Movimientos', header: ['Fecha', 'Tipo', 'Producto', 'Cantidad', 'Antes', 'Después', 'Costo total', 'Motivo', 'Usuario', 'Anulado'],
          rows: moves.map((m) => [fmtDateTime(m.ts), moveLabel(m.type), m.product_name, m.quantity, m.stock_before, m.stock_after, m.total_cost, m.reason, m.user_name, !!m.voided_at]) },
        { name: 'Cortes', header: ['Fecha', 'Tipo', 'Cajero', 'Fondo inicial', 'Total', 'Tickets', 'Formas de pago'],
          rows: cuts.map((c) => [fmtDateTime(c.ts), c.cut_type === 'z' ? 'Corte Z' : c.cut_type === 'x' ? 'Corte X' : 'Apertura', c.cashier, c.opening_amount, c.total, c.sales_count, pay(c.payments)]) },
        { name: 'Inventario hoy', header: ['Código de barras', 'Nombre', 'Categoría', 'Costo', 'Precio', 'Existencia', 'Mínimo', 'Activo'],
          rows: products.map((p) => [p.barcode, p.name, p.category, p.cost, p.price, p.stock, p.min_stock, p.active !== false]) },
      ]);
    } catch (e) {
      toast(`No se pudo armar el Excel: ${(e as Error).message}`);
    }
    xlsxBtn.disabled = false;
  };
  await load();
}
