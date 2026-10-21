import {fileURLToPath} from 'node:url';
import {dirname, resolve, join} from 'node:path';
import {homedir} from 'node:os';
import {existsSync} from 'node:fs';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function config(env=process.env) {
  const candidates=[env.LOCALAPPDATA&&join(env.LOCALAPPDATA,'CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'),join(homedir(),'AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'),env.APPDATA&&join(env.APPDATA,'CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info')].filter(Boolean);
  const number=(key, fallback,min,max)=>{const n=Number(env[key]??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Invalid ${key}`);return n;};
  return {version:'0.2.1',root:ROOT,runtime:resolve(env.WORKBUDDY_RUNTIME_DIR??join(ROOT,'.runtime')),reports:resolve(env.WORKBUDDY_REPORTS_DIR??join(ROOT,'reports')),cliPath:env.WORKBUDDY_CLI,
    authFile:env.WORKBUDDY_AUTH_FILE??candidates.find(existsSync)??candidates[0],
    upstreamModel:env.WORKBUDDY_MODEL??'deepseek-v4.1-flash',
    port:number('WORKBUDDY_PORT',8647,1024,65535),timeoutMs:number('WORKBUDDY_TIMEOUT_MS',300000,1000,1800000),
    concurrency:number('WORKBUDDY_CONCURRENCY',3,1,16),queueLimit:32,bodyLimit:16*1024*1024,heartbeatMs:10000,
    maxSessions:number('WORKBUDDY_MAX_SESSIONS',8,1,64),sessionIdleMs:number('WORKBUDDY_SESSION_IDLE_MS',3600000,60000,86400000),
    replayMs:number('WORKBUDDY_REPLAY_MS',120000,0,600000),decisionRetries:number('WORKBUDDY_DECISION_RETRIES',2,0,2)};
}
