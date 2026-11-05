// Barcode numbers. Alko products carry EAN-13 (or EAN-8); UPC-A scanners report 12 digits, which
// is the same code with a leading zero. Same rules as the Alkometriikka backend, so both sides
// agree on what a valid barcode is.

function checksumOk(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(digits[i]) * weight;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** The canonical EAN-13 or EAN-8 for `input`, or null if it isn't a valid barcode number. */
export function normalizeEan(input: string): string | null {
  const digits = input.trim();
  if (!/^\d+$/.test(digits)) return null;
  const padded = digits.length === 12 ? `0${digits}` : digits;
  if (padded.length !== 13 && padded.length !== 8) return null;
  return checksumOk(padded) ? padded : null;
}
