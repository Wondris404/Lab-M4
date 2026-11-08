/** Usage runs in its own process: deny network APIs before loading parsers.
 * A defense against accidental egress, not an OS sandbox for hostile native code.
 * No URLs, payloads, credentials or source paths are included in errors.
 */
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';

function deny(): never {
  throw new Error('Usage is local-only: network access is disabled.');
}
function block(target: object, names: string[]): void {
  for (const name of names) {
    Object.defineProperty(target, name, { value: deny, writable: false, configurable: false });
  }
}
block(globalThis, ['fetch', 'WebSocket', 'EventSource']);
block(net, ['connect', 'createConnection', 'createServer']);
block(net.Socket.prototype, ['connect']);
block(net.Server.prototype, ['listen']);
block(tls, ['connect', 'createServer']);
for (const module of [http, https]) block(module, ['request', 'get', 'createServer']);
block(http.ClientRequest.prototype, ['end']);
block(http2, ['connect', 'createServer', 'createSecureServer']);
block(dgram, ['createSocket']);
block(dgram.Socket.prototype, ['send', 'connect', 'bind']);
// Includes callback and promises variants; no name lookup is needed for local files.
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  block(target, Object.getOwnPropertyNames(target).filter((name) => /^(lookup|resolve|reverse)/.test(name)));
}
// Do not let future parser code delegate egress to another process or worker.
block(childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
block(childProcess.ChildProcess.prototype, ['spawn']);
block(workerThreads, ['Worker']);
syncBuiltinESMExports();
