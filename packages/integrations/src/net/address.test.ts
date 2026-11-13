import { describe, expect, it } from "vitest";

import { isPublicAddress } from "./address";

// The same cases as the crawler's rule in @repo/knowledge (src/crawl/safe-fetch.test.ts).
describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "100.64.0.1", // carrier-grade NAT
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "192.0.0.1",
    "192.0.2.10",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe", // 169.254.169.254, mapped, in hex
    "::7f00:1", // IPv4-compatible loopback
    "64:ff9b::7f00:1", // NAT64 to loopback
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "2002:7f00:1::1", // 6to4 to loopback
    "2002:c0a8:101::1", // 6to4 to 192.168.1.1
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "100::1",
    "[::1]",
    "fe80::1%eth0",
    "",
    "localhost",
    "999.1.1.1",
    "1.2.3",
    "0x7f.0.0.1",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.1.1",
    "192.167.1.1",
    "198.17.255.255",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
    "[2606:4700:4700::1111]",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});
