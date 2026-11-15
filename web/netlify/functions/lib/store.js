export function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(key) {
      if (!map.has(key)) return null;
      return structuredClone(map.get(key));
    },
    async set(key, value) {
      map.set(key, structuredClone(value));
    },
  };
}

export async function blobStore() {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore("grind-payments");
  return {
    async get(key) {
      const value = await store.get(key, { type: "json" });
      return value ?? null;
    },
    async set(key, value) {
      await store.setJSON(key, value);
    },
  };
}
