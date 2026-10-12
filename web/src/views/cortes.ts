import type { Ctx } from '../main';
import { listCuts, type CashCut } from '../api';
import { dayRange, esc, fmtDate, fmtDateTime, fmtMoney, fmtTime, icon, openSheet, paintIcons, todayIso } from '../ui';

const TYPE_LABEL: Record<string, string> = { x: 'Corte X', z: 'Corte Z', apertura: 'Apertura de caja' };
const TYPE_PILL: Record<string, string> = { x: 'off', z: 'ok', apertura: 'wait' };

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mismo contenido que imprime el ticket del corte en la tienda
function ticketHtml(ctx: Ctx, c: CashCut): string {
  const pays = Object.entries(c.payments);
  const cash = c.payments['Efectivo'] ?? 0;
  return `<div class="ticket">
    <div class="t-c t-big">${esc(ctx.business.name ?? '')}</div>
    <div class="t-c">${TYPE_LABEL[c.cut_type ?? ''] ?? 'Corte'}</div>
    <hr>
    <div class="t-row"><span>Fecha</span><span>${fmtDate(c.ts)}</span></div>
    <div class="t-row"><span>Desde</span><span>${fmtDateTime(c.period_start)}</span></div>
    <div class="t-row"><span>Hasta</span><span>${fmtDateTime(c.period_end)}</span></div>
    <div class="t-row"><span>Cajero</span><span>${esc(c.cashier ?? '—')}</span></div>
    <hr>
    <div class="t-row"><span>Fondo inicial</span><span>${fmtMoney(c.opening_amount)}</span></div>
    <div class="t-row"><span>Ventas</span><span>${c.sales_count ?? 0}</span></div>
    ${pays.map(([k, v]) => `<div class="t-row"><span>${esc(k)}</span><span>${fmtMoney(v)}</span></div>`).join('')}
    <hr>
    <div class="t-row t-big"><span>Total vendido</span><span>${fmtMoney(c.total)}</span></div>
    <div class="t-row"><span>Efectivo esperado en caja</span><span>${fmtMoney((c.opening_amount ?? 0) + cash)}</span></div>
    ${c.notes ? `<hr><div>${esc(c.notes)}</div>` : ''}
    <hr><div class="t-c small">${esc(c.id)}</div>
  </div>`;
}

export async function renderCortes(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Aperturas y cortes X y Z';
  el.innerHTML = `<div class="filters">
      <label>Desde<input type="date" id="f-from" value="${isoDaysAgo(6)}" max="${todayIso()}"></label>
      <label>Hasta<input type="date" id="f-to" value="${todayIso()}" max="${todayIso()}"></label>
      <label>Tipo<select id="f-type"><option value="">Todos</option><option value="z">Corte Z</option><option value="x">Corte X</option><option value="apertura">Aperturas</option></select></label>
    </div>
    <div id="list"><div class="card empty">Cargando…</div></div>`;
  const fFrom = el.querySelector<HTMLInputElement>('#f-from')!;
  const fTo = el.querySelector<HTMLInputElement>('#f-to')!;
  const fType = el.querySelector<HTMLSelectElement>('#f-type')!;
  let cuts: CashCut[] = [];

  const draw = () => {
    const shown = fType.value ? cuts.filter((c) => c.cut_type === fType.value) : cuts;
    el.querySelector('#list')!.innerHTML = shown.length
      ? `<ul class="list card">${shown.map((c) => `<li class="click" data-cut="${esc(c.id)}">
          <span class="pill ${TYPE_PILL[c.cut_type ?? ''] ?? 'off'}">${TYPE_LABEL[c.cut_type ?? ''] ?? 'Corte'}</span>
          <div class="grow"><div><b>${fmtDate(c.ts)}</b> · ${fmtTime(c.ts)} · ${esc(c.cashier ?? '—')}</div>
            <div class="small muted">${c.cut_type === 'apertura' ? `Fondo ${fmtMoney(c.opening_amount)}` : `${c.sales_count ?? 0} ventas`}</div></div>
          <div class="num"><b>${c.cut_type === 'apertura' ? '' : fmtMoney(c.total)}</b></div>
          ${icon('chevron-right')}</li>`).join('')}</ul>`
      : '<div class="card empty">No hay cortes en estas fechas.</div>';
    paintIcons();
    el.querySelectorAll<HTMLElement>('[data-cut]').forEach((li) => {
      li.onclick = () => {
        const c = cuts.find((x) => x.id === li.dataset.cut)!;
        openSheet(TYPE_LABEL[c.cut_type ?? ''] ?? 'Corte', ticketHtml(ctx, c));
      };
    });
  };

  const load = async () => {
    if (!fFrom.value || !fTo.value) return;
    const [from] = dayRange(fFrom.value);
    const [, to] = dayRange(fTo.value);
    try {
      cuts = await listCuts(ctx.business.id, from, to);
      draw();
    } catch (e) {
      el.querySelector('#list')!.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
    }
  };

  fFrom.onchange = fTo.onchange = load;
  fType.onchange = draw;
  await load();
  ctx.onChange((t) => { if (t === 'pos_cash_cuts') void load(); });
}
