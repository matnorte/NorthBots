import { test } from "node:test";
import assert from "node:assert/strict";
import { publicAddress, parseConnect } from "./network.mjs";

for (const address of [
  "0.1.2.3",
  "127.0.0.1",
  "10.0.0.1",
  "100.64.0.1",
  "169.254.169.254",
  "172.16.1.2",
  "192.168.0.1",
  "198.18.0.1",
  "224.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "fc00::1",
  "fe80::1",
  "64:ff9b::a00:1",
  "2002:a00:1::",
  "2001::1",
  "::a00:1",
])
  test(`refuses nonpublic destination ${address}`, async () => {
    assert.equal(await publicAddress(address), null);
  });

test("checks all DNS answers and pins the approved address without a second lookup", async () => {
  let lookups = 0;
  const resolve = async () => {
    lookups++;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  assert.equal(await publicAddress("example.test", { resolve }), "93.184.216.34");
  assert.equal(lookups, 1);
  assert.equal(
    await publicAddress("mixed.test", {
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    }),
    null,
  );
});

test("permits public IPv6 and explicit local-development override", async () => {
  assert.equal(await publicAddress("[2606:4700:4700::1111]"), "2606:4700:4700::1111");
  assert.equal(await publicAddress("127.0.0.1", { allowPrivate: true }), "127.0.0.1");
});

test("rejects malformed CONNECT ports before opening a socket", () => {
  for (const input of [
    "example.test:0",
    "example.test:65536",
    "example.test:999999999",
    "example.test:-1",
    "example.test:abc",
    "example.test:443/path",
    "::1:443",
  ])
    assert.equal(parseConnect(input), null);
  assert.deepEqual(parseConnect("example.test:443"), { host: "example.test", port: 443 });
  assert.deepEqual(parseConnect("[2606:4700:4700::1111]:443"), {
    host: "2606:4700:4700::1111",
    port: 443,
  });
});
