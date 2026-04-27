type ViewportCssVarOptions = {
  onChange?: () => void;
  freezeHeightOnKeyboard?: boolean;
  keyboardOpenThreshold?: number;
};

function isEditableElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  const tagName = element.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

export function installViewportCssVars(options: ViewportCssVarOptions | (() => void) = {}) {
  const normalizedOptions = typeof options === "function"
    ? { onChange: options }
    : options;
  const {
    onChange,
    freezeHeightOnKeyboard = false,
    keyboardOpenThreshold = 120
  } = normalizedOptions;
  const root = document.documentElement;
  let rafId = 0;
  let stableHeight = 0;
  let appliedWidth = 0;
  let appliedHeight = 0;

  const isKeyboardOpen = (width: number, height: number) => {
    if (!freezeHeightOnKeyboard || stableHeight <= 0) {
      return false;
    }
    if (!isEditableElement(document.activeElement)) {
      return false;
    }
    const keyboardDelta = stableHeight - height;
    const widthStable = Math.abs(width - appliedWidth) < 24 || appliedWidth === 0;
    return widthStable && keyboardDelta > keyboardOpenThreshold;
  };

  const apply = () => {
    rafId = 0;
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const keyboardOpen = isKeyboardOpen(width, height);
    if (!keyboardOpen) {
      stableHeight = height;
    }
    const nextHeight = keyboardOpen ? stableHeight : height;
    if (Math.abs(appliedWidth - width) < 0.5 && Math.abs(appliedHeight - nextHeight) < 0.5) {
      return;
    }
    appliedWidth = width;
    appliedHeight = nextHeight;
    root.style.setProperty("--app-width", `${width}px`);
    root.style.setProperty("--app-height", `${nextHeight}px`);
    root.dataset.keyboardOpen = keyboardOpen ? "true" : "false";
    onChange?.();
  };

  const scheduleApply = () => {
    if (rafId) {
      return;
    }
    rafId = window.requestAnimationFrame(apply);
  };

  scheduleApply();
  window.addEventListener("resize", scheduleApply);
  window.addEventListener("orientationchange", scheduleApply);
  window.visualViewport?.addEventListener("resize", scheduleApply);
  window.visualViewport?.addEventListener("scroll", scheduleApply);
  window.addEventListener("focusin", scheduleApply);
  window.addEventListener("focusout", scheduleApply);

  return () => {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
    }
    window.removeEventListener("resize", scheduleApply);
    window.removeEventListener("orientationchange", scheduleApply);
    window.visualViewport?.removeEventListener("resize", scheduleApply);
    window.visualViewport?.removeEventListener("scroll", scheduleApply);
    window.removeEventListener("focusin", scheduleApply);
    window.removeEventListener("focusout", scheduleApply);
  };
}
