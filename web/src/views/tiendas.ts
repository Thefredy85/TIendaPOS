import type { Ctx } from '../main';
import { listAllDevices, listBusinesses, listLicenses, salesSince, type Business, type Device } from '../api';
import { dayRange, esc, fmtMoney, fmtToday, icon, paintIcons, todayIso } from '../ui';
import { licenseState, localIso } from '../licencia-fechas';
import { deviceName, deviceState } from './cajas';

const PILL = { none: 'off', ok: 'ok', soon: 'wait', expired: 'wait', suspended: 'bad' } as const;

// Solo el superadmin: un vistazo a todas las tiendas a la vez
export async function renderTiendas(ctx: Ctx, el: HTMLElement) {
  const sub = document.getElementById('sub')!;
  if (ctx.role !== 'superadmin') {
    el.innerHTML = '<div class="card empty">Solo el administrador del sistema ve todas las tiendas.</div>';
    return;
  }
  el.innerHTML = '<div class="card empty">Cargando…</div>';

  const draw = async () => {
    let businesses: Business[], devices: Device[], licenses, sales;
    try {
      [businesses, devices, licenses, sales] = await Promise.all([
        listBusinesses(), listAllDevices(), listLicenses(), salesSince(dayRange(todayIso())[0])]);
    } catch (e) {
      el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      return;
    }
    sub.textContent = `Todas las tiendas · ${fmtToday()}`;
    const today = localIso(new Date());
    const lic = new Map(licenses.map((l) => [l.business_id, l]));
    const rows = businesses.map((b) => {
      const devs = devices.filter((d) => d.business_id === b.id && d.status !== 'revocado');
      const mine = sales.filter((s) => s.business_id === b.id && !s.cancelled);
      const l = lic.get(b.id) ?? null;
      return {
        b, devs,
        total: mine.reduce((a, s) => a + (s.total ?? 0), 0), tickets: mine.length,
        st: licenseState(l?.paid_until ?? null, l?.enforce ?? false, today), enforce: l?.enforce ?? false,
      };
    });
    const online = devices.filter((d) => deviceState(d).cls === 'ok').length;
    const pending = devices.filter((d) => d.status === 'pendiente').length;
    const total = rows.reduce((a, r) => a + r.total, 0);
    const twins = (b: Business) => businesses.filter((x) => (x.name || x.license_key) === (b.name || b.license_key)).length > 1;

    el.innerHTML = `
      <div class="kpis">
        <div class="card kpi"><small>Tiendas</small><b>${businesses.length}</b></div>
        <div class="card kpi"><small>Cajas en línea</small><b>${online}</b></div>
        <div class="card kpi"><small>Ventas de hoy (todas)</small><b>${fmtMoney(total)}</b></div>
        ${pending ? `<div class="card kpi"><small>Cajas por aprobar</small><b style="color:var(--warn)">${pending}</b></div>` : ''}
      </div>
      <ul class="list card">${rows.map((r) => {
        const devLine = r.devs.length
          ? r.devs.map((d) => { const s = deviceState(d); return `<span class="pill ${s.cls}"><span class="dot ${s.cls}"></span>${esc(deviceName(d))} · ${s.label}${d.app_version ? ` · v${esc(d.app_version)}` : ''}</span>`; }).join(' ')
          : '<span class="pill off">Sin caja conectada (falta instalar la v0.2.14)</span>';
        return `<li class="click" data-biz="${r.b.id}">
          <div class="grow"><div><b>${esc(r.b.name || r.b.license_key)}</b>${twins(r.b) ? ` <span class="small muted">${esc(r.b.license_key)}</span>` : ''}</div>
            <div class="small" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${devLine}
              <span class="pill ${PILL[r.st.state]}">${icon('key-round')} ${esc(r.st.label)}${r.st.state !== 'none' ? (r.enforce ? ' · bloqueo encendido' : ' · bloqueo apagado') : ''}</span></div></div>
          <div class="right"><b class="num">${fmtMoney(r.total)}</b><div class="small muted">${r.tickets} ticket${r.tickets === 1 ? '' : 's'} hoy</div></div>
          ${icon('chevron-right')}</li>`;
      }).join('')}</ul>
      <p class="small muted">Toca una tienda para ver su panel completo.</p>`;
    paintIcons();
    el.querySelectorAll<HTMLElement>('[data-biz]').forEach((li) => { li.onclick = () => ctx.openBusiness(li.dataset.biz!); });
  };

  await draw();
  ctx.every(60_000, () => void draw());
}
