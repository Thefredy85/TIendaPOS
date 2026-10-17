// Cálculos de fechas de las licencias (sin red ni pantalla, para poder probarlos).
// Las fechas van como 'AAAA-MM-DD' en la hora local de quien usa el panel.

export function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseIso(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((parseIso(toDay).getTime() - parseIso(fromDay).getTime()) / 86400000);
}

// Primera fecha con ese día de corte que caiga al menos `minDays` días después de `today`
// (para que ningún negocio se bloquee por sorpresa al empezar).
export function firstCutDate(today: string, cutDay: number, minDays = 30): string {
  const start = parseIso(today);
  start.setDate(start.getDate() + minDays);
  let candidate = new Date(start.getFullYear(), start.getMonth(), cutDay);
  if (candidate < start) candidate = new Date(start.getFullYear(), start.getMonth() + 1, cutDay);
  return localIso(candidate);
}

export type LicenseState = 'none' | 'ok' | 'soon' | 'expired' | 'suspended';

// Mismo criterio que la app: aviso 3, 2 y 1 días antes; desde el día de corte, suspendida
// si el bloqueo está encendido (en la tienda puede haber además 3 días de gracia sin internet).
export function licenseState(paidUntil: string | null, enforce: boolean, today: string): { state: LicenseState; daysLeft: number | null; label: string } {
  if (!paidUntil) return { state: 'none', daysLeft: null, label: 'Sin licencia' };
  const daysLeft = daysBetween(today, paidUntil);
  if (daysLeft <= 0) {
    return enforce
      ? { state: 'suspended', daysLeft, label: 'Suspendida' }
      : { state: 'expired', daysLeft, label: 'Vencida (bloqueo apagado)' };
  }
  if (daysLeft <= 3) return { state: 'soon', daysLeft, label: `Vence en ${daysLeft} día${daysLeft === 1 ? '' : 's'}` };
  return { state: 'ok', daysLeft, label: 'Al día' };
}
