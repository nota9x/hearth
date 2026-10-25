export const storageUnits = {
  MB: 1_000_000,
  GB: 1_000_000_000,
  TB: 1_000_000_000_000,
} as const;
export function storageLimitInput(bytes: number) {
  const unit: keyof typeof storageUnits =
    bytes >= 1e12 && bytes % 1e6 === 0
      ? 'TB'
      : bytes >= 1e9 && bytes % 1000 === 0
        ? 'GB'
        : 'MB';
  const value = BigInt(bytes),
    divisor = BigInt(storageUnits[unit]);
  const fraction = (value % divisor)
    .toString()
    .padStart(Math.log10(storageUnits[unit]), '0')
    .replace(/0+$/, '');
  return {
    unit,
    amount: `${value / divisor}${fraction ? `.${fraction}` : ''}`,
  };
}
export function parseStorageLimit(
  value: string,
  unit: keyof typeof storageUnits,
) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim()))
    throw new Error('Enter a positive number with up to six decimal places.');
  const [whole, fraction = ''] = value.trim().split('.', 2);
  const bytes =
    ((BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))) *
      BigInt(storageUnits[unit])) /
    1_000_000n;
  if (bytes <= 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Choose a positive limit within the supported byte range.');
  return Number(bytes);
}
export function storageBytes(value: number) {
  const [unit, divisor] =
    value >= 1e12
      ? ['TB', 1e12]
      : value >= 1e9
        ? ['GB', 1e9]
        : value >= 1e6
          ? ['MB', 1e6]
          : value >= 1e3
            ? ['KB', 1e3]
            : ['B', 1];
  return `${(value / divisor).toLocaleString('en', { maximumFractionDigits: divisor === 1 ? 0 : 1 })} ${unit}`;
}
export const formatNames: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
};
