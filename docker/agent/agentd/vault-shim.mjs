/* global window, location */
// Injected only after a human connects a credential. No key material crosses this bridge.
export function vaultBrowserShim() {
  if (window.__northbotVaultInstalled) return;
  window.__northbotVaultInstalled = true;
  const nativeGet = navigator.credentials.get.bind(navigator.credentials);
  const enc = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const dec = (text) =>
    Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))
      .buffer;
  navigator.credentials.get = async (options) => {
    if (!options?.publicKey) return nativeGet(options);
    const key = options.publicKey;
    const result = await window.__northbotVaultSign({
      challenge: enc(key.challenge),
      rpId: key.rpId ?? location.hostname,
      allowCredentials: (key.allowCredentials ?? []).map((c) => enc(c.id)),
    });
    return {
      id: result.id,
      rawId: dec(result.rawId),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: dec(result.response.clientDataJSON),
        authenticatorData: dec(result.response.authenticatorData),
        signature: dec(result.response.signature),
        userHandle: result.response.userHandle ? dec(result.response.userHandle) : null,
      },
      getClientExtensionResults: () => ({}),
      toJSON: () => result,
    };
  };
}

