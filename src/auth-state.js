'use strict';

/** Baileys auth state on top of Storage */
function createAuthState(storage, baileys) {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  const read = (key) => {
    const raw = storage.get(key);
    return raw === null ? null : JSON.parse(raw, BufferJSON.reviver);
  };
  const write = (key, value) => storage.set(key, value ? JSON.stringify(value, BufferJSON.replacer) : null);

  const creds = read('auth:creds') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, wanted) => {
          const out = {};
          for (const id of wanted) {
            let v = read(`auth:${type}:${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }
          return out;
        },
        set: async (data) => {
          for (const type of Object.keys(data)) {
            for (const [id, v] of Object.entries(data[type])) write(`auth:${type}:${id}`, v);
          }
        }
      }
    },
    saveCreds: async () => {
      const linked = (c) => !!(c && c.me && c.account);
      const before = linked(read('auth:creds'));
      write('auth:creds', creds);
      // The moment of linking must survive a crash; later updates are batched.
      if (!before || !linked(creds)) await storage.flush().catch(() => {});
    }
  };
}

async function clearAuth(storage) {
  for (const k of storage.keys('auth:')) storage.set(k, null);
  await storage.flush().catch(() => {});
}

module.exports = { createAuthState, clearAuth };
