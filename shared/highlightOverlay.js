import { ROLES } from "./protocol.js";

export function createHiddenHighlightOverlay() {
  return {
    roundId: null,
    winner: null,
    summary: "",
    overlayMode: "hidden",
    items: [],
    open: false
  };
}

export function buildRoundSummary({ winner, recentEvents = [] } = {}) {
  const summaryLead =
    winner === ROLES.ATTACKER
      ? "Attacker wins this round."
      : winner === ROLES.PLAYER
        ? "Runners survive this round."
        : "Round complete.";
  const eventSummary = recentEvents.length > 0 ? recentEvents.map((event) => event.message).join(" · ") : "No major events were recorded this round.";
  return `${summaryLead} ${eventSummary}`;
}

export function normalizeHighlightPayload(payload = {}) {
  const items = Array.isArray(payload.items) ? payload.items.map((item) => ({ ...item })) : [];
  const overlayMode = payload.overlayMode || (items.length > 0 ? "summary-with-images" : "summary-only");
  return {
    roundId: payload.roundId || null,
    winner: payload.winner || null,
    summary: payload.summary || "",
    overlayMode,
    items,
    open: overlayMode !== "hidden"
  };
}

export function buildLocalResultOverlay(game) {
  return normalizeHighlightPayload({
    roundId: game?.roundId || null,
    winner: game?.winner || null,
    summary: buildRoundSummary({
      winner: game?.winner,
      recentEvents: game?.recentEvents || []
    }),
    overlayMode: "summary-only",
    items: []
  });
}

export function closeHighlightOverlay(overlay) {
  return {
    ...overlay,
    open: false
  };
}
