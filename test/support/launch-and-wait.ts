// 给浏览器测试用的子进程：起一个浏览器实例，打印 ready，然后一直等着（等测试把它整个杀掉）。
// 用来验证「内核进程没了，管道断开，浏览器随之退出，不留孤儿」。
import { createPlaywrightDriver } from '../../src/drivers/playwright/driver.ts';

const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: launch-and-wait.ts <user-data-dir>');
const inst = await createPlaywrightDriver().launch({ name: 'orphan-check', userDataDir: dir });
inst.setRequestHandler(() => ({ action: 'continue' }));
await inst.openPage({});
console.log('ready');
setInterval(() => {}, 1 << 30);
