import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

/** True if the IP is loopback/private/link-local/CGNAT/metadata/etc (v4 + v6). */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    // Accept global unicast only. Exclude documentation, tunneling and other special-purpose ranges.
    return !/^[23][0-9a-f]{3}:/.test(l) || /^2001:(?:[0-1]?[0-9a-f]{1,2}:|db8:)|^2002:|^3fff:/.test(l);
  }
  return true;
}

export interface LinkResult { url: string; ok: boolean; status?: number; latencyMs?: number; error?: string }

function once(url: URL, ip: string, method: 'HEAD' | 'GET'): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    // Connect to the already-validated IP (defeats DNS rebinding); keep Host/SNI for the real name.
    const req = https.request({
      host: ip, port: url.port || 443, path: url.pathname + url.search, method, servername: url.hostname,
      headers: { Host: url.host, 'User-Agent': 'DeadlineCrush-LinkCheck/1' }, timeout: 5000,
    }, (res) => {
      let got = 0;
      res.on('data', (d) => { got += d.length; if (got > 64 * 1024) res.destroy(); });
      res.on('close', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function checkLink(raw: string, resolver: (h: string) => Promise<string[]> = defaultResolve): Promise<LinkResult> {
  const t0 = Date.now();
  try {
    let url = new URL(raw);
    for (let hop = 0; hop <= 3; hop++) {
      if (url.protocol !== 'https:') return { url: raw, ok: false, error: 'https only' };
      if (url.username || url.password || url.port) return { url: raw, ok: false, error: 'Use a public HTTPS link on port 443 without credentials' };
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const ips = net.isIP(host) ? [host] : await resolver(host);
      if (!ips.length || ips.some(isBlockedIp)) return { url: raw, ok: false, error: 'blocked address' };
      let r = await once(url, ips[0], 'HEAD');
      if (r.status >= 400 || r.status === 0) r = await once(url, ips[0], 'GET');
      if (r.status >= 300 && r.status < 400 && r.location) {
        if (hop === 3) return { url: raw, ok: false, error: 'too many redirects' };
        url = new URL(r.location, url); // re-validated at top of loop
        continue;
      }
      return { url: raw, ok: r.status >= 200 && r.status < 400, status: r.status, latencyMs: Date.now() - t0 };
    }
    return { url: raw, ok: false, error: 'too many redirects' };
  } catch (e) {
    return { url: raw, ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 };
  }
}

async function defaultResolve(host: string) {
  return (await dns.lookup(host, { all: true })).map((a) => a.address);
}
