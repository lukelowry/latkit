---
name: latkit examples
description: Minimal controls around a window-filling canvas.
colors:
  bg: '#101214'
  surface: '#191c1f'
  raised: '#24282c'
  line: '#30353a'
  line-strong: '#50585f'
  text: '#f0f1f2'
  muted: '#a6adb4'
  accent: '#b8d6c4'
  accent-ink: '#15241c'
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '13px'
    lineHeight: 1.45
  label:
    fontSize: '12px'
  mono:
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace"
rounded:
  control: '4px'
spacing:
  compact: '6px'
  small: '8px'
  regular: '12px'
  section: '16px'
---

# Design System: latkit examples

## Overview

The canvas is the main workspace. A compact header, plain controls, and short labels let developers try each example directly. Shared styles and controls keep the examples consistent.

## Colors

Use the dark background for canvases, surface for the header and controls panel, and raised for inputs and buttons. Lines separate regions. Muted text carries labels and supporting values; text carries primary content. The pale green accent marks primary actions, pressed states, ranges, and keyboard focus. Data colors belong to the example and its legend.

## Typography

Use system sans serif for the interface, with 12px labels and supporting text. The brand is 16px at weight 650; section headings are 12px at weight 600. Use monospace for shortcuts, playback time, and performance values. Numeric readouts use tabular figures.

## Layout

Desktop fills the viewport: a 48px header, flexible canvas, and 272px controls panel. The panel scrolls independently. Playback sits below the canvas when present. Hiding controls gives the canvas and playback the full width.

At 700px and below, the header is 56px and controls move below the canvas and playback. The canvas is at least 360px tall, normally 65dvh. Hiding controls fills the remaining viewport with the canvas. Linked views stack vertically. Buttons, selects, text inputs, and disclosure headings have a 44px minimum height on mobile, up from 32px controls and 40px disclosure headings on desktop.

## Elevation & Depth

Use flat surfaces and thin borders. Menus and canvas annotations sit above content without shadows.

## Shapes

Controls and menus share the small corner radius. Main regions meet edge to edge with straight dividers.

## Components

- Navigation uses a native example picker and a Controls toggle with an expanded state.
- Control groups use native disclosures. Keep labels brief, place values beside sliders, and group related actions in two columns.
- Buttons and fields share raised backgrounds and stronger borders. Hover brightens the border and background; keyboard focus has a 2px accent outline. Disabled controls use half opacity.
- Playback uses a compact button, range, and time readout. On mobile, the range occupies its own row.
- Legends identify the data scale. Keep simulated data identified where shown.
- Reuse `src/ui/controls.ts`, `src/ui/style.css`, and the canvas defaults in `src/ui/theme.ts`. Create views through `Stage`, which supplies plot title clearance and responsive panel layout.

## Do's and Don'ts

- Do keep the canvas large, controls compact, and text direct.
- Do preserve visible keyboard focus, native control behavior, and readable plot titles.
- Don't add decorative cards, marketing copy, or separate styles for controls already shared.
