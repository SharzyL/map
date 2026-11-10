// Per-viewer settings kept in localStorage. Storage can be missing or throw
// (private mode, blocked site data), so reads fall back to defaults and
// writes are best effort.

export function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredSettings<T>(
  key: string,
  normalize: (value: unknown) => T,
  storage: Pick<Storage, 'getItem'> | null = safeLocalStorage(),
): T {
  try {
    const raw = storage?.getItem(key);
    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    return normalize(null);
  }
}

export function writeStoredSettings(
  key: string,
  value: unknown,
  storage: Pick<Storage, 'setItem'> | null = safeLocalStorage(),
) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // The setting still applies for this session.
  }
}
