import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["2001::", 32],
])
  PRIVATE.addSubnet(net, bits, "ipv6");

/** Return the pinned address only after checking every DNS answer, including mapped IPv4. */
export async function publicAddress(host, { resolve = lookup, allowPrivate = false } = {}) {
  const h = host.replace(/^\[|\]$/g, "");
  const family = isIP(h);
  const found = family ? [{ address: h, family }] : await resolve(h, { all: true });
  if (!found.length) throw new Error("no address");
  if (
    !allowPrivate &&
    found.some((a) => PRIVATE.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))
  )
    return null;
  return found[0].address;
}

export function parseConnect(authority) {
  const parsed = (authority ?? "").match(/^(?:\[([^\]]+)\]|([^:\s/]+)):(\d+)$/);
  if (!parsed) return null;
  const port = Number(parsed[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: parsed[1] ?? parsed[2], port };
}
