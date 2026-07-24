import type { Network } from '@latkit/network';

import type { NetworkData } from '../data/types.js';
import { createCaption } from './caption.js';
import { createControls, type HostCommandSink } from './controls.js';
import type { FieldCatalog } from './fields.js';
import { attachCanvasInteraction } from './interaction.js';
import { createLegends } from './legend.js';
import type { InteractionState, ViewState } from './state.js';
import type { Shell } from './shell.js';

/** Stable built-in chrome owned for the complete lifetime of one element. */
export interface Chrome {
  update(
    data: NetworkData,
    fields: FieldCatalog,
    view: ViewState,
    projections: Network['projections'],
    interaction: InteractionState,
    announceSelection?: boolean,
  ): void;
  reset(): void;
}

/** Create every control once and bind it only to the durable element sink. */
export function createChrome(host: HostCommandSink, shell: Shell): Chrome {
  const caption = createCaption(shell.regions.caption, shell.regions.live);
  const controls = createControls(shell.regions, host);
  const legends = createLegends(shell.regions.legends);
  attachCanvasInteraction(shell.canvas, host);
  let previousData: NetworkData | null = null;
  let previousFields: FieldCatalog | null = null;
  let previousView: ViewState | null = null;
  let previousProjections: Network['projections'] | null = null;
  let previousInteraction: InteractionState | null = null;

  return {
    update(data, fields, view, projections, interaction, announceSelection = false) {
      if (
        fields !== previousFields ||
        view !== previousView ||
        projections !== previousProjections ||
        interaction.atFitView !== previousInteraction?.atFitView
      ) {
        controls.update(fields, view, projections, interaction);
      }
      if (view !== previousView) legends.update(view);
      if (
        data !== previousData ||
        view !== previousView ||
        interaction !== previousInteraction ||
        announceSelection
      ) {
        caption.update(data, view, interaction, announceSelection);
      }
      previousData = data;
      previousFields = fields;
      previousView = view;
      previousProjections = projections;
      previousInteraction = interaction;
    },
    reset() {
      controls.reset();
      legends.reset();
      caption.reset();
      previousData = null;
      previousFields = null;
      previousView = null;
      previousProjections = null;
      previousInteraction = null;
    },
  };
}

export type { HostCommandSink } from './controls.js';
