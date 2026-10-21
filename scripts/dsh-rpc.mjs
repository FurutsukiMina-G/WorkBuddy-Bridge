import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dshFetch, windowsDshInventory, proveDshOrigin } from './dsh-endpoint.mjs';
let connected;
const cachePath = '.runtime/dsh-connection.json';
const localRoot = (value) => typeof value === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(value);
function request(connection, method, args, timeout = 30000) {
    return dshFetch(connection.root, `/api/${method}`, { method: 'POST', headers: {
            cookie: connection.cookie, 'content-type': 'application/json', origin: connection.root,
        }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) }, { timeoutMs: timeout });
}
async function discover() {
    const inventory = await windowsDshInventory();
    const owned = (root) => { try {
        proveDshOrigin(root, inventory, process.env.DSH_HOST_ENTRY);
        return true;
    }
    catch {
        return false;
    } };
    for(const savedPath of [cachePath,process.env.DSH_CONNECTION_FILE].filter(Boolean))try {
        const saved = JSON.parse(await readFile(savedPath, 'utf8'));
        if (localRoot(saved.root) && typeof saved.cookie === 'string' && owned(saved.root)) {
            const probe = await request(saved, 'settings/describe', {}, 5000);
            if (probe.ok && (await probe.json()).result?.ok){
                if(savedPath!==cachePath){await mkdir('.runtime',{recursive:true});await writeFile(cachePath,JSON.stringify(saved),{mode:0o600});}
                return saved;
            }
        }
    }
    catch { /* A cache miss or closed desktop is resolved through launch logs. */ }
    for (const path of [process.env.DSH_LAUNCH_LOG, '.runtime/dsh-desktop-host.out.log',
        `${process.env.APPDATA}\\dsh-desktop\\logs\\dsh-host.log`].filter((x) => Boolean(x))) {
        try {
            const log = await readFile(path, 'utf8');
            const links = [...log.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+)\/?\?token=([A-Za-z0-9_-]+)/g)].reverse();
            for (const link of links.slice(0, 2)) {
                const root = link[1];
                if (!owned(root))
                    continue;
                const visit = await dshFetch(root, `/?token=${link[2]}`, {}, { timeoutMs: 3000 });
                const cookie = visit.headers.get('set-cookie')?.split(';', 1)[0];
                if (visit.status !== 303 || !cookie)
                    continue;
                const connection = { root, cookie };
                await mkdir('.runtime', { recursive: true });
                await writeFile(cachePath, JSON.stringify(connection), { mode: 0o600 });
                return connection;
            }
        }
        catch { /* Try the next known local launch log without exposing tokens. */ }
    }
    throw new Error('No verified DSH endpoint is available; no other local ports are probed. Start the desktop with a captured launch log or set DSH_LAUNCH_LOG. For a custom CLI host also set its exact DSH_HOST_ENTRY.');
}
export async function rpc(method, args = {}) {
    connected ??= discover();
    let connection;
    try {
        connection = await connected;
    }
    catch (error) {
        connected = undefined;
        throw error;
    }
    const response = await request(connection, method, args);
    const result = await response.json();
    if (!response.ok || !result.result?.ok)
        throw new Error(`${method} failed: HTTP ${response.status}, ` +
            `${result.result?.error?.code ?? 'unknown'}: ${result.result?.error?.message ?? 'No successful RPC result'}`);
    return result.result.value;
}
if (process.argv[1]?.endsWith('dsh-rpc.ts')) {
    const method = process.argv[2] ?? 'settings/describe';
    if (!['settings/describe', 'session/modelCatalog'].includes(method))
        throw new Error('CLI is read-only');
    const result = await rpc(method);
    if (method === 'settings/describe')
        console.log(JSON.stringify({ keys: Object.keys(result ?? {}),
            namespaces: (result?.namespaces ?? []).map((entry) => ({
                ns: entry.ns, keys: Object.keys(entry), sectionKeys: Object.keys((entry.section ?? {})),
                revision: entry.revision,
            })) }));
    else
        console.log(JSON.stringify({ keys: Object.keys(result ?? {}), models: result?.models?.length ?? null }));
}
