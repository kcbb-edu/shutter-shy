function formatDetails(details = {}) {
  const entries = Object.entries(details).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return "";
  }
  return entries
    .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}`)
    .join(" ");
}

export function logServerEvent(scope, message, details = {}) {
  const timestamp = new Date().toISOString();
  const suffix = formatDetails(details);
  console.log(`${timestamp} [${scope}] ${message}${suffix ? ` ${suffix}` : ""}`);
}
