/** Stable shadow-tree styling for the renderer stage and built-in chrome. */
export const SHELL_STYLES = `
  /* ------------------------------------------------------------------ *
   * Host & design tokens.
   *
   * The --latkit-chrome-* properties are the public theming API. Every
   * other value below derives from them through the private --_latkit-*
   * layer so the chrome restyles coherently from the public tokens alone.
   * ------------------------------------------------------------------ */
  :host {
    --latkit-chrome-surface: color-mix(in srgb, Canvas 93%, transparent);
    --latkit-chrome-surface-strong: color-mix(in srgb, Canvas 97%, transparent);
    --latkit-chrome-control: color-mix(in srgb, CanvasText 7%, Canvas);
    --latkit-chrome-control-hover: color-mix(in srgb, CanvasText 12%, Canvas);
    --latkit-chrome-text: CanvasText;
    --latkit-chrome-muted: color-mix(in srgb, CanvasText 64%, Canvas);
    --latkit-chrome-border: color-mix(in srgb, CanvasText 34%, Canvas);
    --latkit-chrome-accent: color-mix(in srgb, #3b82f6 65%, CanvasText);
    --latkit-chrome-focus: CanvasText;
    --latkit-chrome-radius: 2px;
    --latkit-chrome-shadow: 0 1px 3px rgb(0 0 0 / 25%);
    --latkit-chrome-font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --latkit-chrome-font-mono: ui-monospace, 'Cascadia Code', Consolas, 'JetBrains Mono', Menlo, monospace;

    /* Private derived tokens: one hairline, one divider, one control size. */
    --_latkit-hairline: color-mix(in srgb, var(--latkit-chrome-border) 62%, transparent);
    --_latkit-divider: color-mix(in srgb, var(--latkit-chrome-border) 45%, transparent);
    --_latkit-control-size: 1.75rem;

    position: relative;
    display: block;
    min-block-size: 20rem;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    contain: content;
    container: latkit / inline-size;
    color-scheme: light dark;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  [hidden] {
    display: none !important;
  }

  .latkit-visually-hidden,
  [part~='projection'] > legend,
  [part~='navigation'] > legend {
    position: absolute !important;
    inline-size: 1px !important;
    block-size: 1px !important;
    padding: 0 !important;
    margin: -1px !important;
    overflow: hidden !important;
    clip: rect(0 0 0 0) !important;
    white-space: nowrap !important;
    border: 0 !important;
  }

  /* ------------------------------------------------------------------ *
   * Stage.
   * ------------------------------------------------------------------ */
  [part~='stage'] {
    position: absolute;
    inset: 0;
  }

  [part~='canvas'] {
    display: block;
    inline-size: 100%;
    block-size: 100%;
    outline: none;
  }

  [part~='canvas']:focus-visible {
    outline: 3px solid var(--latkit-chrome-focus);
    outline-offset: -6px;
    box-shadow: inset 0 0 0 7px Canvas;
  }

  [part~='fallback'] {
    display: block;
    block-size: 100%;
  }

  /* ------------------------------------------------------------------ *
   * Chrome overlay: a top rail, a right inspector column, and a pinned
   * color bar. Panels are real elements that own their surface and
   * overflow, so no host size can push controls out of reach.
   * ------------------------------------------------------------------ */
  [part~='chrome'] {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template:
      'top top' auto
      'stage inspector' minmax(0, 1fr)
      'legends inspector' auto /
      minmax(0, 1fr) auto;
    gap: 0.625rem;
    padding: clamp(0.625rem, 1.5cqi, 1rem);
    color: var(--latkit-chrome-text);
    font-family: var(--latkit-chrome-font);
    pointer-events: none;
  }

  .latkit-rail {
    grid-area: top;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.625rem;
    min-inline-size: 0;
    pointer-events: none;
  }

  [part~='caption'],
  [part~='toolbar'],
  [part~='inspector'],
  [part~='legends'] {
    border: 1px solid var(--_latkit-hairline);
    border-radius: var(--latkit-chrome-radius);
    background: var(--latkit-chrome-surface);
    box-shadow: var(--latkit-chrome-shadow);
    backdrop-filter: blur(6px);
  }

  [part~='caption'],
  [part~='toolbar'],
  [part~='inspector'] {
    pointer-events: auto;
  }

  /* ------------------------------------------------------------------ *
   * Caption: instrument-style status readout.
   * ------------------------------------------------------------------ */
  [part~='caption'] {
    flex: 0 1 auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-inline-size: 0;
    max-inline-size: min(32rem, 100%);
    min-block-size: calc(var(--_latkit-control-size) + 0.75rem + 2px);
    padding: 0.375rem 0.625rem;
    color: var(--latkit-chrome-text);
    font: 500 0.6875rem/1.35 var(--latkit-chrome-font-mono);
    font-variant-numeric: tabular-nums;
  }

  [part~='caption']::before {
    content: '';
    flex: 0 0 auto;
    inline-size: 0.375rem;
    block-size: 0.375rem;
    border-radius: 1px;
    background: var(--latkit-chrome-muted);
  }

  [part~='caption'][data-state='hover']::before,
  [part~='caption'][data-state='selected']::before {
    background: var(--latkit-chrome-accent);
    box-shadow: 0 0 0 0.2rem color-mix(in srgb, var(--latkit-chrome-accent) 18%, transparent);
  }

  [part~='caption'][data-state='selected'] {
    border-color: color-mix(in srgb, var(--latkit-chrome-accent) 58%, transparent);
    background: color-mix(in srgb, var(--latkit-chrome-accent) 10%, var(--latkit-chrome-surface-strong));
  }

  /* ------------------------------------------------------------------ *
   * Toolbar: projection segments, navigation commands, inspector toggle.
   * Content-sized; visible groups separate with hairline dividers.
   * ------------------------------------------------------------------ */
  [part~='toolbar'] {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    margin-inline-start: auto;
    padding: 0.375rem;
  }

  [part~='projection'],
  [part~='navigation'],
  [part~='channels'] {
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
    color: inherit;
    font: inherit;
  }

  [part~='projection'],
  [part~='navigation'] {
    display: flex;
    align-items: center;
  }

  [part~='toolbar'] > :not([hidden]) ~ :not([hidden]) {
    margin-inline-start: 0.375rem;
    border-inline-start: 1px solid var(--_latkit-divider);
    padding-inline-start: 0.375rem;
  }

  .latkit-segments,
  .latkit-command-row {
    display: flex;
    align-items: center;
  }

  .latkit-command-row {
    gap: 0.25rem;
  }

  /* ------------------------------------------------------------------ *
   * Shared control styles: every button and select in the chrome.
   * ------------------------------------------------------------------ */
  button,
  select {
    min-block-size: var(--_latkit-control-size);
    border: 1px solid var(--latkit-chrome-border);
    border-radius: var(--latkit-chrome-radius);
    background-color: var(--latkit-chrome-control);
    color: var(--latkit-chrome-text);
    font: 600 0.6875rem/1 var(--latkit-chrome-font);
    touch-action: manipulation;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease,
      box-shadow 120ms ease;
  }

  button {
    display: grid;
    place-items: center;
    min-inline-size: var(--_latkit-control-size);
    padding: 0.25rem;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }

  button > svg {
    display: block;
    inline-size: 1rem;
    block-size: 1rem;
  }

  button:hover:not(:disabled),
  select:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--latkit-chrome-accent) 48%, var(--latkit-chrome-border));
    background-color: var(--latkit-chrome-control-hover);
  }

  button:active:not(:disabled) {
    background-color: color-mix(in srgb, CanvasText 16%, Canvas);
  }

  button:focus-visible,
  select:focus-visible {
    z-index: 2;
    outline: 2px solid var(--latkit-chrome-focus);
    outline-offset: 2px;
    box-shadow: 0 0 0 4px Canvas;
  }

  button:disabled,
  select:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Projection segments join into one control; the pressed segment keeps
   * its accent identity above hover/active at any interaction state. */
  .latkit-segment {
    position: relative;
    margin-inline-start: -1px;
    border-color: transparent;
    border-radius: 0;
    background: transparent;
  }

  .latkit-segment:first-child {
    margin-inline-start: 0;
    border-start-start-radius: var(--latkit-chrome-radius);
    border-end-start-radius: var(--latkit-chrome-radius);
  }

  .latkit-segment:last-child {
    border-start-end-radius: var(--latkit-chrome-radius);
    border-end-end-radius: var(--latkit-chrome-radius);
  }

  .latkit-segments .latkit-segment[aria-pressed='true'] {
    z-index: 1;
    border-color: color-mix(in srgb, var(--latkit-chrome-accent) 55%, transparent);
    background: color-mix(in srgb, var(--latkit-chrome-accent) 16%, Canvas);
    box-shadow: inset 0 -2px 0 var(--latkit-chrome-accent);
  }

  .latkit-command {
    border-color: var(--_latkit-hairline);
  }

  [part~='inspector-toggle'][aria-expanded='true'] {
    border-color: color-mix(in srgb, var(--latkit-chrome-accent) 55%, transparent);
    background: color-mix(in srgb, var(--latkit-chrome-accent) 16%, Canvas);
  }

  select {
    inline-size: 100%;
    min-inline-size: 0;
    appearance: none;
    padding-block: 0.25rem;
    padding-inline: 0.5rem 1.5rem;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--latkit-chrome-muted) 50%),
      linear-gradient(135deg, var(--latkit-chrome-muted) 50%, transparent 50%);
    background-position:
      calc(100% - 0.75rem) 50%,
      calc(100% - 0.5rem) 50%;
    background-repeat: no-repeat;
    background-size: 0.25rem 0.25rem;
    text-overflow: ellipsis;
  }

  :dir(rtl) select {
    background-position:
      0.75rem 50%,
      0.5rem 50%;
  }

  /* ------------------------------------------------------------------ *
   * Shared text roles: one control-label and one micro-label style.
   * ------------------------------------------------------------------ */
  .latkit-control-label {
    overflow: hidden;
    color: var(--latkit-chrome-muted);
    font-size: 0.6875rem;
    font-weight: 650;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  [part~='channels'] > legend,
  .latkit-scope-label {
    padding: 0;
    color: var(--latkit-chrome-muted);
    font-size: 0.625rem;
    font-weight: 750;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .latkit-scope-label {
    overflow: hidden;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ------------------------------------------------------------------ *
   * Inspector: the collapsible display-settings panel. It caps itself to
   * the space beside the stage and scrolls internally, so its content
   * can never be clipped by the host.
   * ------------------------------------------------------------------ */
  [part~='inspector'] {
    grid-area: inspector;
    justify-self: end;
    align-self: start;
    inline-size: 15rem;
    max-inline-size: 100%;
    max-block-size: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.75rem;
    scrollbar-width: thin;
    scrollbar-color: var(--latkit-chrome-border) transparent;
  }

  [part~='colormap'] {
    display: grid;
    grid-template-columns: minmax(4.5rem, auto) minmax(0, 1fr);
    align-items: center;
    gap: 0.625rem;
    min-inline-size: 0;
    color: inherit;
    font: inherit;
  }

  [part~='colormap']:not([hidden]) + [part~='channels']:not([hidden]) {
    margin-block-start: 0.625rem;
    border-block-start: 1px solid var(--_latkit-divider);
    padding-block-start: 0.625rem;
  }

  [part~='channels'] > legend {
    margin-block-end: 0.75rem;
  }

  [part~='channel'] {
    display: grid;
    grid-template-columns: 1fr;
    align-content: end;
    gap: 0.35rem;
    min-inline-size: 0;
    color: inherit;
    font: inherit;
  }

  .latkit-channel-groups {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    min-inline-size: 0;
  }

  .latkit-channel-scope {
    display: grid;
    gap: 0.45rem;
    min-inline-size: 0;
  }

  .latkit-channel-fields {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.5rem;
    min-inline-size: 0;
  }

  /* ------------------------------------------------------------------ *
   * Legend: the single color bar, pinned to the bottom start corner.
   * ------------------------------------------------------------------ */
  [part~='legends'] {
    grid-area: legends;
    align-self: end;
    justify-self: start;
    display: block;
    inline-size: min(100%, 18rem);
    max-inline-size: min(100%, 18rem);
    padding: 0.5rem 0.625rem;
    pointer-events: none;
  }

  [part~='legend'] {
    display: grid;
    grid-template-rows: auto 0.5rem auto;
    gap: 0.3rem;
    min-inline-size: 0;
    color: var(--latkit-chrome-text);
    font: 650 0.6875rem/1.2 var(--latkit-chrome-font);
  }

  .latkit-legend-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .latkit-legend-swatch {
    position: relative;
    display: block;
    overflow: hidden;
    min-block-size: 0.5rem;
    border: 1px solid var(--_latkit-hairline);
    border-radius: 1px;
    direction: ltr;
  }

  .latkit-legend-range {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    color: var(--latkit-chrome-muted);
    font: 500 0.625rem/1.2 var(--latkit-chrome-font-mono);
    font-variant-numeric: tabular-nums;
    direction: ltr;
  }

  /* ------------------------------------------------------------------ *
   * Compact layout: the inspector becomes a bottom sheet that shares
   * free space with a guaranteed-visible strip of stage.
   * ------------------------------------------------------------------ */
  @container latkit (inline-size < 36rem) {
    [part~='chrome'] {
      grid-template:
        'top' auto
        'stage' minmax(2rem, 2fr)
        'inspector' minmax(0, 3fr)
        'legends' auto /
        minmax(0, 1fr);
    }

    [part~='inspector'] {
      justify-self: stretch;
      align-self: end;
      inline-size: 100%;
    }

    .latkit-channel-groups {
      grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    }
  }

  /* ------------------------------------------------------------------ *
   * User preferences & assistive modes.
   * ------------------------------------------------------------------ */
  @media (prefers-reduced-motion: reduce) {
    button,
    select {
      transition: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    [part~='caption'],
    [part~='toolbar'],
    [part~='inspector'],
    [part~='legends'] {
      background: var(--latkit-chrome-surface-strong);
      backdrop-filter: none;
    }
  }

  @media (prefers-contrast: more) {
    :host {
      --_latkit-hairline: var(--latkit-chrome-border);
      --_latkit-divider: var(--latkit-chrome-border);
      --latkit-chrome-muted: color-mix(in srgb, CanvasText 82%, Canvas);
    }
  }

  @media (forced-colors: active) {
    [part~='caption'],
    [part~='toolbar'],
    [part~='inspector'],
    [part~='legends'] {
      border: 1px solid CanvasText;
      background: Canvas;
      box-shadow: none;
      backdrop-filter: none;
    }

    .latkit-segment {
      border-color: ButtonBorder;
    }

    .latkit-segments .latkit-segment[aria-pressed='true'],
    [part~='inspector-toggle'][aria-expanded='true'] {
      outline: 2px solid Highlight;
      outline-offset: -3px;
    }

    button:focus-visible,
    select:focus-visible,
    [part~='canvas']:focus-visible {
      outline-color: Highlight;
    }

    select {
      appearance: auto;
      padding-inline: 0.5rem;
      background-image: none;
    }
  }
`;
