// Small formatting helpers shared across the UI.

export function formatDMS(deg: number): string {
  const d = Math.floor(deg);
  const mFloat = (deg - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60);
  let mm = m;
  let ss = s;
  if (ss === 60) {
    ss = 0;
    mm += 1;
  }
  return `${d}°${String(mm).padStart(2, "0")}'${String(ss).padStart(2, "0")}"`;
}

export function formatDegInSign(deg: number): string {
  return formatDMS(deg);
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatTz(offset: number): string {
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  return `UTC${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function yearsBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (365.25 * 24 * 3600 * 1000);
}
