import crypto from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export function createGoogleSheetsClient() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "";
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME || "Signups";
  const serviceAccountEmail = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL || "";
  const privateKey = normalizePrivateKey(process.env.GOOGLE_SHEETS_PRIVATE_KEY || "");

  if (!spreadsheetId || !sheetName || !serviceAccountEmail || !privateKey) {
    return null;
  }

  let accessToken = "";
  let accessTokenExpiresAt = 0;

  return {
    async appendEvent(event) {
      const token = await getAccessToken({
        serviceAccountEmail,
        privateKey,
        cachedToken: accessToken,
        cachedTokenExpiresAt: accessTokenExpiresAt
      });
      accessToken = token.value;
      accessTokenExpiresAt = token.expiresAt;

      const range = `${sheetName}!A:J`;
      const url = new URL(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`
      );
      url.searchParams.set("valueInputOption", "USER_ENTERED");
      url.searchParams.set("insertDataOption", "INSERT_ROWS");

      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          values: [[
            event.timestamp || new Date().toISOString(),
            event.eventType || "signup",
            event.telegramId || "",
            event.username || "",
            event.firstName || "",
            event.lastName || "",
            event.email || "",
            event.country || "",
            event.source || "",
            event.method || ""
          ]]
        })
      });

      if (!response.ok) {
        const error = await response.text().catch(() => "");
        return {
          ok: false,
          status: response.status,
          error
        };
      }

      return { ok: true };
    }
  };
}

async function getAccessToken({ serviceAccountEmail, privateKey, cachedToken, cachedTokenExpiresAt }) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (cachedToken && cachedTokenExpiresAt > nowSeconds + 60) {
    return {
      value: cachedToken,
      expiresAt: cachedTokenExpiresAt
    };
  }

  const issuedAt = nowSeconds;
  const expiresAt = nowSeconds + 3600;
  const assertion = createJwt({
    serviceAccountEmail,
    privateKey,
    issuedAt,
    expiresAt
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`Google token request failed: ${response.status}`);
  }

  return {
    value: data.access_token,
    expiresAt: issuedAt + Number(data.expires_in || 3600)
  };
}

function createJwt({ serviceAccountEmail, privateKey, issuedAt, expiresAt }) {
  const header = {
    alg: "RS256",
    typ: "JWT"
  };
  const payload = {
    iss: serviceAccountEmail,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: expiresAt,
    iat: issuedAt
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer.sign(privateKey);
  return `${unsignedToken}.${toBase64Url(signature)}`;
}

function toBase64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function normalizePrivateKey(value) {
  return String(value || "").replaceAll("\\n", "\n").trim();
}
