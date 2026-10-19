export function buildTransportConfig(environment = process.env) {
  const config = {
    apiPort: Number(environment.SSH_AGENT_PORT ?? 3001),
    eventsPort: Number(environment.SSH_AGENT_EVENTS_PORT ?? 3002),
  };
  validatePorts(config);
  return config;
}

export function validatePorts(ports) {
  for (const [name, port] of Object.entries(ports)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${name} must be between 1 and 65535.`);
    }
  }
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) {
    throw new Error('Web, API and events ports must differ.');
  }
}

export function browserTransportEnvironment({ apiPort, eventsPort }) {
  return {
    NEXT_PUBLIC_SSH_AGENT_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    NEXT_PUBLIC_SSH_AGENT_EVENTS_BASE_URL: `http://127.0.0.1:${eventsPort}`,
  };
}

export function assertBuildTransportMatches(config, environment = process.env) {
  for (const [name, port] of [['SSH_AGENT_PORT', config.apiPort], ['SSH_AGENT_EVENTS_PORT', config.eventsPort]]) {
    if (environment[name] !== undefined && Number(environment[name]) !== port) {
      throw new Error(`${name} differs from the frontend build. Rebuild with the same ${name} before starting.`);
    }
  }
}
