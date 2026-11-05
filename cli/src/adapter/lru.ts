/** Stores `value` as the newest entry and drops the oldest past `limit`, so `map` stays bounded. */
export function setRecent<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  const [oldest] = map.keys();
  if (map.size > limit && oldest !== undefined) map.delete(oldest);
}
