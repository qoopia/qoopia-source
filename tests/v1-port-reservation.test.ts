import { expect, test } from 'bun:test';
import net from 'node:net';
import { reservePort } from '../src/delivery/entry.ts';

test('installed start port reservation closes while a probe keeps its client socket open', async () => {
  const reservation = await reservePort(0);
  const client = net.createConnection({ host: '127.0.0.1', port: reservation.port });
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  await Bun.sleep(25);

  const close = reservation.close();
  const closedWhileClientHeldOpen = await Promise.race([close.then(() => true), Bun.sleep(100).then(() => false)]);
  client.destroy();
  await close;

  expect(closedWhileClientHeldOpen).toBe(true);
});
