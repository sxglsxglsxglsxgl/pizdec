(function () {
  const root = document.documentElement;
  if (!root) return;

  const hasCSSSupports = typeof CSS !== 'undefined' && typeof CSS.supports === 'function';
  const supportsDynamicViewport =
    hasCSSSupports && (CSS.supports('height: 100dvh') || CSS.supports('height: 100svh'));

  if (supportsDynamicViewport) {
    return;
  }

  let pendingFrame = null;
  let lastViewportWidth = null;
  let lastViewportHeight = null;
  let lastOrientation = null;
  let lockedViewportHeight = null;
  let pendingHeight = null;
  let pendingTimeoutId = null;

  const VIEWPORT_HEIGHT_EVENT = 'viewportheightchange';
  const VIEWPORT_HEIGHT_STATE_KEY = '__viewportHeightPx';
  let lastBroadcastViewportHeight = null;

  const storeViewportHeight = (value) => {
    if (
      typeof window !== 'object' ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0
    ) {
      return;
    }
    window[VIEWPORT_HEIGHT_STATE_KEY] = value;
  };

  const broadcastViewportHeight = (value) => {
    storeViewportHeight(value);
    if (lastBroadcastViewportHeight === value) {
      return;
    }
    lastBroadcastViewportHeight = value;
    if (typeof window !== 'object' || typeof window.dispatchEvent !== 'function') {
      return;
    }

    const detail = { height: value };
    let event = null;

    if (typeof window.CustomEvent === 'function') {
      event = new CustomEvent(VIEWPORT_HEIGHT_EVENT, { detail });
    } else if (typeof document !== 'undefined' && typeof document.createEvent === 'function') {
      event = document.createEvent('CustomEvent');
      event.initCustomEvent(VIEWPORT_HEIGHT_EVENT, false, false, detail);
    }

    if (event) {
      window.dispatchEvent(event);
    }
  };

  const FINE_POINTER_WIDTH_THRESHOLD = 1;
  const DEFAULT_HEIGHT_INCREASE_THRESHOLD = 120;
  const DEFAULT_HEIGHT_DECREASE_THRESHOLD = 12;
  const COARSE_HEIGHT_CHANGE_THRESHOLD = 160;
  // On coarse pointer devices, dynamic browser chrome animations can nudge the
  // reported visual viewport width by a few pixels even though the layout width
  // remains effectively unchanged. Bumping the threshold avoids treating those
  // jitters as real resizes that would bypass the height buffering.
  const COARSE_WIDTH_CHANGE_THRESHOLD = 8;
  const KEYBOARD_VIEWPORT_RATIO = 0.78;
  // Allow fast updates when the viewport shrinks (e.g., browser chrome expands)
  // while ignoring modest growth to avoid layout jumps when the chrome hides. Coarse
  // pointer environments get an additional buffer so dynamic browser chrome toggles
  // do not immediately retrigger layout work.
  const HEIGHT_UPDATE_DELAY_MS = 50;

  const orientationMediaQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia('(orientation: portrait)') : null;

  const coarsePointerMediaQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none) and (pointer: coarse)')
      : null;

  let hasCoarsePointer = coarsePointerMediaQuery?.matches ?? false;

  const refreshPointerMatch = () => {
    if (!coarsePointerMediaQuery) {
      hasCoarsePointer = false;
      return;
    }

    hasCoarsePointer = Boolean(coarsePointerMediaQuery.matches);
  };

  const getOrientation = () => {
    const screenOrientation = window.screen?.orientation?.type;
    if (typeof screenOrientation === 'string') {
      return screenOrientation.startsWith('landscape') ? 'landscape' : 'portrait';
    }

    if (typeof window.orientation === 'number') {
      return Math.abs(window.orientation) === 90 ? 'landscape' : 'portrait';
    }

    if (orientationMediaQuery) {
      return orientationMediaQuery.matches ? 'portrait' : 'landscape';
    }

    return null;
  };

  const pickDimension = (candidates) =>
    candidates.find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0) ??
    null;

  const scheduleRetry = () => {
    if (pendingFrame != null) {
      return;
    }

    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      updateViewportUnit();
    });
  };

  const toViewportUnit = (value) => `${value / 100}px`;

  const resolveLockedEffectsHeight = (value) => {
    const lockedHeight =
      typeof lockedViewportHeight === 'number' &&
      Number.isFinite(lockedViewportHeight) &&
      lockedViewportHeight > 0
        ? lockedViewportHeight
        : null;

    if (lockedHeight == null) {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.max(lockedHeight, value);
    }

    return lockedHeight;
  };

  const applyViewportEffectsHeight = (value, { resolved = false } = {}) => {
    const effectsHeight = resolved ? value : resolveLockedEffectsHeight(value);

    if (
      typeof effectsHeight !== 'number' ||
      !Number.isFinite(effectsHeight) ||
      effectsHeight <= 0
    ) {
      return;
    }

    const nextValue = toViewportUnit(effectsHeight);
    if (root.style.getPropertyValue('--viewport-effects-unit') !== nextValue) {
      root.style.setProperty('--viewport-effects-unit', nextValue);
    }
  };

  const applyViewportHeight = (value, { lock = true } = {}) => {
    lastViewportHeight = value;
    if (lock) {
      lockedViewportHeight = value;
    }
    const nextValue = toViewportUnit(value);
    if (root.style.getPropertyValue('--viewport-unit') !== nextValue) {
      root.style.setProperty('--viewport-unit', nextValue);
    }
    const effectsHeight = resolveLockedEffectsHeight(value);
    applyViewportEffectsHeight(effectsHeight, { resolved: true });
    broadcastViewportHeight(value);
  };

  const commitPendingHeightUpdate = () => {
    if (pendingHeight == null) {
      return;
    }
    const { value, lock } = pendingHeight;
    pendingHeight = null;
    applyViewportHeight(value, { lock });
  };

  const schedulePendingHeightUpdate = (height, lock) => {
    pendingHeight = { value: height, lock };
    if (pendingTimeoutId != null) {
      clearTimeout(pendingTimeoutId);
    }
    pendingTimeoutId = setTimeout(() => {
      pendingTimeoutId = null;
      commitPendingHeightUpdate();
    }, HEIGHT_UPDATE_DELAY_MS);
  };

  const clearPendingHeightUpdate = () => {
    if (pendingTimeoutId != null) {
      clearTimeout(pendingTimeoutId);
      pendingTimeoutId = null;
    }
    pendingHeight = null;
  };

  const updateViewportUnit = () => {
    const height = pickDimension([
      window.visualViewport?.height,
      window.innerHeight,
      document.documentElement?.clientHeight,
    ]);

    if (height == null) {
      scheduleRetry();
      return;
    }

    applyViewportEffectsHeight(height);

    if (pendingFrame != null) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }

    const width = pickDimension([
      window.visualViewport?.width,
      window.innerWidth,
      document.documentElement?.clientWidth,
    ]);

    const normalizedWidth =
      typeof width === 'number' ? Math.round(width) : null;
    const normalizedLastWidth =
      typeof lastViewportWidth === 'number' ? Math.round(lastViewportWidth) : null;

    const orientation = getOrientation();

    const normalizedHeight = Math.round(height);
    const normalizedLastHeight =
      typeof lastViewportHeight === 'number' ? Math.round(lastViewportHeight) : null;

    const screenHeight = pickDimension([window.screen?.height, window.screen?.availHeight]);
    const normalizedScreenHeight =
      typeof screenHeight === 'number' ? Math.round(screenHeight) : null;

    const isLikelyKeyboardViewport =
      hasCoarsePointer &&
      normalizedScreenHeight != null &&
      normalizedHeight / normalizedScreenHeight <= KEYBOARD_VIEWPORT_RATIO;

    const wasLikelyKeyboardViewport =
      hasCoarsePointer &&
      normalizedScreenHeight != null &&
      normalizedLastHeight != null &&
      normalizedLastHeight / normalizedScreenHeight <= KEYBOARD_VIEWPORT_RATIO;

    const heightDecreaseThreshold = hasCoarsePointer
      ? COARSE_HEIGHT_CHANGE_THRESHOLD
      : DEFAULT_HEIGHT_DECREASE_THRESHOLD;
    const heightIncreaseThreshold = hasCoarsePointer
      ? COARSE_HEIGHT_CHANGE_THRESHOLD
      : DEFAULT_HEIGHT_INCREASE_THRESHOLD;

    const widthThreshold = hasCoarsePointer
      ? COARSE_WIDTH_CHANGE_THRESHOLD
      : FINE_POINTER_WIDTH_THRESHOLD;
    const widthChanged =
      normalizedWidth != null &&
      normalizedLastWidth != null &&
      Math.abs(normalizedWidth - normalizedLastWidth) > widthThreshold;

    const orientationChanged =
      orientation != null && lastOrientation != null && orientation !== lastOrientation;

    const widthWasUnknown = typeof width === 'number' && lastViewportWidth == null;
    const widthBecameUnknown = width == null && typeof lastViewportWidth === 'number';
    const geometryChanged = widthChanged || orientationChanged || widthWasUnknown || widthBecameUnknown;

    const heightDecreased =
      normalizedLastHeight != null &&
      (normalizedHeight <= normalizedLastHeight - heightDecreaseThreshold ||
        (isLikelyKeyboardViewport && !wasLikelyKeyboardViewport));

    const generalHeightIncrease =
      normalizedLastHeight != null &&
      normalizedHeight >= normalizedLastHeight + heightIncreaseThreshold;

    const keyboardTransitionRestoringLayout =
      normalizedLastHeight != null &&
      !isLikelyKeyboardViewport &&
      wasLikelyKeyboardViewport;

    const visualViewportHeightRaw = window.visualViewport?.height;
    const isVisualViewportMeasurement =
      typeof visualViewportHeightRaw === 'number' &&
      Number.isFinite(visualViewportHeightRaw) &&
      Math.abs(visualViewportHeightRaw - height) < 0.5;

    const normalizedLockedHeight =
      typeof lockedViewportHeight === 'number' ? Math.round(lockedViewportHeight) : null;

    const shouldIgnoreVisualViewportGrowth =
      hasCoarsePointer &&
      normalizedLockedHeight != null &&
      generalHeightIncrease &&
      !keyboardTransitionRestoringLayout &&
      !geometryChanged &&
      isVisualViewportMeasurement &&
      normalizedHeight > normalizedLockedHeight;

    const heightIncreaseRequiresUpdate =
      keyboardTransitionRestoringLayout ||
      (generalHeightIncrease && !shouldIgnoreVisualViewportGrowth);

    const shouldUpdate =
      lastViewportHeight == null ||
      geometryChanged ||
      heightDecreased ||
      heightIncreaseRequiresUpdate;

    if (!shouldUpdate) {
      lastViewportWidth = typeof width === 'number' ? width : lastViewportWidth;
      if (orientation != null) {
        lastOrientation = orientation;
      }
      if (pendingTimeoutId != null) {
        schedulePendingHeightUpdate(height, !isLikelyKeyboardViewport);
      }
      return;
    }

    lastViewportWidth = typeof width === 'number' ? width : null;
    if (orientation != null) {
      lastOrientation = orientation;
    }

    if (geometryChanged) {
      lockedViewportHeight = null;
    }

    const isHeightOnlyUpdate =
      lastViewportHeight != null &&
      (heightDecreased || heightIncreaseRequiresUpdate) &&
      !geometryChanged;

    if (isHeightOnlyUpdate) {
      schedulePendingHeightUpdate(height, !isLikelyKeyboardViewport);
      return;
    }

    clearPendingHeightUpdate();

    applyViewportHeight(height, { lock: !isLikelyKeyboardViewport });
  };

  function handlePageHide() {
    window.__viewportUnitCleanup?.();
    window.__viewportUnitCleanup = null;
  }

  function initialize() {
    if (typeof window.__viewportUnitCleanup === 'function') {
      window.__viewportUnitCleanup();
    }

    window.removeEventListener('pagehide', handlePageHide);

    refreshPointerMatch();

    const bindings = [];

    if (coarsePointerMediaQuery) {
      const handlePointerChange = () => {
        refreshPointerMatch();
      };

      if (typeof coarsePointerMediaQuery.addEventListener === 'function') {
        coarsePointerMediaQuery.addEventListener('change', handlePointerChange);
        bindings.push(() => {
          coarsePointerMediaQuery.removeEventListener('change', handlePointerChange);
        });
      } else if (typeof coarsePointerMediaQuery.addListener === 'function') {
        coarsePointerMediaQuery.addListener(handlePointerChange);
        bindings.push(() => {
          coarsePointerMediaQuery.removeListener(handlePointerChange);
        });
      }
    }

    lastViewportWidth = null;
    lastViewportHeight = null;
    lastOrientation = null;
    lockedViewportHeight = null;

    const addListener = (target, type) => {
      target.addEventListener(type, updateViewportUnit);
      bindings.push(() => {
        target.removeEventListener(type, updateViewportUnit);
      });
    };

    addListener(window, 'resize');
    addListener(window, 'orientationchange');

    if (window.visualViewport) {
      addListener(window.visualViewport, 'resize');
    }

    updateViewportUnit();

    window.__viewportUnitCleanup = () => {
      if (pendingFrame != null) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }

      clearPendingHeightUpdate();

      while (bindings.length) {
        const remove = bindings.pop();
        remove();
      }
      window.removeEventListener('pagehide', handlePageHide);
      lockedViewportHeight = null;
      root.style.removeProperty('--viewport-unit');
      root.style.removeProperty('--viewport-effects-unit');
    };

    window.addEventListener('pagehide', handlePageHide, { once: true });
  }

  function handlePageShow(event) {
    if (!event.persisted) {
      return;
    }

    if (typeof window.__viewportUnitCleanup === 'function') {
      return;
    }

    initialize();
  }

  initialize();
  window.addEventListener('pageshow', handlePageShow);
})();

