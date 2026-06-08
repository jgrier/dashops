// Catalog of every process the supervisor manages. Order matters: Restate
// goes first so registrations land somewhere when the rest come up.

export interface ServiceSpec {
  name: string;
  // For npm-managed services, the working directory holds the package.json.
  cwd?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  // Restate deployment port (the HTTP endpoint Restate registers as a
  // service deployment). Used to:
  //   (a) probe whether the process is actually listening
  //   (b) POST to admin /deployments after start
  port?: number;
  // Per-service ops view port. Surfaced in the UI as a clickable link.
  uiPort?: number;
  // Skip the admin /deployments register call (used for restate-server itself).
  registerDeployment?: boolean;
  // One-line description shown in the UI.
  role: string;
}

export const services: ServiceSpec[] = [
  {
    name: "restate-server",
    command: "restate-server",
    args: ["--no-logo"],
    port: 9070,
    registerDeployment: false,
    role: "Restate runtime — durable execution, VO state, journal storage",
  },
  {
    name: "gateway",
    cwd: "services/gateway",
    command: "npm",
    args: ["run", "dev"],
    port: 9080,
    uiPort: 9180,
    registerDeployment: true,
    role: "Routes every agent ↔ tool/LLM call. Middleware, cost ledger, recent-calls log.",
  },
  {
    name: "delivery-svc",
    cwd: "services/delivery-svc",
    command: "npm",
    args: ["run", "dev"],
    port: 9081,
    uiPort: 9181,
    registerDeployment: true,
    role: "delivery_lookup, escalation_history",
  },
  {
    name: "customer-svc",
    cwd: "services/customer-svc",
    command: "npm",
    args: ["run", "dev"],
    port: 9082,
    uiPort: 9182,
    registerDeployment: true,
    role: "customer_lookup, apply_credit, customer_outreach",
  },
  {
    name: "ops-agent",
    cwd: "services/ops-agent",
    command: "npm",
    args: ["run", "dev"],
    port: 9083,
    uiPort: 9183,
    registerDeployment: true,
    role: "Per-session VOs (Session). Chat UIs moved to the supervisor BFF.",
  },
  {
    name: "guardrails",
    cwd: "services/guardrails",
    command: "npm",
    args: ["run", "dev"],
    port: 9084,
    uiPort: 9184,
    registerDeployment: true,
    role: "PIIGuardrail (regex pre-screen / LLM classifier in live mode)",
  },
  {
    name: "approval-service",
    cwd: "services/approval-service",
    command: "npm",
    args: ["run", "dev"],
    port: 9085,
    uiPort: 9185,
    registerDeployment: true,
    role: "Async human-in-the-loop approvals + appeals; pending + decided indexes",
  },
  {
    name: "insights-svc",
    cwd: "services/insights-svc",
    command: "npm",
    args: ["run", "dev"],
    port: 9086,
    uiPort: 9186,
    registerDeployment: true,
    role: "semantic_search, merchant_status",
  },
  {
    name: "llm-svc",
    cwd: "services/llm-svc",
    command: "npm",
    args: ["run", "dev"],
    port: 9087,
    uiPort: 9187,
    registerDeployment: true,
    role: "Single backend for every LLM call (gateway-routed)",
  },
];
