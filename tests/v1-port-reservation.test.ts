import { expect, test } from 'bun:test';
import net from 'node:net';
import http from 'node:http';
import { claimInstallationPort, reservePort } from '../src/delivery/entry.ts';

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

test('start tells "already running" (same installation /health) apart from another program on the recorded port', async () => {
  const listen = async (server: net.Server) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    return (server.address() as net.AddressInfo).port;
  };
  const own = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ instance_id: 'installation-a' })); });
  const foreign = net.createServer(socket => socket.destroy());
  const ownPort = await listen(own), foreignPort = await listen(foreign);
  try {
    await expect(claimInstallationPort(ownPort, 'installation-a')).rejects.toThrow(`Qoopia is already running at http://127.0.0.1:${ownPort}/dashboard`);
    await expect(claimInstallationPort(ownPort, 'installation-b')).rejects.toThrow(`Port ${ownPort} is used by another program`);
    await expect(claimInstallationPort(foreignPort, 'installation-a')).rejects.toThrow(`Port ${foreignPort} is used by another program`);
  } finally { own.close(); foreign.close(); }
  const free = await reservePort(0);
  await free.close();
  await claimInstallationPort(free.port, 'installation-a');
});
