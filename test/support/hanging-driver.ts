import type { Driver, Instance, Page } from '../../src/driver/types.ts';
import { FakeDriver } from './fake-driver.ts';
import type { FakePageSpec } from './fake-driver.ts';

// 一个 openPage 永远不落定的驱动：关停时的 drain 会一直等下去。hangStop 给了，实例的 stop() 也永远不落定。
export function hangingDriver(pages: Record<string, FakePageSpec>, o: { hangStop?: boolean } = {}):
{ driver: Driver; stops: () => number; opened: () => boolean } {
  const fake = new FakeDriver({ pages });
  let stops = 0;
  let opened = false;
  const driver: Driver = {
    name: fake.name, capabilities: fake.capabilities, selfCheck: () => fake.selfCheck(),
    async launch(profile) {
      const inst = await fake.launch(profile);
      const wrapped: Instance = {
        health: () => inst.health(),
        stop: async () => {
          stops++;
          if (o.hangStop === true) return new Promise<void>(() => {});
          await inst.stop();
        },
        onClosed: (l) => { inst.onClosed(l); },
        setRequestHandler: (h) => { inst.setRequestHandler(h); },
        onRequestDone: (l) => { inst.onRequestDone(l); },
        addInitScript: (s) => inst.addInitScript(s),
        onPageOpened: (l) => { inst.onPageOpened(l); },
        openPage: () => { opened = true; return new Promise<Page>(() => {}); },
      };
      return wrapped;
    },
  };
  return { driver, stops: () => stops, opened: () => opened };
}
