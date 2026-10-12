import type { Ctx } from '../main';
import { listDevices, setDeviceStatus, type Device } from '../api';
import { ago, esc, fmtDateTime, fmtMoney, fmtTime, icon, paintIcons, toast } from '../ui';

// La caja manda su latido cada minuto: 3 minutos sin latido = sin conexión.
const ONLINE_MS = 3 * 60 * 1000;

export function deviceState(d: Device): { cls: 'ok' | 'wait' | 'off' | 'bad'; label: string } {
  if (d.status === 'revocado') return { cls: 'bad', label: 'Dada de baja' };
  if (d.status === 'pendiente') return { cls: 'wait', label: 'Pendiente de aprobación' };
  const online = d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < ONLINE_MS;
  return online ? { cls: 'ok', label: 'En línea' } : { cls: 'off', label: `Sin conexión · ${ago(d.last_seen_at)}` };
}

export const deviceName = (d: Device) => d.name || 'Caja sin nombre';

export function cashLine(d: Device): string {
  if (d.status !== 'aprobado') return `Registrada ${fmtDateTime(d.registered_at)}`;
  const who = d.session_user_name ? ` · ${esc(d.session_user_name)}` : '';
  return d.cash_open
    ? `Caja abierta desde ${fmtTime(d.cash_period_start)} · fondo ${fmtMoney(d.cash_opening_amount)}${who}`
    : `Caja cerrada${who}`;
}

// Aprobar o dar de baja, con confirmación. Devuelve true si se hizo el cambio.
export async function changeStatus(d: Device, status: 'aprobado' | 'revocado'): Promise<boolean> {
  const msg = status === 'aprobado'
    ? `¿Aprobar "${deviceName(d)}"?\n\nPodrá enviar ventas, inventario y cortes de este negocio. Aprueba solo si reconoces este equipo.`
    : `¿Dar de baja "${deviceName(d)}"?\n\nDejará de enviar datos a la nube. Lo que ya envió se conserva.`;
  if (!confirm(msg)) return false;
  try {
    await setDeviceStatus(d.id, status);
    toast(status === 'aprobado' ? 'Caja aprobada' : 'Caja dada de baja');
    return true;
  } catch (e) {
    toast(`No se pudo: ${(e as Error).message}`);
    return false;
  }
}

export async function renderCajas(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Cajas registradas en este negocio';
  el.innerHTML = '<div class="card empty">Cargando…</div>';

  const draw = async () => {
    const devices = await listDevices(ctx.business.id);
    if (!devices.length) {
      el.innerHTML = `<div class="card empty">${icon('monitor-smartphone')}<p>Todavía no hay cajas.<br>Aparecerán aquí cuando la app de la tienda (v0.2.12 o más nueva) se conecte a internet.</p></div>`;
      paintIcons();
      return;
    }
    const pending = devices.filter((d) => d.status === 'pendiente').length;
    el.innerHTML = `
      ${pending ? `<div class="banner wait">${icon('shield-alert')}<div><b>${pending} caja(s) esperan aprobación.</b><br>
        <span class="small">Aprueba solo los equipos que reconozcas. Una caja pendiente guarda sus ventas y las envía en cuanto la apruebes.</span></div></div>` : ''}
      ${ctx.canManageDevices ? '' : `<div class="banner info">${icon('info')}<span class="small">Solo el dueño del negocio puede aprobar o dar de baja cajas.</span></div>`}
      <ul class="list card">${devices.map((d) => {
        const st = deviceState(d);
        const actions = !ctx.canManageDevices ? '' :
          d.status === 'pendiente' ? `<button class="btn primary" data-act="aprobado" data-id="${d.id}">${icon('check')} Aprobar</button>
                                      <button class="btn danger" data-act="revocado" data-id="${d.id}">Rechazar</button>` :
          d.status === 'aprobado' ? `<button class="btn danger" data-act="revocado" data-id="${d.id}">Dar de baja</button>` :
          `<button class="btn" data-act="aprobado" data-id="${d.id}">Reactivar</button>`;
        return `<li style="flex-wrap:wrap">
          <span class="dot ${st.cls}"></span>
          <div class="grow">
            <div><b>${esc(deviceName(d))}</b> <span class="pill ${st.cls}">${st.label}</span></div>
            <div class="small muted">${cashLine(d)}</div>
            <div class="small muted">Versión ${esc(d.app_version ?? '—')} · último contacto ${ago(d.last_seen_at)}</div>
          </div>
          <div style="display:flex;gap:8px">${actions}</div>
        </li>`;
      }).join('')}</ul>`;
    paintIcons();
    el.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
      b.onclick = async () => {
        const d = devices.find((x) => x.id === b.dataset.id)!;
        if (await changeStatus(d, b.dataset.act as 'aprobado' | 'revocado')) { await draw(); ctx.refreshBadge(); }
      };
    });
  };

  await draw().catch((e) => { el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`; });
  ctx.onChange((t) => { if (t === 'pos_devices') void draw(); });
  ctx.every(30_000, () => void draw());
}
