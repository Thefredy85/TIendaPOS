import type { Ctx } from '../main';
import {
  listAllDevices, listBusinesses, listCancelled, listDevices, listLicenses, listProducts, myLicense,
  type Business, type CancelledSale, type Device, type Product,
} from '../api';
import { ago, esc, fmtDate, fmtDateTime, fmtMoney, icon, paintIcons } from '../ui';
import { daysBetween, licenseState, localIso } from '../licencia-fechas';
import { deviceName } from './cajas';

// Más de 2 horas sin latido (la caja lo manda cada minuto)
const OFFLINE_MS = 2 * 3600_000;
const CANCELLED_DAYS = 7;
const LINES_SHOWN = 5;

type Level = 'bad' | 'wait' | 'off';
const ORDER: Record<Level, number> = { bad: 0, wait: 1, off: 2 };

export interface Alert {
  level: Level; icon: string; title: string; detail: string;
  businessId: string; store: string;
  go: string; // sección a la que lleva (admite filtro: inventario/bajo-con)
  lines?: string[];
}

interface StoreData {
  business: Business; devices: Device[]; products: Product[]; cancelled: CancelledSale[];
  license: { paid_until: string; enforce: boolean } | null;
}

const qtyOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function alertsOf(s: StoreData, ctx: Ctx, multi: boolean): Alert[] {
  const name = s.business.name || s.business.license_key;
  const store = multi ? `${name} (${s.business.license_key})` : name;
  const base = { businessId: s.business.id, store };
  const out: Alert[] = [];

  for (const d of s.devices) {
    if (d.status === 'pendiente' && ctx.canManageDevices) {
      out.push({ ...base, level: 'wait', icon: 'shield-alert', title: `Caja por aprobar: ${deviceName(d)}`, detail: 'Apruébala solo si reconoces el equipo', go: 'cajas' });
    }
    if (d.status === 'aprobado' && (!d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > OFFLINE_MS)) {
      out.push({ ...base, level: 'wait', icon: 'monitor-smartphone', title: `Caja sin conexión: ${deviceName(d)}`, detail: `Última comunicación ${ago(d.last_seen_at)}`, go: 'cajas' });
    }
  }

  if (s.license) {
    const today = localIso(new Date());
    const st = licenseState(s.license.paid_until, s.license.enforce, today);
    if (st.state === 'soon' || st.state === 'expired' || st.state === 'suspended') {
      const left = daysBetween(today, s.license.paid_until);
      out.push({
        ...base, level: st.state === 'suspended' ? 'bad' : 'wait', icon: 'key-round', title: `Licencia: ${st.label}`,
        detail: `${left > 0 ? 'Vigente hasta' : 'Venció el'} ${fmtDate(`${s.license.paid_until}T12:00:00`)}`,
        go: ctx.role === 'superadmin' ? 'licencias' : 'inicio',
      });
    }
  }

  const active = s.products.filter((p) => p.active !== false);
  const out0 = active.filter((p) => (p.stock ?? 0) === 0).length;
  const negative = active.filter((p) => (p.stock ?? 0) < 0).length;
  if (out0 + negative) {
    const parts = [out0 ? `${out0} sin existencia` : '', negative ? `${negative} en negativo` : ''].filter(Boolean).join(' · ');
    out.push({ ...base, level: negative ? 'bad' : 'wait', icon: 'triangle-alert', title: `${qtyOf(out0 + negative, 'producto agotado', 'productos agotados')}`, detail: parts, go: 'inventario/sin-existencia' });
  }

  const low = active.filter((p) => p.min_stock !== null && p.min_stock > 0 && (p.stock ?? 0) > 0 && (p.stock ?? 0) <= p.min_stock).length;
  if (low) out.push({ ...base, level: 'off', icon: 'package', title: `${qtyOf(low, 'producto bajo mínimo', 'productos bajo mínimo')}`, detail: 'Aún queda existencia', go: 'inventario/bajo-con' });

  if (s.cancelled.length) {
    out.push({
      ...base, level: 'wait', icon: 'ban',
      title: `${qtyOf(s.cancelled.length, 'venta cancelada', 'ventas canceladas')} en ${CANCELLED_DAYS} días`,
      detail: fmtMoney(s.cancelled.reduce((a, c) => a + (c.total ?? 0), 0)),
      go: 'ventas',
      lines: s.cancelled.map((c) => `${fmtDateTime(c.cancelled_at ?? c.ts)} · ${fmtMoney(c.total)} · canceló ${c.cancelled_by || '—'} · autorizó ${c.cancelled_authorized_by || '—'}`),
    });
  }

  const noCost = active.filter((p) => !p.cost).length;
  if (noCost) out.push({ ...base, level: 'off', icon: 'receipt', title: `${qtyOf(noCost, 'producto sin costo', 'productos sin costo')}`, detail: 'Mientras falte, la ganancia sale inflada', go: 'inventario/sin-costo' });

  return out;
}

