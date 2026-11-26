// M0: can a Node child process show a native macOS dialog with osascript, and does its timeout come back?
// Run by hand with `node scripts/m0/dialog-probe.ts` (not part of `npm run m0`). A dialog pops up and closes itself after 8 seconds.
import { execFile } from 'node:child_process';

const SCRIPT = 'display dialog "e2k 对话框探针" buttons {"拒绝","允许"} default button "拒绝" giving up after 8';

const started = Date.now();
execFile('osascript', ['-e', SCRIPT], (error, stdout, stderr) => {
  const ms = Date.now() - started;
  console.log(`out: ${JSON.stringify(stdout.trim())}`);
  console.log(`ms: ${ms}`);
  if (error !== null) {
    console.log(`error: ${stderr.trim() || error.message}`);
    process.exitCode = 1;
  } else {
    console.log('error: none');
  }
});
