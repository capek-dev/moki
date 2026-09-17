import { createServer, type RequestListener } from 'node:http';

export type CallbackListener = (complete: (url: string) => Promise<void>) => Promise<() => void>;

export function callbackHandler(complete: (url: string) => Promise<void>): RequestListener {
  return (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Connection', 'close');
    if (request.method !== 'GET' || request.headers.host !== 'localhost:1455' || !request.url?.startsWith('/auth/callback?') || request.url.length > 32000) {
      response.writeHead(400); response.end('Invalid sign-in callback.'); return;
    }
    void complete(`http://localhost:1455${request.url}`).then(() => {
      response.end('Signed in to Moki. You can close this tab and return to the app.');
    }, () => {
      response.writeHead(400); response.end('Sign-in could not be completed. Return to Moki and try again.');
    });
  };
}

// Bind both loopback families because browsers may resolve localhost to either.
// Never bind to a wildcard address or fall back to another redirect port.
export const listenForOAuth: CallbackListener = async (complete) => {
  const servers: ReturnType<typeof createServer>[] = [];
  const close = () => {
    for (const server of servers) {
      server.close();
      // Permit the active callback response to finish, but bound lingering sockets.
      const timer = setTimeout(() => server.closeAllConnections(), 1000);
      timer.unref();
    }
  };
  try {
    for (const host of ['127.0.0.1', '::1']) {
      const server = createServer(callbackHandler(complete));
      server.headersTimeout = 5000;
      server.requestTimeout = 10000;
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host, port: 1455, ipv6Only: host === '::1' }, resolve);
      });
    }
    return close;
  } catch {
    close();
    throw new Error('Cannot open localhost port 1455. Close any other Codex sign-in attempt and try again.');
  }
};
