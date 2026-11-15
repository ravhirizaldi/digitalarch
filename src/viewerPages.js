export function parsePageSelection(value, total) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000)
    throw new Error('Enter pages such as 1, 3, 8–12.');
  const selected = new Set();
  for (const part of value.split(',')) {
    const match = /^\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error('Use page numbers or ranges separated by commas.');
    const from = Number(match[1]),
      to = Number(match[2] || match[1]);
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 1 ||
      to < from ||
      to > total
    )
      throw new Error(`Choose pages between 1 and ${total}, in ascending ranges.`);
    for (let number = from; number <= to; number++) selected.add(number);
  }
  return [...selected].sort((a, b) => a - b);
}
