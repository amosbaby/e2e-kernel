// M0: can the kernel's real dialog implementation (osascriptDialog) show a native macOS dialog and get the click or the timeout back?
// Run by hand with `node scripts/m0/dialog-probe.ts` (not part of `npm run m0`). A dialog pops up and gives up by itself after 60 seconds.
import { osascriptDialog } from '../../src/kernel/approval.ts';

const started = Date.now();
const result = await osascriptDialog().show({
  title: 'e2k 对话框探针', lines: ['这是一次探针：点「允许」或「拒绝」，或等它自己超时。'],
  buttons: ['拒绝', '允许'], defaultButton: '拒绝', timeoutSec: 60,
});
console.log(`result: ${JSON.stringify(result)}`);
console.log(`ms: ${Date.now() - started}`);
if (result.kind === 'unavailable') process.exitCode = 1;