(function () {
  const { SENTENCES } = window.SITE_CONFIG || {};
  if (!Array.isArray(SENTENCES) || SENTENCES.length === 0) return;

  const container = document.getElementById('sentences');
  if (!container) return;

  const VIEWPORT_HEIGHT_EVENT = 'viewportheightchange';
  const VIEWPORT_HEIGHT_STATE_KEY = '__viewportHeightPx';

  const total = SENTENCES.length;
  const nodes = SENTENCES.map((text, index) => {
    const sentence = document.createElement('p');
    sentence.className = 'sentence';
    sentence.textContent = text;
    sentence.setAttribute('role', 'listitem');
    sentence.setAttribute('aria-setsize', String(total));
    sentence.setAttribute('aria-posinset', String(index + 1));
    container.appendChild(sentence);
    return sentence;
  });

  const revealed = new Set();
  let activeIndex = -1;
  let ticking = false;

  const getStableViewportHeight = () => {
    const sharedHeight = window[VIEWPORT_HEIGHT_STATE_KEY];
    if (
      typeof sharedHeight === 'number' &&
      Number.isFinite(sharedHeight) &&
      sharedHeight > 0
    ) {
      return sharedHeight;
    }

    const innerHeight = typeof window.innerHeight === 'number' ? window.innerHeight : null;
    if (innerHeight != null && innerHeight > 0) {
      return innerHeight;
    }

    const clientHeight = document.documentElement?.clientHeight;
    if (typeof clientHeight === 'number' && clientHeight > 0) {
      return clientHeight;
    }

    return 0;
  };

  applyStates(activeIndex);

  function applyStates(currentIndex) {
    nodes.forEach((node, index) => {
      const isActive = index === currentIndex;
      const isPast = index < currentIndex;
      const hasBeenRevealed = revealed.has(index) || isPast || isActive;

      if (isPast) {
        revealed.add(index);
      }

      node.classList.toggle('is-active', isActive);
      node.classList.toggle('is-past', isPast);
      node.classList.toggle('is-visible', hasBeenRevealed);

      if (!hasBeenRevealed) {
        node.classList.remove('is-past', 'is-active');
      }
    });
  }

  function updateActiveSentence() {
    const viewportHeight = getStableViewportHeight();
    const revealOffset = viewportHeight * 0.3;
    const viewportCenter = viewportHeight / 2;
    let nextIndex = -1;
    let smallestDistance = Infinity;

    nodes.forEach((node, index) => {
      const rect = node.getBoundingClientRect();
      const isIntersecting =
        rect.bottom > -revealOffset && rect.top < viewportHeight + revealOffset;

      if (!isIntersecting) {
        return;
      }

      const nodeCenter = rect.top + rect.height / 2;
      const distance = Math.abs(nodeCenter - viewportCenter);

      if (distance < smallestDistance) {
        smallestDistance = distance;
        nextIndex = index;
      }
    });

    if (activeIndex !== nextIndex) {
      activeIndex = nextIndex;
    }

    applyStates(activeIndex);
  }

  function requestUpdate() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      updateActiveSentence();
    });
  }

  requestUpdate();

  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate);
  window.addEventListener(VIEWPORT_HEIGHT_EVENT, requestUpdate);
})();

