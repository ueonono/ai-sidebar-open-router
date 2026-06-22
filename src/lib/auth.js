// Account-based sign-in for providers that support OAuth.
//
// Reality check: OpenAI, Anthropic, Google, Mistral… do NOT offer OAuth for API
// access — they only issue API keys. The one provider with a real browser OAuth
// flow is OpenRouter, which also lets the user sign in with Google / GitHub /
// email on its side, and unlocks every model (Claude, GPT, Gemini, Llama…).
//
// We implement OpenRouter's PKCE flow via browser.identity.launchWebAuthFlow,
// which opens a popup, lets the user authenticate, and returns an API key that we
// store locally (BYOK semantics preserved — the key never leaves this browser
// except to OpenRouter).

function base64UrlEncode(bytes) {
  let str = "";
  for (const b of new Uint8Array(bytes)) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makePkce() {
  // High-entropy code verifier.
  const verifierBytes = crypto.getRandomValues(new Uint8Array(48));
  const verifier = base64UrlEncode(verifierBytes);
  // S256 challenge = base64url(sha256(verifier)).
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(digest);
  return { verifier, challenge };
}

// Run the OpenRouter OAuth flow and return a fresh API key string.
export async function connectOpenRouter() {
  if (!browser.identity || !browser.identity.launchWebAuthFlow) {
    throw new Error("API identity indisponible (permission manquante).");
  }
  const redirectUri = browser.identity.getRedirectURL();
  const { verifier, challenge } = await makePkce();

  const authUrl =
    "https://openrouter.ai/auth?callback_url=" +
    encodeURIComponent(redirectUri) +
    "&code_challenge=" +
    encodeURIComponent(challenge) +
    "&code_challenge_method=S256";

  const redirectResponse = await browser.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  const code = new URL(redirectResponse).searchParams.get("code");
  if (!code) throw new Error("Aucun code d'autorisation reçu d'OpenRouter.");

  // Exchange the auth code for an API key.
  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Échange OAuth échoué (HTTP ${res.status}). ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  const key = json.key || json.api_key;
  if (!key) throw new Error("OpenRouter n'a pas renvoyé de clé.");
  return key;
}
