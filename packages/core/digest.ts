export async function digest(value: string, purpose: string) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`hearth:v1:${purpose}:${value}`),
  );
  return new Uint8Array(hash).toHex();
}