(function () {
  const toggle = document.querySelector('[data-menu-toggle]');
  const menu = document.getElementById('site-menu');
  if (!toggle || !menu) return;

  const menuContainer = menu.querySelector('.site-menu__container');
  const closeTargets = menu.querySelectorAll('[data-menu-close]');
  const menuLinks = menu.querySelectorAll('[data-menu-link]');
  const initialFocus = menu.querySelector('[data-menu-focus]');

  const FOCUSABLE_SELECTORS = [
    'a[href]',
    'button:not([disabled])',
    'input:not([type="hidden"]):not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ];

  let lastFocusedElement = null;
  let hideTimeoutId = null;
  let pendingTransitionHandler = null;

  function getFocusableElements() {
    return Array.from(menu.querySelectorAll(FOCUSABLE_SELECTORS.join(','))).filter((element) => {
      if (element.hasAttribute('disabled')) return false;
      if (element.getAttribute('aria-hidden') === 'true') return false;
      if (element.hasAttribute('hidden')) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function setExpandedState(isExpanded) {
    toggle.setAttribute('aria-expanded', String(isExpanded));
    toggle.setAttribute('aria-label', isExpanded ? 'Close menu' : 'Open menu');
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return;

    const focusable = getFocusableElements();
    if (
      document.body.classList.contains('has-menu-open') &&
      toggle instanceof HTMLElement &&
      !toggle.hasAttribute('disabled')
    ) {
      const rect = toggle.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        focusable.push(toggle);
      }
    }
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey) {
      if (document.activeElement === first || !menu.contains(document.activeElement)) {
        event.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }

    trapFocus(event);
  }

  function focusInitialElement() {
    const candidates = [];
    if (initialFocus instanceof HTMLElement) {
      candidates.push(initialFocus);
    }
    if (menuContainer instanceof HTMLElement) {
      candidates.push(menuContainer);
    }
    candidates.push(...getFocusableElements());

    const target = candidates.find((element) => typeof element.focus === 'function');
    if (!target) return;

    requestAnimationFrame(() => {
      target.focus();
    });
  }

  function openMenu() {
    if (document.body.classList.contains('has-menu-open')) return;
    if (document.body.classList.contains('is-menu-closing')) return;

    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (hideTimeoutId !== null) {
      window.clearTimeout(hideTimeoutId);
      hideTimeoutId = null;
    }

    if (pendingTransitionHandler) {
      menu.removeEventListener('transitionend', pendingTransitionHandler);
      pendingTransitionHandler = null;
    }

    document.body.classList.remove('is-menu-closing');

    menu.hidden = false;
    menu.removeAttribute('hidden');
    menu.setAttribute('aria-hidden', 'false');

    // Ensure the opening opacity transition runs after the element becomes visible.
    menu.classList.remove('is-open');
    void menu.offsetWidth;

    menu.classList.add('is-open');
    document.body.classList.add('has-menu-open');

    setExpandedState(true);
    focusInitialElement();

    document.addEventListener('keydown', handleKeydown);
  }

  function closeMenu({ focusToggle = true } = {}) {
    if (!document.body.classList.contains('has-menu-open')) return;
    if (document.body.classList.contains('is-menu-closing')) return;

    document.body.classList.add('is-menu-closing');
    menu.classList.remove('is-open');
    menu.setAttribute('aria-hidden', 'true');
    setExpandedState(false);
    document.removeEventListener('keydown', handleKeydown);

    const finalizeHide = () => {
      menu.setAttribute('hidden', '');
      menu.hidden = true;
      document.body.classList.remove('is-menu-closing');
      document.body.classList.remove('has-menu-open');
    };

    const prefersReducedMotion =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion) {
      finalizeHide();
      hideTimeoutId = null;
      pendingTransitionHandler = null;
    } else {
      const handleTransitionEnd = (event) => {
        if (event.target !== menu || event.propertyName !== 'opacity') return;
        menu.removeEventListener('transitionend', handleTransitionEnd);
        pendingTransitionHandler = null;
        if (document.body.classList.contains('is-menu-closing')) {
          finalizeHide();
        }
        hideTimeoutId = null;
      };

      menu.addEventListener('transitionend', handleTransitionEnd);
      pendingTransitionHandler = handleTransitionEnd;
      hideTimeoutId = window.setTimeout(() => {
        if (pendingTransitionHandler) {
          menu.removeEventListener('transitionend', pendingTransitionHandler);
          pendingTransitionHandler = null;
        }
        if (document.body.classList.contains('is-menu-closing')) {
          finalizeHide();
        }
        hideTimeoutId = null;
      }, 500);
    }

    if (focusToggle) {
      const focusTarget =
        (lastFocusedElement && document.body.contains(lastFocusedElement)) ? lastFocusedElement : toggle;

      if (focusTarget && typeof focusTarget.focus === 'function') {
        requestAnimationFrame(() => {
          focusTarget.focus();
        });
      }
    }
  }

  toggle.addEventListener('click', () => {
    if (document.body.classList.contains('has-menu-open')) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  closeTargets.forEach((element) => {
    element.addEventListener('click', () => {
      closeMenu();
    });
  });

  menuLinks.forEach((link) => {
    link.addEventListener('click', () => {
      closeMenu({ focusToggle: false });
    });
  });
})();

(function () {
  const trigger = document.querySelector('[data-scroll-to-sentences]');
  const container = document.getElementById('sentences');

  if (!trigger || !container) return;

  function getAbsoluteOffsetTop(element) {
    let current = element;
    let offset = 0;

    while (current) {
      offset += current.offsetTop || 0;
      current = current.offsetParent;
    }

    return offset;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function animateScrollTo(top, duration) {
    const start = window.scrollY || window.pageYOffset || 0;
    const distance = top - start;
    if (distance === 0 || duration <= 0) {
      window.scrollTo(0, top);
      return;
    }

    const startTime = performance.now();

    const easeInOutCubic = (t) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    function step(now) {
      const elapsed = now - startTime;
      const progress = clamp(elapsed / duration, 0, 1);
      const eased = easeInOutCubic(progress);
      window.scrollTo(0, Math.round(start + distance * eased));
      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
  }

  function scrollToSentences() {
    const target = container.querySelector('.sentence') || container;
    const prefersReducedMotion =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const targetHeight = target.offsetHeight || target.getBoundingClientRect().height || 0;
    const documentHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight,
      document.body.clientHeight,
      document.documentElement.clientHeight
    );

    const maxScroll = Math.max(0, documentHeight - viewportHeight);

    let destination = getAbsoluteOffsetTop(target);

    if (targetHeight < viewportHeight) {
      destination -= (viewportHeight - targetHeight) / 2;
    }

    destination = clamp(destination, 0, maxScroll);

    if (prefersReducedMotion) {
      window.scrollTo({ top: destination, behavior: 'auto' });
      return;
    }

    animateScrollTo(destination, 700);
  }

  trigger.addEventListener('click', scrollToSentences);
})();
