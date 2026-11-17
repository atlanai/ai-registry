// Keep credentials in tab memory/session storage, never in a bookmark or on disk.
const KEY = "aireg-web-token";
let channel;
let verified = false;
let current = "";

export async function sessionToken() {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]{16,128})(?:&|$)/.exec(location.hash);
  if (match) history.replaceState(null, "", location.pathname);
  try {
    if (match) sessionStorage.setItem(KEY, match[1]);
    current = match ? match[1] : sessionStorage.getItem(KEY) || "";
  } catch (_) {
    current = match ? match[1] : "";
  }
  try {
    channel = new BroadcastChannel("aireg-ui-session");
    channel.onmessage = ({ data }) => {
      if (data?.type === "request" && verified) {
        channel.postMessage({ type: "session", token: current });
      } else if (data?.type === "ready" && !verified) {
        channel.postMessage({ type: "request" });
      } else if (
        data?.type === "session" &&
        !verified &&
        /^[A-Za-z0-9_-]{16,128}$/.test(data.token || "") &&
        data.token !== current
      ) {
        try {
          sessionStorage.setItem(KEY, data.token);
          location.reload();
        } catch (_) {
          // A browser that disables storage can still open the CLI's launch address.
        }
      }
    };
    if (!current) channel.postMessage({ type: "request" });
  } catch (_) {
    // Sharing across tabs is optional; the launch address works without it.
  }
  globalThis.addEventListener?.("hashchange", () => {
    // A fresh launch address in this tab can be a same-document navigation.
    if (/(?:^#|&)token=[A-Za-z0-9_-]{16,128}(?:&|$)/.test(location.hash)) location.reload();
  });
  return current;
}

export function sessionResult(status) {
  if (status === 401) {
    verified = false;
    const gate = document.getElementById("sessionGate");
    if (gate) gate.hidden = false;
    document.getElementById("appSurface")?.setAttribute("inert", "");
    channel?.postMessage({ type: "request" });
    return;
  }
  if (status >= 200 && status < 300 && !verified) {
    verified = true;
    channel?.postMessage({ type: "ready" });
  }
}
