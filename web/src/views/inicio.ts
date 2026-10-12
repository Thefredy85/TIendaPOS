import type { Ctx } from '../main';
import { listDevices, listSales, type Device, type Sale } from '../api';
import { dayRange, esc, fmtMoney, fmtToday, icon, paintIcons, todayIso } from '../ui';
import { cashLine, changeStatus, deviceName, deviceState } from './cajas';
import { openSale, saleRow } from './ventas';

export async function renderInicio(ctx: Ctx, el: HTMLElement) {
  const sub = document.getElementById('sub')!;
  el.innerHTML = '<div class="card empty">Cargando…</div>';
  let sales: Sale[] = [];
  let devices: Device[] = [];

  const draw = () => {
    sub.innerHTML = `${fmtToday()} · <span class="pill ok" style="padding:1px 8px"><span class="dot ok"></span>En vivo</span>`;
    const valid = sales.filter((s) => !s.cancelled);
    const total = valid.reduce((a, s) => a + (s.total ?? 0), 0);
    const avg = valid.length ? total / valid.length : 0;
    const cancelled = sales.length - valid.length;
    el.innerHTML = `
      <div class="kpis">
        <div class="card kpi"><small>Ventas de hoy</small><b>${fmtMoney(total)}</b></div>
        <div class="card kpi"><small>Tickets</small><b>${valid.length}</b></div>
        <div class="card kpi"><small>Ticket promedio</small><b>${fmtMoney(avg)}</b></div>
        ${cancelled ? `<div class="card kpi"><small>Canceladas</small><b style="color:var(--danger)">${cancelled}</b></div>` : ''}
      </div>
      <div class="section-title">${icon('monitor-smartphone')} Cajas</div>
      ${devices.length ? `<ul class="list card">${devices.filter((d) => d.status !== 'revocado').map((d) => {
        const st = deviceState(d);
        const approve = d.status === 'pendiente' && ctx.canManageDevices
          ? `<button class="btn primary" data-approve="${d.id}">${icon('check')} Aprobar</button>` : '';
        return `<li><span class="dot ${st.cls}"></span>
          <div class="grow"><div><b>${esc(deviceName(d))}</b> <span class="pill ${st.cls}">${st.label}</span></div>
          <div class="small muted">${cashLine(d)}</div></div>${approve}</li>`;
      }).join('')}</ul>`
        : '<div class="card empty small">Sin cajas conectadas todavía. Aparecen al instalar la v0.2.12 en la tienda.</div>'}
      <div class="section-title">${icon('receipt')} Últimas ventas</div>
      ${sales.length ? `<ul class="list card">${sales.slice(0, 8).map(saleRow).join('')}</ul>
        ${sales.length > 8 ? '<p class="small"><a href="#/ventas">Ver todas las ventas de hoy</a></p>' : ''}`
        : '<div class="card empty small">Aún no hay ventas hoy.</div>'}`;
    paintIcons();
    el.querySelectorAll<HTMLElement>('[data-sale]').forEach((li) => {
      li.onclick = () => openSale(ctx, sales.find((s) => s.id === li.dataset.sale)!);
    });
    el.querySelectorAll<HTMLButtonElement>('[data-approve]').forEach((b) => {
      b.onclick = async () => {
        if (await changeStatus(devices.find((d) => d.id === b.dataset.approve)!, 'aprobado')) {
          await loadDevices(); ctx.refreshBadge();
        }
      };
    });
  };

  const loadSales = async () => {
    const [from, to] = dayRange(todayIso());
    sales = await listSales(ctx.business.id, from, to);
  };
  const loadDevices = async () => { devices = await listDevices(ctx.business.id); draw(); };

  try {
    await Promise.all([loadSales(), listDevices(ctx.business.id).then((d) => { devices = d; })]);
    draw();
  } catch (e) {
    el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
    return;
  }
  ctx.onChange((t) => {
    if (t === 'pos_sales') void loadSales().then(draw);
    if (t === 'pos_devices') void loadDevices();
  });
  // "hace X s" y en línea / sin conexión cambian con el tiempo aunque no llegue nada
  ctx.every(30_000, draw);
}
