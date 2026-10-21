import {createRequire} from 'node:module';
import {join,dirname,resolve} from 'node:path';
export function runtimePath(cfg){return resolve(cfg.cliPath??join(process.env.ProgramFiles??'C:/Program Files','WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'));}
export function containChildren(cfg){
  if(process.platform!=='win32')return;
  // Use the installed official runtime's N-API Job Object implementation.
  // Kill-on-close contains this worker, SDK launchers and every descendant;
  // even an abrupt worker crash cannot strand an authenticated runtime.
  const require=createRequire(import.meta.url);
  const {loadBinding}=require(join(dirname(runtimePath(cfg)),'../bin/windows-job.cjs'));
  loadBinding().ensureKillOnCloseJob();
}
