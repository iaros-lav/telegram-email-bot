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
    async upsertContact({ email, firstName, lastName, country, source, method }) {
      const finalTags = buildTags(tags, { source, method, country });
      const payload = {
        api_key: apiKey,
        email_address: email,
        status,
        tags: finalTags
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
        return withFriendlyError(createResponse);
      }

      const memberId = crypto.createHash("md5").update(email).digest("hex");
      const updatePayload = {
        ...payload,
        tags: toTagUpdateMap(finalTags)
      };
      const updateResponse = await emailOctopusFetch(
        `/lists/${listId}/contacts/${memberId}`,
        {
          method: "PUT",
          body: updatePayload
        }
      );

      if (updateResponse.ok) {
        return { ok: true, action: "updated" };
      }

      return withFriendlyError(updateResponse);
    },
    async unsubscribeContact({ email, firstName, lastName, country, source, method }) {
      const memberId = crypto.createHash("md5").update(email).digest("hex");
      const finalTags = buildTags(tags, { source, method, country });
      const payload = {
        api_key: apiKey,
        email_address: email,
        status: "UNSUBSCRIBED",
        tags: toTagUpdateMap(finalTags)
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

      const response = await emailOctopusFetch(
        `/lists/${listId}/contacts/${memberId}`,
        {
          method: "PUT",
          body: payload
        }
      );

      if (response.ok) {
        return { ok: true, action: "unsubscribed" };
      }

      if (response.error?.code === "MEMBER_NOT_FOUND") {
        return { ok: true, action: "already_missing" };
      }

      return withFriendlyError(response);
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

function toTagUpdateMap(tags) {
  return Object.fromEntries(tags.map((tag) => [tag, true]));
}

function buildTags(baseTags, { source, method, country }) {
  const dynamicTags = [];
  const safeSource = sanitizeTag(source);
  const safeMethod = sanitizeTag(method);

  if (safeSource) {
    dynamicTags.push(`source-${safeSource}`);
  }
  if (safeMethod) {
    dynamicTags.push(`method-${safeMethod}`);
  }

  return [...new Set([...baseTags, ...dynamicTags])];
}

function sanitizeTag(value) {
  return String(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function withFriendlyError(result) {
  return {
    ...result,
    message: describeEmailOctopusError(result.error)
  };
}

function describeEmailOctopusError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "");

  if (code.includes("INVALID") || code.includes("EMAIL")) {
    return "Сервис рассылки отклонил этот email.";
  }

  if (code.includes("MEMBER_EXISTS")) {
    return "Этот email уже есть в списке рассылки.";
  }

  if (code.includes("MEMBER_NOT_FOUND")) {
    return "Этот email не найден в списке рассылки.";
  }

  if (message) {
    return message;
  }

  return "Сервис рассылки не смог обработать этот запрос.";
}
