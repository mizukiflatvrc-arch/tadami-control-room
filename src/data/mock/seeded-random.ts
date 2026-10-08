// Stateless by time slot: the same seed and timestamp always produce the same value.
export function noise(seed: number, slot: number): number {
  let value = Math.imul((slot ^ seed) >>> 0, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}
