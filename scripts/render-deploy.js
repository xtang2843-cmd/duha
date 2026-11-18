"use strict";

/**
 * Deploy duha to Render using the public API.
 *
 * Usage:
 *   RENDER_API_KEY=... node scripts/render-deploy.js
 * or put the key in `.render-api-key` (gitignored).
 *
 * Optional:
 *   RENDER_OWNER_ID=...   pick a workspace if the account has several
 *   RENDER_SERVICE=duha   service name
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const KEY_FILE = path.join(ROOT, ".render-api-key");
const REPO = process.env.RENDER_REPO || "https://github.com/xtang2843-cmd/duha";
const BRANCH = process.env.RENDER_BRANCH || "main";
const SERVICE_NAME = process.env.RENDER_SERVICE || "duha";
const REGION = process.env.RENDER_REGION || "frankfurt";

function readKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY.trim();
  try {
    return fs.readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    console.error(`Missing Render API key. Put it in ${KEY_FILE} or set RENDER_API_KEY.`);
    process.exit(1);
  }
}

const API_KEY = readKey();

async function api(endpoint, options = {}) {
  const response = await fetch(`https://api.render.com/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body && body.message ? body.message : text;
    const error = new Error(`Render API ${response.status}: ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function unwrapOwner(entry) {
  return entry && entry.owner ? entry.owner : entry;
}

async function findOwner() {
  if (process.env.RENDER_OWNER_ID) {
    return { id: process.env.RENDER_OWNER_ID, name: "from RENDER_OWNER_ID" };
  }
  const owners = (await api("/owners?limit=50")) || [];
  const list = owners.map(unwrapOwner).filter((owner) => owner && owner.id);
  if (!list.length) throw new Error("No Render workspace found for this API key.");
  if (list.length > 1) {
    console.log("Workspaces:");
    list.forEach((owner) => console.log(`  ${owner.id}  ${owner.name || ""}`));
    console.log(`Using the first one. Set RENDER_OWNER_ID to choose another.`);
  }
  return list[0];
}

async function findService(ownerId) {
  const services = (await api("/services?limit=100")) || [];
  for (const entry of services) {
    const service = entry.service || entry;
    if (service && service.name === SERVICE_NAME && service.ownerId === ownerId) return service;
  }
  return null;
}

async function createService(owner) {
  const payload = {
    type: "web_service",
    name: SERVICE_NAME,
    ownerId: owner.id,
    repo: REPO,
    branch: BRANCH,
    autoDeployTrigger: "commit",
    envVars: [
      { key: "NODE_ENV", value: "production" },
      { key: "HOST", value: "0.0.0.0" },
      { key: "NODE_VERSION", value: "24" },
      { key: "TRUST_PROXY", value: "1" },
      { key: "COOKIE_SECURE", value: "auto" },
    ],
    serviceDetails: {
      runtime: "node",
      plan: "free",
      region: REGION,
      healthCheckPath: "/api/health",
      envSpecificDetails: {
        buildCommand: "npm install --omit=dev",
        startCommand: "npm start",
      },
    },
  };

  return api("/services", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function getDeploy(serviceId, deployId) {
  return api(`/services/${serviceId}/deploys/${deployId}`);
}

async function waitForDeploy(serviceId, deployId, timeoutMs = 12 * 60 * 1000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const deploy = await getDeploy(serviceId, deployId);
    const status = deploy && deploy.status ? deploy.status : "unknown";
    if (status !== last) {
      console.log(`Deploy status: ${status}`);
      last = status;
    }
    if (status === "live") return deploy;
    if (["build_failed", "update_failed", "canceled", "pre_deploy_failed"].includes(status)) {
      throw new Error(`Deploy ended with status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("Timed out waiting for the deploy.");
}

async function main() {
  console.log("Finding Render workspace…");
  const owner = await findOwner();
  console.log(`Workspace: ${owner.name || owner.id}`);

  let service = await findService(owner.id);
  let deployId = null;

  if (service) {
    console.log(`Service "${SERVICE_NAME}" already exists (${service.id}); deploying latest commit…`);
    const deploy = await api(`/services/${service.id}/deploys`, {
      method: "POST",
      body: JSON.stringify({ clearCache: "do_not_clear" }),
    });
    deployId = deploy && deploy.id ? deploy.id : deploy && deploy.deploy ? deploy.deploy.id : null;
    if (!deployId) {
      const list = await api(`/services/${service.id}/deploys?limit=1`);
      deployId = list && list[0] ? (list[0].deploy?.id || list[0].id) : null;
    }
  } else {
    console.log(`Creating "${SERVICE_NAME}" from ${REPO} (${BRANCH})…`);
    const created = await createService(owner);
    service = created.service;
    deployId = created.deployId || (created.deploy && created.deploy.id) || null;
    console.log(`Service created: ${service.id}`);
  }

  if (deployId) {
    const deploy = await waitForDeploy(service.id, deployId);
    console.log(`Deploy finished: ${deploy.status}`);
  }

  const fresh = await api(`/services/${service.id}`);
  const details = fresh.serviceDetails || service.serviceDetails || {};
  const url = details.url || fresh.url || "";
  console.log("");
  console.log(`Live URL: ${url || "(Render is still assigning one)"}`);
  console.log(`Dashboard: ${fresh.dashboardUrl || service.dashboardUrl || ""}`);
  if (url) console.log(`Health: ${url.replace(/\/$/, "")}/api/health`);
  console.log("");
  console.log(`Note: the Render free plan has an ephemeral disk, so SQLite resets on deploys/restarts.`);
}

main().catch((error) => {
  console.error("");
  console.error(error.message);
  if (error.body && typeof error.body === "object") {
    console.error(JSON.stringify(error.body, null, 2));
  }
  process.exit(1);
});
