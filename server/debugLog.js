export function logServerEvent(scope, event, details = {}) {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  const payload = {
    at: new Date().toISOString(),
    scope,
    event,
    ...details
  };
  console.log(JSON.stringify(payload));
}
