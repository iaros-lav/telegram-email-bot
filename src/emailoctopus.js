import crypto from "node:crypto";

const EMAILOCTOPUS_BASE_URL = "https://emailoctopus.com/api/1.6";

export function createEmailOctopusClient() {
  const apiKey = process.env.EMAILOCTOPUS_API_KEY || "";
  const listId = process.env.EMAILOCTOPUS_LIST_ID || "";
  const status = process.env.EMAILOCTOPUS_STATUS || "SUBSCRIBED";
  const tags = parseTags(process.env.EMAILOCTOPUS_TAGS || "");

  if (!apiKey || !listId) {
    return null;
  }

  return {
    async upsertContact({ email, firstName, lastName }) {
      const payload = {
        api_key: apiKey,
        email_address: email,
        status,
        tags
      };

      const fields = {};
      if (firstName) {
        fields.FirstName = firstName;
      }
      if (lastName) {
        fields.LastName = lastName;
      }
      if (Object.keys(fields).length > 0) {
        payload.fields = fields;
      }

      const createResponse = await emailOctopusFetch(`/lists/${listId}/contacts`, {
        method: "POST",
        body: payload
      });

      if (createResponse.ok) {
        return { ok: true, action: "created" };
      }

      if (createResponse.error?.code !== "MEMBER_EXISTS_WITH_EMAIL_ADDRESS") {
        return createResponse;
      }

      const memberId = crypto.createHash("md5").update(email).digest("hex");
      const updateResponse = await emailOctopusFetch(
        `/lists/${listId}/contacts/${memberId}`,
        {
          method: "PUT",
          body: payload
        }
      );

      if (updateResponse.ok) {
        return { ok: true, action: "updated" };
      }

      return updateResponse;
    }
  };
}

async function emailOctopusFetch(endpoint, { method, body }) {
  const response = await fetch(`${EMAILOCTOPUS_BASE_URL}${endpoint}`, {
    method,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (response.ok) {
    return { ok: true, data };
  }

  return {
    ok: false,
    status: response.status,
    error: data
  };
}

function parseTags(value) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}
