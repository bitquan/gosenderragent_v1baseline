export function formatStamp(value: string | undefined) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return 'now';
  }
  return date.toLocaleString();
}

export function shortPath(value: string | undefined) {
  const input = String(value || '').trim();
  if (!input) {
    return '';
  }
  const parts = input.split(/[\\/]+/).filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join('/') : input;
}

export function summarizeText(value: string | undefined, limit = 160) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