// El superadmin ve todas las tiendas; el dueño y el gestor, solo la suya
export async function loadAlerts(ctx: Ctx): Promise<Alert[]> {
  const since = new Date(Date.now() - CANCELLED_DAYS * 86400_000);
  let stores: StoreData[];
  if (ctx.role === 'superadmin') {
    const [businesses, devices, licenses, cancelled] = await Promise.all([listBusinesses(), listAllDevices(), listLicenses(), listCancelled(since)]);
    const products = await Promise.all(businesses.map((b) => listProducts(b.id)));
    stores = businesses.map((business, i) => ({
      business, products: products[i],
      devices: devices.filter((d) => d.business_id === business.id),
      cancelled: cancelled.filter((c) => c.business_id === business.id),
      license: licenses.find((l) => l.business_id === business.id) ?? null,
    }));
  } else {
    const id = ctx.business.id;
    const [devices, products, cancelled, lic] = await Promise.all([listDevices(id), listProducts(id), listCancelled(since, id), myLicense(id)]);
    stores = [{ business: ctx.business, devices, products, cancelled, license: lic.defined && lic.paid_until ? { paid_until: lic.paid_until, enforce: !!lic.enforce } : null }];
  }
  const multi = stores.length > 1;
  return stores.flatMap((s) => alertsOf(s, ctx, multi)).sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

export async function renderAlertas(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Lo que necesita atención en este momento';
  el.innerHTML = '<div class="card empty">Cargando…</div>';

  const draw = async () => {
    let alerts: Alert[];
    try {
      alerts = await loadAlerts(ctx);
    } catch (e) {
      el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      return;
    }
    ctx.setAlertCount(alerts.length);
    if (!alerts.length) {
      el.innerHTML = `<div class="card empty">${icon('check')} Todo en orden: no hay alertas.</div>`;
      paintIcons();
      return;
    }
    el.innerHTML = `<ul class="list card">${alerts.map((a, i) => `<li class="click" data-i="${i}">
        <span class="pill ${a.level}">${icon(a.icon)}</span>
        <div class="grow"><div><b>${esc(a.title)}</b></div>
          <div class="small muted">${esc(a.store)} · ${esc(a.detail)}</div>
          ${a.lines ? `<div class="small" style="margin-top:6px">${a.lines.slice(0, LINES_SHOWN).map((l) => `<div>${esc(l)}</div>`).join('')}
            ${a.lines.length > LINES_SHOWN ? `<div class="muted">y ${a.lines.length - LINES_SHOWN} más</div>` : ''}</div>` : ''}
        </div>
        ${icon('chevron-right')}</li>`).join('')}</ul>`;
    paintIcons();
    el.querySelectorAll<HTMLElement>('[data-i]').forEach((li) => {
      const a = alerts[Number(li.dataset.i)];
      li.onclick = () => ctx.openBusiness(a.businessId, a.go);
    });
  };

  await draw();
  ctx.every(5 * 60_000, () => void draw());
}
