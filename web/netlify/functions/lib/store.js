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

function wrapBlobStore(store) {
  return {
    async get(key) {
      const value = await store.get(key, { type: "json", consistency: "strong" });
      return value ?? null;
    },
    async set(key, value) {
      await store.setJSON(key, value);
    },
  };
}

export async function blobStore() {
  const { getStore } = await import("@netlify/blobs");
  // Strong consistency on the client covers every read and write. The default
  // is eventual, and consume runs about a second after verify's set.
  return wrapBlobStore(getStore({ name: "grind-payments", consistency: "strong" }));
}

/** Production uses Blobs. Local `netlify functions:serve` falls back to memory. */
export async function openStore() {
  try {
    return await blobStore();
  } catch (error) {
    if (process.env.CONTEXT === "production") throw error;
    console.warn(`Netlify Blobs unavailable (${error.message}); using a memory store`);
    return memoryStore();
  }
}
