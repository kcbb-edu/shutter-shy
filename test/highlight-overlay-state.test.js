import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalResultOverlay, closeHighlightOverlay, createHiddenHighlightOverlay, normalizeHighlightPayload } from "../shared/highlightOverlay.js";
import { ROLES } from "../shared/protocol.js";

test("controllers can close the same summary-only overlay independently", () => {
  const payload = {
    roundId: "round-summary",
    winner: ROLES.ATTACKER,
    summary: "Attacker wins this round. Runner OUT.",
    items: [],
    overlayMode: "summary-only"
  };

  const leftPhone = normalizeHighlightPayload(payload);
  const rightPhone = normalizeHighlightPayload(payload);
  const leftClosed = closeHighlightOverlay(leftPhone);

  assert.equal(leftClosed.open, false);
  assert.equal(rightPhone.open, true);
  assert.equal(rightPhone.overlayMode, "summary-only");
  assert.deepEqual(createHiddenHighlightOverlay(), {
    roundId: null,
    winner: null,
    summary: "",
    overlayMode: "hidden",
    items: [],
    open: false
  });
});

test("local fallback overlay remains summary-only when the room has no image payload yet", () => {
  const overlay = buildLocalResultOverlay({
    roundId: "fallback-round",
    winner: ROLES.PLAYER,
    recentEvents: []
  });

  assert.equal(overlay.open, true);
  assert.equal(overlay.overlayMode, "summary-only");
  assert.equal(overlay.items.length, 0);
  assert.match(overlay.summary, /Runners survive this round\./);
});
