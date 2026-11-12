import { isIP } from "node:net";

/**
 * Which IP addresses an outgoing webhook may connect to: only addresses on the public
 * internet. A copy of the crawler's rule in `@repo/knowledge` (`src/crawl/address.ts`, with
 * its tests), because domain packages do not import each other (DECISIONS); `address.test.ts`
 * here checks the same cases. Refused: loopback, private networks, link-local (where cloud
 * metadata services live), carrier-grade NAT, multicast, documentation and reserved ranges,
 * and every IPv6 form that wraps an IPv4 address (mapped, compatible, NAT64, 6to4), which is
 * judged by the IPv4 address inside it.
 */
function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

function isPublicIpv4(bytes: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = bytes;
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // documentation
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** The 16 bytes of an IPv6 address, or null when it is not one. Zone ids are refused. */
function parseIpv6(address: string): number[] | null {
  if (address.includes("%") || isIP(address) !== 6) return null;
  let text = address;
  // A dotted IPv4 tail ("::ffff:10.0.0.1") becomes two hex groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1];
  if (tail !== undefined) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head.length > 0 ? head.split(":") : [];
  const right = rest !== undefined && rest.length > 0 ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: rest === undefined ? 0 : missing }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function isPublicIpv6(bytes: readonly number[]): boolean {
  const at = (index: number) => bytes[index] ?? 0;
  const zero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const embedded = (offset: number) => isPublicIpv4(bytes.slice(offset, offset + 4));

  // ::/96: unspecified, loopback and IPv4-compatible addresses.
  if (zero(0, 12)) return false;
  // ::ffff:0:0/96: IPv4-mapped.
  if (zero(0, 10) && at(10) === 0xff && at(11) === 0xff) return embedded(12);
  // 64:ff9b::/96: NAT64 to a public or a private IPv4 address.
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b) {
    return zero(4, 12) ? embedded(12) : false; // 64:ff9b:1::/48 is for local use
  }
  // 2002::/16: 6to4, with the IPv4 address in the next four bytes.
  if (at(0) === 0x20 && at(1) === 0x02) return embedded(2);
  // Global unicast is 2000::/3; everything outside it is local, multicast or reserved.
  if ((at(0) & 0xe0) !== 0x20) return false;
  if (at(0) === 0x20 && at(1) === 0x01) {
    if (at(2) === 0x00 && at(3) === 0x00) return false; // 2001::/32 Teredo
    if (at(2) === 0x0d && at(3) === 0xb8) return false; // 2001:db8::/32 documentation
    if (at(2) === 0x00 && (at(3) & 0xf0) === 0x10) return false; // 2001:10::/28 ORCHID
    if (at(2) === 0x00 && (at(3) & 0xf0) === 0x20) return false; // 2001:20::/28 ORCHIDv2
  }
  if (at(0) === 0x3f && at(1) === 0xff) return false; // 3fff::/20 documentation
  return true;
}

/** True only for an address a crawler may connect to. Anything unparseable is refused. */
export function isPublicAddress(address: string): boolean {
  const text = address.trim().replace(/^\[(.*)\]$/, "$1");
  const v4 = parseIpv4(text);
  if (v4 !== null) return isPublicIpv4(v4);
  const v6 = parseIpv6(text);
  return v6 !== null && isPublicIpv6(v6);
}

/** True when the host part of a URL is an IP address (IPv6 in or out of brackets). */
export function isIpLiteral(hostname: string): boolean {
  return isIP(hostname.replace(/^\[(.*)\]$/, "$1")) !== 0;
}
