const BASE_URL = String(process.env.DOGRAH_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = String(process.env.DOGRAH_API_KEY || '').trim();

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

function isTransientNetworkError(error) {
  const code = error && (error.code || error.cause?.code);
  return TRANSIENT_CODES.has(code) || error?.name === 'TimeoutError';
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(method, path, body = null) {
  if (!BASE_URL) {
    throw new Error('DOGRAH_BASE_URL is not configured');
  }

  if (!API_KEY) {
    throw new Error('DOGRAH_API_KEY is not configured');
  }

  const url = `${BASE_URL}/api/v1${path}`;

  let response;
  const attempts = method === 'GET' ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000)
      });
      break;
    } catch (error) {
      if (attempt === attempts || !isTransientNetworkError(error)) throw error;
      await wait(150 * attempt);
    }
  }

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message =
      data?.detail ||
      data?.error ||
      data?.message ||
      `Dograh request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = response.status === 404 ? 'dograh_not_found' : 'dograh_request_failed';
    throw error;
  }

  return data;
}

async function health() {
  const response = await fetch(`${BASE_URL}/api/v1/health`);

  if (!response.ok) {
    throw new Error(`Dograh health check failed: ${response.status}`);
  }

  return response.json();
}
async function listWorkflows() {
  return request('GET', '/workflow/fetch');
}
async function getWorkflow(workflowId) {
  return request('GET', `/workflow/fetch/${workflowId}`);
}

async function createWorkflow(name, workflowDefinition) {
  return request('POST', '/workflow/create/definition', {
    name,
    workflow_definition: workflowDefinition
  });
}
async function updateWorkflow(workflowId, name, workflowDefinition, workflowConfigurations) {
  const payload = {
    name,
    workflow_definition: workflowDefinition
  };
  if (workflowConfigurations !== undefined) payload.workflow_configurations = workflowConfigurations;
  await request('PUT', `/workflow/${workflowId}`, payload);
  await request('POST', `/workflow/${workflowId}/publish`);
  return getWorkflow(workflowId);
}
async function updateWorkflowStatus(workflowId, status) {
  return request('PUT', `/workflow/${workflowId}/status`, { status });
}
async function createEmbedToken(workflowId, options = {}) {
  return request('POST', `/workflow/${workflowId}/embed-token`, {
    allowed_domains: options.allowedDomains || null,
    settings: options.settings || null,
    usage_limit: options.usageLimit || null,
    expires_in_days: options.expiresInDays ?? 30
  });
}

async function getEmbedToken(workflowId) {
  return request('GET', `/workflow/${workflowId}/embed-token`);
}
module.exports = {
  request,
  health,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  updateWorkflowStatus,
  createEmbedToken,
  getEmbedToken
};
