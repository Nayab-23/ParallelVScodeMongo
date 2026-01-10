const MAX_DIFF_CHARS = 200_000;

export function renderDiff(filePath: string, oldText: string, newText: string): string {
  const normalizedOld = normalizeEol(oldText);
  const normalizedNew = normalizeEol(newText);
  const total = normalizedOld.length + normalizedNew.length;
  if (total > MAX_DIFF_CHARS) {
    return `[diff omitted: too large (~${Math.round(total / 1024)} KB)]`;
  }
  if (maybeBinary(normalizedOld) || maybeBinary(normalizedNew)) {
    return '[diff omitted: binary/unknown encoding]';
  }
  const header = [`--- ${filePath}`, `+++ ${filePath}`, '@@'].join('\n');
  const oldLines = normalizedOld.split('\n').map((l) => `-${l}`);
  const newLines = normalizedNew.split('\n').map((l) => `+${l}`);
  return [header, ...oldLines, ...newLines].join('\n');
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function maybeBinary(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 4000);
  return sample.includes('\u0000');
}
