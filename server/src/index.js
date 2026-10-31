import fs from 'node:fs';
import https from 'node:https';
import { createApp } from './app.js';
import { DEFAULT_PORT } from './settings.js';

// Demo tier: ports 5400-5449 only. Loopback only: this server never faces a network.
const port = Number(process.env.PORT || DEFAULT_PORT);
if (!Number.isInteger(port) || port < 5400 || port > 5449) {
  console.error('PORT must be between 5400 and 5449');
  process.exit(1);
}
// LAB_BIND=0.0.0.0 only inside Docker, where compose publishes the port on the Mac's 127.0.0.1 alone.
const bind = process.env.LAB_BIND === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
let app;
try { app = createApp({ port, bind }); } catch (error) {
  // A settings file that is a link or not JSON, or a bad LAB_ALLOWED_HOSTS, stops the lab rather than guessing.
  console.error(['file', 'env'].includes(error?.field) ? error.message : 'PingFederate LAB could not start');
  process.exit(1);
}
for (const warning of app.locals.customerWarnings || []) console.warn(`customer.config: ${warning}`);
// The netguard's self-test: in mock mode a real URL must be refused before the lab answers anything.
const guard = await app.locals.netguard.selfTest();
if (!guard.ok) {
  console.error('netguard self-test failed; refusing to start');
  process.exit(1);
}
// LAB_TLS_CERT and LAB_TLS_KEY (PEM files): serve https with that certificate instead of http.
const tls = process.env.LAB_TLS_CERT && process.env.LAB_TLS_KEY;
let server = app;
if (tls) {
  try {
    server = https.createServer({ cert: fs.readFileSync(process.env.LAB_TLS_CERT), key: fs.readFileSync(process.env.LAB_TLS_KEY) }, app);
  } catch {
    console.error('LAB_TLS_CERT or LAB_TLS_KEY could not be read');
    process.exit(1);
  }
}
server.listen(port, bind, () => {
  // The address it really listens on. Inside Docker that is 0.0.0.0 (the container), and compose publishes it on 127.0.0.1 only.
  const where = bind === '0.0.0.0' ? `0.0.0.0:${port} (in the container; docker-compose publishes it on 127.0.0.1 only)` : `${bind}:${port}`;
  console.log(`PingFederate LAB on ${tls ? 'https' : 'http'}://${where}`);
});
